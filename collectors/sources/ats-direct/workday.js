/**
 * Source: Workday direct (multi-tenant).
 *
 * Workday boards expose a public JSON search API used by their own SPA:
 *   POST https://{host}/wday/cxs/{tenant}/{site}/jobs
 *   body: { appliedFacets, limit, offset, searchText }
 * Response shape:
 *   { total, jobPostings: [{ title, externalPath, locationsText, postedOn, ... }] }
 *
 * Tenant config lives in data/companies/non-tech-seed.json under `workday`.
 * Per-tenant failures (404, timeout, site rename) are logged and skipped.
 * The pipeline continues with the remaining tenants.
 *
 * Role detail:
 *   GET https://{host}/wday/cxs/{tenant}/{site}/job{externalPath}
 *   returns { jobPostingInfo: { jobDescription, ... } } — used lazily by enrich().
 *   The collector only emits listing metadata; JD text is left to enrich.
 */

const path = require('path');
const fs = require('fs');
const { createPosting } = require('../../../lib/posting');
const { getProjectRoot } = require('../../../lib/config');

const ID = 'workday';
const ML_KEYWORDS = [
  'machine learning',
  'artificial intelligence',
  'data scientist',
  'ai engineer',
  'mlops',
  'deep learning',
  'quantitative researcher',
  'generative ai'
];
const ML_REGEX = /\b(machine learning|ml engineer|ai engineer|applied scien|research engineer|research scien|data scien|mlops|llm|genai|deep learning|computer vision|nlp|quantitative research|quantitative analyst|advanced analytics|principal data|computational biolog|bioinformatic|member of technical staff)\b/i;

function loadTenants() {
  const p = path.join(getProjectRoot(), 'data/companies/non-tech-seed.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data.workday || [];
  } catch {
    return [];
  }
}

async function searchTenant(tenant, searchText, limit = 20) {
  const url = `https://${tenant.host}/wday/cxs/${tenant.tenant}/${tenant.site}/jobs`;
  const body = JSON.stringify({
    appliedFacets: {},
    limit,
    offset: 0,
    searchText
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; JobeDiscovery/1.0)'
    },
    body,
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) return null;
  return res.json();
}

function buildUrl(tenant, job) {
  const ext = job.externalPath || '';
  if (!ext) return null;
  // externalPath looks like "/job/Location/Title_R-12345" — full public URL is
  // https://{host}/{site}/job/Location/Title_R-12345
  const clean = ext.startsWith('/') ? ext : `/${ext}`;
  return `https://${tenant.host}/${tenant.site}${clean}`;
}

async function discover(ctx) {
  const { queries, logger } = ctx;
  const tenants = loadTenants();
  if (tenants.length === 0) {
    logger.info(`[${ID}] no Workday tenants seeded (data/companies/non-tech-seed.json); skipping`);
    return [];
  }

  logger.info(`[${ID}] scanning ${tenants.length} Workday tenants`);

  // Workday returns generous match sets on each search; broad terms beat
  // specific ones. Cap at 3 terms per tenant to keep request volume sane.
  const terms = ['machine learning', 'data scientist', 'artificial intelligence'];

  const all = [];
  const seenUrls = new Set();

  for (const tenant of tenants) {
    let tenantFound = 0;
    let totalSeen = 0;
    for (const term of terms) {
      try {
        const data = await searchTenant(tenant, term, 20);
        if (!data || !Array.isArray(data.jobPostings)) continue;
        totalSeen += data.jobPostings.length;
        for (const j of data.jobPostings) {
          if (!ML_REGEX.test(j.title || '')) continue;
          const url = buildUrl(tenant, j);
          if (!url || seenUrls.has(url)) continue;
          seenUrls.add(url);
          const p = createPosting({
            title: j.title,
            company: tenant.company,
            companySlug: tenant.tenant,
            location: j.locationsText || j.locations?.[0]?.name || '',
            url,
            postedDate: j.postedOn || j.startDate,
            sourceUrl: `https://${tenant.host}/wday/cxs/${tenant.tenant}/${tenant.site}/jobs`,
            sourceQuery: `workday:${tenant.tenant}:${term}`
          }, ID);
          if (p) {
            all.push(p);
            tenantFound++;
          }
        }
      } catch (err) {
        logger.warn(`[${ID}] ${tenant.tenant}/${term}: ${err.message}`);
      }
    }
    if (tenantFound > 0) {
      logger.info(`[${ID}] ${tenant.tenant} (${tenant.industry || '?'}) -> ${tenantFound} ML roles (scanned ${totalSeen})`);
    }
  }
  return all;
}

module.exports = {
  id: ID,
  name: 'Workday Direct (non-tech)',
  requires: [],
  rateLimit: { rpm: 60 },
  discover
};
