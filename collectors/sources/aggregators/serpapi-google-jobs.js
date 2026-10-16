/**
 * Source: SerpAPI Google Jobs engine.
 *
 * Primary aggregator. Uses Google's job search (engine=google_jobs) which
 * aggregates postings from Greenhouse, Lever, Ashby, LinkedIn, Indeed,
 * ZipRecruiter, company career pages, and more. Single query returns ~10
 * structured postings with title/company/location/description.
 *
 * For each seed query we paginate until no more results or hit 50 per query.
 * The search location is the seed's own location; with none, the country is
 * named only when the user's policy is a single country search. The search
 * market (gl) is the single two letter code in the user's country list, when
 * there is exactly one.
 */

const { createPosting } = require('../../../lib/posting');
const { searchCountry } = require('../../../lib/slug-harvest');

const ID = 'serpapi-google-jobs';

async function serpFetch(params, apiKey, attempt = 0) {
  const qs = new URLSearchParams({ ...params, api_key: apiKey });
  const res = await fetch(`https://serpapi.com/search.json?${qs}`);
  // A quota 429 applies to the source, not one query. Retrying every query
  // multiplies a known quota failure into a request storm. Stop immediately
  // and let the other sources continue. Bounded retries remain for 5xx only.
  if (res.status === 429) {
    const err = new Error('SerpAPI quota exhausted');
    err.code = 'SERPAPI_QUOTA';
    throw err;
  }
  if (res.status >= 500 && attempt < 2) {
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const wait = retryAfter > 0 ? retryAfter : Math.min(2000 * 2 ** attempt, 8000);
    await new Promise((r) => setTimeout(r, wait));
    return serpFetch(params, apiKey, attempt + 1);
  }
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  return res.json();
}

async function discover(ctx) {
  const { queries, filters = {}, auth, logger, reportSourceStatus } = ctx;
  if (!auth.serpApiKey) { logger.warn(`[${ID}] skipped: no SERPAPI_KEY`); return []; }

  const country = searchCountry(filters.countries);
  const all = [];
  for (const q of queries) {
    try {
      let next = null;
      let pageCount = 0;
      const MAX_PAGES = 5; // up to ~50 results per query
      do {
        const location = q.location || (filters.usOnly ? 'United States' : '');
        const params = {
          engine: 'google_jobs',
          q: q.query,
          ...(location ? { location } : {}),
          hl: 'en',
          ...(country ? { gl: country } : {}),
          ...(next ? { next_page_token: next } : {}),
        };
        const data = await serpFetch(params, auth.serpApiKey);
        const jobs = data.jobs_results || [];
        if (jobs.length === 0) break; // no results: stop, don't 400 on a stale next-page token
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
      if (err.code === 'SERPAPI_QUOTA') {
        reportSourceStatus?.('degraded', 'quota_exhausted');
        logger.warn(`[${ID}] quota exhausted; stopping this source after the first 429`);
        break;
      }
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
