/**
 * Source: SerpAPI Google Search with site: operator.
 *
 * Replacement for a hardcoded employer whitelist. Runs site-scoped keyword
 * searches against ATS domains, returning every matching posting across EVERY
 * customer of that ATS, not just the ones we had configured.
 *
 * One query like:
 *   site:job-boards.greenhouse.io "<one of the user's target roles>" after:YYYY-MM-DD
 * returns postings across all Greenhouse customers that match — no slug list
 * required. The roles are the user's own seeds (a nurse's seeds search nursing
 * titles, an accountant's search accounting titles).
 *
 * The same queries also run against the career sites the user listed in
 * discovery.companySites (data/profile.json). No site list ships with the
 * code; with none configured that fan out is skipped.
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings } = require('../../../lib/role-queries');
const { loadProfile } = require('../../../lib/profile');
const { searchCountry } = require('../../../lib/slug-harvest');

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

// ── Company career sites (search via site:) ─────────────────
// The user's own list: discovery.companySites in data/profile.json, which the
// pipeline passes as filters.companySites. An entry is a domain, optionally
// with a path ("careers.example.org", "example.org/jobs"), or an object
// { site, company }. Nothing ships here: an empty list means no company site
// queries at all.

function slugToName(slug) {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ponytail: the display name is the first host label that is not a generic
// careers prefix ("careers.example.org" -> "Example"). Wrong for an employer
// hosted under a department label; pass { site, company } to name it exactly.
function siteCompany(site) {
  const labels = site.split('/')[0].split('.').filter(l => !/^(www|careers?|jobs|apply|work)$/i.test(l));
  return slugToName(labels[0] || site);
}

function companySiteDomains(filters = {}) {
  const list = Array.isArray(filters.companySites) ? filters.companySites : loadProfile().discovery.companySites;
  const out = [];
  for (const e of list || []) {
    const raw = typeof e === 'string' ? e : (e && typeof e.site === 'string' ? e.site : '');
    const site = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!site) continue;
    out.push({ site, company: (e && typeof e.company === 'string' && e.company.trim()) || siteCompany(site) });
  }
  return out;
}

// ── Fetch ───────────────────────────────────────────────────

async function serpFetch(params, apiKey, attempt = 0) {
  const qs = new URLSearchParams({ ...params, api_key: apiKey, engine: 'google' });
  const res = await fetch(`https://serpapi.com/search.json?${qs}`);
  // 429 (hourly rate limit) / 5xx are transient: back off and retry so a
  // concurrent burst does not zero out the whole source. Respect Retry-After.
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const wait = retryAfter > 0 ? retryAfter : Math.min(2000 * 2 ** attempt, 15000);
    await new Promise((r) => setTimeout(r, wait));
    return serpFetch(params, apiKey, attempt + 1);
  }
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  return res.json();
}

function dateCutoff(maxAgeDays) {
  const d = new Date();
  d.setDate(d.getDate() - maxAgeDays);
  return d.toISOString().slice(0, 10);
}

// Per-(domain, role) fan-out, same shape as brave-search.js. SerpAPI's free
// tier is 100/month, so cap the role count tighter than Brave. Roles come from
// the user's seeds (ctx.queries) — no hardcoded role vocabulary.
const SERP_MAX_ROLES = 4;

function siteClauseFor(domain) {
  if (domain.raw) return `site:${domain.raw}`;
  const [host, ...rest] = domain.site.split('/');
  return rest.length ? `site:${host} inurl:${rest.join('/')}` : `site:${host}`;
}

function buildSiteQueries(queries, filters) {
  // Roles come from the user's seeds. With none, there is nothing to search.
  const roles = roleStrings({ queries }, { max: SERP_MAX_ROLES, quoted: true });
  if (!roles.length) return [];

  const afterClause = filters.maxAgeDays ? ` after:${dateCutoff(filters.maxAgeDays)}` : '';
  const out = [];
  const remoteHint = filters.remoteOnly ? ' remote' : '';

  // A hit is never stamped with a location it did not state: neither the
  // search hint nor a seed location is evidence of where a posting is. The
  // location stays empty (the posting reads "unknown") until the snippet or
  // enrichment supplies a real one.
  for (const domain of ATS_DOMAINS) {
    const site = siteClauseFor(domain);
    for (const role of roles) {
      out.push({ query: `${site} ${role}${remoteHint}${afterClause}`, domain, location: '' });
    }
  }

  // The user's own career sites: OR the roles, one query per site.
  const orClause = roles.join(' OR ');
  for (const domain of companySiteDomains(filters)) {
    const site = siteClauseFor(domain);
    out.push({ query: `${site} (${orClause})${remoteHint}${afterClause}`, domain, location: '' });
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
  // Search market: the single two letter code in the user's country list.
  const country = searchCountry(filters.countries);
  logger.info(`[${ID}] running ${siteQueries.length} site-scoped queries`);

  const all = [];
  for (const { query, domain, location } of siteQueries) {
    try {
      const data = await serpFetch({ q: query, num: 20, hl: 'en', ...(country ? { gl: country } : {}) }, auth.serpApiKey);
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
  name: 'SerpAPI site: search (ATS domains + the user\'s company sites)',
  requires: ['SERPAPI_KEY'],
  rateLimit: { rpm: 60 },
  discover,
  ATS_DOMAINS, companySiteDomains, buildSiteQueries,
};
