#!/usr/bin/env node
/**
 * Unified discovery pipeline.
 *
 *   discover (parallel sources)
 *     -> normalize (Posting schema)
 *     -> dedup (URL exact + fuzzy)
 *     -> update company index
 *     -> filter (recency, location, role, queue, negative list)
 *     -> quick-rank (URL/title heuristic)
 *     -> enrich top-K (JD fetch + cache)
 *     -> full-rank (JD-aware scoring)
 *     -> persist
 *
 * Usage:
 *   node collectors/pipeline.js                # full run with defaults
 *   node collectors/pipeline.js --dry-run      # show sources and queries only
 *   node collectors/pipeline.js --source X     # run one source
 *   node collectors/pipeline.js --no-enrich    # skip JD fetch, show discovery only
 *   node collectors/pipeline.js --max-enrich N # cap enrichment to N postings (default 300)
 */

const fs = require('fs');
const path = require('path');

const { loadEnv, getProjectRoot } = require('../lib/config');
const { dedup } = require('../lib/dedup');
const { quickScore, fullScore, fuseRanking, isRoleMatch } = require('../lib/rank');
const { enrich } = require('../lib/enrich');
const { ghostScore } = require('../lib/ghost-score');
const { mergeIntoIndex } = require('../lib/tracker-stats');
const { atomicWrite } = require('../lib/tracker-writer');
const { createLimiter } = require('../lib/rate-limiter');
const { harvestSlugs } = require('../lib/slug-harvest');

loadEnv();

const ROOT = getProjectRoot();
const TODAY = new Date().toISOString().slice(0, 10);
const OUT_DIR = path.join(ROOT, 'signals', 'discovered', TODAY);

// ── logger ──────────────────────────────────────────────────

function mkLogger(prefix) {
  const write = (lvl, msg) => console.error(`[${new Date().toISOString().slice(11, 19)}][${lvl}] ${prefix || ''}${msg}`);
  return {
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg),
  };
}

// ── Source discovery ────────────────────────────────────────

function loadSources(onlyId = null) {
  const base = path.join(ROOT, 'collectors', 'sources');
  const dirs = ['aggregators', 'company-specific', 'ats-directories', 'ats-direct'];
  const sources = [];
  for (const dir of dirs) {
    const full = path.join(base, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.js')) continue;
      const mod = require(path.join(full, f));
      if (!mod.id || typeof mod.discover !== 'function') continue;
      if (onlyId && mod.id !== onlyId) continue;
      sources.push(mod);
    }
  }
  return sources;
}

// ── Seed queries ────────────────────────────────────────────

function loadSeedQueries() {
  const p = path.join(ROOT, 'data', 'queries', 'seeds.json');
  if (!fs.existsSync(p)) {
    return [
      { query: 'Senior Machine Learning Engineer', location: 'New York' },
      { query: 'Staff Machine Learning Engineer', location: 'New York' },
      { query: 'Machine Learning Engineer', location: 'Remote' },
      { query: 'AI Engineer', location: 'New York' },
      { query: 'Senior Data Scientist', location: 'New York' },
    ];
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')).queries || [];
}

// ── Company index update (emergent) ─────────────────────────

function updateCompanyIndex(postings) {
  const p = path.join(ROOT, 'data', 'companies', 'index.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};

  for (const post of postings) {
    const url = post.canonicalUrl || '';
    let ats = null;
    let slug = null;
    const gh = url.match(/greenhouse\.io\/([^/?]+)/i);
    const lv = url.match(/jobs\.lever\.co\/([^/?]+)/i);
    const ab = url.match(/jobs\.ashbyhq\.com\/([^/?]+)/i);
    if (gh) { ats = 'greenhouse'; slug = gh[1]; }
    else if (lv) { ats = 'lever'; slug = lv[1]; }
    else if (ab) { ats = 'ashby'; slug = ab[1]; }

    if (!slug) {
      slug = post.companySlug;
      if (!slug) continue;
    }

    const entry = existing[slug] || {};
    // Posting-count history used by ghost-score to approximate hires/posting ratio
    const thisRunCount = (entry.postingCountByRun?.[TODAY] || 0) + 1;
    existing[slug] = {
      name: post.company,
      ats: ats || entry.ats || 'other',
      lastSeen: new Date().toISOString(),
      sources: [...new Set([...(entry.sources || []), ...post.discoveredVia.map(d => d.source)])],
      urls: [...new Set([...(entry.urls || []), post.canonicalUrl])].slice(-20),
      postingCountByRun: { ...(entry.postingCountByRun || {}), [TODAY]: thisRunCount },
      // hiresPerPosting: operator-supplied signal (or later derived from
      // tracker outcomes) used by lib/ghost-score.js
      hiresPerPosting: entry.hiresPerPosting ?? null,
      recentLayoff: entry.recentLayoff ?? null,
    };
  }

  const sorted = Object.keys(existing).sort().reduce((acc, k) => (acc[k] = existing[k], acc), {});
  atomicWrite(p, JSON.stringify(sorted, null, 2));
  return Object.keys(existing).length;
}

// ── Requisition history (cross-run repost tracking for ghost-score) ──
// Records, per dedupKey, the set of run-dates a req has appeared in, and
// annotates each posting with `reqRuns` (how many distinct runs it has been
// seen in, including today). ghost-score's repostSignal consumes this.
function updateReqHistory(postings) {
  const p = path.join(ROOT, 'signals', 'req-history.json');
  let hist = {};
  if (fs.existsSync(p)) {
    try { hist = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { hist = {}; }
  }
  for (const post of postings) {
    const key = post.dedupKey;
    if (!key) continue;
    const entry = hist[key] || { company: post.company, title: post.title, runs: [] };
    if (!entry.runs.includes(TODAY)) entry.runs.push(TODAY);
    entry.runs = entry.runs.slice(-12); // cap history depth
    entry.lastSeen = TODAY;
    hist[key] = entry;
    post.reqRuns = entry.runs.length;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWrite(p, JSON.stringify(hist, null, 2));
}

// ── Filters ─────────────────────────────────────────────────

function loadQueueUrls() {
  const p = path.join(ROOT, 'data', 'apply-queue.json');
  if (!fs.existsSync(p)) return new Set();
  const q = JSON.parse(fs.readFileSync(p, 'utf8'));
  const s = new Set();
  for (const e of q) {
    if (e.primaryUrl) s.add(e.primaryUrl);
    for (const u of e.alternativeUrls || []) s.add(u);
  }
  return s;
}

function loadNegativeList() {
  const p = path.join(ROOT, 'data', 'companies', 'negative-list.json');
  if (!fs.existsSync(p)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(p, 'utf8')).companySlugs || []); } catch { return new Set(); }
}

function applyFilters(postings, filters) {
  const queueUrls = loadQueueUrls();
  const negative = loadNegativeList();
  // Seniority-aware recency: senior/staff IC vacancies stay open longer
  // per Review of Accounting Studies 2023 (high-skill jobs have longer
  // vacancy durations). Give them +15 days of headroom.
  const seniorRe = /\b(senior|staff|principal|lead|member of technical staff)\b/i;
  const baseDays = filters.maxAgeDays || 30;
  const seniorDays = baseDays + (filters.seniorityExtensionDays ?? 15);
  const out = [];
  const rejected = { recency: 0, location: 0, role: 0, queue: 0, negative: 0, nonRemote: 0 };

  for (const p of postings) {
    // Role
    if (!isRoleMatch(p.title)) { rejected.role++; continue; }
    // Negative list
    if (negative.has(p.companySlug)) { rejected.negative++; continue; }
    // Queue
    const urls = [p.canonicalUrl, ...p.alternateUrls];
    if (urls.some(u => queueUrls.has(u))) { rejected.queue++; continue; }
    // Location: US-only
    if (filters.usOnly && p.us === false) { rejected.location++; continue; }
    // Location: remote-only — hard filter per _profile.md.
    // PRE-ENRICH stage is permissive: reject only postings we already KNOW are
    // non-remote ('hybrid'/'onsite'). 'unknown' (ambiguous "United States" /
    // "Multiple Locations" strings, and aggregator hits with no location) is
    // kept so enrichment can fetch the real JD and verify. The STRICT pass —
    // dropping anything that is not 'remote' after enrichment — runs in
    // finalizeRemoteAndRecency() once we have JD-derived signals.
    if (filters.remoteOnly && (p.remote === 'hybrid' || p.remote === 'onsite')) { rejected.nonRemote++; continue; }
    // Recency: apply seniority-aware cutoff (keep if date unknown)
    if (p.postedDate && baseDays > 0) {
      const useDays = seniorRe.test(p.title) ? seniorDays : baseDays;
      const cutoff = new Date(Date.now() - useDays * 86400_000);
      if (new Date(p.postedDate) < cutoff) { rejected.recency++; continue; }
    }
    out.push(p);
  }
  return { kept: out, rejected };
}

// Strict post-enrichment gate. Runs AFTER enrich() has fetched JD text and
// re-derived posting.remote / .us / .postedDate, so remote and recency are
// decided on verified data rather than the thin listing-stage location string.
function finalizeRemoteAndRecency(postings, filters) {
  const seniorRe = /\b(senior|staff|principal|lead|member of technical staff)\b/i;
  const baseDays = filters.maxAgeDays || 30;
  const seniorDays = baseDays + (filters.seniorityExtensionDays ?? 15);
  const out = [];
  const rejected = { nonRemote: 0, recency: 0, location: 0 };
  for (const p of postings) {
    if (filters.usOnly && p.us === false) { rejected.location++; continue; }
    if (filters.remoteOnly && p.remote !== 'remote') { rejected.nonRemote++; continue; }
    if (p.postedDate && baseDays > 0) {
      const useDays = seniorRe.test(p.title) ? seniorDays : baseDays;
      const cutoff = new Date(Date.now() - useDays * 86400_000);
      if (new Date(p.postedDate) < cutoff) { rejected.recency++; continue; }
    }
    out.push(p);
  }
  return { kept: out, rejected };
}

// Bounded-concurrency async map. enrich() can now run over a few hundred
// postings; an unbounded Promise.all would open that many sockets at once.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Persist ─────────────────────────────────────────────────

function persist(data, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// ── Main ────────────────────────────────────────────────────

async function run(opts = {}) {
  const log = mkLogger('pipeline ');
  const filters = {
    usOnly: true,
    remoteOnly: true,  // hard filter per _profile.md; override with --allow-onsite
    maxAgeDays: 30,
    ...opts.filters,
  };

  const auth = {
    serpApiKey: process.env.SERPAPI_KEY || null,
    braveApiKey: process.env.BRAVE_API_KEY || null,
  };

  const queries = opts.queries || loadSeedQueries();

  const sources = loadSources(opts.onlySource);
  log.info(`sources loaded: ${sources.map(s => s.id).join(', ')}`);

  if (opts.dryRun) {
    console.log(JSON.stringify({ sources: sources.map(s => s.id), queries, filters, auth: { serpApiKey: !!auth.serpApiKey } }, null, 2));
    return;
  }

  // ── Refresh company stats from tracker before discovery (feeds ghost-score) ──
  try {
    const statsCount = mergeIntoIndex();
    log.info(`tracker-stats: merged ${statsCount} companies into index`);
  } catch (err) {
    log.warn(`tracker-stats failed (non-fatal): ${err.message}`);
  }

  // ── Phase 0: harvest unknown ATS slugs from Brave so the direct-ATS
  // plugins iterate them in the same run. This is what makes the seed list
  // vestigial — every role-less site:greenhouse.io / site:lever.co /
  // site:ashbyhq.com query surfaces companies the role-targeted queries miss
  // (they sit past Brave's top-20 ranking window). ──
  if (!opts.noHarvest) {
    try {
      const harvest = await harvestSlugs({
        apiKey: auth.braveApiKey,
        maxAgeDays: filters.maxAgeDays,
        logger: mkLogger('slug-harvest '),
      });
      log.info(`slug-harvest: +${harvest.harvested} new slugs across ${harvest.queriesRun} queries (index: ${harvest.indexSize})`);
    } catch (err) {
      log.warn(`slug-harvest failed (non-fatal): ${err.message}`);
    }
  }

  // ── Discover (parallel, rate-limited per source) ──
  log.info(`running ${sources.length} sources in parallel`);
  const results = await Promise.allSettled(sources.map(s => {
    const limiter = createLimiter(s.rateLimit || { rpm: 120 });
    const ctx = { queries, filters, auth, logger: mkLogger(`${s.id} `), limiter };
    return s.discover(ctx)
      .catch(err => { log.warn(`${s.id} threw: ${err.message}`); return []; });
  }));

  const raw = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (results[i].status === 'fulfilled') {
      const got = results[i].value || [];
      log.info(`${src.id} returned ${got.length}`);
      raw.push(...got);
      persist(got, `raw-${src.id}`);
    } else {
      log.warn(`${src.id} rejected: ${results[i].reason}`);
    }
  }
  log.info(`total raw: ${raw.length}`);

  // ── Dedup ──
  const deduped = dedup(raw);
  log.info(`after dedup: ${deduped.length}`);

  // ── Annotate cross-run reposts (feeds ghost-score repostSignal) ──
  try { updateReqHistory(deduped); } catch (err) { log.warn(`req-history failed (non-fatal): ${err.message}`); }

  // ── Update company index ──
  const totalKnown = updateCompanyIndex(deduped);
  log.info(`company index now has ${totalKnown} companies`);

  // ── Filter ──
  const { kept, rejected } = applyFilters(deduped, filters);
  log.info(`after filter: ${kept.length} (rejected: role=${rejected.role} recency=${rejected.recency} loc=${rejected.location} non-remote=${rejected.nonRemote} queue=${rejected.queue} negative=${rejected.negative})`);
  persist(deduped, 'merged');
  persist({ filters, rejected, kept: kept.length }, 'filter-report');

  // ── Ghost-score each posting (multi-signal; lib/ghost-score.js) ──
  // Build per-company history from the raw set so repost signal has context
  const byCompany = new Map();
  for (const p of deduped) {
    if (!byCompany.has(p.companySlug)) byCompany.set(p.companySlug, []);
    byCompany.get(p.companySlug).push(p);
  }
  const idx = loadCompanyIndexObj();
  for (const p of kept) {
    const history = (byCompany.get(p.companySlug) || []).filter(x => x.canonicalUrl !== p.canonicalUrl);
    const stats = idx[p.companySlug] || {};
    p.ghost = ghostScore(p, { history, companyStats: stats });
  }
  const shownKept = opts.showGhosts ? kept : kept.filter(p => p.ghost.label !== 'Suspicious');
  log.info(`ghost filter: ${kept.length - shownKept.length} Suspicious hidden (${opts.showGhosts ? 'shown via --show-ghosts' : 'use --show-ghosts to see'})`);

  // ── Quick rank + RRF fusion ──
  for (const p of shownKept) quickScore(p);
  // RRF-fused ordering (portfolio density + seniority + freshness + jd)
  const fused = fuseRanking(shownKept);
  shownKept.splice(0, shownKept.length, ...fused);

  // ── Enrich top-K ──
  if (opts.noEnrich) {
    // No JD to verify against, so apply the strict gate on listing-stage data:
    // only explicit 'remote' survives (matches the old pre-enrich behavior).
    const fast = finalizeRemoteAndRecency(shownKept, filters);
    persist(fast.kept, 'ranked');
    log.info(`skip enrich; ranked ${fast.kept.length} (strict remote/recency on listing data)`);
    return fast.kept;
  }
  // Enrich broadly; the title gate already kept the right candidates and the
  // remote gate is deliberately permissive pre-enrich (keeps 'unknown'), so
  // enrichment is what verifies remote/recency. 30-day cached + bounded
  // concurrency keeps the cost of enriching widely low.
  const maxEnrich = opts.maxEnrich || 300;
  const topK = shownKept.slice(0, maxEnrich);
  log.info(`enriching top ${topK.length} (concurrency 8)`);
  await mapLimit(topK, 8, p => enrich(p).catch(err => { log.warn(`enrich ${p.canonicalUrl} failed: ${err.message}`); return p; }));

  // ── Full rank. Every enriched posting that has any JD text — whether
  // from full enrichment or a fallback search-result snippet pre-attached
  // by brave/serpapi — gets a real matchScore. ──
  for (const p of topK) {
    if (p.jdText) fullScore(p);
  }

  // ── STRICT post-enrich gate: now that remote/us/postedDate reflect the real
  // JD, drop non-remote, non-US, and stale postings that slipped through the
  // permissive pre-enrich filter. ──
  const finalGate = finalizeRemoteAndRecency(topK, filters);
  log.info(`post-enrich gate: kept ${finalGate.kept.length} (dropped non-remote=${finalGate.rejected.nonRemote} stale=${finalGate.rejected.recency} non-us=${finalGate.rejected.location})`);
  const finalList = finalGate.kept;

  // Compute RRF fields (used as a tiebreak + diagnostic) then order by the
  // JD-aware matchScore so the displayed score and the list order agree.
  // Postings with no JD (matchScore null) sink to the bottom.
  fuseRanking(finalList);
  finalList.sort((a, b) =>
    ((b.matchScore ?? -1) - (a.matchScore ?? -1)) || ((b.rrfScore || 0) - (a.rrfScore || 0))
  );

  persist(shownKept, 'ranked-all');
  persist(finalList, 'ranked-enriched');

  // ── Discovery summary (consumed by modes/find.md to decide whether to
  // launch the WebSearch-agent fallback) ──
  const perSource = {};
  for (let i = 0; i < sources.length; i++) {
    if (results[i].status === 'fulfilled') perSource[sources[i].id] = (results[i].value || []).length;
  }
  const summary = {
    date: TODAY,
    perSource,
    totalRaw: raw.length,
    afterDedup: deduped.length,
    afterFilter: kept.length,
    enriched: topK.length,
    finalCount: finalList.length,
    postEnrichRejected: finalGate.rejected,
    rejected,
    needsAgentFallback: (perSource['brave-search'] || 0) < 100 || deduped.length < 300,
    fallbackReason: ((perSource['brave-search'] || 0) < 100)
      ? `brave-search returned ${perSource['brave-search'] || 0} < 100`
      : (deduped.length < 300 ? `merged set ${deduped.length} < 300` : null),
  };
  persist(summary, 'discovery-summary');

  log.info(`done. wrote ${OUT_DIR}`);
  if (summary.needsAgentFallback) log.info(`recall low (${summary.fallbackReason}); mode should launch jobe-job-discovery agent`);
  return finalList;
}

function loadCompanyIndexObj() {
  const p = path.join(ROOT, 'data/companies/index.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

// ── CLI ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { filters: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-enrich') opts.noEnrich = true;
    else if (a === '--source') opts.onlySource = args[++i];
    else if (a === '--max-enrich') opts.maxEnrich = parseInt(args[++i], 10);
    else if (a === '--max-age') opts.filters.maxAgeDays = parseInt(args[++i], 10);
    else if (a === '--no-us-only') opts.filters.usOnly = false;
    else if (a === '--allow-onsite') opts.filters.remoteOnly = false;
    else if (a === '--show-ghosts') opts.showGhosts = true;
    else if (a === '--no-harvest') opts.noHarvest = true;
    else if (a === '--senior-extension') opts.filters.seniorityExtensionDays = parseInt(args[++i], 10);
    else if (a === '--query') { opts.queries = opts.queries || []; opts.queries.push({ query: args[++i], location: opts.filters.__pendingLocation || 'Remote' }); }
    else if (a === '--location') {
      if (opts.queries && opts.queries.length) {
        opts.queries[opts.queries.length - 1].location = args[++i];
      } else {
        opts.filters.__pendingLocation = args[++i];
      }
    }
    else if (a === '--atomic') opts.atomic = true;
  }
  return opts;
}

if (require.main === module) {
  run(parseArgs()).catch(err => {
    console.error(err.stack || err);
    process.exit(1);
  });
}

module.exports = { run, loadSources };
