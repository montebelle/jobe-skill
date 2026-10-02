/**
 * Source: Jobicy (remote job board, public JSON API v2).
 *
 * Endpoint: GET https://jobicy.com/api/v2/remote-jobs?count=50&tag=<kw>[&geo=usa]
 * Docs: https://jobicy.com/jobs-rss-feed (JSON API, free, no key, attribution requested)
 *
 * Every posting is remote by construction (that is the board, not a filter
 * added here). `geo=usa` restricts to roles open to US residents and is sent
 * only when the user's country policy is exactly the US. The `tag` parameter is
 * a free text keyword search, so the user's seed roles are the queries and
 * titles are filtered again locally.
 *
 * Response shape: { jobs: [{ id, url, jobTitle, companyName, jobIndustry,
 *   jobType[], jobGeo, jobLevel, jobExcerpt, jobDescription, pubDate (ISO),
 *   salaryMin, salaryMax, salaryCurrency, salaryPeriod }] }
 */

const { createPosting, stripHtml } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { recencyDays, withinAge } = require('../../../lib/profile');

const ID = 'jobicy';

const MAX_ROLES = 3;

function comp(j) {
  const cur = j.salaryCurrency || 'USD';
  // A stated period other than a year rides along as "/period", which the pay
  // parser reads as "not a yearly band" (unknown to the pay floor).
  const per = j.salaryPeriod && !/^(year|annual)/i.test(j.salaryPeriod) ? `/${String(j.salaryPeriod).toLowerCase()}` : '';
  if (j.salaryMin && j.salaryMax) return `${cur} ${j.salaryMin} - ${j.salaryMax}${per}`;
  if (j.salaryMin) return `${cur} ${j.salaryMin}+`;
  return null;
}

// ponytail: only the US maps to a geo slug here. Any other country policy
// queries every region and leaves the country gate to the pipeline. Upgrade
// path: a country to Jobicy region table if users elsewhere need tighter queries.
function searchParams(tag, usOnly) {
  const qs = new URLSearchParams({ count: '50', tag });
  if (usOnly) qs.set('geo', 'usa');
  return qs;
}

async function fetchJobs(qs) {
  const res = await fetch(`https://jobicy.com/api/v2/remote-jobs?${qs}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Jobicy ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

async function discover(ctx) {
  const { logger } = ctx;
  const filters = ctx.filters || {};
  const maxAgeDays = recencyDays(filters);
  const usOnly = filters.usOnly === true;
  const roles = roleStrings(ctx, { max: MAX_ROLES });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  // tag search matches descriptions too, so titles are filtered again locally.
  const titleOk = makeTitleMatcher(ctx);
  const all = [];

  for (const q of roles) {
    try {
      const qs = searchParams(q, usOnly);
      const jobs = await fetchJobs(qs);
      let kept = 0;
      for (const j of jobs) {
        const title = j.jobTitle || '';
        if (!titleOk(title)) continue;
        if (!withinAge(j.pubDate, maxAgeDays)) continue;
        // A named region is kept in the label for the country gate. With
        // geo=usa the query is already US scoped, so an unnamed or "anywhere"
        // region is labeled USA; without it the region stays unknown.
        const named = (j.jobGeo && !/anywhere|worldwide/i.test(j.jobGeo)) ? j.jobGeo : (usOnly ? 'USA' : '');
        const p = createPosting({
          title,
          company: j.companyName,
          location: named ? `Remote - ${named}` : 'Remote',
          url: j.url,
          postedDate: j.pubDate,
          sourceUrl: `https://jobicy.com/api/v2/remote-jobs?${qs}`,
          sourceQuery: q,
          jdText: stripHtml(j.jobDescription || j.jobExcerpt).slice(0, 4000),
          compensation: comp(j),
        }, ID);
        if (p) { all.push(p); kept++; }
      }
      logger.info(`[${ID}] "${q}" -> ${jobs.length} jobs, ${kept} within ${maxAgeDays ? maxAgeDays + 'd' : 'any age'}`);
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      logger.warn(`[${ID}] query "${q}" failed: ${err.message}`);
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Jobicy (remote board, public API)',
  requires: [],
  rateLimit: { rpm: 30 },
  discover,
};
