/**
 * Source: USAJOBS (official US federal government job board API).
 *
 * Key: register a free account + request an API key at
 *   https://developer.usajobs.gov/apirequest/  (instant, no cost).
 * The key is tied to the email you register with, and the API requires that
 * SAME email as the User-Agent header (the one source where the header is not
 * the project string). Set USAJOBS_API_KEY + USAJOBS_EMAIL; both are read from
 * your own environment at run time. Env-gated: either one missing -> [] and
 * the pipeline continues.
 *
 * Endpoint: GET https://data.usajobs.gov/api/search
 *   ?Keyword=<role>&DatePosted=<0-60>&ResultsPerPage=<=500&Page=<n>[&RemoteIndicator=True][&LocationName=<seed places>]
 * Headers: Host: data.usajobs.gov, User-Agent: <registered email>,
 *          Authorization-Key: <USAJOBS_API_KEY>
 *
 * RemoteIndicator=True returns only remote positions and is sent only when the
 * user's work mode policy is exactly remote. DatePosted is a whole day window
 * capped at 60 by the API. The board is US federal by nature.
 *
 * Response: { SearchResult: { SearchResultItems: [ { MatchedObjectDescriptor: {
 *   PositionTitle, PositionURI, ApplyURI[], OrganizationName,
 *   PositionLocationDisplay, PositionLocation: [{ LocationName, CountryCode }],
 *   PositionRemuneration: [{ MinimumRange,
 *   MaximumRange, RateIntervalCode, Description }], PublicationStartDate,
 *   UserArea: { Details: { JobSummary } } } } ] } }
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings, seedPlaces } = require('../../../lib/role-queries');
const { recencyDays, acceptedModes } = require('../../../lib/profile');

const ID = 'usajobs';

const MAX_ROLES = 3;

const RATE_INTERVAL = { PA: '/yr', PH: '/hr', PD: '/day', PW: '/wk', PB: '/pay period', PM: '/mo' };

function comp(descriptor) {
  const r = (descriptor.PositionRemuneration || [])[0];
  if (!r) return null;
  const min = r.MinimumRange, max = r.MaximumRange;
  // An interval code this table does not know is kept as its own suffix, so
  // the band is never read as a yearly figure.
  const unit = RATE_INTERVAL[r.RateIntervalCode] || (r.RateIntervalCode ? `/${r.RateIntervalCode}` : '');
  if (min && max) return `$${min} - $${max}${unit}`;
  if (min) return `$${min}+${unit}`;
  return null;
}

// Where the job is, for a search that is not remote scoped. The display string
// omits the country ("Albany, New York"), so the country of the first listed
// location is appended: the country gate then reads it rather than guessing
// from a state name. Most rows are US, a few federal posts are overseas.
function displayLocation(d) {
  const text = String(d.PositionLocationDisplay || '').trim();
  const country = String(((d.PositionLocation || [])[0] || {}).CountryCode || '').trim();
  if (!country || text.toLowerCase().includes(country.toLowerCase())) return text;
  return text ? `${text}, ${country}` : country;
}

function searchParams(query, datePosted, page, remoteOnly, places = []) {
  const qs = new URLSearchParams({
    Keyword: query,
    ResultsPerPage: '50',
    Page: String(page),
  });
  if (datePosted) qs.set('DatePosted', String(datePosted)); // null: no recency cut
  if (remoteOnly) qs.set('RemoteIndicator', 'True');
  else if (places.length) qs.set('LocationName', places.join(';'));
  return qs;
}

async function fetchQuery(qs, apiKey, email) {
  const res = await fetch(`https://data.usajobs.gov/api/search?${qs}`, {
    headers: {
      'Host': 'data.usajobs.gov',
      'User-Agent': email,
      'Authorization-Key': apiKey,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`USAJOBS ${res.status}`);
  const data = await res.json();
  return (data.SearchResult && data.SearchResult.SearchResultItems) || [];
}

async function discover(ctx) {
  const { auth, logger } = ctx;
  const filters = ctx.filters || {};
  const apiKey = (auth && auth.usajobsApiKey) || process.env.USAJOBS_API_KEY;
  if (!apiKey) { logger.warn(`[${ID}] skipped: no USAJOBS_API_KEY`); return []; }
  const email = (auth && auth.usajobsEmail) || process.env.USAJOBS_EMAIL;
  if (!email) { logger.warn(`[${ID}] skipped: no USAJOBS_EMAIL (must match the email the key was registered with)`); return []; }
  const roles = roleStrings(ctx, { max: MAX_ROLES });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }

  const remoteOnly = filters.remoteOnly === true;
  // DatePosted is a whole day window, API capped at 60.
  const days = recencyDays(filters);
  const datePosted = days ? Math.min(Math.max(days, 1), 60) : null;
  const all = [];
  // A policy that accepts no remote work is searched in the seed row's places.
  const modes = acceptedModes(filters);
  const places = modes.length && !modes.includes('remote') ? seedPlaces(ctx) : new Map();

  for (const q of roles) {
    try {
      const items = await fetchQuery(searchParams(q, datePosted, 1, remoteOnly, places.get(q.toLowerCase())), apiKey, email);
      for (const item of items) {
        const d = item.MatchedObjectDescriptor || {};
        const jobSummary = d.UserArea && d.UserArea.Details && d.UserArea.Details.JobSummary;
        const p = createPosting({
          title: d.PositionTitle,
          company: d.OrganizationName,
          // RemoteIndicator=True guarantees remote and federal postings are US.
          // Without it the posting's own location display is the evidence.
          location: remoteOnly ? 'Remote - United States' : displayLocation(d),
          url: (d.ApplyURI && d.ApplyURI[0]) || d.PositionURI,
          postedDate: d.PublicationStartDate,
          sourceUrl: 'https://data.usajobs.gov/api/search',
          sourceQuery: q,
          jdText: (jobSummary || '').slice(0, 4000),
          compensation: comp(d),
        }, ID);
        if (p) all.push(p);
      }
      logger.info(`[${ID}] "${q}" -> ${items.length} results`);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      logger.warn(`[${ID}] "${q}" failed: ${err.message}`);
      if (/401|403|429/.test(err.message)) break; // bad key / quota, stop
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'USAJOBS (US federal government job board)',
  requires: ['USAJOBS_API_KEY', 'USAJOBS_EMAIL'],
  rateLimit: { rpm: 30 },
  discover,
  __test: { searchParams, comp, displayLocation },
};
