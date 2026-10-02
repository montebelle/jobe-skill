/**
 * Source: hiring.cafe (public job search aggregator, key free).
 *
 * hiring.cafe is a Next.js (Pages Router) app. Its filtered search is served
 * by getServerSideProps and exposed as pure JSON at the framework data route:
 *
 *   GET https://hiringcafe.com/_next/data/{buildId}/index.json
 *         ?searchState=<JSON.stringify(searchState)>&page=<n>
 *
 * The `POST /api/search-jobs` endpoint is behind a login token, so the SSR
 * data route is the only key free path. `buildId` changes on every deploy, so
 * it is scraped fresh from the homepage `__NEXT_DATA__` on each run (a stale id
 * 404s). hiring.cafe redirects to hiringcafe.com.
 *
 * searchState fields:
 *   searchQuery          free text semantic query
 *   workplaceTypes       ["Remote"] | ["Hybrid"] | ["Onsite"]
 *   locations            [ <place object> ]
 *   dateFetchedPastNDays integer recency window (-1 = no filter)
 *   sortBy               "default" | "Relevance"
 *
 * Response: { pageProps: { ssrHits: [ { apply_url, board_token,
 *   job_information: { title }, v5_processed_job_data: { company_name,
 *   workplace_type, workplace_countries, formatted_workplace_location,
 *   estimated_publish_date, yearly_min/max_compensation, requirements_summary,
 *   ... } } ], ssrIsLastPage, ssrTotalCount } }
 *
 * ROBOTS: hiringcafe.com/robots.txt disallows the `?searchState=` / `?page=`
 * URL pattern for all agents. The JSON itself is served without a login, so
 * this is the site's stated preference rather than a wall, and this source
 * honors it by default: it is OFF unless the user opts in with
 * HIRING_CAFE_OPT_IN=1 for personal, low volume use. When on it stays polite:
 * a descriptive User-Agent, a few role queries from the user's seeds, at most
 * 2 pages each, spaced requests, rpm capped.
 * ponytail: buildId scraped per run (fragile across a deploy in the middle of
 * a run); the run just returns [] if the id 404s, acceptable for discovery.
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { recencyDays } = require('../../../lib/profile');

const ID = 'hiring-cafe';
const HOST = 'https://hiringcafe.com';
const UA = 'jobe-discovery/1.0 (personal job search)';

const MAX_ROLES = 3;
const PAGES = 2;

// The country object the site's own search state uses to scope results to the
// United States (with worldwide remote flexibility). Sent only when the user's
// country policy is exactly the US.
// ponytail: no coordinates are sent and no other country is mapped. A single
// country policy other than the US searches without a location scope and
// relies on the pipeline's country gate. Upgrade path: build this object from
// filters.countries once the shape is confirmed for other countries.
const US_LOCATION = {
  formatted_address: 'United States',
  types: ['country'],
  id: 'user_country',
  address_components: [{ long_name: 'United States', short_name: 'US', types: ['country'] }],
  options: { flexible_regions: ['anywhere_in_continent', 'anywhere_in_world'] },
};

function optedIn(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.HIRING_CAFE_OPT_IN || '').trim());
}

async function getBuildId() {
  const res = await fetch(`${HOST}/`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`homepage ${res.status}`);
  const html = await res.text();
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error('buildId not found in __NEXT_DATA__');
  return m[1];
}

function comp(v) {
  // The currency is the one the listing states; with none the band carries no
  // currency label and the pay floor reads it as unknown.
  const code = v.listed_compensation_currency ? String(v.listed_compensation_currency).toUpperCase() : null;
  const cur = code ? ` ${code}` : '';
  const yMin = v.yearly_min_compensation, yMax = v.yearly_max_compensation;
  if (yMin && yMax) return { min: Math.round(yMin), max: Math.round(yMax), currency: code };
  if (yMin) return `${Math.round(yMin)}+${cur}`;
  const hMin = v.hourly_min_compensation, hMax = v.hourly_max_compensation;
  if (hMin && hMax) return `${Math.round(hMin)} - ${Math.round(hMax)}/hr${cur}`;
  return null;
}

// The feed lists countries as two letter codes; they are written as names so
// a code is never read as a US state ("DE", "CA", "IN").
const REGION = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (c) => { try { return REGION.of(c) || c; } catch { return c; } };

function loc(v) {
  const named = (Array.isArray(v.workplace_countries) ? v.workplace_countries : []).map(countryName);
  const type = String(v.workplace_type || '').toLowerCase();
  if (type === 'remote') return named.length ? `Remote - ${named.join('/')}` : 'Remote';
  const base = v.formatted_workplace_location || named.join(', ') || '';
  // The stated Hybrid type is folded into the string so parseLocation reads it.
  return type === 'hybrid' ? (base ? `${base} (Hybrid)` : 'Hybrid') : base;
}

function buildSearchState(query, filters) {
  const state = {
    searchQuery: query,
    sortBy: 'default',
  };
  const days = recencyDays(filters);
  if (days) state.dateFetchedPastNDays = days; // null: no recency cut, the site's own default window applies
  if (filters.remoteOnly) state.workplaceTypes = ['Remote'];
  if (filters.usOnly) state.locations = [US_LOCATION];
  return state;
}

async function fetchPage(buildId, query, filters, page) {
  const qs = new URLSearchParams({ searchState: JSON.stringify(buildSearchState(query, filters)), page: String(page) });
  const res = await fetch(`${HOST}/_next/data/${buildId}/index.json?${qs}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const data = await res.json();
  const pp = data.pageProps || {};
  return { hits: Array.isArray(pp.ssrHits) ? pp.ssrHits : [], isLast: pp.ssrIsLastPage !== false };
}

async function discover(ctx) {
  const { logger } = ctx;
  const filters = ctx.filters || {};
  const maxAgeDays = recencyDays(filters);

  // Robots gate (see header): off unless the user opts in explicitly.
  if (!optedIn()) {
    logger.warn(`[${ID}] off by default (robots.txt disallows its URL pattern); set HIRING_CAFE_OPT_IN=1 to enable`);
    return [];
  }
  const roles = roleStrings(ctx, { max: MAX_ROLES });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  // The search is semantic and returns loosely related titles, so titles are
  // filtered again here against the user's seed roles.
  const titleOk = makeTitleMatcher(ctx);

  let buildId;
  try {
    buildId = await getBuildId();
  } catch (err) {
    logger.warn(`[${ID}] buildId fetch failed: ${err.message}`);
    return [];
  }

  const all = [];
  for (const q of roles) {
    for (let page = 0; page < PAGES; page++) {
      let r;
      try {
        r = await fetchPage(buildId, q, filters, page);
      } catch (err) {
        logger.warn(`[${ID}] "${q}" p${page} failed: ${err.message}`);
        break;
      }
      let kept = 0;
      for (const j of r.hits) {
        const v = j.v5_processed_job_data || {};
        const title = (j.job_information && j.job_information.title) || v.core_job_title;
        if (!title || !titleOk(title)) continue;
        const postedIso = v.estimated_publish_date
          || (v.estimated_publish_date_millis ? new Date(v.estimated_publish_date_millis).toISOString() : null);
        const p = createPosting({
          title,
          company: v.company_name || j.board_token,
          location: loc(v),
          url: j.apply_url,
          postedDate: postedIso,
          sourceUrl: `${HOST}/`,
          sourceQuery: q,
          jdText: (v.requirements_summary || '').slice(0, 4000),
          compensation: comp(v),
        }, ID);
        if (p) { all.push(p); kept++; }
      }
      logger.info(`[${ID}] "${q}" p${page} -> ${r.hits.length} hits, ${kept} matching`);
      if (r.isLast || r.hits.length === 0) break;
      await new Promise(res => setTimeout(res, 800));
    }
  }

  const seen = new Set();
  const out = all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
  logger.info(`[${ID}] ${out.length} unique matching within ${maxAgeDays ? maxAgeDays + 'd' : 'any age'}`);
  return out;
}

module.exports = {
  id: ID,
  name: 'hiring.cafe (public job search aggregator)',
  requires: ['HIRING_CAFE_OPT_IN'], // robots.txt disallows the search URL pattern; off unless the user opts in
  rateLimit: { rpm: 12 },
  discover,
  __test: { buildSearchState, optedIn, comp, loc },
};
