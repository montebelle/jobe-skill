/**
 * Canonical Posting schema + parsers.
 *
 * Every source plugin must return Posting[] in this shape. Downstream stages
 * (dedup, filter, rank, enrich) operate on this schema only and are ignorant
 * of the source format.
 *
 * Posting identity:
 *   canonicalUrl  - preferred URL (direct ATS preferred over aggregator)
 *   alternateUrls - every URL that pointed at this posting
 *   dedupKey      - sha1(company-slug, role-normalized)   // location intentionally excluded
 *   discoveredVia - provenance: one entry per source that returned the posting
 *
 * Lifecycle:
 *   discovered -> normalized -> deduped -> filtered -> quick-ranked
 *     -> enriched (lazy) -> fully-ranked -> persisted
 */

const crypto = require('crypto');
const { normalize: asciiNormalize } = require('./normalize');

// ── text helpers ────────────────────────────────────────────

// Posting text is always cleaned to ASCII with hyphens stripped, whatever the
// user's render preferences (output.stripHyphens, output.asciiOnly) say. Company slugs, dedup keys and
// the location parser were all built on that form ("Acme - Health" reads as
// "Acme, Health"), so following the render preference here would change dedup
// keys from one user to the next and re-surface postings already handled.
// ponytail: a title, company or location written in a non Latin script folds
// to empty, so createPosting discards the row (no title) or keeps it with no
// location. Upgrade path: fold for the keys only and keep the display text.
const cleanAscii = (s) => asciiNormalize(s, { stripHyphens: true, asciiOnly: true, foldSymbols: false });

function textClean(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // Decode percent-encoding that leaks in from URL-slug-derived names
  // (e.g. "Example%20Inc" -> "Example Inc").
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try { s = decodeURIComponent(s); } catch { /* leave as-is on malformed input */ }
  }
  return cleanAscii(s).replace(/\s+/g, ' ').trim();
}

// Named and numeric entities worth decoding in posting text. "&amp;" goes last
// so "&amp;lt;" decodes one level, not two.
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/&amp;/g, '&');
}

// Tags are removed BEFORE the ASCII cleanup. The cleanup rewrites a literal
// "<" as " less than " (an ATS safety rule for rendered text), so running it
// first turned every tag into words and left no markup to strip.
function stripHtml(html) {
  if (!html) return '';
  let s = String(html);
  // Some ATS feeds ship the whole markup entity encoded ("&lt;p&gt;..."):
  // decode one level first so those tags are seen as tags.
  if (!/<[a-z!/][^>]*>/i.test(s) && /&lt;\/?[a-z][^&]*&gt;/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return cleanAscii(decodeEntities(s))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Company slug ────────────────────────────────────────────

function companySlug(name) {
  return textClean(name)
    .toLowerCase()
    .replace(/[&,]/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-')
    .replace(/-(inc|llc|ltd|corp|co|gmbh|ag|plc|sa)$/, '');
}

// ── Role title normalization (dedup key) ────────────────────

const ROLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'at', 'in', 'on', 'for', 'and', 'or', 'to',
  'iii', 'ii', 'iv',
]);

// Abbreviation folding for the dedup key only: it makes two spellings of one
// title hash alike and never filters a posting. The table is frozen, because
// changing an entry changes existing dedup keys.
const ROLE_SYNONYMS = new Map([
  ['ml', 'machinelearning'],
  ['ai', 'artificialintelligence'],
  ['eng', 'engineer'],
  ['engineering', 'engineer'],
  ['dev', 'developer'],
  ['swe', 'softwareengineer'],
  ['llm', 'llm'],
  ['genai', 'generativeai'],
  ['nlp', 'naturallanguage'],
  ['cv', 'computervision'],
  ['ds', 'datascientist'],
  ['de', 'dataengineer'],
  ['mle', 'machinelearningengineer'],
  ['sde', 'softwareengineer'],
  ['sr', 'senior'],
  ['jr', 'junior'],
]);

function roleNormalize(title) {
  const tokens = textClean(title)
    .toLowerCase()
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !ROLE_STOPWORDS.has(t))
    .map(t => ROLE_SYNONYMS.get(t) || t);
  return [...new Set(tokens)].sort().join('-');
}

// ── Location parsing ────────────────────────────────────────

const REMOTE_PATTERNS = /\b(remote|anywhere|work(?:ing)?\s*from\s*home|wfh)\b/i;
// Other wordings of remote work: "Home Based" and "Homeworking" (the usual UK
// form) and "Telework". Read as remote in a location field, and in a title
// only as a closing tag ("Tax Accountant (Home Based)"), never as part of the
// job itself ("Home Based Therapist", "Home Based Primary Care"). "Telework
// eligible" is an office job with some telework and stays as it was. In a
// location the wording must be the whole place (see parseLocation).
// ponytail: English wording only. Upgrade path: a table of wordings per language.
const HOME_WORDS = 'home[\\s-]?(?:based|working)|telework(?:ing)?(?!\\s+(?:eligible|available|options?))';
const HOME_BASED = new RegExp(`\\b(?:${HOME_WORDS})\\b`, 'i');
const TITLE_HOME_BASED = new RegExp(`[(\\-|,:]\\s*(?:${HOME_WORDS})\\b(?=\\s*(?:$|[),|/;:-]))`, 'i');
const HYBRID_PATTERNS = /\b(hybrid|flexible)\b/i;
const US_PATTERNS = /\b(united\s*states|usa|u\.s\.a?\.?|us\b|us-based|us\s*remote|remote\s*us)\b/i;

// US state code -> name (lowercased), the one table both sets below come
// from. lib/profile.js reuses it to match a region given by name against a
// posting that writes the code, and the reverse.
const US_STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada',
  NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma',
  OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina',
  SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin',
  WY: 'wyoming', DC: 'district of columbia',
};
const STATE_CODES = new Set(Object.keys(US_STATES));

// Full US state names (lowercased) so "Austin, Texas" reads as US-onsite while
// "Pune, Maharashtra" / "Toronto, Ontario" read as FOREIGN onsite.
const US_STATE_NAMES = new Set(Object.values(US_STATES));

// Country/region tokens that are unambiguously non-US. NOTE: do NOT add bare
// city names that collide with US towns (Paris TX, Berlin CT/NH, Munich ND) —
// those must be disambiguated by a country/state suffix, not a naked city
// match. "mexico" carries a lookbehind so the US state New Mexico is not read
// as the country. The added tokens below (cyprus/gibraltar/luxembourg/malta/andorra/
// latam/latin america/riyadh/...) have negligible US collision and were the
// gaps that let non-US "City (Remote)" postings through.
const NON_US_COUNTRIES = /\b(india|china|japan|korea|singapore|israel|germany|france|spain|portugal|italy|netherlands|amsterdam|poland|romania|bulgaria|ukraine|russia|uk|united\s*kingdom|london|manchester|dublin|ireland|sweden|norway|finland|denmark|switzerland|austria|belgium|greece|turkey|(?<!new\s)mexico|brazil|argentina|colombia|chile|peru|canada|toronto|vancouver|montreal|ottawa|australia|sydney|melbourne|new\s*zealand|south\s*africa|nigeria|kenya|egypt|dubai|uae|saudi\s*arabia|riyadh|jeddah|doha|qatar|bahrain|kuwait|cyprus|gibraltar|luxembourg|malta|andorra|monaco|liechtenstein|iceland|reykjavik|latam|latin\s*america|czech|hungary|slovakia|slovenia|croatia|estonia|latvia|lithuania|taiwan|thailand|vietnam|philippines|indonesia|malaysia|pakistan|bangladesh|sri\s*lanka|serbia|bosnia|moldova|macedonia|montenegro|albania|georgia\s*country|armenia|azerbaijan|kazakhstan|uzbekistan|belgrade|sofia|bucharest|tallinn|warsaw|krakow|helsinki|oslo|stockholm|copenhagen|zurich|geneva|vienna|prague|budapest|bratislava|athens|tel\s*aviv|bangalore|mumbai|hyderabad|shanghai|beijing|seoul|taipei|hcmc|ho\s*chi\s*minh|hanoi|jakarta|manila|bangkok|kuala\s*lumpur|mexico\s*city|são\s*paulo|sao\s*paulo|buenos\s*aires|bogota|santiago)\b/i;

// Amazon / ISO-3166-1 alpha-3 non-US country codes (comma-prefixed in locations like "Bucharest, ROU")
const NON_US_COUNTRY_CODES = /,\s*(?!USA?\b)(AFG|ALB|DZA|AND|AGO|ARG|ARM|AUS|AUT|AZE|BHS|BHR|BGD|BRB|BLR|BEL|BLZ|BEN|BTN|BOL|BIH|BWA|BRA|BRN|BGR|BFA|BDI|CPV|KHM|CMR|CAN|CAF|TCD|CHL|CHN|COL|COM|COG|COD|CRI|CIV|HRV|CUB|CYP|CZE|DNK|DJI|DMA|DOM|ECU|EGY|SLV|GNQ|ERI|EST|SWZ|ETH|FJI|FIN|FRA|GAB|GMB|GEO|DEU|GHA|GRC|GRD|GTM|GIN|GNB|GUY|HTI|HND|HKG|HUN|ISL|IND|IDN|IRN|IRQ|IRL|ISR|ITA|JAM|JPN|JOR|KAZ|KEN|KIR|PRK|KOR|KWT|KGZ|LAO|LVA|LBN|LSO|LBR|LBY|LIE|LTU|LUX|MAC|MKD|MDG|MWI|MYS|MDV|MLI|MLT|MHL|MRT|MUS|MEX|FSM|MDA|MCO|MNG|MNE|MAR|MOZ|MMR|NAM|NRU|NPL|NLD|NZL|NIC|NER|NGA|MKD|NOR|OMN|PAK|PLW|PSE|PAN|PNG|PRY|PER|PHL|POL|PRT|QAT|ROU|RUS|RWA|KNA|LCA|VCT|WSM|SMR|STP|SAU|SEN|SRB|SYC|SLE|SGP|SVK|SVN|SLB|SOM|ZAF|SSD|ESP|LKA|SDN|SUR|SWE|CHE|SYR|TWN|TJK|TZA|THA|TLS|TGO|TON|TTO|TUN|TUR|TKM|TUV|UGA|UKR|ARE|GBR|URY|UZB|VUT|VAT|VEN|VNM|YEM|ZMB|ZWE)\b/;

function parseLocation(raw) {
  const loc = textClean(raw);
  if (!loc) return { raw: '', primary: '', remote: 'unknown', us: null, parts: [] };

  const parts = loc.split(/\s*(?:[;|·•]|\/\/|\s-\s|\s\|\s)\s*/).filter(Boolean);
  const primary = parts[0] || loc;

  let remote = 'unknown';
  let us = null;
  // Home based / telework wording counts only when it is the whole place
  // ("Home Based, UK", "Telework, United States"). Beside a city or any other
  // word ("Partial Telework, Arlington, VA", "Home Based Primary Care, Denver,
  // CO") it is an office or visiting job and falls through to the rules below.
  // Lazy require: lib/profile.js requires this file.
  if (REMOTE_PATTERNS.test(loc) || (HOME_BASED.test(loc) && !HYBRID_PATTERNS.test(loc) && require('./profile').namesNoCity(loc))) remote = 'remote';
  else if (HYBRID_PATTERNS.test(loc)) remote = 'hybrid';

  // "City, Region" -> onsite. The region word identifies the country: a US
  // state code/name is US-onsite; any other region (e.g. "Maharashtra",
  // "Ontario", "England") is a FOREIGN onsite location -> us=false. This is
  // what stops a "Pune, Maharashtra" / On-Site role leaking through as
  // 'unknown' (the old regex only matched a 2-letter US state code).
  const cityRegion = remote === 'unknown'
    // A work mode word after the comma ("Georgia - Virtual - GA01") is no region.
    ? loc.match(/\b[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*\s*,\s*(?!(?:[Vv]irtual|VIRTUAL|[Oo]nsite|ONSITE|[Tt]elework|TELEWORK)\b)([A-Za-z]{2,})\b/)
    : null;
  if (cityRegion) {
    remote = 'onsite';
    const region = cityRegion[1];
    // The regex captures one word after the comma ("New" of "New York"), so
    // also test the whole segment up to the next comma.
    const segment = loc.slice(cityRegion.index + cityRegion[0].lastIndexOf(',') + 1).split(',')[0].trim().toLowerCase();
    if (STATE_CODES.has(region.toUpperCase()) || US_STATE_NAMES.has(region.toLowerCase()) || US_STATE_NAMES.has(segment)) us = true;
    else if (!US_PATTERNS.test(loc)) us = false; // foreign onsite
  }

  const isUs = US_PATTERNS.test(loc);
  const isNonUsName = NON_US_COUNTRIES.test(loc);
  const isNonUsCode = NON_US_COUNTRY_CODES.test(loc);
  // Guard `us !== true`: an explicit US-state-coded city (set above, e.g.
  // "Paris, TX" -> us=true) must NOT be overridden by a foreign-name token
  // matching the same city stem. Only override when US-ness is unestablished.
  if ((isNonUsName || isNonUsCode) && !isUs && us !== true) us = false;
  else if (isUs && us === null) us = true;
  else if (us === null) {
    const stateMatch = loc.match(/\b([A-Z]{2})\b/g) || [];
    if (stateMatch.some(s => STATE_CODES.has(s))) us = true;
  }

  return { raw: loc, primary, remote, us, parts };
}

// Combine the structured-location verdict with signals from the role title
// and (when available) JD text. The location field alone is unreliable:
// many ATS feeds label a hybrid role "Remote" while the TITLE says
// "(Hybrid - Seattle, WA)". Title/JD hybrid+onsite markers are therefore
// authoritative downgrades; an explicit "remote" in the title can only
// upgrade an otherwise-unknown location (never override an onsite city).
// A bare "hybrid" in a short TITLE is authoritative ("…(Hybrid - Seattle)").
const TITLE_IS_HYBRID = /\bhybrid\b/i;
// In free-form JD text, a bare "hybrid" is too noisy (benefits boilerplate),
// so only STRONG phrases downgrade. Same for onsite.
const JD_HYBRID_PHRASE = /\b(this (role|position) is hybrid|hybrid (work\s*)?(schedule|model|arrangement|role|position|environment)|\d+\s*days?\s*(per week\s*)?in[- ](the\s*)?office|in[- ]office\s*\d+\s*days?)\b/i;
const JD_ONSITE_PHRASE = /\b(must be (located|based) in|relocation (is )?required|fully on[- ]?site|on[- ]?site position|in[- ]person (role|position))\b/i;
// 'this role is home based' must close its clause (or go on to a place or a
// condition), like the title rule: 'is home based care coordinator' is a job
// done in homes.
const ROLE_IS_REMOTE = /\b(fully remote|100%\s*remote|remote[- ]first|this (role|position) is remote|(this|the) (role|position) is (fully )?(home[\s-]?based|telework(?!\s+(eligible|available)))(?=[^\S\n]*(?:$|[\n.,;:()!]|(?:and|but|or|with|within|in|across)\b))|is an? (fully )?(home[\s-]?based|telework) (role|position|contract)|home[\s-]?working (role|position|contract)|100%\s*telework)\b/i;

// Region acronyms / continents that mark a role as non-US even when the
// structured location is just "Remote". These usually appear in the TITLE
// ("Senior Accountant - LATAM", "Team Lead (Full Remote - Europe)").
const NON_US_REGION = /\b(latam|emea|apac|anz|mena|europe|european|asia|africa|oceania|nordics?|benelux|dach)\b/i;

// Decide US eligibility from the structured location plus title region markers.
// Title is checked (not the whole JD) to avoid false-positives from boilerplate
// like "we have offices in Europe".
function classifyUs(locUs, title = '') {
  if (locUs === false) return false;
  if ((NON_US_REGION.test(title) || NON_US_COUNTRIES.test(title)) && !US_PATTERNS.test(title)) {
    return false;
  }
  return locUs; // true or null (unknown)
}

function classifyRemote(locationRemote, title = '', jdText = '') {
  const remote = locationRemote;
  // Authoritative downgrades (precision-first).
  if (TITLE_IS_HYBRID.test(title)) return 'hybrid';
  if (jdText) {
    if (JD_HYBRID_PHRASE.test(jdText)) return 'hybrid';
    if (JD_ONSITE_PHRASE.test(jdText) && remote !== 'remote') return 'onsite';
  }
  // Upgrades only from explicit remote phrasing, and only when the location
  // field was ambiguous (never flip an onsite city to remote).
  if (remote === 'unknown' && (REMOTE_PATTERNS.test(title) || TITLE_HOME_BASED.test(title) || ROLE_IS_REMOTE.test(jdText || ''))) return 'remote';
  return remote;
}

// ── Date parsing ────────────────────────────────────────────

function parseDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw) ? null : raw;

  if (typeof raw === 'number') {
    const d = new Date(raw < 1e12 ? raw * 1000 : raw);
    return isNaN(d) ? null : d;
  }

  const rel = String(raw).trim().toLowerCase();
  const now = new Date();
  if (/^today$/.test(rel) || /just\s*posted/.test(rel)) return now;
  if (/^yesterday$/.test(rel)) { const d = new Date(now); d.setDate(d.getDate() - 1); return d; }
  const m = rel.match(/(\d+)\+?\s*(minute|hour|day|week|month)s?\s*ago/);
  if (m) {
    const n = parseInt(m[1], 10);
    const d = new Date(now);
    if (m[2] === 'minute') d.setMinutes(d.getMinutes() - n);
    else if (m[2] === 'hour') d.setHours(d.getHours() - n);
    else if (m[2] === 'day') d.setDate(d.getDate() - n);
    else if (m[2] === 'week') d.setDate(d.getDate() - 7 * n);
    else if (m[2] === 'month') d.setMonth(d.getMonth() - n);
    return d;
  }

  const d = new Date(raw);
  return isNaN(d) ? null : d;
}

// ── URL canonicalization ────────────────────────────────────

const TRACKING_PARAMS = new Set([
  'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
  'gh_src','ref','referrer','source','lever-source','hsCtaTracking',
  'mc_cid','mc_eid','fbclid','gclid',
]);

function canonicalizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.toLowerCase();
    let out = u.toString();
    if (out.endsWith('/') && !u.search && !u.hash) out = out.slice(0, -1);
    return out;
  } catch {
    return url;
  }
}

// Canonical form preference: direct ATS > company site > aggregator
const URL_PREFERENCE = [
  /job-boards\.greenhouse\.io/i,
  /boards\.greenhouse\.io/i,
  /jobs\.lever\.co/i,
  /jobs\.ashbyhq\.com/i,
  /workday\.com/i,
  /smartrecruiters\.com/i,
  /\.(com|io|ai|co)\/(?:careers|jobs|work)/i,
  /linkedin\.com\/jobs/i,
  /indeed\.com/i,
  /glassdoor\.com/i,
];

function preferUrl(a, b) {
  const rankA = URL_PREFERENCE.findIndex(re => re.test(a));
  const rankB = URL_PREFERENCE.findIndex(re => re.test(b));
  const rA = rankA === -1 ? URL_PREFERENCE.length : rankA;
  const rB = rankB === -1 ? URL_PREFERENCE.length : rankB;
  if (rA !== rB) return rA < rB ? a : b;
  return a.length <= b.length ? a : b;
}

// ── Dedup key ───────────────────────────────────────────────
//
// Keyed on (company-slug, role-normalized) only. Location is deliberately
// excluded: the same requisition listed in several locations (e.g. "Charge
// Nurse - Austin" + "Charge Nurse - Dallas") must collapse to one posting, not N.
// Genuinely distinct roles still differ by their normalized title.
function dedupKey({ company, title }) {
  const parts = [
    companySlug(company || ''),
    roleNormalize(title || ''),
  ];
  const key = parts.filter(Boolean).join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

// ── Posting factory ─────────────────────────────────────────

function createPosting(raw, sourceId) {
  const title = textClean(raw.title);
  const company = textClean(raw.company);
  const location = textClean(raw.location);
  const canonicalUrl = canonicalizeUrl(raw.url || raw.canonicalUrl);
  if (!title || !company || !canonicalUrl) return null;

  const loc = parseLocation(location);
  const remote = classifyRemote(loc.remote, title, raw.jdText || '');
  const us = classifyUs(loc.us, title);
  const postedDate = parseDate(
    raw.postedDate || raw.updatedAt || raw.publishedAt || raw.createdAt || raw.posted
  );

  const alts = new Set([canonicalUrl]);
  for (const u of raw.alternateUrls || []) {
    const c = canonicalizeUrl(u);
    if (c) alts.add(c);
  }

  return {
    canonicalUrl,
    alternateUrls: [...alts],
    dedupKey: dedupKey({ company, title }),

    company,
    companySlug: raw.companySlug || companySlug(company),
    title,
    location,
    remote,
    us,
    locationParts: loc.parts,
    // The location a source DISPLAYED, when it differs from the work location it
    // asserted (some listing cards show the company HQ city even under a remote
    // work-type filter). Kept so the remote label can be cross-checked rather
    // than trusted; dropping it made the label unverifiable.
    hqLocation: textClean(raw.hqLocation) || null,
    // Whether `remote` came from a real JD / posting page (true), or is an
    // unverified label a source asserted (false). Discovery may assert; only
    // verification may set this true. See scripts/verify-remote.js.
    remoteVerified: raw.remoteVerified === true,
    postedDate: postedDate ? postedDate.toISOString() : null,

    discoveredVia: [{
      source: sourceId,
      foundAt: new Date().toISOString(),
      sourceUrl: raw.sourceUrl || canonicalUrl,
      sourceQuery: raw.sourceQuery || null,
    }],

    jdText: raw.jdText || null,
    jdHtml: raw.jdHtml || null,
    compensation: raw.compensation || null,
    department: raw.department || null,

    archetype: null,
    matchScore: null,
    quickScore: null,
    gatePass: null,
    gaps: [],
    rankReason: null,
  };
}

module.exports = {
  textClean,
  stripHtml,
  companySlug,
  roleNormalize,
  parseLocation,
  parseDate,
  canonicalizeUrl,
  preferUrl,
  dedupKey,
  createPosting,
  classifyRemote,
  classifyUs,
  US_STATE_NAMES,
  US_STATES,
  NON_US_COUNTRY_CODES,
  HOME_BASED,
};
