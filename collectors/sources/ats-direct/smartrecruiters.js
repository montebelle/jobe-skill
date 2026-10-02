/**
 * Source: SmartRecruiters direct (multi-tenant).
 *
 * Public postings API:
 *   GET https://api.smartrecruiters.com/v1/companies/{companyId}/postings
 *     ?q=<keywords>&limit=100&offset=0
 * Response:
 *   { content: [{ id, name, jobAd: { sections: { ... } }, location, releasedDate, ... }] }
 *
 * Posting URL pattern:
 *   https://jobs.smartrecruiters.com/{companyId}/{postingId}
 *
 * Company IDs live under `smartrecruiters` in data/companies/non-tech-seed.json:
 * the user's workspace copy first, then the shared copy (ships empty).
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { nonTechSeed } = require('../../seed-files');

const ID = 'smartrecruiters';

function loadCompanies() {
  return nonTechSeed('smartrecruiters').filter(c => c && c.companyId);
}

async function fetchPostings(companyId, q) {
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyId)}/postings?q=${encodeURIComponent(q)}&limit=100&offset=0`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; jobe-discovery/1.0; personal job search)' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) return null;
  return res.json();
}

async function discover(ctx) {
  const { logger } = ctx;
  const companies = loadCompanies();
  if (companies.length === 0) {
    logger.info(`[${ID}] no SmartRecruiters companies seeded; skipping`);
    return [];
  }
  const titleOk = makeTitleMatcher(ctx);
  const terms = roleStrings(ctx, { max: 4 });
  if (!terms.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  logger.info(`[${ID}] scanning ${companies.length} SmartRecruiters companies`);

  const all = [];
  const seen = new Set();
  for (const c of companies) {
    let found = 0;
    for (const q of terms) {
      try {
        const data = await fetchPostings(c.companyId, q);
        if (!data || !Array.isArray(data.content)) continue;
        for (const p of data.content) {
          const title = p.name || p.title;
          if (!title || !titleOk(title)) continue;
          const postingId = p.uuid || p.id || p.refNumber;
          if (!postingId) continue;
          const url = `https://jobs.smartrecruiters.com/${c.companyId}/${postingId}`;
          if (seen.has(url)) continue;
          seen.add(url);
          const locText = p.location ?
            [p.location.city, p.location.region, p.location.country].filter(Boolean).join(', ') :
            (p.locations || []).map(l => l.city).filter(Boolean).join('; ');
          const posting = createPosting({
            title,
            company: c.company,
            companySlug: c.companyId.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            location: locText,
            url,
            postedDate: p.releasedDate || p.createdOn,
            sourceUrl: `https://api.smartrecruiters.com/v1/companies/${c.companyId}/postings`,
            sourceQuery: `smartrecruiters:${c.companyId}:${q}`
          }, ID);
          if (posting) { all.push(posting); found++; }
        }
      } catch (err) {
        logger.warn(`[${ID}] ${c.companyId}/${q}: ${err.message}`);
      }
    }
    if (found > 0) {
      logger.info(`[${ID}] ${c.companyId} (${c.industry || '?'}) -> ${found} roles`);
    }
  }
  return all;
}

module.exports = {
  id: ID,
  name: 'SmartRecruiters Direct',
  requires: [],
  rateLimit: { rpm: 60 },
  discover
};
