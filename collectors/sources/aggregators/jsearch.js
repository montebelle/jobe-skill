/**
 * Source: JSearch via RapidAPI (Google for Jobs aggregation incl. LinkedIn/
 * Indeed/Glassdoor-listed postings).
 *
 * Key: subscribe at https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
 * and set JSEARCH_API_KEY (the RapidAPI key). Free tier exists; paid tiers
 * raise quota. Env-gated: missing key -> [] and the pipeline continues.
 *
 * Endpoint: GET https://jsearch.p.rapidapi.com/search
 *   ?query=<role[ in united states | in <seed place>]>&date_posted=month&page=1&num_pages=1
 *   [&work_from_home=true][&country=<code>]
 * The country suffix and the remote flag are sent only when the user's
 * discovery policy asks for them; `country` is the single two letter code in
 * the user's country list, when there is exactly one.
 * Headers: X-RapidAPI-Key, X-RapidAPI-Host: jsearch.p.rapidapi.com
 *
 * Response: { data: [{ job_title, employer_name, job_city, job_state,
 *   job_country, job_is_remote, job_apply_link, job_google_link,
 *   job_posted_at_datetime_utc, job_description,
 *   job_min_salary, job_max_salary, job_salary_period }] }
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings, seedPlaces } = require('../../../lib/role-queries');
const { recencyDays, acceptedModes } = require('../../../lib/profile');
const { searchCountry } = require('../../../lib/slug-harvest');

const ID = 'jsearch';

const MAX_ROLES = 4; // free-tier quota is tight; roles come from the user's seeds

function datePostedParam(maxAgeDays) {
  if (!maxAgeDays) return 'all'; // recency cut off
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
    // The currency is the one the API states; with none the band carries no
    // currency label and the pay floor reads it as unknown.
    const cur = d.job_salary_currency ? `${String(d.job_salary_currency).toUpperCase()} ` : '';
    return `${cur}${d.job_min_salary} - ${d.job_max_salary}${per}`;
  }
  return null;
}

async function fetchQuery(query, apiKey, maxAgeDays, remoteOnly, country) {
  const qs = new URLSearchParams({
    query,
    date_posted: datePostedParam(maxAgeDays),
    page: '1',
    num_pages: '1',
  });
  if (remoteOnly) qs.set('work_from_home', 'true');
  if (country) qs.set('country', country);
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

  const maxAgeDays = recencyDays(filters);
  const where = filters.usOnly ? ' in united states' : '';
  const country = searchCountry(filters.countries);
  // A policy that accepts no remote work is searched in the seed row's own
  // place (the first one) in place of the country suffix.
  const modes = acceptedModes(filters);
  const places = modes.length && !modes.includes('remote') ? seedPlaces(ctx) : new Map();
  const roles = roleStrings(ctx, { max: MAX_ROLES }).map((r) => {
    const place = (places.get(r.toLowerCase()) || [])[0];
    return place ? `${r} in ${place}` : `${r}${where}`;
  });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const all = [];

  for (const q of roles) {
    try {
      const rows = await fetchQuery(q, apiKey, maxAgeDays, filters.remoteOnly === true, country);
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
