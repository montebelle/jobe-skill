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
 *   dedupKey      - sha1(company-slug, role-normalized, location-primary)
 *   discoveredVia - provenance: one entry per source that returned the posting
 *
 * Lifecycle:
 *   discovered -> normalized -> deduped -> filtered -> quick-ranked
 *     -> enriched (lazy) -> fully-ranked -> persisted
 */

const crypto = require('crypto');
const { normalize: asciiNormalize } = require('./normalize');

// ── text helpers ────────────────────────────────────────────

function textClean(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // Decode percent-encoding that leaks in from URL-slug-derived names
  // (e.g. "Pulsora%20Inc" -> "Pulsora Inc").
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try { s = decodeURIComponent(s); } catch { /* leave as-is on malformed input */ }
  }
  return asciiNormalize(s).replace(/\s+/g, ' ').trim();
}

function stripHtml(html) {
  if (!html) return '';
  return asciiNormalize(String(html))
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
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

const REMOTE_PATTERNS = /\b(remote|anywhere|work\s*from\s*home|wfh)\b/i;
const HYBRID_PATTERNS = /\b(hybrid|flexible)\b/i;
const US_PATTERNS = /\b(united\s*states|usa|u\.s\.a?\.?|us\b|us-based|us\s*remote|remote\s*us)\b/i;

const STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC'
]);

const NON_US_COUNTRIES = /\b(india|china|japan|korea|singapore|israel|germany|france|spain|portugal|italy|netherlands|amsterdam|poland|romania|bulgaria|ukraine|russia|uk|united\s*kingdom|london|manchester|dublin|ireland|sweden|norway|finland|denmark|switzerland|austria|belgium|greece|turkey|mexico|brazil|argentina|colombia|chile|peru|canada|toronto|vancouver|montreal|ottawa|australia|sydney|melbourne|new\s*zealand|south\s*africa|nigeria|kenya|egypt|dubai|uae|saudi\s*arabia|czech|hungary|slovakia|slovenia|croatia|estonia|latvia|lithuania|taiwan|thailand|vietnam|philippines|indonesia|malaysia|pakistan|bangladesh|sri\s*lanka|serbia|bosnia|moldova|macedonia|montenegro|albania|georgia\s*country|armenia|azerbaijan|kazakhstan|uzbekistan|belgrade|sofia|bucharest|tallinn|warsaw|krakow|helsinki|oslo|stockholm|copenhagen|zurich|geneva|vienna|prague|budapest|bratislava|athens|tel\s*aviv|bangalore|mumbai|hyderabad|shanghai|beijing|seoul|taipei|hcmc|ho\s*chi\s*minh|hanoi|jakarta|manila|bangkok|kuala\s*lumpur|mexico\s*city|são\s*paulo|sao\s*paulo|buenos\s*aires|bogota|santiago)\b/i;

// Amazon / ISO-3166-1 alpha-3 non-US country codes (comma-prefixed in locations like "Bucharest, ROU")
const NON_US_COUNTRY_CODES = /,\s*(?!USA?\b)(AFG|ALB|DZA|AND|AGO|ARG|ARM|AUS|AUT|AZE|BHS|BHR|BGD|BRB|BLR|BEL|BLZ|BEN|BTN|BOL|BIH|BWA|BRA|BRN|BGR|BFA|BDI|CPV|KHM|CMR|CAN|CAF|TCD|CHL|CHN|COL|COM|COG|COD|CRI|CIV|HRV|CUB|CYP|CZE|DNK|DJI|DMA|DOM|ECU|EGY|SLV|GNQ|ERI|EST|SWZ|ETH|FJI|FIN|FRA|GAB|GMB|GEO|DEU|GHA|GRC|GRD|GTM|GIN|GNB|GUY|HTI|HND|HKG|HUN|ISL|IND|IDN|IRN|IRQ|IRL|ISR|ITA|JAM|JPN|JOR|KAZ|KEN|KIR|PRK|KOR|KWT|KGZ|LAO|LVA|LBN|LSO|LBR|LBY|LIE|LTU|LUX|MAC|MKD|MDG|MWI|MYS|MDV|MLI|MLT|MHL|MRT|MUS|MEX|FSM|MDA|MCO|MNG|MNE|MAR|MOZ|MMR|NAM|NRU|NPL|NLD|NZL|NIC|NER|NGA|MKD|NOR|OMN|PAK|PLW|PSE|PAN|PNG|PRY|PER|PHL|POL|PRT|QAT|ROU|RUS|RWA|KNA|LCA|VCT|WSM|SMR|STP|SAU|SEN|SRB|SYC|SLE|SGP|SVK|SVN|SLB|SOM|ZAF|SSD|ESP|LKA|SDN|SUR|SWE|CHE|SYR|TWN|TJK|TZA|THA|TLS|TGO|TON|TTO|TUN|TUR|TKM|TUV|UGA|UKR|ARE|GBR|URY|UZB|VUT|VAT|VEN|VNM|YEM|ZMB|ZWE)\b/;

function parseLocation(raw) {
  const loc = textClean(raw);
  if (!loc) return { raw: '', primary: '', remote: 'unknown', us: null, parts: [] };

  const parts = loc.split(/\s*(?:[;|·•]|\/\/|\s-\s|\s\|\s)\s*/).filter(Boolean);
  const primary = parts[0] || loc;

  let remote = 'unknown';
  if (REMOTE_PATTERNS.test(loc)) remote = 'remote';
  else if (HYBRID_PATTERNS.test(loc)) remote = 'hybrid';
  else if (/\b[A-Z][a-z]+,\s*[A-Z]{2}\b/.test(loc)) remote = 'onsite';

  let us = null;
  const isUs = US_PATTERNS.test(loc);
  const isNonUsName = NON_US_COUNTRIES.test(loc);
  const isNonUsCode = NON_US_COUNTRY_CODES.test(loc);
  if ((isNonUsName || isNonUsCode) && !isUs) us = false;
  else if (isUs) us = true;
  else {
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
const ROLE_IS_REMOTE = /\b(fully remote|100%\s*remote|remote[- ]first|this (role|position) is remote)\b/i;

// Region acronyms / continents that mark a role as non-US even when the
// structured location is just "Remote". These usually appear in the TITLE
// ("Senior AI Engineer - LATAM", "Tech Lead (Full Remote - Europe)").
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
  if (remote === 'unknown' && (REMOTE_PATTERNS.test(title) || ROLE_IS_REMOTE.test(jdText || ''))) return 'remote';
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
// excluded: the same requisition listed in several locations (e.g. "Staff
// MLE - NYC" + "Staff MLE - Remote") must collapse to one posting, not N.
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
};
