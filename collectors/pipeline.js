#!/usr/bin/env node
/**
 * Unified discovery pipeline.
 *
 *   discover (parallel sources)
 *     -> normalize (Posting schema)
 *     -> dedup (URL exact + fuzzy)
 *     -> update company index
 *     -> filter (role and title policy, excluded companies, queue, history,
 *                country, work mode, recency)
 *     -> ghost-score, quick-rank (URL/title heuristic)
 *     -> enrich top-K (JD fetch + cache)
 *     -> full-rank (JD-aware scoring)
 *     -> strict gate on JD verified data (country, work mode, recency, pay floor)
 *     -> persist
 *
 * What gets filtered is the USER's policy, read from data/profile.json through
 * lib/profile.js. With no policy nothing is dropped by work mode, country, or
 * pay, and the recency window is the shipped default. Precedence: command line
 * flag, then profile.json, then the permissive default.
 *
 * Usage:
 *   node collectors/pipeline.js                # full run with the user's policy
 *   node collectors/pipeline.js --dry-run      # print sources, queries, filters; no network
 *   node collectors/pipeline.js --source X     # run one source
 *   node collectors/pipeline.js --no-enrich    # skip JD fetch, show discovery only
 *   node collectors/pipeline.js --max-enrich N # cap enrichment to N postings (default 300)
 *   node collectors/pipeline.js --max-age N    # recency window in days (0 turns it off, here and in every source)
 *   node collectors/pipeline.js --senior-extension N  # extra days for senior titles
 *   node collectors/pipeline.js --remote-only | --allow-onsite   # force / lift the work mode filter
 *   node collectors/pipeline.js --us-only | --no-us-only         # force / lift the country filter
 *   node collectors/pipeline.js --include-applied  # keep reqs already applied to or skipped
 *   node collectors/pipeline.js --show-ghosts      # keep postings flagged Suspicious
 *   node collectors/pipeline.js --no-harvest       # skip the slug harvest phase
 *   node collectors/pipeline.js --query "<role>" [--location "<place>"]   # ad hoc query, repeatable
 *   node collectors/pipeline.js --help         # print this usage and exit
 *
 * A flag this script does not know stops the run with this usage and a non
 * zero exit, so a typo never starts a network run. Mode level flags (for
 * example the find mode's --linkedin) belong to the mode, not to this script.
 */

const fs = require('fs');
const path = require('path');

const { loadEnv, getProjectRoot } = require('../lib/config');
const { dedup, place } = require('../lib/dedup');
const { dedupKey } = require('../lib/posting');
const { buildProfile, quickScore, fullScore, fuseRanking, isRoleMatch } = require('../lib/rank');
const { roleStrings } = require('../lib/role-queries');
const { enrich, extractCompFromText } = require('../lib/enrich');
const { ghostScore } = require('../lib/ghost-score');
const { mergeIntoIndex } = require('../lib/tracker-stats');
const { atomicWrite } = require('../lib/tracker-writer');
const { createLimiter } = require('../lib/rate-limiter');
const { harvestSlugs, searchCountry, atsFromUrl } = require('../lib/slug-harvest');
const { historyState } = require('../scripts/prune-queue');
const {
  loadProfile, discoveryFilters, countryOk, regionOk, acceptedModes, modePass, recencyDays, seniorTitle, DEFAULTS,
} = require('../lib/profile');
const { loadExclusions } = require('../lib/exclusions');

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
  // Source plugins are CODE (system layer) — resolve against this file's own
  // dir, never the active workspace (ROOT = getUserRoot()).
  const base = path.join(__dirname, 'sources');
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
    // No seeds yet. Discovery is driven by the user's target roles, which
    // `/jobe onboard` writes here. With none, return [] (sources that need
    // query terms contribute nothing) rather than assuming any field.
    return [];
  }
  try {
    const queries = JSON.parse(fs.readFileSync(p, 'utf8')).queries;
    return Array.isArray(queries) ? queries : [];
  } catch (err) {
    console.error(`[pipeline] ${p} is unreadable (${err.message}); running with no seed roles`);
    return [];
  }
}

// ── Company index update (emergent) ─────────────────────────

function updateCompanyIndex(postings) {
  const p = path.join(ROOT, 'data', 'companies', 'index.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};

  for (const post of postings) {
    // Which ATS hosts this posting, and under which tenant slug. The host table
    // is shared with the slug harvest (lib/slug-harvest.js), so every index
    // writer recognizes the same boards and the matching direct-ATS plugin
    // scans that tenant on the next run. This is what feeds the plugins that
    // ship with no tenant list of their own.
    const hit = atsFromUrl(post.canonicalUrl);
    const ats = hit ? hit.ats : null;
    const slug = hit ? hit.slug : post.companySlug;
    if (!slug) continue;

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
  const s = new Set();
  let q;
  try { q = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return s; } // file optional
  for (const e of Array.isArray(q) ? q : []) {
    if (!e) continue;
    if (e.primaryUrl) s.add(e.primaryUrl);
    for (const u of e.alternativeUrls || []) s.add(u);
  }
  return s;
}

// Cross-run history: dedupKey (company-slug + role-normalized) for every req
// already APPLIED to or SKIPPED. Keying on dedupKey — not URL — is what catches
// the same job re-discovered from a different source (LinkedIn vs Greenhouse vs
// a job board), which the URL-only queue filter misses.
function loadHistoryKeys() {
  const p = path.join(ROOT, 'data', 'apply-queue.json');
  if (!fs.existsSync(p)) return new Map();
  let q;
  try { q = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return new Map(); }
  const m = new Map();
  for (const e of Array.isArray(q) ? q : []) {
    if (!e || !e.company || !e.role) continue;
    // A req counts as applied/skipped once its report folder has been relocated
    // (moveReportFolder rewrites resumeDocx to reports/applied|skipped/{slug}),
    // or an explicit applied flag / tracker status says so.
    // Same test the queue prune uses, so the two cannot drift (it also sees a
    // bare skipped flag and a status in any letter case).
    const state = historyState(e);
    if (!state) continue;
    const k = dedupKey({ company: e.company, title: e.role });
    // The row's city, when the queue row carries a location, lets a policy
    // that accepts onsite or hybrid work tell two cities apart. Rows with no
    // location match the req in every city.
    if (!m.has(k)) m.set(k, []);
    m.get(k).push({ state, place: e.location ? place({ location: e.location }) : null });
  }
  return m;
}

// ── The user's policy, applied the same way at both stages ──

// Seniority-aware recency: senior IC vacancies stay open longer (Review of
// Accounting Studies 2023, high-skill jobs have longer vacancy durations), so
// a user may grant them extra days (discovery.seniorityExtensionDays, 0 unless
// set). A posting with no date is kept. A window of 0 turns the cut off
// (lib/profile.js recencyDays, the one reading every source shares).
function isStale(p, filters) {
  const baseDays = recencyDays(filters);
  if (!p.postedDate || !baseDays) return false;
  const days = baseDays + (seniorTitle(p.title) ? (filters.seniorityExtensionDays ?? 0) : 0);
  return new Date(p.postedDate) < new Date(Date.now() - days * 86400_000);
}

// The countries the user accepts ([] = all). usOnly is the short form of
// exactly ["US"]; a caller that switches usOnly off lifts that list.
function acceptedCountries(filters) {
  const list = filters.countries || [];
  if (filters.usOnly) return list.length ? list : ['US'];
  return list.length === 1 && list[0] === 'US' ? [] : list;
}

// Country policy. Exactly ["US"] uses the US classifier verdict already on the
// posting; any other list is matched against the location text (lib/profile.js
// countryOk): a posting is dropped only when its location positively names a
// country outside the list. A city alone, or a location that names no place,
// is unknown and kept. No list keeps everything.
function countryPass(p, filters) {
  return filters.usOnly ? p.us !== false : countryOk(p.location, acceptedCountries(filters), p.title);
}

// Work mode: acceptedModes / modePass live in lib/profile.js so the agent
// import applies the same gate.

// Region policy (discovery.regions) for work that needs the candidate on
// site: a hybrid or onsite posting must name one of the user's regions. A
// remote posting is never touched, and a location that names no place is kept.
// At the strict stage a posting that still states no mode counts as onsite,
// the same reading modePass uses.
function regionPass(p, filters, strict) {
  const onSite = p.remote === 'hybrid' || p.remote === 'onsite' || (strict && p.remote !== 'remote');
  return !onSite || regionOk(p.location, filters.regions);
}

// The top of a posting's PUBLISHED yearly pay band in `currency`, or null when
// nothing usable is published: no band, another or an unstated currency, a
// band with a pay period other than a year, or free text that does not parse.
// A bare "$" names no currency; it is read as USD only for a posting placed in
// the US, and as unknown everywhere else.
// ponytail: a band under 1000 is read as an hourly or monthly figure, a band
// with a stated non yearly period is not annualized, and free text is parsed
// by lib/enrich.js extractCompFromText (see its ceiling). All err toward
// "unknown", which is kept. Upgrade path: a pay period and currency field on
// Posting.compensation, filled by the sources.
function publishedMax(p, currency = 'USD') {
  let c = p.compensation;
  if (typeof c === 'string') c = extractCompFromText(c);
  if (!c || typeof c !== 'object') return null;
  if (c.period && !/^(year|yr|annual|annum)/i.test(String(c.period))) return null;
  const stated = c.currency ? String(c.currency).toUpperCase() : (p.us === true ? 'USD' : null);
  if (stated !== currency) return null;
  const max = Number(c.max ?? c.min);
  return Number.isFinite(max) && max >= 1000 ? max : null;
}

function applyFilters(postings, filters, profile) {
  const queueUrls = loadQueueUrls();
  // The user's negative list, plus the shared staffing list unless the user
  // turned that off (discovery.excludeStaffing). Same loader as the manual
  // ingest and the agent import, so every path drops the same employers:
  // brokers run their own ATS boards and surface through the direct and
  // aggregator sources like any employer.
  const excluded = loadExclusions({ root: ROOT, excludeStaffing: filters.excludeStaffing }).all;
  const historyKeys = filters.historyFilter === false ? new Map() : loadHistoryKeys();
  const out = [];
  const rejected = { recency: 0, location: 0, role: 0, queue: 0, history: 0, negative: 0, nonRemote: 0 };

  for (const p of postings) {
    // Role: the user's title policy (discovery.titleExclude / titleKeep), then
    // the posting title against the user's target-role tokens. Permissive
    // (keeps everything) when the user has neither.
    if (!isRoleMatch(p.title, profile)) { rejected.role++; continue; }
    // Excluded companies
    if (excluded.has(p.companySlug)) { rejected.negative++; continue; }
    // Queue (URL-exact: same posting already tracked)
    const urls = [p.canonicalUrl, ...(p.alternateUrls || [])];
    if (urls.some(u => queueUrls.has(u))) { rejected.queue++; continue; }
    // History (dedupKey: this req was already applied to or skipped, possibly
    // via a different source URL) — override with --include-applied.
    // Under a remote only policy the req is one job wherever it is listed;
    // otherwise a row that recorded its city hides only that city.
    const past = p.dedupKey && historyKeys.get(p.dedupKey);
    if (past && past.some(h => filters.remoteOnly || h.place == null || h.place === place(p))) { rejected.history++; continue; }
    // Country
    if (!countryPass(p, filters)) { rejected.location++; continue; }
    // Work mode, PRE-ENRICH stage (permissive). The STRICT pass runs in
    // finalizeRemoteAndRecency() once enrichment has JD-derived signals.
    if (!modePass(p, filters, false)) { rejected.nonRemote++; continue; }
    // Region (hybrid and onsite postings only)
    if (!regionPass(p, filters, false)) { rejected.location++; continue; }
    // Recency (keep if date unknown)
    if (isStale(p, filters)) { rejected.recency++; continue; }
    out.push(p);
  }
  return { kept: out, rejected };
}

// Strict post-enrichment gate. Runs AFTER enrich() has fetched JD text and
// re-derived posting.remote / .us / .postedDate / .compensation, so country,
// work mode, recency, and pay are decided on verified data rather than the
// thin listing-stage strings. `rejected.nonRemote` counts every work mode
// rejection (the name is kept for the readers of discovery-summary.json).
function finalizeRemoteAndRecency(postings, filters) {
  const floor = filters.salaryFloor > 0 ? filters.salaryFloor : null;
  const out = [];
  const rejected = { nonRemote: 0, recency: 0, location: 0, salary: 0 };
  for (const p of postings) {
    if (!countryPass(p, filters)) { rejected.location++; continue; }
    if (!modePass(p, filters, true)) { rejected.nonRemote++; continue; }
    if (!regionPass(p, filters, true)) { rejected.location++; continue; }
    if (isStale(p, filters)) { rejected.recency++; continue; }
    // Pay floor: only a PUBLISHED yearly band in the user's currency that tops
    // out below the floor drops a posting. Unknown pay (no band, another or an
    // unstated currency, another pay period) is kept and labeled.
    const max = publishedMax(p, filters.salaryCurrency || DEFAULTS.discovery.salaryCurrency);
    if (floor && max != null && max < floor) { rejected.salary++; continue; }
    p.salaryCheck = max == null ? 'unknown' : 'published';
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
  // The user's discovery policy (data/profile.json), then command line flags.
  // No policy: no work mode filter, no country filter, no pay floor.
  const user = loadProfile({ root: ROOT });
  const filters = {
    ...discoveryFilters(user),
    companySites: user.discovery.companySites,
    ...opts.filters,
  };
  // One consistent view for the gates and for the sources, which read the
  // lists: a short form switched off by a caller lifts its list too.
  filters.workModes = acceptedModes(filters);
  filters.countries = acceptedCountries(filters);

  const auth = {
    serpApiKey: process.env.SERPAPI_KEY || null,
    braveApiKey: process.env.BRAVE_API_KEY || null,
  };

  const queries = opts.queries || loadSeedQueries();
  const profile = buildProfile({ queries, root: ROOT });
  if (!profile.configured) {
    log.warn('no target roles configured (data/queries/seeds.json is empty) — run `/jobe onboard`. Discovery will be permissive and thin.');
  }

  const sources = loadSources(opts.onlySource);
  log.info(`sources loaded: ${sources.map(s => s.id).join(', ')}`);

  if (opts.dryRun) {
    // Sources, the queries derived from the user's seeds, and the merged
    // filters. Nothing is fetched and nothing is written.
    console.log(JSON.stringify({
      sources: sources.map(s => s.id),
      queries,
      filters,
      auth: { serpApiKey: !!auth.serpApiKey, braveApiKey: !!auth.braveApiKey },
    }, null, 2));
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
        roleTails: roleStrings({ queries }, { max: 3, quoted: true }),
        country: searchCountry(filters.countries),
        logger: mkLogger('slug-harvest '),
      });
      log.info(`slug-harvest: +${harvest.harvested} new slugs across ${harvest.queriesRun} queries (index: ${harvest.indexSize})`);
    } catch (err) {
      log.warn(`slug-harvest failed (non-fatal): ${err.message}`);
    }
  }

  // ── Discover (parallel, rate-limited per source) ──
  log.info(`running ${sources.length} sources in parallel`);
  const sourceStatus = Object.fromEntries(sources.map((source) => [source.id, { status: 'ok' }]));
  const results = await Promise.allSettled(sources.map(s => {
    const limiter = createLimiter(s.rateLimit || { rpm: 120 });
    const ctx = {
      queries,
      filters,
      auth,
      logger: mkLogger(`${s.id} `),
      limiter,
      reportSourceStatus: (status, reason = null) => {
        sourceStatus[s.id] = { status, ...(reason ? { reason } : {}) };
      },
    };
    return s.discover(ctx)
      .catch(err => {
        sourceStatus[s.id] = { status: 'failed', reason: 'source_exception' };
        log.warn(`${s.id} threw: ${err.message}`);
        return [];
      });
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

  // ── Dedup ── (the city is part of the merge unless the policy is remote
  // only: one employer hiring the same title in two cities is two jobs to
  // anyone who has to be there)
  const deduped = dedup(raw, { byLocation: !filters.remoteOnly });
  log.info(`after dedup: ${deduped.length}`);

  // ── Annotate cross-run reposts (feeds ghost-score repostSignal) ──
  try { updateReqHistory(deduped); } catch (err) { log.warn(`req-history failed (non-fatal): ${err.message}`); }

  // ── Update company index ──
  const totalKnown = updateCompanyIndex(deduped);
  log.info(`company index now has ${totalKnown} companies`);

  // ── Filter ──
  const { kept, rejected } = applyFilters(deduped, filters, profile);
  log.info(`after filter: ${kept.length} (rejected: role=${rejected.role} recency=${rejected.recency} loc=${rejected.location} work-mode=${rejected.nonRemote} queue=${rejected.queue} applied/skipped=${rejected.history} excluded-company=${rejected.negative})`);
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
    p.ghost = ghostScore(p, { history, companyStats: stats, seniorityExtensionDays: filters.seniorityExtensionDays, maxAgeDays: filters.maxAgeDays });
  }
  const shownKept = opts.showGhosts ? kept : kept.filter(p => p.ghost.label !== 'Suspicious');
  log.info(`ghost filter: ${kept.length - shownKept.length} Suspicious hidden (${opts.showGhosts ? 'shown via --show-ghosts' : 'use --show-ghosts to see'})`);

  // ── Quick rank + RRF fusion ──
  for (const p of shownKept) quickScore(p, { profile });
  // RRF-fused ordering (profile-keyword overlap + seniority + freshness)
  const fused = fuseRanking(shownKept, { profile });
  shownKept.splice(0, shownKept.length, ...fused);

  // ── Enrich top-K ──
  if (opts.noEnrich) {
    // No JD to verify against, so the strict gate runs on listing-stage data
    // (under a remote policy only a listing that says remote survives).
    const fast = finalizeRemoteAndRecency(shownKept, filters);
    persist(fast.kept, 'ranked');
    log.info(`skip enrich; ranked ${fast.kept.length} (strict work mode/recency/pay gate on listing data)`);
    return fast.kept;
  }
  // Enrich broadly; the title gate already kept the right candidates and the
  // work mode gate is deliberately permissive pre-enrich (keeps 'unknown'), so
  // enrichment is what verifies work mode/recency. 30-day cached + bounded
  // concurrency keeps the cost of enriching widely low.
  const maxEnrich = opts.maxEnrich || 300;
  const topK = shownKept.slice(0, maxEnrich);
  log.info(`enriching top ${topK.length} (concurrency 8)`);
  await mapLimit(topK, 8, p => enrich(p).catch(err => { log.warn(`enrich ${p.canonicalUrl} failed: ${err.message}`); return p; }));

  // ── Full rank. Every enriched posting that has any JD text — whether
  // from full enrichment or a fallback search-result snippet pre-attached
  // by brave/serpapi — gets a real matchScore. ──
  for (const p of topK) {
    if (p.jdText) fullScore(p, { profile });
  }

  // ── STRICT post-enrich gate: now that remote/us/postedDate/compensation
  // reflect the real JD, drop postings outside the user's work modes or
  // countries, stale postings, and postings whose published pay band tops out
  // below the user's floor, that slipped through the permissive pre-enrich
  // filter. ──
  const finalGate = finalizeRemoteAndRecency(topK, filters);
  log.info(`post-enrich gate: kept ${finalGate.kept.length} (dropped work-mode=${finalGate.rejected.nonRemote} stale=${finalGate.rejected.recency} country=${finalGate.rejected.location} below-pay-floor=${finalGate.rejected.salary})`);
  const finalList = finalGate.kept;

  // Compute RRF fields (used as a tiebreak + diagnostic) then order by the
  // JD-aware matchScore so the displayed score and the list order agree.
  // Postings with no JD (matchScore null) sink to the bottom.
  fuseRanking(finalList, { profile });
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
    sourceStatus,
    totalRaw: raw.length,
    afterDedup: deduped.length,
    afterFilter: kept.length,
    enriched: topK.length,
    finalCount: finalList.length,
    postEnrichRejected: finalGate.rejected,
    rejected,
    // Rows the presentation step must label rather than hide.
    payUnknown: finalList.filter(p => p.salaryCheck === 'unknown').length,
    withUnmetMinimums: finalList.filter(p => (p.minimumsUnmet || []).length > 0).length,
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

function usage() {
  const src = fs.readFileSync(__filename, 'utf8');
  return src.slice(src.indexOf(' * Usage:'), src.indexOf(' */')).replace(/^ \* ?/gm, '');
}

// Returns the run options. `opts.help` is set for --help / -h, and
// `opts.unknown` lists every flag this script does not know; the command line
// entry prints the usage for either and does not start a run.
function parseArgs(args = process.argv.slice(2)) {
  const opts = { filters: {} };
  let pendingLocation = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-enrich') opts.noEnrich = true;
    else if (a === '--source') opts.onlySource = args[++i];
    else if (a === '--max-enrich') opts.maxEnrich = parseInt(args[++i], 10);
    else if (a === '--max-age') opts.filters.maxAgeDays = parseInt(args[++i], 10);
    else if (a === '--include-applied') opts.filters.historyFilter = false;
    // Country and work mode flags set the short form and the list together so
    // every reader of the filter object (pipeline gates and sources) agrees.
    else if (a === '--no-us-only') Object.assign(opts.filters, { usOnly: false, countries: [] });
    else if (a === '--us-only') Object.assign(opts.filters, { usOnly: true, countries: ['US'] });
    else if (a === '--allow-onsite') Object.assign(opts.filters, { remoteOnly: false, workModes: [] });
    else if (a === '--remote-only') Object.assign(opts.filters, { remoteOnly: true, workModes: ['remote'] });
    else if (a === '--show-ghosts') opts.showGhosts = true;
    else if (a === '--no-harvest') opts.noHarvest = true;
    else if (a === '--senior-extension') opts.filters.seniorityExtensionDays = parseInt(args[++i], 10);
    // --query replaces the seed queries for this run. --location applies to
    // the query before it, or to every later query when given first.
    else if (a === '--query') { opts.queries = opts.queries || []; opts.queries.push({ query: args[++i], location: pendingLocation }); }
    else if (a === '--location') {
      if (opts.queries && opts.queries.length) {
        opts.queries[opts.queries.length - 1].location = args[++i];
      } else {
        pendingLocation = args[++i];
      }
    }
    else if (a === '--atomic') opts.atomic = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else (opts.unknown = opts.unknown || []).push(a);
  }
  return opts;
}

if (require.main === module) {
  const cli = parseArgs();
  if (cli.help) { console.log(usage()); process.exit(0); }
  if (cli.unknown) {
    console.error(`unknown argument: ${cli.unknown.join(' ')}\n\n${usage()}`);
    process.exit(2);
  }
  run(cli).catch(err => {
    console.error(err.stack || err);
    process.exit(1);
  });
}

module.exports = {
  run, loadSources, loadSeedQueries, parseArgs,
  applyFilters, finalizeRemoteAndRecency, publishedMax, updateCompanyIndex, usage,
};
