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
 * Company IDs live in data/companies/non-tech-seed.json under `smartrecruiters`.
 */

const path = require('path');
const fs = require('fs');
const { createPosting } = require('../../../lib/posting');
const { getProjectRoot } = require('../../../lib/config');

const ID = 'smartrecruiters';
const ML_REGEX = /\b(machine learning|ml engineer|ai engineer|applied scien|research engineer|research scien|data scien|mlops|llm|genai|deep learning|computer vision|nlp|quantitative research|advanced analytics|principal data|computational biolog|bioinformatic|member of technical staff)\b/i;
const KEYWORDS = ['machine learning', 'data scientist', 'artificial intelligence', 'mlops'];

function loadCompanies() {
  const p = path.join(getProjectRoot(), 'data/companies/non-tech-seed.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data.smartrecruiters || [];
  } catch {
    return [];
  }
}

async function fetchPostings(companyId, q) {
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyId)}/postings?q=${encodeURIComponent(q)}&limit=100&offset=0`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; JobeDiscovery/1.0)' },
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
  logger.info(`[${ID}] scanning ${companies.length} SmartRecruiters companies`);

  const all = [];
  const seen = new Set();
  for (const c of companies) {
    let found = 0;
    for (const q of KEYWORDS) {
      try {
        const data = await fetchPostings(c.companyId, q);
        if (!data || !Array.isArray(data.content)) continue;
        for (const p of data.content) {
          const title = p.name || p.title;
          if (!title || !ML_REGEX.test(title)) continue;
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
      logger.info(`[${ID}] ${c.companyId} (${c.industry || '?'}) -> ${found} ML roles`);
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
