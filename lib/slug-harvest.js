/**
 * Slug enumeration via role-less Brave Search queries.
 *
 * Runs BEFORE the parallel source pipeline so that newly-discovered slugs
 * land in data/companies/index.json before the direct-ATS plugins
 * (greenhouse, lever, ashby, workable, recruitee, breezy, bamboohr, personio)
 * iterate the index. Each of those plugins re-reads index.json at
 * discover()-time, so the same run reaps the new slugs. workday,
 * smartrecruiters and icims hosts are harvested into the index too, but their
 * crawlers read only non-tech-seed.json (a Workday entry needs host, tenant
 * and site, which a harvested slug does not give).
 * ponytail: those three patterns spend search calls no crawler uses yet;
 * drop them from the harvest or teach the three crawlers to read the index.
 *
 * The role-less queries (e.g. `site:boards.greenhouse.io jobs`) hit a
 * different surface than the role-targeted queries in brave-search.js: they
 * harvest boards Brave indexed recently regardless of role match, which
 * surfaces employers the role queries miss because they fall past Brave's
 * top-20 ranking window.
 *
 * Reference: this is the "slug enumeration" phase that lets the seed list
 * become vestigial — once a slug is in index.json, every future run scans it
 * via the direct ATS API.
 */

const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./tracker-writer');
const { recencyDays, isoOf } = require('./profile');
const { getProjectRoot } = require('./config');

const HARVEST_DOMAINS = [
  { ats: 'greenhouse', sites: ['boards.greenhouse.io', 'job-boards.greenhouse.io'], slugRe: /greenhouse\.io\/([^/?#]+)\/jobs/i },
  { ats: 'lever',      sites: ['jobs.lever.co'],         slugRe: /jobs\.lever\.co\/([^/?#]+)/i },
  { ats: 'ashby',      sites: ['jobs.ashbyhq.com'],      slugRe: /jobs\.ashbyhq\.com\/([^/?#]+)/i },
  { ats: 'workday',    sites: ['myworkdayjobs.com'],     slugRe: /^https?:\/\/([^./]+)\.wd\d+\.myworkdayjobs\.com/i },
  { ats: 'smartrecruiters', sites: ['jobs.smartrecruiters.com'], slugRe: /jobs\.smartrecruiters\.com\/([^/?#]+)/i },
  { ats: 'icims',      sites: ['icims.com'],             slugRe: /^https?:\/\/(?:careers-)?([^./]+)\.icims\.com/i },
  { ats: 'workable',   sites: ['apply.workable.com'],    slugRe: /apply\.workable\.com\/([^/?#]+)/i },
  { ats: 'recruitee',  sites: ['recruitee.com'],         slugRe: /^https?:\/\/([a-z0-9-]+)\.recruitee\.com/i },
  { ats: 'breezy',     sites: ['breezy.hr'],             slugRe: /^https?:\/\/([a-z0-9-]+)\.breezy\.hr/i },
  { ats: 'bamboohr',   sites: ['bamboohr.com'],          slugRe: /^https?:\/\/([a-z0-9-]+)\.bamboohr\.com/i },
  { ats: 'personio',   sites: ['jobs.personio.com'],     slugRe: /^https?:\/\/([a-z0-9-]+)\.jobs\.personio\.com/i },
];

// Host labels and path segments that sit where a tenant slug would but are the
// vendor's own pages (www.bamboohr.com, apply.workable.com/j/<code>).
const NOT_A_TENANT = new Set(['www', 'app', 'api', 'help', 'support', 'blog', 'careers', 'jobs', 'apply', 'j']);

// Which ATS (and which tenant slug) a posting URL belongs to, or null. Shared
// with lib/agent-import.js so every index writer recognizes the same hosts.
function atsFromUrl(url) {
  for (const dom of HARVEST_DOMAINS) {
    const m = String(url || '').match(dom.slugRe);
    if (!m || !m[1]) continue;
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch { /* keep the raw segment */ }
    if (slug.length < 2 || slug.length > 100 || NOT_A_TENANT.has(slug.toLowerCase())) return null;
    return { ats: dom.ats, slug };
  }
  return null;
}

const SLEEP_MS = 1100; // Brave free tier: 1 qps

function dateCutoff(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function braveFetch(query, apiKey, freshness = 'pm', country = null) {
  const qs = new URLSearchParams({
    q: query,
    count: 20,
    search_lang: 'en',
    text_decorations: 'false',
    safesearch: 'off',
  });
  if (freshness) qs.set('freshness', freshness); // null: no recency cut
  if (country) qs.set('country', country);
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

// The search market follows the user's country policy: exactly one country in
// discovery.countries, written as a code, a name, or an alias ("UK" resolves
// to gb), is passed to the search API; no policy or several countries leave
// the market unset.
// ponytail: the search API accepts a fixed list of markets and rejects the
// rest; a rejected query is logged and skipped. Upgrade path: validate against
// that list here.
function searchCountry(countries) {
  const list = Array.isArray(countries) ? countries : [];
  const codes = [...new Set(list.map(isoOf).filter(Boolean).map(c => c.toLowerCase()))];
  return codes.length === 1 ? codes[0] : null;
}

async function harvestSlugs({ apiKey, maxAgeDays = 30, logger = console, roleTails, country } = {}) {
  if (!apiKey) {
    logger.info('[slug-harvest] skipped: no BRAVE_API_KEY');
    return { harvested: 0, byAts: {}, queriesRun: 0 };
  }

  // Query tails come from the user's seed roles so slug enumeration follows
  // their field; fall back to a generic tail when unconfigured. Recency is
  // handled by Brave's `freshness` range, not a Google `after:` operator.
  const tails = (Array.isArray(roleTails) && roleTails.length) ? roleTails.slice(0, 3) : ['jobs'];
  if (country === undefined) {
    const { loadProfile, discoveryFilters } = require('./profile');
    country = searchCountry(discoveryFilters(loadProfile()).countries);
  }

  const { idx, p: idxPath } = loadIndex();
  const before = Object.keys(idx).length;
  const today = new Date().toISOString().slice(0, 10);
  const days = recencyDays({ maxAgeDays });
  const freshness = days ? `${dateCutoff(days)}to${today}` : null;
  const ts = new Date().toISOString();
  const byAts = {};
  let queriesRun = 0;

  for (const dom of HARVEST_DOMAINS) {
    let added = 0;
    for (const site of dom.sites) {
      for (const tail of tails) {
        const query = `site:${site} ${tail}`;
        queriesRun++;
        try {
          const data = await braveFetch(query, apiKey, freshness, country);
          const results = data.web?.results || [];
          for (const r of results) {
            const hit = atsFromUrl(r.url);
            if (!hit || hit.ats !== dom.ats) continue;
            const slug = hit.slug;
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

module.exports = { harvestSlugs, atsFromUrl, searchCountry, HARVEST_DOMAINS };
