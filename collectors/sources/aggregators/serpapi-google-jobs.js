/**
 * Source: SerpAPI Google Jobs engine.
 *
 * Primary aggregator. Uses Google's job search (engine=google_jobs) which
 * aggregates postings from Greenhouse, Lever, Ashby, LinkedIn, Indeed,
 * ZipRecruiter, company career pages, and more. Single query returns ~10
 * structured postings with title/company/location/description.
 *
 * For each seed query we paginate until no more results or hit 50 per query.
 */

const { createPosting } = require('../../../lib/posting');

const ID = 'serpapi-google-jobs';

async function serpFetch(params, apiKey) {
  const qs = new URLSearchParams({ ...params, api_key: apiKey });
  const res = await fetch(`https://serpapi.com/search.json?${qs}`);
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  return res.json();
}

async function discover(ctx) {
  const { queries, auth, logger } = ctx;
  if (!auth.serpApiKey) { logger.warn(`[${ID}] skipped: no SERPAPI_KEY`); return []; }

  const all = [];
  for (const q of queries) {
    try {
      let next = null;
      let pageCount = 0;
      const MAX_PAGES = 5; // up to ~50 results per query
      do {
        const params = {
          engine: 'google_jobs',
          q: q.query,
          location: q.location || 'United States',
          hl: 'en',
          ...(next ? { next_page_token: next } : {}),
        };
        const data = await serpFetch(params, auth.serpApiKey);
        const jobs = data.jobs_results || [];
        for (const j of jobs) {
          const link = (j.apply_options || [])[0]?.link || j.share_link || null;
          if (!link) continue;
          const p = createPosting({
            title: j.title,
            company: j.company_name,
            location: j.location,
            url: link,
            postedDate: j.detected_extensions?.posted_at,
            department: null,
            jdText: (j.description || '').slice(0, 3000),
            sourceUrl: `https://serpapi.com/search.json?engine=google_jobs&q=${encodeURIComponent(q.query)}`,
            sourceQuery: q.query,
          }, ID);
          if (p) all.push(p);
        }
        next = data.serpapi_pagination?.next_page_token || null;
        pageCount++;
      } while (next && pageCount < MAX_PAGES);
      logger.info(`[${ID}] "${q.query}" @ "${q.location}" -> ${pageCount} pages`);
    } catch (err) {
      logger.warn(`[${ID}] query "${q.query}" failed: ${err.message}`);
    }
  }

  // Within-source dedup by canonicalUrl
  const seen = new Set();
  return all.filter(p => {
    if (seen.has(p.canonicalUrl)) return false;
    seen.add(p.canonicalUrl);
    return true;
  });
}

module.exports = {
  id: ID,
  name: 'SerpAPI Google Jobs',
  requires: ['SERPAPI_KEY'],
  rateLimit: { rpm: 60 },
  discover,
};
