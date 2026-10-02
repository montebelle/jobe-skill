/**
 * Source: Jooble Jobs API (global job aggregator; a key is issued per country
 * and returns that country's listings).
 *
 * Key: request a free key via the form at https://jooble.org/api/about -
 * set JOOBLE_API_KEY. The free plan is 500 requests for the life of the key,
 * so this source runs a small query set. Env-gated: missing key -> [] and the
 * pipeline continues (source plugin contract).
 *
 * Endpoint: POST https://jooble.org/api/{JOOBLE_API_KEY}
 *   Content-Type: application/json
 *   Body: { keywords, location, page }
 *
 * Response: { totalCount, jobs: [{ id, title, location, snippet (HTML),
 *   salary, source, type, link, company, updated (ISO) }] }
 * No age parameter exists; the downstream recency gate enforces the user's
 * window on `updated`.
 */

const { createPosting, stripHtml } = require('../../../lib/posting');
const { roleStrings } = require('../../../lib/role-queries');

const ID = 'jooble';

// Kept small on purpose: the key has a lifetime request quota.
const MAX_ROLES = 4;

// The location each seed role was written with (first seed wins).
// ponytail: a role seeded in several locations is searched in the first one
// only, to protect the lifetime quota. Upgrade path: one request per seed pair.
function seedLocations(ctx) {
  const map = new Map();
  for (const q of (ctx && ctx.queries) || []) {
    const role = (typeof q === 'string' ? q : (q && q.query) || '').trim().toLowerCase();
    if (role && !map.has(role)) map.set(role, String((q && q.location) || '').trim());
  }
  return map;
}

async function fetchQuery(keywords, location, apiKey) {
  const body = { keywords, location, page: '1' };
  const res = await fetch(`https://jooble.org/api/${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Jooble ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

async function discover(ctx) {
  const { auth, logger } = ctx;
  const filters = ctx.filters || {};
  const apiKey = (auth && auth.joobleApiKey) || process.env.JOOBLE_API_KEY;
  if (!apiKey) { logger.warn(`[${ID}] skipped: no JOOBLE_API_KEY`); return []; }
  const roles = roleStrings(ctx, { max: MAX_ROLES });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }

  const remoteOnly = filters.remoteOnly === true;
  const locations = seedLocations(ctx);
  const all = [];

  for (const q of roles) {
    try {
      const location = remoteOnly ? 'Remote' : (locations.get(q.toLowerCase()) || '');
      const rows = await fetchQuery(q, location, apiKey);
      for (const j of rows) {
        const p = createPosting({
          title: j.title,
          company: j.company,
          location: j.location,
          url: j.link,
          postedDate: j.updated,
          sourceUrl: 'https://jooble.org/api',
          sourceQuery: q,
          jdText: stripHtml(j.snippet || '').slice(0, 4000),
          compensation: j.salary || null,
        }, ID);
        if (p) all.push(p);
      }
      logger.info(`[${ID}] "${q}" -> ${rows.length} results`);
      await new Promise(res => setTimeout(res, 1000));
    } catch (err) {
      logger.warn(`[${ID}] "${q}" failed: ${err.message}`);
      if (/40[13]|429/.test(err.message)) break; // auth/quota - stop burning the lifetime budget
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Jooble Jobs API (global aggregator)',
  requires: ['JOOBLE_API_KEY'],
  rateLimit: { rpm: 20 },
  discover,
};
