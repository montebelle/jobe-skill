/**
 * Source: SerpAPI Google Search with site: operator.
 *
 * Replacement for the hardcoded portals.json whitelist. Runs site-scoped
 * keyword searches against ATS domains and company career sites, returning
 * every matching posting across EVERY customer of that ATS, not just the
 * ones we had configured.
 *
 * One query like:
 *   site:job-boards.greenhouse.io "Senior Machine Learning Engineer" "New York" after:2026-03-22
 * returns postings across all Greenhouse customers that match — no slug list required.
 *
 * We also run site: queries against major company career sites (Google, Meta,
 * Amazon, Apple, Netflix, Stripe, OpenAI, etc.) whose public APIs are either
 * private or unreliable.
 */

const { createPosting } = require('../../../lib/posting');

const ID = 'serpapi-site-search';

// ── ATS domain configurations ───────────────────────────────

const ATS_DOMAINS = [
  { site: 'job-boards.greenhouse.io', extractCompany: /greenhouse\.io\/([^/]+)\/jobs/i, slugField: 1 },
  { site: 'boards.greenhouse.io',     extractCompany: /greenhouse\.io\/([^/]+)\/jobs/i, slugField: 1 },
  { site: 'jobs.lever.co',            extractCompany: /jobs\.lever\.co\/([^/]+)/i, slugField: 1 },
  { site: 'jobs.ashbyhq.com',         extractCompany: /jobs\.ashbyhq\.com\/([^/]+)/i, slugField: 1 },
  { site: 'myworkdayjobs.com' },
  { site: 'smartrecruiters.com/[^/]+/jobs', raw: 'smartrecruiters.com' },
  { site: 'jobvite.com' },
  { site: 'icims.com' },
];

// ── Major-company direct career sites (search via google site:) ──

const COMPANY_SITES = [
  { site: 'careers.google.com/jobs/results', company: 'Google' },
  { site: 'metacareers.com/jobs',            company: 'Meta' },
  { site: 'amazon.jobs/en/jobs',             company: 'Amazon' },
  { site: 'jobs.apple.com/en-us/details',    company: 'Apple' },
  { site: 'jobs.netflix.com/jobs',           company: 'Netflix' },
  { site: 'stripe.com/jobs/listing',         company: 'Stripe' },
  { site: 'openai.com/careers',              company: 'OpenAI' },
  { site: 'deepmind.com/careers',            company: 'DeepMind' },
  { site: 'anthropic.com/jobs',              company: 'Anthropic' },
  { site: 'xai.com/careers',                 company: 'xAI' },
  { site: 'nvidia.com/en-us/about-nvidia/careers', company: 'NVIDIA' },
];

// ── Startup / AI-specific aggregator sites ──────────────────

const STARTUP_SITES = [
  { site: 'wellfound.com/jobs', tag: 'wellfound' },
  { site: 'workatastartup.com/jobs', tag: 'ycombinator' },
  { site: 'aijobs.net', tag: 'aijobs' },
  { site: 'mlbuddies.com/jobs', tag: 'mlbuddies' },
];

// ── Fetch ───────────────────────────────────────────────────

async function serpFetch(params, apiKey) {
  const qs = new URLSearchParams({ ...params, api_key: apiKey, engine: 'google' });
  const res = await fetch(`https://serpapi.com/search.json?${qs}`);
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  return res.json();
}

function dateCutoff(maxAgeDays) {
  const d = new Date();
  d.setDate(d.getDate() - maxAgeDays);
  return d.toISOString().slice(0, 10);
}

// Per-(domain, role) fan-out, same shape as brave-search.js. SerpAPI free
// tier is 100/month so we use a smaller pattern set than Brave; users on
// paid plans can still benefit from the extra recall without hitting limits.
const SERP_ROLE_PATTERNS = [
  '"senior machine learning engineer"',
  '"staff machine learning engineer"',
  '"senior data scientist"',
  '"senior ai engineer"',
];
const SERP_FALLBACK_OR = '"machine learning engineer" OR "ai engineer" OR "data scientist" OR "applied scientist"';

function siteClauseFor(domain) {
  if (domain.raw) return `site:${domain.raw}`;
  const [host, ...rest] = domain.site.split('/');
  return rest.length ? `site:${host} inurl:${rest.join('/')}` : `site:${host}`;
}

function buildSiteQueries(queries, filters) {
  const afterClause = filters.maxAgeDays ? ` after:${dateCutoff(filters.maxAgeDays)}` : '';
  const out = [];
  const locations = [...new Set(queries.map(q => q.location).filter(Boolean))];
  const remoteHint = filters.remoteOnly ? ' remote' : '';

  for (const domain of ATS_DOMAINS) {
    const site = siteClauseFor(domain);
    for (const role of SERP_ROLE_PATTERNS) {
      out.push({
        query: `${site} ${role}${remoteHint}${afterClause}`,
        domain,
        location: filters.remoteOnly ? 'Remote' : (locations[0] || ''),
      });
    }
  }

  for (const domain of [...COMPANY_SITES, ...STARTUP_SITES]) {
    const site = siteClauseFor(domain);
    out.push({
      query: `${site} (${SERP_FALLBACK_OR})${remoteHint}${afterClause}`,
      domain,
      location: filters.remoteOnly ? 'Remote' : (locations[0] || ''),
    });
  }
  return out;
}

function extractCompanyFromUrl(url, domain) {
  if (domain.extractCompany) {
    const m = url.match(domain.extractCompany);
    if (m && m[domain.slugField]) return slugToName(m[domain.slugField]);
  }
  if (domain.company) return domain.company;
  return null;
}

function slugToName(slug) {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Extract location from the page title/snippet (often contains "Company | Location")
function extractLocation(text) {
  if (!text) return '';
  const m = text.match(/\b(in|at|-|\|)\s*([A-Z][A-Za-z ]+,\s*[A-Z]{2}|Remote|United States|Anywhere)/);
  return m ? m[2] : '';
}

// ── discover ────────────────────────────────────────────────

async function discover(ctx) {
  const { queries, filters, auth, logger } = ctx;
  if (!auth.serpApiKey) { logger.warn(`[${ID}] skipped: no SERPAPI_KEY`); return []; }

  const siteQueries = buildSiteQueries(queries, filters);
  logger.info(`[${ID}] running ${siteQueries.length} site-scoped queries`);

  const all = [];
  for (const { query, domain, location } of siteQueries) {
    try {
      const data = await serpFetch({ q: query, num: 20, hl: 'en' }, auth.serpApiKey);
      const results = data.organic_results || [];
      for (const r of results) {
        const company = extractCompanyFromUrl(r.link, domain) || 'Unknown';
        const postedHint = (r.date || r.snippet || '').match(/\d+\s*(day|week|month)s?\s*ago|today|yesterday/i);
        const p = createPosting({
          title: r.title?.replace(/\s*[|-]\s*(Jobs|Careers|.*?\bat\b.*)$/i, '').trim(),
          company,
          location: extractLocation(r.snippet) || location,
          url: r.link,
          postedDate: postedHint ? postedHint[0] : null,
          sourceUrl: `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}`,
          sourceQuery: query,
          jdText: (r.snippet || '').slice(0, 1000),
        }, ID);
        if (p) all.push(p);
      }
    } catch (err) {
      logger.warn(`[${ID}] query failed: ${err.message}`);
    }
  }

  const seen = new Set();
  return all.filter(p => {
    if (seen.has(p.canonicalUrl)) return false;
    seen.add(p.canonicalUrl);
    return true;
  });
}

module.exports = {
  id: ID,
  name: 'SerpAPI site: search (ATS + company + startup domains)',
  requires: ['SERPAPI_KEY'],
  rateLimit: { rpm: 60 },
  discover,
  ATS_DOMAINS, COMPANY_SITES, STARTUP_SITES,
};
