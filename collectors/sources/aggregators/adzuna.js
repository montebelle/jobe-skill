/**
 * Source: Adzuna Jobs API (aggregator incl. board-syndicated listings).
 *
 * Free developer key: https://developer.adzuna.com (app_id + app_key).
 * Endpoint: GET https://api.adzuna.com/v1/api/jobs/us/search/{page}
 *   ?app_id=..&app_key=..&what=<role>&max_days_old=<n>&results_per_page=50
 *
 * Why: Adzuna indexes listings syndicated across boards (incl. some that
 * never hit ATS-direct sources), with clean JSON + `created` dates that
 * feed the recency gate honestly. Env-gated: missing keys -> [] and the
 * pipeline continues (source plugin contract).
 *
 * Response: { results: [{ title, company: { display_name },
 *   location: { display_name, area[] }, redirect_url, created,
 *   description, salary_min, salary_max }] }
 */

const { createPosting } = require('../../../lib/posting');

const ID = 'adzuna';

const ROLE_QUERIES = [
  'senior machine learning engineer',
  'staff machine learning engineer',
  'senior ai engineer',
  'senior data scientist',
];

function comp(r) {
  const lo = r.salary_min ? Math.round(r.salary_min) : null;
  const hi = r.salary_max ? Math.round(r.salary_max) : null;
  if (lo && hi) return `$${lo} - $${hi}`;
  if (lo) return `$${lo}+`;
  return null;
}

async function fetchPage(what, page, maxAgeDays, appId, appKey, remoteOnly) {
  const qs = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    what,
    max_days_old: String(maxAgeDays),
    results_per_page: '50',
    'content-type': 'application/json',
  });
  // "remote" as a where-term biases Adzuna toward remote listings; the
  // strict remote gate still runs downstream on JD-verified data.
  if (remoteOnly) qs.set('where', 'remote');
  const res = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/${page}?${qs}`, {
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

  const maxAgeDays = filters.maxAgeDays || 30;
  const all = [];

  for (const q of ROLE_QUERIES) {
    try {
      const results = await fetchPage(q, 1, maxAgeDays, appId, appKey, filters.remoteOnly !== false);
      for (const r of results) {
        const p = createPosting({
          title: r.title,
          company: r.company && r.company.display_name,
          location: (r.location && r.location.display_name) || '',
          url: r.redirect_url,
          postedDate: r.created,
          sourceUrl: `https://api.adzuna.com/v1/api/jobs/us/search/1?what=${encodeURIComponent(q)}`,
          sourceQuery: q,
          jdText: (r.description || '').slice(0, 4000),
          compensation: comp(r),
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
