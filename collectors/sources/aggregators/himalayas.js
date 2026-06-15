/**
 * Source: Himalayas (remote-first job board, public JSON API).
 *
 * Endpoint: GET https://himalayas.app/jobs/api?limit=100&offset=0
 * Docs: https://himalayas.app/api (free, no key, attribution requested)
 *
 * Response shape (tolerant parsing — the API has evolved):
 *   { jobs: [{ title, companyName | company.name, applicationLink | link |
 *     guid, pubDate (epoch seconds) | publishedDate, locationRestrictions[],
 *     categories[] | parentCategories[], description, minSalary, maxSalary }] }
 *
 * The API has no keyword search; we pull the recent feed and filter
 * locally for ML/AI/DS titles, then apply the recency window.
 * locationRestrictions (e.g. ["United States"]) drives US classification.
 */

const { createPosting } = require('../../../lib/posting');
const { makeTitleMatcher } = require('../../../lib/role-queries');

const ID = 'himalayas';

// No keyword search: pull the recent feed and filter titles locally against
// the user's target roles.
const PAGES = 3;        // 3 x 100 most recent postings per run
const PAGE_SIZE = 100;

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function jobDate(j) {
  // pubDate is epoch seconds in the documented API; fall back to ISO fields.
  if (typeof j.pubDate === 'number') return new Date(j.pubDate * 1000).toISOString();
  return j.publishedDate || j.pubDate || j.createdAt || null;
}

function jobUrl(j) {
  return j.applicationLink || j.link || j.url || j.guid || null;
}

function jobCompany(j) {
  return j.companyName || (j.company && (j.company.name || j.company.displayName)) || null;
}

function comp(j) {
  if (j.minSalary && j.maxSalary) return `$${j.minSalary} - $${j.maxSalary}`;
  if (j.minSalary) return `$${j.minSalary}+`;
  return null;
}

function withinAge(iso, maxAgeDays) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) <= maxAgeDays * 86400000;
}

async function discover(ctx) {
  const { filters, logger } = ctx;
  const maxAgeDays = filters.maxAgeDays || 30;
  const titleOk = makeTitleMatcher(ctx);
  const all = [];

  for (let page = 0; page < PAGES; page++) {
    try {
      const res = await fetch(`https://himalayas.app/jobs/api?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`Himalayas ${res.status}`);
      const data = await res.json();
      const jobs = Array.isArray(data.jobs) ? data.jobs : (Array.isArray(data) ? data : []);
      if (!jobs.length) { logger.info(`[${ID}] page ${page} empty, stopping`); break; }
      let kept = 0;
      for (const j of jobs) {
        const title = j.title || '';
        if (!titleOk(title)) continue;
        const posted = jobDate(j);
        if (!withinAge(posted, maxAgeDays)) continue;
        const restr = Array.isArray(j.locationRestrictions) && j.locationRestrictions.length
          ? j.locationRestrictions.join(', ')
          : '';
        const p = createPosting({
          title,
          company: jobCompany(j),
          location: restr ? `Remote - ${restr}` : 'Remote',
          url: jobUrl(j),
          postedDate: posted,
          sourceUrl: 'https://himalayas.app/jobs/api',
          sourceQuery: `feed:page${page}`,
          jdText: stripHtml(j.description).slice(0, 4000),
          compensation: comp(j),
        }, ID);
        if (p) { all.push(p); kept++; }
      }
      logger.info(`[${ID}] page ${page} -> ${jobs.length} jobs, ${kept} matching within ${maxAgeDays}d`);
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      logger.warn(`[${ID}] page ${page} failed: ${err.message}`);
      break;
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Himalayas (remote-first board, public API)',
  requires: [],
  rateLimit: { rpm: 20 },
  discover,
};
