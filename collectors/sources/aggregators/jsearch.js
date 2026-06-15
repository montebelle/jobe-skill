/**
 * Source: JSearch via RapidAPI (Google for Jobs aggregation incl. LinkedIn/
 * Indeed/Glassdoor-listed postings).
 *
 * Key: subscribe at https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
 * and set JSEARCH_API_KEY (the RapidAPI key). Free tier exists; paid tiers
 * raise quota. Env-gated: missing key -> [] and the pipeline continues.
 *
 * Endpoint: GET https://jsearch.p.rapidapi.com/search
 *   ?query=<role in united states>&date_posted=month&page=1&num_pages=1
 *   [&work_from_home=true]
 * Headers: X-RapidAPI-Key, X-RapidAPI-Host: jsearch.p.rapidapi.com
 *
 * Response: { data: [{ job_title, employer_name, job_city, job_state,
 *   job_country, job_is_remote, job_apply_link, job_google_link,
 *   job_posted_at_datetime_utc, job_description,
 *   job_min_salary, job_max_salary, job_salary_period }] }
 */

const { createPosting } = require('../../../lib/posting');

const ID = 'jsearch';

const ROLE_QUERIES = [
  'senior machine learning engineer in united states',
  'staff machine learning engineer in united states',
  'senior ai engineer in united states',
  'senior data scientist in united states',
];

function datePostedParam(maxAgeDays) {
  if (maxAgeDays <= 1) return 'today';
  if (maxAgeDays <= 3) return '3days';
  if (maxAgeDays <= 7) return 'week';
  return 'month';
}

function loc(d) {
  if (d.job_is_remote) {
    const country = d.job_country === 'US' ? 'United States' : (d.job_country || '');
    return country ? `Remote - ${country}` : 'Remote';
  }
  return [d.job_city, d.job_state].filter(Boolean).join(', ');
}

function comp(d) {
  if (d.job_min_salary && d.job_max_salary) {
    const per = d.job_salary_period ? ` per ${String(d.job_salary_period).toLowerCase()}` : '';
    return `$${d.job_min_salary} - $${d.job_max_salary}${per}`;
  }
  return null;
}

async function fetchQuery(query, apiKey, maxAgeDays, remoteOnly) {
  const qs = new URLSearchParams({
    query,
    date_posted: datePostedParam(maxAgeDays),
    page: '1',
    num_pages: '1',
  });
  if (remoteOnly) qs.set('work_from_home', 'true');
  const res = await fetch(`https://jsearch.p.rapidapi.com/search?${qs}`, {
    headers: {
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`JSearch ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

async function discover(ctx) {
  const { filters, auth, logger } = ctx;
  const apiKey = auth.jsearchApiKey || process.env.JSEARCH_API_KEY || process.env.RAPIDAPI_KEY;
  if (!apiKey) { logger.warn(`[${ID}] skipped: no JSEARCH_API_KEY`); return []; }

  const maxAgeDays = filters.maxAgeDays || 30;
  const all = [];

  for (const q of ROLE_QUERIES) {
    try {
      const rows = await fetchQuery(q, apiKey, maxAgeDays, filters.remoteOnly !== false);
      for (const d of rows) {
        const p = createPosting({
          title: d.job_title,
          company: d.employer_name,
          location: loc(d),
          url: d.job_apply_link || d.job_google_link,
          postedDate: d.job_posted_at_datetime_utc,
          sourceUrl: 'https://jsearch.p.rapidapi.com/search',
          sourceQuery: q,
          jdText: (d.job_description || '').slice(0, 4000),
          compensation: comp(d),
        }, ID);
        if (p) all.push(p);
      }
      logger.info(`[${ID}] "${q}" -> ${rows.length} results`);
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      logger.warn(`[${ID}] "${q}" failed: ${err.message}`);
      if (/429|403/.test(err.message)) break; // quota exhausted — stop burning calls
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'JSearch / RapidAPI (Google for Jobs aggregation)',
  requires: ['JSEARCH_API_KEY'],
  rateLimit: { rpm: 20 },
  discover,
};
