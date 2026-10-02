/**
 * Source: The Muse (public jobs API).
 *
 * Endpoint: GET https://www.themuse.com/api/public/jobs
 *   ?page=<n>[&category=<cat>][&location=Flexible%20/%20Remote]
 * Docs: https://www.themuse.com/developers/api/v2 (free; no key needed for
 * modest use).
 *
 * The API has no keyword search, only category and location facets, so the
 * feed is paged and titles are filtered locally against the user's seed roles.
 * No category is sent by default (a category list is a field filter). To narrow
 * the feed to your field, set THEMUSE_CATEGORIES to a comma separated list of
 * the site's own category names, for example
 *   THEMUSE_CATEGORIES="Healthcare,Accounting and Finance"
 * The remote location facet is sent only when the user's work mode policy is
 * exactly remote. Country eligibility is left to the downstream gate:
 * "Flexible / Remote" alone names no place (kept for JD verification), while an
 * accompanying city classifies normally.
 *
 * Response shape: { page_count, results: [{ name, company:{name},
 *   locations:[{name}], refs:{landing_page}, publication_date, contents,
 *   categories:[{name}], levels:[{name}] }] }
 */

const { createPosting, stripHtml } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { recencyDays, withinAge } = require('../../../lib/profile');

const ID = 'themuse';

const PAGES = 2;            // most recent pages per category
// ponytail: fixed depth for the feed with no category (20 jobs per page, so a
// thin slice of a large feed). Set THEMUSE_CATEGORIES for real recall; raise
// this if the unscoped feed proves worth more requests.
const PAGES_UNSCOPED = 5;

function categories(env = process.env) {
  return String(env.THEMUSE_CATEGORIES || '').split(',').map(s => s.trim()).filter(Boolean);
}

function locationString(j, remoteOnly) {
  const locs = Array.isArray(j.locations) ? j.locations.map(l => l && l.name).filter(Boolean) : [];
  // No location on a row from the remote facet means remote; otherwise unknown.
  if (!locs.length) return remoteOnly ? 'Remote' : '';
  // Normalize The Muse "Flexible / Remote" into a Remote label the gate reads.
  return locs.map(l => (/flexible\s*\/\s*remote/i.test(l) ? 'Remote' : l)).join(', ');
}

function searchParams(category, page, remoteOnly) {
  const qs = new URLSearchParams({ page: String(page) });
  if (category) qs.set('category', category);
  if (remoteOnly) qs.set('location', 'Flexible / Remote');
  return qs;
}

async function fetchPage(qs) {
  const res = await fetch(`https://www.themuse.com/api/public/jobs?${qs}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`The Muse ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function discover(ctx) {
  const { logger } = ctx;
  const filters = ctx.filters || {};
  const maxAgeDays = recencyDays(filters);
  const remoteOnly = filters.remoteOnly === true;
  if (!roleStrings(ctx, { max: 1 }).length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const titleOk = makeTitleMatcher(ctx);
  const cats = categories();
  const scopes = cats.length ? cats : [null];
  const pages = cats.length ? PAGES : PAGES_UNSCOPED;
  const all = [];

  for (const category of scopes) {
    const label = category || 'all categories';
    for (let page = 0; page < pages; page++) {
      try {
        const results = await fetchPage(searchParams(category, page, remoteOnly));
        if (!results.length) break;
        let kept = 0;
        for (const j of results) {
          const title = j.name || '';
          if (!titleOk(title)) continue;
          if (!withinAge(j.publication_date, maxAgeDays)) continue;
          const p = createPosting({
            title,
            company: j.company && j.company.name,
            location: locationString(j, remoteOnly),
            url: j.refs && j.refs.landing_page,
            postedDate: j.publication_date,
            sourceUrl: `https://www.themuse.com/api/public/jobs?${searchParams(category, page, remoteOnly)}`,
            sourceQuery: `${category || 'all'}:page${page}`,
            jdText: stripHtml(j.contents).slice(0, 4000),
            compensation: null,
          }, ID);
          if (p) { all.push(p); kept++; }
        }
        logger.info(`[${ID}] "${label}" page ${page} -> ${results.length} jobs, ${kept} matching within ${maxAgeDays ? maxAgeDays + 'd' : 'any age'}`);
        await new Promise(r => setTimeout(r, 1200));
      } catch (err) {
        logger.warn(`[${ID}] "${label}" page ${page} failed: ${err.message}`);
        break;
      }
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'The Muse (public jobs API)',
  requires: [],
  rateLimit: { rpm: 30 },
  discover,
  __test: { categories, searchParams, locationString },
};
