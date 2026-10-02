/**
 * Source: Adzuna Jobs API (aggregator incl. board-syndicated listings).
 *
 * Free developer key: https://developer.adzuna.com (app_id + app_key).
 * Endpoint: GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}
 *   ?app_id=..&app_key=..&what=<role>&max_days_old=<n>&results_per_page=50
 * {country} is a two letter market code taken from the user's country policy.
 * `where` is "remote" under a remote only policy, the seed row's place under
 * a policy that accepts no remote work, and unset otherwise.
 *
 * Why: Adzuna indexes listings syndicated across boards (incl. some that
 * never hit ATS-direct sources), with clean JSON + `created` dates that
 * feed the recency gate honestly. Env-gated: missing keys -> [] and the
 * pipeline continues (source plugin contract).
 *
 * Response: { results: [{ title, company: { display_name },
 *   location: { display_name, area[] }, redirect_url, created,
 *   description, salary_min, salary_max, salary_is_predicted }] }
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings, seedPlaces } = require('../../../lib/role-queries');
const { recencyDays, isoOf, acceptedModes } = require('../../../lib/profile');

const ID = 'adzuna';

const MAX_ROLES = 4; // roles come from the user's seeds

// Salaries are in the market's own currency; only the US market is dollars.
// A predicted salary is Adzuna's estimate, not a published band: left out.
function comp(r, country) {
  if (String(r.salary_is_predicted) === '1') return null;
  const lo = r.salary_min ? Math.round(r.salary_min) : null;
  const hi = r.salary_max ? Math.round(r.salary_max) : null;
  const cur = country === 'us' ? '$' : '';
  if (lo && hi) return `${cur}${lo} - ${cur}${hi}`;
  if (lo) return `${cur}${lo}+`;
  return null;
}

// ponytail: the API path needs exactly one market. The first country in the
// user's list (a code, a name, or an alias: "UK" is gb) picks it; with none
// on file the source skips. Upgrade path: one request per listed country.
function market(filters) {
  const code = (filters.countries || []).map(isoOf).find(Boolean);
  return code ? code.toLowerCase() : null;
}

async function fetchPage(what, page, maxAgeDays, appId, appKey, remoteOnly, country, place) {
  const qs = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    what,
    results_per_page: '50',
    'content-type': 'application/json',
  });
  // "remote" as a where-term biases Adzuna toward remote listings; the
  // strict remote gate still runs downstream on JD-verified data.
  if (remoteOnly) qs.set('where', 'remote');
  else if (place) qs.set('where', place);
  if (maxAgeDays) qs.set('max_days_old', String(maxAgeDays)); // null: no recency cut
  const res = await fetch(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${qs}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Adzuna ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function discover(ctx) {
  const { filters, auth, logger } = ctx;
  const appId = auth.adzunaAppId || process.env.ADZUNA_APP_ID;
  const appKey = auth.adzunaAppKey || process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) { logger.warn(`[${ID}] skipped: no ADZUNA_APP_ID / ADZUNA_APP_KEY`); return []; }

  const maxAgeDays = recencyDays(filters);
  const roles = roleStrings(ctx, { max: MAX_ROLES });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const country = market(filters);
  if (!country) { logger.info(`[${ID}] no country in discovery.countries; skipping`); return []; }
  const all = [];
  // A policy that accepts no remote work is searched in the seed row's own
  // place (the first one, one request per role as before).
  const modes = acceptedModes(filters);
  const places = modes.length && !modes.includes('remote') ? seedPlaces(ctx) : new Map();

  for (const q of roles) {
    try {
      const results = await fetchPage(q, 1, maxAgeDays, appId, appKey, filters.remoteOnly === true, country, (places.get(q.toLowerCase()) || [])[0]);
      for (const r of results) {
        const p = createPosting({
          title: r.title,
          company: r.company && r.company.display_name,
          location: (r.location && r.location.display_name) || '',
          url: r.redirect_url,
          postedDate: r.created,
          sourceUrl: `https://api.adzuna.com/v1/api/jobs/${country}/search/1?what=${encodeURIComponent(q)}`,
          sourceQuery: q,
          jdText: (r.description || '').slice(0, 4000),
          compensation: comp(r, country),
        }, ID);
        if (p) all.push(p);
      }
      logger.info(`[${ID}] "${q}" -> ${results.length} results`);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      logger.warn(`[${ID}] "${q}" failed: ${err.message}`);
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Adzuna Jobs API (board aggregator)',
  requires: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
  rateLimit: { rpm: 25 },
  discover,
};
