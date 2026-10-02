/**
 * Source: Arbeitnow (public job board API, keyless, paginated).
 *
 * Endpoint: GET https://www.arbeitnow.com/api/job-board-api
 * Response: { data: [ ... ], links: { next: "<url>?page=2" }, meta: {...} }
 * Job fields: { slug, company_name, title, description (HTML), remote (bool),
 *   url, tags[], job_types[], location, created_at (unix seconds) }
 *
 * There is no server side search parameter, so the feed is paged and filtered
 * locally: titles against the user's seed roles, recency against
 * filters.maxAgeDays (created_at), and, only when the user's policy asks for
 * it, a work mode and country keep. The pipeline's gate after enrichment makes
 * the final call. The board is weighted toward European employers.
 */

const { createPosting, stripHtml } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { recencyDays, withinAge } = require('../../../lib/profile');

const ID = 'arbeitnow';

const FEED = 'https://www.arbeitnow.com/api/job-board-api';
const MAX_PAGES = 10;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function discover(ctx) {
  const { logger } = ctx;
  const filters = ctx.filters || {};
  const maxAgeDays = recencyDays(filters);
  if (!roleStrings(ctx, { max: 1 }).length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const titleOk = makeTitleMatcher(ctx);

  const all = [];
  const seen = new Set();
  let url = FEED;
  let scanned = 0;

  for (let page = 1; page <= MAX_PAGES && url; page++) {
    let body;
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`arbeitnow ${res.status}`);
      body = await res.json();
    } catch (err) {
      logger.warn(`[${ID}] page ${page} fetch failed: ${err.message}`);
      break;
    }
    const jobs = Array.isArray(body?.data) ? body.data : [];
    scanned += jobs.length;

    for (const j of jobs) {
      const title = j.title;
      if (!title || !titleOk(title)) continue;
      if (!withinAge(Number(j.created_at) * 1000, maxAgeDays)) continue;
      if (!j.url) continue;

      // Fold the boolean remote flag into the location so the classifier can
      // read it; don't double-tag when the location already says "remote".
      const loc = String(j.location || '').trim();
      const location = j.remote && !/remote/i.test(loc) ? (loc ? `${loc} (Remote)` : 'Remote') : loc;

      const p = createPosting({
        title,
        company: j.company_name,
        location,
        url: j.url,
        postedDate: j.created_at,
        jdText: stripHtml(j.description).slice(0, 8000),
        compensation: null,          // arbeitnow feed carries no salary field
        sourceUrl: FEED,
        sourceQuery: 'feed',
      }, ID);
      if (!p || seen.has(p.canonicalUrl)) continue;

      // Early keep, each half applied only when the user's policy sets it:
      // the role must resolve remote, and must not sit in a known foreign
      // location (us === false). us === null (unknown) is kept for the
      // downstream gate.
      if (filters.remoteOnly && p.remote !== 'remote') continue;
      if (filters.usOnly && p.us === false) continue;
      seen.add(p.canonicalUrl);
      all.push(p);
    }

    url = body?.links?.next || null;
    if (url) await sleep(250); // polite pacing between pages
  }

  logger.info(`[${ID}] scanned ${scanned} jobs -> ${all.length} matching within ${maxAgeDays ? maxAgeDays + 'd' : 'any age'}`);
  return all;
}

module.exports = {
  id: ID,
  name: 'Arbeitnow (public job board API)',
  requires: [],
  rateLimit: { rpm: 30 },
  discover,
};
