/**
 * Source: LinkedIn Jobs guest search (NO LOGIN, no account risk).
 *
 * Uses the public guest endpoint that powers linkedin.com/jobs for
 * logged-out visitors:
 *   GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
 *     ?keywords=...[&location=<country>][&f_WT=<work types>]&f_TPR=r<seconds>&start=0
 *
 * Params: f_WT (work type facet: 1 onsite, 2 remote, 3 hybrid), f_TPR=r<seconds>
 * (posted within), location, start (pagination, 25/page). The facet, the
 * country, and the recency window come from the user's discovery policy
 * (ctx.filters); with no policy the search carries no work type facet and no
 * location. The location is the country, except that an onsite or hybrid
 * search is run in the seed row's own place (else the user's first region):
 * a country wide search for work that needs the candidate on site returns
 * mostly rows the region gate then drops. Returns an HTML fragment of <li> job cards parsed here with regex
 * — no headless browser, no authenticated session, no Camoufox. Design
 * decision: the user's logged-in accounts are never automated unattended;
 * this endpoint is what any logged-out visitor sees.
 *
 * DISCOVERY IS NOT VERIFICATION. Under a remote search the cards still show
 * the company HQ city, and the posting page cannot be enriched, so nothing
 * here can confirm a work mode. Every posting leaves with remoteVerified
 * false and the displayed city in hqLocation; scripts/verify-remote.js is the
 * second step that confirms or corrects the label.
 *
 * Fragility note: unofficial endpoint. May 429 under load or change markup.
 * All failures degrade to [] with a warning; the pipeline continues with
 * other sources. Politeness: ~2s between requests, capped pages per query.
 *
 * Card fields parsed: base-search-card__title (title), __subtitle (company),
 * job-search-card__location, <time datetime="YYYY-MM-DD">, base-card__full-link
 * (URL, tracking params stripped by canonicalizeUrl downstream).
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings, seedPlaces } = require('../../../lib/role-queries');
const { isoOf, isRegion, namesNoCity } = require('../../../lib/profile');

const ID = 'linkedin-guest';

// Depth is env-overridable: LINKEDIN_GUEST_PAGES raises the cap for a "deep
// sweep" whose value is COMPANY DISCOVERY (growing the emergent company index
// in data/companies/index.json), not remote listings — the logged-out endpoint
// does not surface remote status (all cards show HQ cities even with f_WT=2).
const PAGES_PER_QUERY = Math.max(1, parseInt(process.env.LINKEDIN_GUEST_PAGES || '2', 10));
const DELAY_MS = 2200;
const MAX_ROLES = 9;         // politeness cap; roles come from the user's seeds
// ponytail: an onsite or hybrid search covers the first two seed places of a
// role (requests scale with roles x modes x places). Upgrade path: a page cap
// per place.
const MAX_PLACES = 2;
const WORK_TYPE = { onsite: '1', remote: '2', hybrid: '3' };

// A title naming a specific city, or saying hybrid/onsite, is a stronger signal
// than LinkedIn's work-type facet. When it fires we do NOT assert Remote — the
// posting keeps the displayed location and falls to the normal classifier.
const TITLE_LOCATION_OVERRIDE = /\b(hybrid|on-?site|in-?office|in-?person|relocat)\b|\b(san francisco|sf bay|new york|nyc|brooklyn|seattle|bellevue|redmond|austin|boston|cambridge|chicago|denver|boulder|atlanta|los angeles|san diego|san jose|santa clara|sunnyvale|mountain view|palo alto|menlo park|cupertino|irvine|dallas|houston|philadelphia|phoenix|portland|miami|nashville|pittsburgh|detroit|minneapolis|salt lake|raleigh|durham|arlington|bethesda|mclean|reston|washington,? d\.?c|london|dublin|berlin|paris|amsterdam|zurich|munich|toronto|vancouver|bangalore|bengaluru|hyderabad|pune|mumbai|delhi|gurgaon|singapore|tokyo|seoul|sydney|melbourne|tel aviv|warsaw|krakow|lisbon|madrid|barcelona|hong kong|shanghai|beijing|taipei|manila|jakarta|bangkok)\b/i;

// The table above is one market's metros. For every other place, the title's
// trailing token (in parentheses, or after the last dash, bar, or comma) is
// read as a place when it names the city the card shows ("Tax Manager -
// Leeds" on a Leeds card) or is written "City, Region" ("Staff Nurse -
// Calgary, AB").
// A region code that is also a word or a stock abbreviation in job titles
// ("Surgery, OR", "Payroll, AR", "Imaging, CT") counts only when the card
// shows the same code.
// ponytail: no gazetteer, so a trailing city that is neither on the card nor
// followed by a region ("- Leeds" on a London card, "- Portland, OR" on a
// Seattle card) is missed, and a tail such as "Enterprise, Canada" or
// "Surgery, OR" on an Oregon card reads as a place. A miss leaves a
// provisional Remote label for scripts/verify-remote.js to correct; a false
// hit keeps the card location. Upgrade path: a city list per country.
const CODE_ALSO_A_WORD = new Set('OR IN ME HI OK ID ON AR CT MD PA MA LA DE VA CA GA MS QC PE'.split(' '));
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function titleNamesPlace(c) {
  const title = c.title || '';
  const tails = [
    (title.match(/\(([^()]+)\)\s*$/) || [])[1],
    (title.match(/\s[-\u2013\u2014|]\s+([^|\u2013\u2014]+?)\s*$/) || [])[1],
    (title.match(/,\s*([^,]+)$/) || [])[1],
  ].filter(Boolean);
  if (!tails.length) return false;
  // "City, Region": the part after the comma is a known state, province, or
  // nation (code or name) or a country name.
  const cityRegion = (t) => {
    const m = t.trim().match(/^([A-Z][a-z][A-Za-z.' ]*),\s*([A-Za-z][A-Za-z. ]+)$/);
    // "Remote, United States" is a work mode and a country, not a city.
    if (!m || namesNoCity(m[1])) return false;
    if (/^[A-Z]{2,3}$/.test(m[2])) {
      return (isRegion(m[2]) || /^(UK|USA?)$/.test(m[2])) && (segs.includes(m[2]) || !CODE_ALSO_A_WORD.has(m[2]));
    }
    return isRegion(m[2]) || (m[2].length > 2 && !!isoOf(m[2])) || /^U\.S\.A?\.?$/.test(m[2]);
  };
  // Only a "City, Region" card names a city; a bare country is not one.
  const segs = (c.location || '').split(',').map(x => x.trim());
  if (tails.some(cityRegion)) return true;
  const city = segs.length > 1 && !namesNoCity(segs[0]) ? segs[0] : '';
  return city.length > 2 && tails.some(t => new RegExp(`(?<![A-Za-z])${escapeRe(city)}(?![A-Za-z])`, 'i').test(t));
}

// What the search is scoped to, from the user's discovery policy.
// ponytail: the country is sent as LinkedIn's free text `location`, so it must
// be a NAME. Exactly ["US"] sends "United States"; otherwise the first entry
// longer than two letters is used, else the display name of the code when the
// list resolves to one country ("GB" sends "United Kingdom"; several bare
// codes send no location and leave the choice to the pipeline country gate,
// same rule as slug-harvest searchCountry). Upgrade path: LinkedIn geo ids,
// one search per listed country.
function codeName(countries) {
  const codes = [...new Set((countries || []).map(isoOf).filter(Boolean))];
  const code = codes.length === 1 && codes[0];
  try { return (code && new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(code)) || ''; } catch { return ''; }
}

function searchScope(filters) {
  const maxAgeDays = filters.maxAgeDays ?? 30;
  const modes = filters.remoteOnly ? ['remote'] : (filters.workModes || []);
  return {
    tprSeconds: maxAgeDays > 0 ? maxAgeDays * 86400 : 0,
    workTypes: modes.map(m => WORK_TYPE[m]).filter(Boolean).join(','),
    geo: filters.usOnly ? 'United States' : ((filters.countries || []).find(c => String(c).length > 2) || codeName(filters.countries) || ''),
  };
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decode(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function parseCards(html) {
  const cards = html.match(/<li>[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (const card of cards) {
    const title = decode((card.match(/base-search-card__title[^>]*>([\s\S]*?)<\//) || [])[1]);
    const company = decode((card.match(/base-search-card__subtitle[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1])
      || decode((card.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\//) || [])[1]);
    const location = decode((card.match(/job-search-card__location[^>]*>([\s\S]*?)<\//) || [])[1]);
    const datetime = (card.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1];
    const url = (card.match(/href="(https:\/\/[^"]*linkedin\.com\/jobs\/view\/[^"]+)"/) || [])[1];
    if (title && company && url) out.push({ title, company, location, datetime, url: decode(url) });
  }
  return out;
}

async function fetchPage(keywords, scope, start) {
  const qs = new URLSearchParams({ keywords, start: String(start) });
  if (scope.geo) qs.set('location', scope.geo);
  if (scope.tprSeconds) qs.set('f_TPR', `r${scope.tprSeconds}`);
  if (scope.workTypes) qs.set('f_WT', scope.workTypes);
  const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${qs}`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) throw new Error('rate-limited (429) — backing off for this run');
  if (!res.ok) throw new Error(`LinkedIn guest ${res.status}`);
  return res.text();
}

async function discover(ctx) {
  const { filters = {}, logger } = ctx;
  const scope = searchScope(filters);
  // One search per accepted work type, so each card carries the facet it came
  // from: only the remote search may assert a (provisional) remote label, only
  // the hybrid search a hybrid one. No policy is one search with no facet.
  // ponytail: requests per role scale with the number of accepted modes.
  // Upgrade path: a page cap per type.
  const types = scope.workTypes ? scope.workTypes.split(',') : [''];
  const roles = roleStrings(ctx, { max: MAX_ROLES });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const all = [];
  // Work that needs the candidate on site is searched where the seed row is,
  // else in the user's first region written as a name; the remote search and
  // the search with no facet stay country wide.
  const places = seedPlaces(ctx);
  const region = (filters.regions || []).find(r => String(r).trim().length > 3);
  const inCountry = (pl) => (scope.geo && !pl.toLowerCase().includes(scope.geo.toLowerCase()) ? `${pl}, ${scope.geo}` : pl);

  outer:
  for (const q of roles) for (const type of types) {
    const onSite = type === WORK_TYPE.onsite || type === WORK_TYPE.hybrid;
    const here = onSite ? (places.get(q.toLowerCase()) || (region ? [String(region).trim()] : [])).slice(0, MAX_PLACES) : [];
    for (const geo of (here.length ? here.map(inCountry) : [scope.geo])) for (let page = 0; page < PAGES_PER_QUERY; page++) {
      try {
        const html = await fetchPage(q, { ...scope, geo, workTypes: type }, page * 25);
        const cards = parseCards(html);
        if (!cards.length) break; // no more results for this query
        for (const c of cards) {
          // DISCOVERY ONLY. f_WT=2 restricts the search to remote work-type, but
          // the guest cards show the company HQ CITY, not the work location, and
          // LinkedIn blocks JD enrichment — so nothing here can CONFIRM remote.
          // We therefore assert a provisional remote label to survive the
          // pre-enrich gate, ALWAYS keep the displayed HQ city in hqLocation as
          // the cross-check, and leave remoteVerified false. A posting from this
          // source is not trustworthy as remote until scripts/verify-remote.js
          // fetches the real posting and sets remoteVerified.
          //
          // A title that names a city or says hybrid/onsite OVERRIDES the
          // asserted remote label — never stamp Remote over an explicit signal.
          // The hybrid search works the same way: a card from it is labeled
          // hybrid at its displayed city unless the title says another mode.
          const titleContradictsRemote = TITLE_LOCATION_OVERRIDE.test(c.title || '') || titleNamesPlace(c);
          const assertRemote = type === WORK_TYPE.remote && !titleContradictsRemote;
          const assertHybrid = type === WORK_TYPE.hybrid && !/\b(remote|on-?site|in-?office|in-?person)\b/i.test(c.title || '');
          const p = createPosting({
            title: c.title,
            company: c.company,
            location: assertRemote ? (scope.geo ? `Remote - ${scope.geo}` : 'Remote')
              : assertHybrid ? (c.location ? `${c.location} (Hybrid)` : 'Hybrid') : (c.location || ''),
            hqLocation: c.location || null,
            remoteVerified: false,
            url: c.url,
            postedDate: c.datetime || null,
            sourceUrl: `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(q)}`,
            sourceQuery: q,
          }, ID);
          if (p) all.push(p);
        }
        logger.info(`[${ID}] "${q}" p${page} -> ${cards.length} cards`);
        await new Promise(r => setTimeout(r, DELAY_MS));
      } catch (err) {
        logger.warn(`[${ID}] "${q}" p${page} failed: ${err.message}`);
        if (/429/.test(err.message)) break outer; // stop entirely on rate-limit
        break; // next query on other errors
      }
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'LinkedIn Jobs guest search (no login)',
  requires: [],
  rateLimit: { rpm: 25 },
  discover,
  searchScope,
  titleNamesPlace,
};
