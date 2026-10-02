/**
 * Source: Findwork.dev Jobs API.
 *
 * The board itself lists software and technology roles, so it returns little
 * for other fields. That is a property of the source, not a filter in this
 * file: the search terms are the user's own seed roles.
 *
 * Key: sign up at https://findwork.dev and copy the token shown at
 * https://findwork.dev/developers/ - set FINDWORK_API_KEY. Env-gated:
 * missing key -> [] and the pipeline continues (source plugin contract).
 *
 * Endpoint: GET https://findwork.dev/api/jobs/
 *   ?search=<role>&sort_by=date[&remote=true]
 * Headers: Authorization: Token <FINDWORK_API_KEY>, Accept: application/json
 *
 * Response: { count, next, previous, results: [{ id, role, company_name,
 *   company_num_employees, employment_type, location, remote (bool), logo,
 *   url, text (HTML description), date_posted (ISO), keywords[], source }] }
 * No age filter parameter exists (sort_by=date biases fresh first); the
 * downstream recency gate enforces the user's window on `date_posted`.
 */

const { createPosting, stripHtml } = require('../../../lib/posting');
const { roleStrings } = require('../../../lib/role-queries');

const ID = 'findwork';

// Search terms come from the user's seed roles; one request per role.
const MAX_ROLES = 4;

function loc(r) {
  if (r.remote) return r.location ? `Remote - ${r.location}` : 'Remote';
  return r.location || '';
}

async function fetchQuery(search, apiKey, remoteOnly) {
  const qs = new URLSearchParams({ search, sort_by: 'date' });
  if (remoteOnly) qs.set('remote', 'true');
  const res = await fetch(`https://findwork.dev/api/jobs/?${qs}`, {
    headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Findwork ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function discover(ctx) {
  const { auth, logger } = ctx;
  const filters = ctx.filters || {};
  const apiKey = (auth && auth.findworkApiKey) || process.env.FINDWORK_API_KEY;
  if (!apiKey) { logger.warn(`[${ID}] skipped: no FINDWORK_API_KEY`); return []; }
  const roles = roleStrings(ctx, { max: MAX_ROLES });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }

  const remoteOnly = filters.remoteOnly === true;
  const all = [];

  for (const q of roles) {
    try {
      const rows = await fetchQuery(q, apiKey, remoteOnly);
      for (const r of rows) {
        const p = createPosting({
          title: r.role,
          company: r.company_name,
          location: loc(r),
          url: r.url,
          postedDate: r.date_posted,
          sourceUrl: 'https://findwork.dev/api/jobs/',
          sourceQuery: q,
          jdText: stripHtml(r.text || '').slice(0, 4000),
          compensation: null,
        }, ID);
        if (p) all.push(p);
      }
      logger.info(`[${ID}] "${q}" -> ${rows.length} results`);
      await new Promise(res => setTimeout(res, 1000));
    } catch (err) {
      logger.warn(`[${ID}] "${q}" failed: ${err.message}`);
      if (/40[13]|429/.test(err.message)) break; // auth/quota - stop burning calls
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Findwork.dev Jobs API',
  requires: ['FINDWORK_API_KEY'],
  rateLimit: { rpm: 30 },
  discover,
};
