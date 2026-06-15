/**
 * Source: Brave Search API with site: operator (keyword-driven discovery).
 *
 * Functional equivalent of serpapi-site-search.js but using Brave Search API
 * (api.search.brave.com). Free tier: 2,000 queries/month. No card required.
 * Get a key at https://api.search.brave.com.
 *
 * Why both Brave and SerpAPI: Brave's free tier is enough for ~10 full
 * pipeline runs/month. SerpAPI's free tier is 100 queries/month total,
 * which gets exhausted in one pipeline run. Brave is the higher-recall
 * default for users without a paid SerpAPI subscription.
 *
 * Coverage: identical surface to serpapi-site-search.js — runs site-scoped
 * keyword queries against ATS domains (Greenhouse, Lever, Ashby, Workday,
 * SmartRecruiters, JobVite, iCIMS) plus major company career pages plus
 * startup aggregators (Wellfound, Workatastartup, AIJobs, MLBuddies).
 *
 * Endpoint: GET https://api.search.brave.com/res/v1/web/search
 * Headers: X-Subscription-Token: <BRAVE_API_KEY>
 * Response: { web: { results: [{ url, title, description, age, ... }] } }
 */

const { createPosting } = require('../../../lib/posting');
const {
  ATS_DOMAINS, COMPANY_SITES, STARTUP_SITES
} = require('./serpapi-site-search');
const { roleStrings } = require('../../../lib/role-queries');

const ID = 'brave-search';

// Roles come from the user's seeds (ctx.queries) — no hardcoded role vocabulary.
// Each role becomes its own per-ATS query (no OR-megaquery) so Brave's ranking
// surfaces specialty roles instead of drowning them under the commonest term.
// Cap the role count so a long seed list does not blow the Brave free tier
// (~2000 queries/month): queries ~= ATS_DOMAINS x roles + company/startup sites.
const MAX_ROLES = 8;

// ── Fetch ───────────────────────────────────────────────────

async function braveFetch(query, apiKey, freshness = 'pm') {
  const qs = new URLSearchParams({
    q: query,
    count: 20,
    country: 'us',
    search_lang: 'en',
    // Recency is expressed via Brave's own `freshness` parameter (either a
    // preset like 'pm' = past month, or a 'YYYY-MM-DDtoYYYY-MM-DD' range).
    // Brave does NOT support Google's `after:` operator -- appending it to the
    // query string makes Brave treat "after:2026-05-06" as a literal keyword,
    // which collapsed recall to near-zero (most pages never contain that text).
    freshness,
    text_decorations: 'false',
    safesearch: 'off',
  });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${qs}`, {
    headers: {
      'X-Subscription-Token': apiKey,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function dateCutoff(maxAgeDays) {
  const d = new Date();
  d.setDate(d.getDate() - maxAgeDays);
  return d.toISOString().slice(0, 10);
}

// Brave freshness range: 'YYYY-MM-DDtoYYYY-MM-DD'. Falls back to the 'pm'
// preset when no age window is supplied.
function freshnessFor(maxAgeDays) {
  if (!maxAgeDays) return 'pm';
  const today = new Date().toISOString().slice(0, 10);
  return `${dateCutoff(maxAgeDays)}to${today}`;
}

function siteClauseFor(domain) {
  if (domain.raw) return `site:${domain.raw}`;
  const [host, ...rest] = domain.site.split('/');
  return rest.length ? `site:${host} inurl:${rest.join('/')}` : `site:${host}`;
}

function buildSiteQueries(queries, filters) {
  // Roles come from the user's seeds. With none, there is nothing to search.
  const roles = roleStrings({ queries }, { max: MAX_ROLES, quoted: true });
  if (!roles.length) return [];

  // The "remote" keyword biases Brave's ranking toward remote roles, but we no
  // longer fabricate a location string from it -- a search hint is not evidence
  // the posting is remote. Location is left empty so the canonical schema marks
  // it 'unknown' and enrichment verifies it from the real JD.
  const remoteHint = filters.remoteOnly ? ' remote' : '';
  const location = '';
  const out = [];

  // ATS domains: one query per (domain, role) so single-role queries surface
  // specialty roles that an OR-megaquery would drown under the commonest term.
  for (const domain of ATS_DOMAINS) {
    const site = siteClauseFor(domain);
    for (const role of roles) {
      out.push({ query: `${site} ${role}${remoteHint}`, domain, location });
    }
  }

  // Company + startup sites: OR the user's roles; broad enumeration is fine.
  const orClause = roles.join(' OR ');
  for (const domain of [...COMPANY_SITES, ...STARTUP_SITES]) {
    const site = siteClauseFor(domain);
    out.push({ query: `${site} (${orClause})${remoteHint}`, domain, location });
  }

  return out;
}

function extractCompanyFromUrl(url, domain) {
  if (domain.extractCompany) {
    const m = url.match(domain.extractCompany);
    if (m && m[domain.slugField]) return slugToName(m[domain.slugField]);
  }
  if (domain.company) return domain.company;
  // Workday URL pattern: {tenant}.wd*.myworkdayjobs.com — extract tenant
  const wd = url.match(/^https?:\/\/([^./]+)\.wd\d+\.myworkdayjobs\.com/i);
  if (wd) return slugToName(wd[1]);
  // SmartRecruiters: jobs.smartrecruiters.com/{company}/{id}
  const sr = url.match(/jobs\.smartrecruiters\.com\/([^/]+)/i);
  if (sr) return slugToName(sr[1]);
  return null;
}

function slugToName(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function extractLocation(text) {
  if (!text) return '';
  const m = text.match(/\b(in|at|-|\|)\s*([A-Z][A-Za-z ]+,\s*[A-Z]{2}|Remote|United States|Anywhere)/);
  return m ? m[2] : '';
}

// ── discover ────────────────────────────────────────────────

async function discover(ctx) {
  const { queries, filters, auth, logger } = ctx;
  const apiKey = auth.braveApiKey || process.env.BRAVE_API_KEY;
  if (!apiKey) { logger.warn(`[${ID}] skipped: no BRAVE_API_KEY`); return []; }

  const siteQueries = buildSiteQueries(queries, filters);
  const freshness = freshnessFor(filters.maxAgeDays);
  logger.info(`[${ID}] running ${siteQueries.length} Brave site-scoped queries (freshness=${freshness})`);

  const all = [];
  let queryIdx = 0;
  for (const { query, domain, location } of siteQueries) {
    queryIdx++;
    try {
      const data = await braveFetch(query, apiKey, freshness);
      const results = data.web?.results || [];
      logger.info(`[${ID}] q${queryIdx}/${siteQueries.length} -> ${results.length} results: ${query.slice(0, 80)}...`);
      for (const r of results) {
        const company = extractCompanyFromUrl(r.url, domain) || 'Unknown';
        const postedHint = r.age || (r.description || '').match(/\d+\s*(day|week|month)s?\s*ago|today|yesterday/i)?.[0];
        const p = createPosting({
          title: r.title?.replace(/\s*[|-]\s*(Jobs|Careers|.*?\bat\b.*)$/i, '').trim(),
          company,
          location: extractLocation(r.description) || location,
          url: r.url,
          postedDate: postedHint || null,
          sourceUrl: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`,
          sourceQuery: query,
          jdText: (r.description || '').slice(0, 1000),
        }, ID);
        if (p) all.push(p);
      }
      // Brave free tier: 1 query/sec
      await new Promise(r => setTimeout(r, 1100));
    } catch (err) {
      logger.warn(`[${ID}] query failed: ${err.message}`);
    }
  }

  // Dedup within source
  const seen = new Set();
  return all.filter(p => {
    if (seen.has(p.canonicalUrl)) return false;
    seen.add(p.canonicalUrl);
    return true;
  });
}

module.exports = {
  id: ID,
  name: 'Brave Search site:scoped (ATS + company + startup domains)',
  requires: ['BRAVE_API_KEY'],
  rateLimit: { rpm: 50 },  // Brave free tier: 1 qps == 60 rpm; conservative 50
  discover,
};
