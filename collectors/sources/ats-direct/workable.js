/**
 * Source: Workable direct API (public careers widget feed per company, v1 GET).
 *
 * Endpoint: GET https://www.workable.com/api/accounts/{sub}?details=true
 *           ->  { name, description, jobs: [...] }
 * This is the keyless public feed the embeddable careers widget calls. It
 * returns the account display name (clean company name) and, with
 * details=true, each job's full HTML description. Preferred over the POST
 * widget (apply.workable.com/api/v3/accounts/{sub}/jobs): that one is throttled
 * far more aggressively per IP, has no account name, and omits descriptions.
 * The {sub}.workable.com/spi/v3/jobs host is the AUTHENTICATED API (401 without
 * a Bearer key) and is NOT usable here.
 *
 * Fields per job: { title, shortcode, department, url, application_url,
 *   telecommuting (bool), country, city, state,
 *   locations: [{ country, countryCode, city, region }],
 *   published_on, created_at, description (HTML) }
 *
 * Tenants come from lib/ats-tenants.js (ctx.filters.atsSlugs.workable, the
 * portals seed files, the workspace company index). No tenant list ships. A
 * tenant is the Workable ACCOUNT slug (the {sub} in apply.workable.com/{sub}/),
 * which is not always the bare company name. Titles are filtered against the
 * user's seed roles. Recency is left to the pipeline (company boards are low
 * volume), matching the Lever crawler.
 */

const { createPosting, stripHtml, companySlug } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { loadTenants, prettify } = require('../../../lib/ats-tenants');

const ID = 'workable';

const UA = 'jobe-discovery/1.0 (personal job search)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBoard(sub) {
  const res = await fetch(`https://www.workable.com/api/accounts/${sub}?details=true`, {
    headers: { 'Accept': 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  if (!Array.isArray(j.jobs)) return null;
  return { name: j.name || null, jobs: j.jobs };
}

// Fold Workable's telecommuting flag + location object into the location string
// so the canonical classifier sees an explicit remote signal and keeps the
// country for the country check. (The v1 widget has no hybrid flag; hybrid
// downgrades happen downstream from the JD text, which details=true provides.)
function workableLocation(j) {
  const l = (Array.isArray(j.locations) && j.locations[0]) || {};
  const geo = [l.city || j.city, l.region || j.state, l.country || j.country]
    .filter(Boolean).join(', ');
  if (j.telecommuting === true) return geo ? `Remote - ${geo}` : 'Remote';
  return geo;
}

async function discover(ctx) {
  const { logger, limiter } = ctx;
  if (!roleStrings(ctx, { max: 1 }).length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const tenants = loadTenants(ctx, ID);
  if (!tenants.length) { logger.info(`[${ID}] no tenants (seed "workable" in data/companies/portals.json or let the company index learn them); skipping`); return []; }
  const titleOk = makeTitleMatcher(ctx);
  logger.info(`[${ID}] scanning ${tenants.length} Workable boards`);

  const all = [];
  for (const t of tenants) {
    const sub = t.slug;
    if (limiter) await limiter.wait();
    try {
      const board = await fetchBoard(sub);
      if (!board) continue;
      const company = board.name || t.name || prettify(sub);
      let kept = 0;
      for (const j of board.jobs) {
        if (!j || !j.title) continue;
        if (!titleOk(j.title)) continue;
        const p = createPosting({
          title: j.title,
          company,
          companySlug: companySlug(company),
          location: workableLocation(j),
          url: j.url || j.application_url || (j.shortcode ? `https://apply.workable.com/j/${j.shortcode}` : null),
          department: typeof j.department === 'string' ? j.department : (j.department && j.department.name) || null,
          postedDate: j.published_on || j.created_at,
          jdText: j.description ? stripHtml(j.description).slice(0, 8000) : null,
          compensation: null,
          sourceUrl: `https://www.workable.com/api/accounts/${sub}`,
          sourceQuery: `workable:${sub}`,
        }, ID);
        if (p) { all.push(p); kept++; }
      }
      if (kept) logger.info(`[${ID}] ${sub}: ${board.jobs.length} jobs -> ${kept} matching`);
      await sleep(500); // ponytail: light pacing; this GET bucket is lenient, raise if 429s appear
    } catch (err) {
      logger.warn(`[${ID}] ${sub}: ${err.message}`);
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Workable Direct (public careers API per company)',
  requires: [],
  rateLimit: { rpm: 40 },
  discover,
};
