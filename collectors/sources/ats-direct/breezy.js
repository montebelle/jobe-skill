/**
 * Source: Breezy HR direct (one public board per company subdomain).
 *
 * Public board JSON (no auth, no key):
 *   GET https://{sub}.breezy.hr/json  ->  array of open positions
 * Position fields:
 *   { id, friendly_id, name (title), url, published_date (ISO), type,
 *     location: { name, city, state:{name,id}, country:{name,id},
 *                 is_remote, remote_details }, locations[], department,
 *     salary (string), company: { name, friendly_id } }
 * The list endpoint carries NO description, so jdText is left null and filled
 * lazily by the pipeline's enrichment stage.
 *
 * Tenants come from lib/ats-tenants.js (ctx.filters.atsSlugs.breezy, the
 * portals seed files, the workspace company index). No tenant list ships.
 * Titles are filtered against the user's seed roles; work mode, country and
 * recency gating is the pipeline's job downstream.
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { loadTenants, prettify } = require('../../../lib/ats-tenants');

const ID = 'breezy';

// Fold Breezy's structured is_remote flag into the location string so the
// canonical classifier sees the explicit remote signal (a board listing a city
// can be is_remote:true, so trust the flag over the city).
function breezyLocation(loc) {
  if (!loc) return '';
  const base = loc.name ||
    [loc.city, loc.state && loc.state.name, loc.country && loc.country.name].filter(Boolean).join(', ');
  if (loc.is_remote) return base ? `Remote - ${base}` : 'Remote';
  return base;
}

async function fetchBoard(sub) {
  const res = await fetch(`https://${sub}.breezy.hr/json`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function discover(ctx) {
  const { logger } = ctx;
  if (!roleStrings(ctx, { max: 1 }).length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const tenants = loadTenants(ctx, ID);
  if (!tenants.length) { logger.info(`[${ID}] no tenants (seed "breezy" in data/companies/portals.json or let the company index learn them); skipping`); return []; }
  const titleOk = makeTitleMatcher(ctx);
  logger.info(`[${ID}] scanning ${tenants.length} Breezy boards`);

  const all = [];
  const seen = new Set();
  for (const t of tenants) {
    const sub = t.slug;
    try {
      const jobs = await fetchBoard(sub);
      if (Array.isArray(jobs)) {
        for (const j of jobs) {
          const title = j.name;
          if (!title || !titleOk(title) || !j.url) continue;
          const p = createPosting({
            title,
            company: (j.company && j.company.name) || t.name || prettify(sub),
            companySlug: (j.company && j.company.friendly_id) || sub,
            location: breezyLocation(j.location),
            url: j.url,
            department: j.department || null,
            postedDate: j.published_date,
            jdText: null,                 // list endpoint has no description; enriched lazily
            compensation: (typeof j.salary === 'string' && j.salary.trim()) ? j.salary.trim() : null,
            sourceUrl: `https://${sub}.breezy.hr/json`,
            sourceQuery: `breezy:${sub}`,
          }, ID);
          if (p && !seen.has(p.canonicalUrl)) { seen.add(p.canonicalUrl); all.push(p); }
        }
      }
    } catch (err) {
      logger.warn(`[${ID}] ${sub}: ${err.message}`);
    }
    await sleep(300); // ponytail: fixed 300ms pace; Breezy throttles rapid bursts. Tune if a large tenant list makes runs slow.
  }
  logger.info(`[${ID}] -> ${all.length} matching postings from ${tenants.length} boards`);
  return all;
}

module.exports = {
  id: ID,
  name: 'Breezy HR Direct',
  requires: [],
  rateLimit: { rpm: 40 },
  discover,
};
