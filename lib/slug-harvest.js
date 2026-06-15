/**
 * Slug enumeration via role-less Brave Search queries.
 *
 * Runs BEFORE the parallel source pipeline so that newly-discovered slugs
 * land in data/companies/index.json before the direct-ATS plugins
 * (greenhouse, lever, ashby, workday, smartrecruiters, icims) iterate the
 * index. Each direct-ATS plugin re-reads index.json at discover()-time, so
 * the same run reaps the new slugs.
 *
 * The role-less queries (e.g. `site:boards.greenhouse.io after:DATE`) hit a
 * different surface than the role-targeted queries in brave-search.js: they
 * harvest boards Brave indexed recently regardless of role match, which
 * surfaces companies like Mozilla / Optum / NerdWallet that the role queries
 * miss because they fall past Brave's top-20 ranking window.
 *
 * Reference: this is the "slug enumeration" phase that lets the seed list
 * become vestigial — once a slug is in index.json, every future run scans it
 * via the direct ATS API.
 */

const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./tracker-writer');
const { getProjectRoot } = require('./config');

const HARVEST_DOMAINS = [
  { ats: 'greenhouse', sites: ['boards.greenhouse.io', 'job-boards.greenhouse.io'], slugRe: /greenhouse\.io\/([^/?#]+)\/jobs/i },
  { ats: 'lever',      sites: ['jobs.lever.co'],         slugRe: /jobs\.lever\.co\/([^/?#]+)/i },
  { ats: 'ashby',      sites: ['jobs.ashbyhq.com'],      slugRe: /jobs\.ashbyhq\.com\/([^/?#]+)/i },
  { ats: 'workday',    sites: ['myworkdayjobs.com'],     slugRe: /^https?:\/\/([^./]+)\.wd\d+\.myworkdayjobs\.com/i },
  { ats: 'smartrecruiters', sites: ['jobs.smartrecruiters.com'], slugRe: /jobs\.smartrecruiters\.com\/([^/?#]+)/i },
  { ats: 'icims',      sites: ['icims.com'],             slugRe: /^https?:\/\/(?:careers-)?([^./]+)\.icims\.com/i },
];

// Three diverse query tails per site to surface different rank orderings.
// Recency is handled by Brave's `freshness` range, NOT a Google `after:`
// operator (Brave treats `after:DATE` as a literal keyword and returns ~0).
const QUERY_TAILS = [
  '"machine learning"',
  '"data scientist" remote',
  '"senior" remote',
];

const SLEEP_MS = 1100; // Brave free tier: 1 qps

function dateCutoff(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function braveFetch(query, apiKey, freshness = 'pm') {
  const qs = new URLSearchParams({
    q: query,
    count: 20,
    country: 'us',
    search_lang: 'en',
    freshness,
    text_decorations: 'false',
    safesearch: 'off',
  });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${qs}`, {
    headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json', 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

function loadIndex() {
  const p = path.join(getProjectRoot(), 'data/companies/index.json');
  if (!fs.existsSync(p)) return { idx: {}, p };
  try { return { idx: JSON.parse(fs.readFileSync(p, 'utf8')), p }; }
  catch { return { idx: {}, p }; }
}

function persistIndex(p, idx) {
  const sorted = Object.keys(idx).sort().reduce((a, k) => (a[k] = idx[k], a), {});
  atomicWrite(p, JSON.stringify(sorted, null, 2));
}

async function harvestSlugs({ apiKey, maxAgeDays = 30, logger = console } = {}) {
  if (!apiKey) {
    logger.info('[slug-harvest] skipped: no BRAVE_API_KEY');
    return { harvested: 0, byAts: {}, queriesRun: 0 };
  }

  const { idx, p: idxPath } = loadIndex();
  const before = Object.keys(idx).length;
  const today = new Date().toISOString().slice(0, 10);
  const freshness = maxAgeDays ? `${dateCutoff(maxAgeDays)}to${today}` : 'pm';
  const ts = new Date().toISOString();
  const byAts = {};
  let queriesRun = 0;

  for (const dom of HARVEST_DOMAINS) {
    let added = 0;
    for (const site of dom.sites) {
      for (const tail of QUERY_TAILS) {
        const query = `site:${site} ${tail}`;
        queriesRun++;
        try {
          const data = await braveFetch(query, apiKey, freshness);
          const results = data.web?.results || [];
          for (const r of results) {
            const m = (r.url || '').match(dom.slugRe);
            if (!m || !m[1]) continue;
            const slug = decodeURIComponent(m[1]);
            if (slug.length < 2 || slug.length > 100) continue;
            if (idx[slug] && idx[slug].ats === dom.ats) continue; // already known under this ATS
            const entry = idx[slug] || {};
            const wasNew = !entry.ats;
            idx[slug] = {
              name: entry.name || slug,
              ats: dom.ats,
              lastSeen: ts,
              sources: [...new Set([...(entry.sources || []), 'slug-harvest'])],
              urls: [...new Set([...(entry.urls || []), r.url])].slice(-20),
              postingCountByRun: entry.postingCountByRun || {},
              hiresPerPosting: entry.hiresPerPosting ?? null,
              recentLayoff: entry.recentLayoff ?? null,
              seededFrom: entry.seededFrom || 'slug-harvest',
            };
            if (wasNew) added++;
          }
        } catch (err) {
          logger.warn(`[slug-harvest] ${query.slice(0, 80)} failed: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, SLEEP_MS));
      }
    }
    byAts[dom.ats] = added;
    logger.info(`[slug-harvest] ${dom.ats}: +${added} new slugs`);
  }

  persistIndex(idxPath, idx);
  const after = Object.keys(idx).length;
  return { harvested: after - before, byAts, queriesRun, indexSize: after };
}

module.exports = { harvestSlugs };
