/**
 * Source: Working Nomads (remote job board, public JSON feed).
 *
 * Endpoint: GET https://www.workingnomads.com/api/exposed_jobs/
 * Free, no key. Returns the recent remote jobs feed (all categories) as a
 * JSON array; there is no keyword search, so the feed is pulled once and
 * filtered locally: titles against the user's seed roles, then the recency
 * window.
 *
 * Every posting is remote by construction (that is the board). `location`
 * (for example "United States", "Anywhere", "USA, Canada") names where the
 * remote worker may live and drives the country gate downstream. The `url` is
 * a Working Nomads redirect to the employer posting.
 *
 * Response shape: [{ url, title, description, company_name, category_name,
 *   tags, location, pub_date (ISO) }]
 */

const { createPosting, stripHtml } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { recencyDays, withinAge } = require('../../../lib/profile');

const ID = 'working-nomads';

async function discover(ctx) {
  const { logger } = ctx;
  const filters = ctx.filters || {};
  const maxAgeDays = recencyDays(filters);
  if (!roleStrings(ctx, { max: 1 }).length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const titleOk = makeTitleMatcher(ctx);
  const all = [];

  try {
    const res = await fetch('https://www.workingnomads.com/api/exposed_jobs/', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Working Nomads ${res.status}`);
    const data = await res.json();
    const jobs = Array.isArray(data) ? data : (Array.isArray(data.jobs) ? data.jobs : []);
    let kept = 0;
    for (const j of jobs) {
      const title = j.title || '';
      if (!titleOk(title)) continue;
      if (!withinAge(j.pub_date, maxAgeDays)) continue;
      const loc = j.location && j.location.trim() ? j.location.trim() : 'Remote';
      const p = createPosting({
        title,
        company: j.company_name,
        location: /remote/i.test(loc) ? loc : `Remote - ${loc}`,
        url: j.url,
        postedDate: j.pub_date,
        sourceUrl: 'https://www.workingnomads.com/api/exposed_jobs/',
        sourceQuery: 'feed',
        jdText: stripHtml(j.description).slice(0, 4000),
        compensation: null,
      }, ID);
      if (p) { all.push(p); kept++; }
    }
    logger.info(`[${ID}] feed -> ${jobs.length} jobs, ${kept} matching within ${maxAgeDays ? maxAgeDays + 'd' : 'any age'}`);
  } catch (err) {
    logger.warn(`[${ID}] feed failed: ${err.message}`);
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Working Nomads (remote board, public feed)',
  requires: [],
  rateLimit: { rpm: 20 },
  discover,
};
