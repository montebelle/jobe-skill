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
 *   node collectors/pipeline.js --max-enrich N # cap enrichment to N postings (default 60)
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
  const rejected = { recency: 0, location: 0, role: 0, queue: 0, negative: 0 };

  for (const p of postings) {
    // Role
    if (!isRoleMatch(p.title)) { rejected.role++; continue; }
    // Negative list
    if (negative.has(p.companySlug)) { rejected.negative++; continue; }
    // Queue
    const urls = [p.canonicalUrl, ...p.alternateUrls];
    if (urls.some(u => queueUrls.has(u))) { rejected.queue++; continue; }
    // Location
    if (filters.usOnly && p.us === false) { rejected.location++; continue; }
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
    maxAgeDays: 30,
    ...opts.filters,
  };

  const auth = {
    serpApiKey: process.env.SERPAPI_KEY || null,
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

  // ── Update company index ──
  const totalKnown = updateCompanyIndex(deduped);
  log.info(`company index now has ${totalKnown} companies`);

  // ── Filter ──
  const { kept, rejected } = applyFilters(deduped, filters);
  log.info(`after filter: ${kept.length} (rejected: role=${rejected.role} recency=${rejected.recency} loc=${rejected.location} queue=${rejected.queue} negative=${rejected.negative})`);
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
    persist(shownKept, 'ranked');
    log.info(`skip enrich; ranked ${shownKept.length}`);
    return shownKept;
  }
  const maxEnrich = opts.maxEnrich || 60;
  const topK = shownKept.slice(0, maxEnrich);
  log.info(`enriching top ${topK.length}`);
  await Promise.all(topK.map(p => enrich(p).catch(err => { log.warn(`enrich ${p.canonicalUrl} failed: ${err.message}`); return p; })));

  // ── Full rank (refresh RRF with jd text present) ──
  for (const p of topK) {
    if (p.jdText) fullScore(p);
  }
  const refused = fuseRanking(topK);
  topK.splice(0, topK.length, ...refused);

  persist(shownKept, 'ranked-all');
  persist(topK, 'ranked-enriched');

  log.info(`done. wrote ${OUT_DIR}`);
  return topK;
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
    else if (a === '--show-ghosts') opts.showGhosts = true;
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
