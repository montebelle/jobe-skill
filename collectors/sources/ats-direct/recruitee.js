/**
 * Source: Recruitee direct API (public JSON per company).
 *
 * Endpoint: GET https://{sub}.recruitee.com/api/offers/  ->  { offers: [...] }
 * Keyless, public (the same feed that powers each company's careers page).
 * Recruitee asks only for a descriptive User-Agent; applications always go
 * through the offer's own careers_url.
 *
 * Fields per offer: { title, slug, careers_url, careers_apply_url,
 *   company_name, location, city, country, country_code, remote (bool),
 *   hybrid (bool), on_site (bool), department, published_at, created_at,
 *   salary: { min, max, currency, period }, description (HTML), status }
 *
 * Tenants come from lib/ats-tenants.js (ctx.filters.atsSlugs.recruitee, the
 * portals seed files, the workspace company index). No tenant list ships.
 * Titles are filtered against the user's seed roles. Recency is left to the
 * pipeline (company boards are low volume; a hard age cut here would starve
 * discovery), matching the Lever crawler.
 */

const { createPosting, stripHtml, companySlug } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { loadTenants, prettify } = require('../../../lib/ats-tenants');

const ID = 'recruitee';

async function fetchBoard(sub) {
  const url = `https://${sub}.recruitee.com/api/offers/`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return Array.isArray(j.offers) ? j.offers : null;
}

// Fold Recruitee's structured remote/hybrid flags into the location string so
// the canonical classifier (lib/posting.parseLocation) sees an explicit signal
// and keeps the country for the country check.
function recruiteeLocation(o) {
  const geo = [o.city, o.country].filter(Boolean).join(', ');
  if (o.remote) return geo ? `Remote - ${geo}` : 'Remote';
  if (o.hybrid) return geo ? `${geo} (Hybrid)` : 'Hybrid';
  return geo || o.location || '';
}

function comp(o) {
  const s = o.salary;
  // The period the feed states goes along: a monthly band is not a yearly
  // figure, and the pay floor reads any period other than a year as unknown.
  if (s && (s.min || s.max)) return { min: s.min, max: s.max, currency: s.currency || null, ...(s.period ? { period: String(s.period) } : {}) };
  return null;
}

async function discover(ctx) {
  const { logger, limiter } = ctx;
  if (!roleStrings(ctx, { max: 1 }).length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const tenants = loadTenants(ctx, ID);
  if (!tenants.length) { logger.info(`[${ID}] no tenants (seed "recruitee" in data/companies/portals.json or let the company index learn them); skipping`); return []; }
  const titleOk = makeTitleMatcher(ctx);
  logger.info(`[${ID}] scanning ${tenants.length} Recruitee boards`);

  const all = [];
  for (const t of tenants) {
    const sub = t.slug;
    if (limiter) await limiter.wait();
    try {
      const offers = await fetchBoard(sub);
      if (!offers) continue;
      let kept = 0;
      for (const o of offers) {
        if (!o || !o.title) continue;
        if (o.status && o.status !== 'published') continue;
        if (!titleOk(o.title)) continue;
        const company = o.company_name || t.name || prettify(sub);
        const p = createPosting({
          title: o.title,
          company,
          companySlug: companySlug(o.company_name || sub),
          location: recruiteeLocation(o),
          url: o.careers_url || `https://${sub}.recruitee.com/o/${o.slug}`,
          department: o.department,
          postedDate: o.published_at || o.created_at,
          jdText: stripHtml(o.description || '').slice(0, 8000),
          compensation: comp(o),
          sourceUrl: `https://${sub}.recruitee.com/api/offers/`,
          sourceQuery: `recruitee:${sub}`,
        }, ID);
        if (p) { all.push(p); kept++; }
      }
      if (kept) logger.info(`[${ID}] ${sub}: ${offers.length} offers -> ${kept} matching`);
    } catch (err) {
      logger.warn(`[${ID}] ${sub}: ${err.message}`);
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Recruitee Direct (public offers API per company)',
  requires: [],
  rateLimit: { rpm: 60 },
  discover,
};
