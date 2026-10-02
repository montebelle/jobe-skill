/**
 * Source: Remotive (remote-first job board, public JSON API).
 *
 * Endpoint: GET https://remotive.com/api/remote-jobs?search=<kw>&limit=100
 * Docs: https://github.com/remotive-com/remote-jobs-api
 * No API key required. Polite use requested by Remotive (do not hammer);
 * we run a handful of role-keyword queries per pipeline run with a delay.
 *
 * Every posting on Remotive is remote by construction. Country eligibility
 * is classified downstream from `candidate_required_location` (e.g. "USA
 * Only", "Worldwide", "Europe").
 *
 * Response shape: { jobs: [{ id, url, title, company_name, category,
 *   candidate_required_location, publication_date, salary, description }] }
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { recencyDays, withinAge } = require('../../../lib/profile');

const ID = 'remotive';

// Roles come from the user's seeds. Remotive's `search` matches descriptions
// too (off-target roles surface), so titles are re-filtered locally against the
// same target roles before normalization. Cap to stay polite on their API.
const MAX_ROLES = 5;

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchJobs(search) {
  const qs = new URLSearchParams({ search, limit: '100' });
  const res = await fetch(`https://remotive.com/api/remote-jobs?${qs}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Remotive ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

async function discover(ctx) {
  const { filters, logger } = ctx;
  const maxAgeDays = recencyDays(filters);
  const roles = roleStrings(ctx, { max: MAX_ROLES });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const titleOk = makeTitleMatcher(ctx);
  const all = [];

  for (const q of roles) {
    try {
      const jobs = await fetchJobs(q);
      let kept = 0;
      for (const j of jobs) {
        if (!titleOk(j.title || '')) continue;
        if (!withinAge(j.publication_date, maxAgeDays)) continue;
        // candidate_required_location drives country classification
        // downstream: "Remote - USA Only" parses as remote+us; under a US
        // country policy "Remote - Europe" is dropped by the country gate.
        const loc = j.candidate_required_location
          ? `Remote - ${j.candidate_required_location}`
          : 'Remote';
        const p = createPosting({
          title: j.title,
          company: j.company_name,
          location: loc,
          url: j.url,
          postedDate: j.publication_date,
          sourceUrl: `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}`,
          sourceQuery: q,
          jdText: stripHtml(j.description).slice(0, 4000),
          compensation: j.salary || null,
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
  name: 'Remotive (remote-first board, public API)',
  requires: [],
  rateLimit: { rpm: 30 },
  discover,
};
