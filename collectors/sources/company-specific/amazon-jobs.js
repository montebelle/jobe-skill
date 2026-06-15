/**
 * Source: Amazon Jobs public search API.
 *
 * Endpoint: https://www.amazon.jobs/en/search.json
 * Params: base_query, loc_query, result_limit, offset, sort, category
 * No auth required. Public. Returns structured job records.
 *
 * Amazon posts thousands of roles daily; we filter client-side to ML/AI.
 */

const { createPosting } = require('../../../lib/posting');
const { makeTitleMatcher } = require('../../../lib/role-queries');

const ID = 'amazon-jobs';
const BASE = 'https://www.amazon.jobs/en/search.json';

async function searchPage(query, location, offset = 0, limit = 100) {
  const params = new URLSearchParams({
    base_query: query,
    loc_query: location || '',
    result_limit: String(limit),
    offset: String(offset),
    sort: 'recent',
    'country[]': 'US',
  });
  const url = `${BASE}?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Amazon ${res.status}`);
  return res.json();
}

async function discover(ctx) {
  const { queries, logger } = ctx;
  const titleOk = makeTitleMatcher(ctx);
  const all = [];

  const baseQueries = [...new Set(queries.map(q => q.query))];
  if (!baseQueries.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const locs = [...new Set(queries.map(q => q.location).filter(Boolean))];
  if (!locs.length) locs.push('');

  for (const baseQuery of baseQueries) {
    for (const loc of locs) {
      try {
        let offset = 0;
        let pageCount = 0;
        const MAX_PAGES = 3;
        while (pageCount < MAX_PAGES) {
          const data = await searchPage(baseQuery, loc, offset, 100);
          const jobs = data.jobs || [];
          if (!jobs.length) break;
          for (const j of jobs) {
            if (!titleOk(j.title || '')) continue;
            const url = `https://www.amazon.jobs${j.job_path || `/en/jobs/${j.id}`}`;
            const p = createPosting({
              title: j.title,
              company: 'Amazon',
              location: [j.city, j.state_province, j.country_code].filter(Boolean).join(', '),
              url,
              department: j.business_category || j.department_name,
              postedDate: j.posted_date || j.updated_time,
              jdText: [j.description_short, j.description, j.basic_qualifications, j.preferred_qualifications].filter(Boolean).join('\n\n').slice(0, 10000),
              sourceUrl: `${BASE}?${new URLSearchParams({ base_query: baseQuery, loc_query: loc })}`,
              sourceQuery: `${baseQuery} @ ${loc}`,
            }, ID);
            if (p) all.push(p);
          }
          offset += jobs.length;
          pageCount++;
          if (jobs.length < 100) break;
        }
        logger.info(`[${ID}] "${baseQuery}" @ "${loc}" -> ${pageCount} pages`);
      } catch (err) {
        logger.warn(`[${ID}] "${baseQuery}" @ "${loc}" failed: ${err.message}`);
      }
    }
  }

  const seen = new Set();
  return all.filter(p => {
    if (seen.has(p.canonicalUrl)) return false;
    seen.add(p.canonicalUrl);
    return true;
  });
}

module.exports = {
  id: ID,
  name: 'Amazon Jobs',
  requires: [],
  rateLimit: { rpm: 60 },
  discover,
};
