/**
 * Source: Apple Jobs via SSR scrape.
 *
 * Apple's public API at /api/role/search is not stable for public use.
 * Their search page https://jobs.apple.com/en-us/search SSRs job links
 * in the initial HTML, which we parse out.
 *
 * Per-role detail is fetched on demand during the enrich phase.
 */

const { createPosting, textClean } = require('../../../lib/posting');
const { makeTitleMatcher } = require('../../../lib/role-queries');

const ID = 'apple-jobs';
const BASE = 'https://jobs.apple.com/en-us/search';
const UA = 'Mozilla/5.0 (compatible; JobePositioningSkill/1.0)';

async function fetchSearchPage(query, page = 1) {
  const params = new URLSearchParams({
    search: query,
    sort: 'newest',
    location: 'united-states-USA',
    page: String(page),
  });
  const res = await fetch(`${BASE}?${params}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Apple ${res.status}`);
  return res.text();
}

// Parse job cards from the SSR HTML
function parseCards(html) {
  const jobs = [];
  // Two patterns: details/{id}/{slug} and data-role-id="..." sibling blocks
  const linkRe = /href="(\/en-us\/details\/[^"]+)"/g;
  const seen = new Set();
  let m;
  while ((m = linkRe.exec(html))) {
    let href = m[1];
    // Trim query / locationPicker suffix
    href = href.split('?')[0].replace(/\/locationPicker$/, '');
    if (seen.has(href)) continue;
    seen.add(href);

    // Title is the slug after the id, kebab-cased
    const segs = href.split('/');
    const slug = segs[segs.length - 1];
    const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    jobs.push({ url: `https://jobs.apple.com${href}`, title });
  }
  return jobs;
}

async function discover(ctx) {
  const { queries, logger } = ctx;
  const titleOk = makeTitleMatcher(ctx);
  const all = [];

  const baseQueries = [...new Set(queries.map(q => q.query))];

  for (const q of baseQueries) {
    try {
      let page = 1;
      const MAX_PAGES = 3;
      let totalForQuery = 0;
      while (page <= MAX_PAGES) {
        const html = await fetchSearchPage(q, page);
        const cards = parseCards(html);
        if (!cards.length) break;
        for (const c of cards) {
          if (!titleOk(c.title)) continue;
          const p = createPosting({
            title: c.title,
            company: 'Apple',
            location: 'United States',
            url: c.url,
            sourceUrl: `${BASE}?search=${encodeURIComponent(q)}`,
            sourceQuery: q,
          }, ID);
          if (p) { all.push(p); totalForQuery++; }
        }
        if (cards.length < 20) break;
        page++;
      }
      logger.info(`[${ID}] "${q}" -> ${totalForQuery} roles across ${page} pages`);
    } catch (err) {
      logger.warn(`[${ID}] "${q}" failed: ${err.message}`);
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
  name: 'Apple Jobs (SSR scrape)',
  requires: [],
  rateLimit: { rpm: 30 },
  discover,
};
