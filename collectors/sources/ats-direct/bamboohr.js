/**
 * Source: BambooHR direct (hosted careers sites, one tenant per subdomain).
 *
 * Every BambooHR hosted careers site exposes two public JSON endpoints its own
 * widget calls:
 *   GET https://{sub}.bamboohr.com/careers/list
 *     -> { meta:{totalCount}, result:[ { id, jobOpeningName, departmentLabel,
 *          employmentStatusLabel, location:{city,state}, atsLocation, isRemote,
 *          locationType } ] }        // listing only, NO date/description
 *   GET https://{sub}.bamboohr.com/careers/{id}/detail
 *     -> { result:{ jobOpening:{ jobOpeningShareUrl, datePosted, description,
 *          compensation, location:{city,state,postalCode,addressCountry}, ... } } }
 *
 * The list carries no posted date or JD, and lib/enrich.js has no BambooHR
 * extractor, so the recency and work mode gates downstream would have nothing
 * to test. /detail is therefore fetched for the (small) set of openings whose
 * title matches the user's seed roles, to attach datePosted + JD + location +
 * compensation. A subdomain that is not a customer redirects to the vendor
 * site, so redirects are not followed and only a 200 JSON body counts. The
 * vendor's shared demo tenant (served for some such subdomains) is
 * fingerprinted and skipped.
 *
 * Tenants come from lib/ats-tenants.js (ctx.filters.atsSlugs.bamboohr, the
 * portals seed files, the workspace company index). No tenant list ships. The
 * careers/list JSON exposes NO company name and a guessed subdomain can belong
 * to an unrelated company, so seed a tenant as { "slug": ..., "name": ... }
 * when the subdomain is not the company name. Keyless.
 */

const { createPosting, stripHtml } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { loadTenants, prettify } = require('../../../lib/ats-tenants');

const ID = 'bamboohr';
const UA = 'jobe-discovery/1.0 (personal job search)';

const MAX_DETAIL_PER_TENANT = 30; // bound detail fetches per company

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': UA },
    redirect: 'manual',                 // subdomains with no customer redirect to the vendor site
    signal: AbortSignal.timeout(12000),
  });
  if (res.status !== 200) return null;
  try { return JSON.parse(await res.text()); } catch { return null; }
}

// Fingerprint of the vendor's shared demo tenant.
function isDemo(result) {
  const j = result[0] || {};
  return j.jobOpeningName === 'IT Security Engineer' && j.location && j.location.city === 'Mayfair';
}

function buildLocation(loc, atsLoc, isRemote) {
  const l = loc || {};
  const a = atsLoc || {};
  const parts = [l.city || a.city, l.state || a.state || a.province, l.addressCountry || a.country]
    .filter(Boolean);
  const text = [...new Set(parts)].join(', ');
  if (isRemote === true) return text ? `Remote - ${text}` : 'Remote';
  return text;
}

function comp(c) {
  if (!c) return null;
  if (typeof c === 'string') return c.trim() || null;
  if (typeof c === 'object' && (c.min || c.max)) return { min: c.min, max: c.max, currency: c.currency || null };
  return null;
}

async function discover(ctx) {
  const { logger } = ctx;
  if (!roleStrings(ctx, { max: 1 }).length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const tenants = loadTenants(ctx, ID);
  if (!tenants.length) { logger.info(`[${ID}] no tenants (seed "bamboohr" in data/companies/portals.json or let the company index learn them); skipping`); return []; }
  const titleOk = makeTitleMatcher(ctx);
  logger.info(`[${ID}] scanning ${tenants.length} BambooHR boards`);

  const all = [];
  for (const t of tenants) {
    const sub = t.slug;
    const company = t.name || prettify(sub);
    let found = 0;
    try {
      const list = await getJson(`https://${sub}.bamboohr.com/careers/list`);
      const result = list && Array.isArray(list.result) ? list.result : null;
      if (!result || result.length === 0) continue;
      if (isDemo(result)) { logger.warn(`[${ID}] ${sub}: shared demo tenant, skipping`); continue; }

      const matched = result.filter(j => j && titleOk(j.jobOpeningName || ''))
        .slice(0, MAX_DETAIL_PER_TENANT);
      for (const j of matched) {
        const id = j.id;
        let url = `https://${sub}.bamboohr.com/careers/${id}`;
        let postedDate = null, jdText = null, compensation = null;
        let location = buildLocation(j.location, j.atsLocation, j.isRemote === true);
        const detail = await getJson(`https://${sub}.bamboohr.com/careers/${id}/detail`);
        const jo = detail && detail.result && detail.result.jobOpening;
        if (jo) {
          if (jo.jobOpeningShareUrl) url = jo.jobOpeningShareUrl;
          postedDate = jo.datePosted || null;
          jdText = jo.description ? stripHtml(jo.description).slice(0, 8000) : null;
          compensation = comp(jo.compensation);
          // Preserve the list entry's remote flag: the /detail record often omits
          // isRemote while still carrying an office city, which would otherwise
          // reclassify a remote role as onsite.
          const loc = buildLocation(jo.location, jo.atsLocation, jo.isRemote === true || j.isRemote === true);
          if (loc) location = loc;
        }
        const p = createPosting({
          title: j.jobOpeningName,
          company,
          companySlug: sub,
          location,
          url,
          department: j.departmentLabel || null,
          postedDate,
          jdText,
          compensation,
          sourceUrl: `https://${sub}.bamboohr.com/careers/list`,
          sourceQuery: `bamboohr:${sub}`,
        }, ID);
        if (p) { all.push(p); found++; }
      }
    } catch (err) {
      logger.warn(`[${ID}] ${sub}: ${err.message}`);
    }
    if (found > 0) logger.info(`[${ID}] ${sub} (${company}) -> ${found} matching roles`);
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'BambooHR Direct (hosted careers)',
  requires: [],
  rateLimit: { rpm: 40 },
  discover,
};
