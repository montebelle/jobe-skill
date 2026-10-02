/**
 * The one machine readable user file: <workspace>/data/profile.json.
 *
 * All structured per user policy (discovery filters, title policy, candidate
 * facts, evidence pointers, output rules) lives in that file and is read ONLY
 * through this module. Every key is optional. An absent key means the
 * permissive default in DEFAULTS: nothing is filtered, nothing is assumed
 * about the user's field, country, or working arrangement.
 *
 * Precedence at every call site: CLI flag, then profile.json, then DEFAULTS:
 *   const filters = { ...discoveryFilters(loadProfile()), ...opts.filters };
 *
 * Template: templates/profile.template.json. Written by `/jobe onboard`.
 */

const fs = require('fs');
const path = require('path');
const { getUserRoot } = require('./config');

const DEFAULTS = {
  version: 1,
  candidate: { yearsExperience: null, degrees: [], clearance: null },
  discovery: {
    workModes: [],
    hybridMaxOfficeShare: null,
    countries: [],
    regions: [],
    maxAgeDays: 30,
    seniorityExtensionDays: 0,
    titleExclude: [],
    titleKeep: [],
    salaryFloor: null,
    salaryCurrency: 'USD',
    excludeStaffing: true,
    companySites: [],
    minScore: null,
    referralFirst: false,
  },
  skills: { levels: {}, gaps: [] },
  evidence: {
    ledger: 'reference.md',
    narrative: 'data/career-narrative.md',
    roots: [],
    githubAccounts: [],
    tools: [],
    attribution: [],
  },
  output: { forbiddenTerms: [], targetPages: null, stripHyphens: false, asciiOnly: false, pageSize: null, dateLocale: null },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep merge `over` onto a fresh copy of `base`. Objects merge key by key,
// arrays and scalars replace. A value whose kind disagrees with the default
// (a string where a list is expected, and so on) is ignored so one bad key
// cannot break every reader. Keys starting with "$" ("$comment") are notes.
function merge(base, over) {
  const out = {};
  for (const k of Object.keys(base)) {
    const b = base[k];
    out[k] = isObj(b) ? merge(b, {}) : Array.isArray(b) ? b.slice() : b;
  }
  if (!isObj(over)) return out;
  for (const k of Object.keys(over)) {
    if (k.startsWith('$')) continue;
    const b = base[k];
    const o = over[k];
    if (o === undefined) continue;
    if (isObj(b)) { if (isObj(o)) out[k] = merge(b, o); }
    else if (Array.isArray(b)) { if (Array.isArray(o)) out[k] = o.slice(); }
    else out[k] = isObj(o) ? merge({}, o) : Array.isArray(o) ? o.slice() : o;
  }
  return out;
}

const _cache = new Map();

/**
 * Read <root>/data/profile.json merged over DEFAULTS. Never throws. A missing
 * file is silent (defaults). A malformed file warns once per root and yields
 * defaults. Cached per root for the life of the process.
 */
function loadProfile({ root } = {}) {
  let key;
  try { key = path.resolve(root || getUserRoot()); } catch { return merge(DEFAULTS, {}); }
  if (_cache.has(key)) return _cache.get(key);
  const file = path.join(key, 'data', 'profile.json');
  let raw = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObj(parsed)) throw new Error('top level must be a JSON object');
    raw = parsed;
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[profile] ${file} is unreadable (${err.message}); using permissive defaults`);
    }
  }
  const profile = merge(DEFAULTS, raw);
  _cache.set(key, profile);
  return profile;
}

const strings = (list) => (Array.isArray(list) ? list : [])
  .filter((s) => typeof s === 'string' && s.trim())
  .map((s) => s.trim());

const numOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);

const US_ALIASES = new Set(['us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america']);
const countryCode = (c) => (US_ALIASES.has(c.toLowerCase()) ? 'US' : c);

/**
 * Map the profile's discovery block onto the filter object the collectors use.
 * remoteOnly is true only when workModes is exactly ["remote"]; usOnly is true
 * only when countries is exactly ["US"]. Anything else leaves both false.
 */
function discoveryFilters(profile) {
  const d = { ...DEFAULTS.discovery, ...((profile && profile.discovery) || {}) };
  const workModes = [...new Set(strings(d.workModes).map((m) => m.toLowerCase()))];
  const countries = [...new Set(strings(d.countries).map(countryCode))];
  return {
    remoteOnly: workModes.length === 1 && workModes[0] === 'remote',
    usOnly: countries.length === 1 && countries[0] === 'US',
    countries,
    regions: strings(d.regions),
    workModes,
    maxAgeDays: numOr(d.maxAgeDays, DEFAULTS.discovery.maxAgeDays),
    seniorityExtensionDays: numOr(d.seniorityExtensionDays, DEFAULTS.discovery.seniorityExtensionDays),
    salaryFloor: numOr(d.salaryFloor, null),
    salaryCurrency: typeof d.salaryCurrency === 'string' && d.salaryCurrency.trim()
      ? d.salaryCurrency.trim().toUpperCase() : DEFAULTS.discovery.salaryCurrency,
    excludeStaffing: d.excludeStaffing !== false,
    minScore: numOr(d.minScore, null),
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The matching fold shared with posting text (lowercase, accents stripped).
// Lazy require: normalize loads this module.
const fold = (s) => require('./normalize').foldText(s);

// Case insensitive alternation of whole phrases. The edges are "not a letter
// or digit" lookarounds, not \b, so a phrase ending in punctuation ("sr.")
// still anchors correctly.
// `loose` lets a hyphen in a phrase stand for a space as well.
function phraseRegex(list, loose = false) {
  const parts = strings(list).map((p) => (loose
    ? escapeRe(p).replace(/[\s-]+/g, '[\\s-]+') : escapeRe(p).replace(/\s+/g, '\\s+')));
  return parts.length ? new RegExp(`(?<![a-z0-9])(?:${parts.join('|')})(?![a-z0-9])`, 'i') : null;
}

/**
 * Compile discovery.titleExclude / titleKeep. A title is dropped when an
 * exclude phrase matches outside every keep phrase (see titleExcluded: a keep
 * phrase shields only its own words). Empty lists compile to null, which
 * means no title is ever dropped by policy.
 */
// Phrases and titles are both folded (accents, case), and a hyphen in a phrase
// also matches a space: stored posting titles carry neither accents nor
// hyphens ("Eleve infirmier", "Part Time").
function titlePolicy(profile) {
  const d = (profile && profile.discovery) || {};
  const re = (list) => phraseRegex(strings(list).map(fold), true);
  return { exclude: re(d.titleExclude), keep: re(d.titleKeep) };
}

// True when an exclude phrase matches outside every keep phrase: a keep phrase
// shields only its own words, never the rest of the title.
function titleExcluded(title, policy) {
  const { exclude, keep } = policy || {};
  if (!exclude) return false;
  const t = fold(title);
  return exclude.test(keep ? t.replace(new RegExp(keep.source, 'gi'), ' ') : t);
}

const NO_PLACE = /\b(remote|hybrid|on[\s-]?site|in[\s-]?(?:office|person)|anywhere|worldwide|global|wfh|work(?:ing)?\s+from\s+home|home[\s-]?(?:based|working)|telework(?:ing)?|multiple\s+locations)\b/gi;
const namesNoPlace = (loc) => !loc || !loc.replace(NO_PLACE, '').replace(/[^A-Za-z0-9]+/g, '');

// Everyday names that differ from the Intl display name of the code.
const COUNTRY_ALIASES = {
  GB: ['UK', 'U.K.', 'Great Britain', 'Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland'],
  AE: ['UAE'],
  CZ: ['Czech Republic'],
  KR: ['Korea'],
  TR: ['Turkey'],
  CI: ['Ivory Coast'],
  MM: ['Burma'],
  MO: ['Macau'],
};
// The display name as postings write it: no accents, "and" for "&", a straight
// apostrophe, no bracketed or "SAR China" suffix ("Trinidad and Tobago",
// "Turkiye", "Myanmar", "Hong Kong").
const plainName = (n) => foldMarks(n).replace(/\s*&\s*/g, ' and ').replace(/\u2019/g, "'")
  .replace(/\s*\([^)]*\)$|\s+SAR\s+China$/g, '');
// Codes Intl names that are not countries (unions, placeholders).
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'ZZ', 'XA', 'XB']);

// State, province and nation codes postings write after a city, beside the
// US table lib/posting.js already holds: Canadian provinces and territories,
// Australian states, UK nations. [code, name, country].
// ponytail: four countries. A region anywhere else matches by name only, so
// the user lists both forms. A code shared by two regions (WA, NT) stands for
// both. Upgrade path: ISO 3166-2 data.
const REGIONS = [
  ['AB', 'Alberta', 'CA'], ['BC', 'British Columbia', 'CA'], ['MB', 'Manitoba', 'CA'],
  ['NB', 'New Brunswick', 'CA'], ['NL', 'Newfoundland and Labrador', 'CA'], ['NS', 'Nova Scotia', 'CA'],
  ['NT', 'Northwest Territories', 'CA'], ['NU', 'Nunavut', 'CA'], ['ON', 'Ontario', 'CA'],
  ['PE', 'Prince Edward Island', 'CA'], ['QC', 'Quebec', 'CA'], ['SK', 'Saskatchewan', 'CA'], ['YT', 'Yukon', 'CA'],
  ['NSW', 'New South Wales', 'AU'], ['QLD', 'Queensland', 'AU'], ['SA', 'South Australia', 'AU'],
  ['TAS', 'Tasmania', 'AU'], ['VIC', 'Victoria', 'AU'], ['WA', 'Western Australia', 'AU'],
  ['ACT', 'Australian Capital Territory', 'AU'], ['NT', 'Northern Territory', 'AU'],
  ['ENG', 'England', 'GB'], ['SCT', 'Scotland', 'GB'], ['WLS', 'Wales', 'GB'], ['NIR', 'Northern Ireland', 'GB'],
];

// code -> names and name -> codes for every region above plus the US states.
let _regionTable = null;
function regionTable() {
  if (_regionTable) return _regionTable;
  // Lazy require: posting -> normalize -> profile would otherwise be a cycle.
  const { US_STATES } = require('./posting');
  const rows = [...Object.entries(US_STATES).map(([code, name]) => [code, name, 'US']), ...REGIONS];
  const byCode = new Map();
  const byName = new Map();
  for (const [code, name] of rows) {
    const n = name.toLowerCase();
    byCode.set(code, [...(byCode.get(code) || []), n]);
    byName.set(n, [...(byName.get(n) || []), code]);
  }
  return (_regionTable = { rows, byCode, byName });
}

// code -> every name it goes by, built once from the runtime's own region data.
let _countryTable = null;
function countryTable() {
  if (_countryTable) return _countryTable;
  const byCode = new Map();
  const byName = new Map();
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of A) for (const b of A) {
      const code = a + b;
      if (NOT_COUNTRIES.has(code)) continue;
      let full;
      // Retired codes ("UK", "DD") carry the name of the code that replaced
      // them; only the current code keeps the name.
      try { full = new Intl.Locale(`und-${code}`).region === code ? dn.of(code) : null; } catch { full = null; }
      if (full) byCode.set(code, [...new Set([full, plainName(full), ...(COUNTRY_ALIASES[code] || [])])]);
    }
  } catch { /* no ICU data: codes and aliases only */ }
  for (const [code, list] of Object.entries(COUNTRY_ALIASES)) if (!byCode.has(code)) byCode.set(code, list);
  for (const [code, list] of byCode) for (const n of list) byName.set(n.toLowerCase(), code);
  // A region whose name holds a country name ("New Mexico", "New South
  // Wales") is read as the region's own country, never as the country inside.
  const anyName = phraseRegex([...byName.keys()]);
  const scanNames = new Map(byName);
  for (const [, name, country] of regionTable().rows) {
    const n = name.toLowerCase();
    if (!scanNames.has(n) && anyName && anyName.test(n)) scanNames.set(n, country);
  }
  scanNames.set('port of spain', 'TT'); // a capital that holds another country's name
  // Longest name first, so the longer place name wins over a name inside it.
  const parts = [...scanNames.keys()].sort((x, y) => y.length - x.length)
    .map((n) => escapeRe(n).replace(/\s+/g, '\\s+'));
  const scan = parts.length ? new RegExp(`(?<![a-z0-9])(?:${parts.join('|')})(?![a-z0-9])`, 'gi') : null;
  return (_countryTable = { byCode, byName, scanNames, scan });
}

// True when a location, or one segment of it, names no city: only work mode
// words and country names ("Remote", "United States (Remote)", "Canada").
// `inUs` is for a location already known to be in the US: there only the US
// names count, so the town "Lebanon" in "Lebanon, NH" stays a place.
const US_NAMES = /\b(?:usa?|u\.s\.a?\.?|united\s+states(?:\s+of\s+america)?)(?![a-z])/gi;
function namesNoCity(location, inUs = false) {
  const { scan } = countryTable();
  const rest = String(location || '').replace(US_NAMES, ' ');
  return namesNoPlace(scan && !inUs ? rest.replace(scan, ' ') : rest);
}

// True when a token is a state, province, or nation: its code in capitals
// ("CO", "ON", "NSW") or its name.
function isRegion(token) {
  const t = String(token || '').trim();
  const { byCode, byName } = regionTable();
  return byCode.has(t) || byName.has(t.toLowerCase());
}

// The ISO code of a list entry: a country name or everyday alias ("Germany",
// "UK"), or a two letter code as written. null for anything else.
function isoOf(entry) {
  const e = String(entry || '').trim();
  return countryTable().byName.get(e.toLowerCase()) || (/^[A-Za-z]{2}$/.test(e) ? e.toUpperCase() : null);
}

// The countries a location names, as ISO codes. A country name inside a
// longer place name ("Mexico" in "New Mexico", "Ireland" in "Northern
// Ireland") counts for the longer place only.
function namedCountries(location) {
  const { scan, scanNames } = countryTable();
  const out = new Set();
  if (!scan) return out;
  for (const m of foldMarks(String(location || '')).replace(/\u2019/g, "'").matchAll(scan)) {
    const code = scanNames.get(m[0].toLowerCase().replace(/\s+/g, ' '));
    if (code) out.add(code);
  }
  return out;
}

/**
 * Does a posting location satisfy the user's country list?
 *   []               no filter, always true
 *   includes "US"    the existing US classifier in lib/posting.js decides
 *                    first: a location it places in the US, or cannot place,
 *                    is kept. Exactly ["US"] drops everything else; a mixed
 *                    list falls through to the rule below.
 *   other entries    the location naming a listed country (by ISO code such
 *                    as "DE", by name, or by an everyday alias) keeps the
 *                    posting. With no match the posting is dropped only when
 *                    the location positively names another country (a country
 *                    name outside the list, or a place the US classifier
 *                    recognizes). A city alone, or a city and region
 *                    ("Toronto, ON"), is unknown and kept.
 * An empty location, or one that names no place at all ("Remote"), is unknown
 * and kept.
 */
// ponytail: naive country model. Two letter codes collide with US state codes
// and short words ("CA", "IN", "DE"), which errs toward keeping a posting, and
// a city alone in another country ("Berlin" for ["CA"]) is kept as unknown
// unless it is one of the few dozen cities in FOREIGN_CITIES; a
// few country names double as other places ("Georgia", "Jersey"). A comma
// prefixed three letter country code ("Bengaluru, IND") drops the posting
// unless it can stand for a listed country, which is guessed from the letters
// (no three letter table): a few foreign codes pass ("Jakarta, IDN" for
// ["IN"]), and North Korea's PRK matches only when listed as "PRK". The verify
// step and the final list run after this gate. Upgrade path: a general country
// and region classifier in lib/posting.js that returns an ISO code per location.
function countryOk(location, countries, title = '') {
  const list = [...new Set(strings(countries).map(countryCode))];
  if (!list.length) return true;
  const loc = String(location || '').trim();
  if (namesNoPlace(loc)) return true;
  const others = list.filter((c) => c !== 'US');
  // Lazy require: posting -> normalize -> profile would otherwise be a cycle.
  const { parseLocation, classifyUs, NON_US_COUNTRY_CODES } = require('./posting');
  const us = classifyUs(parseLocation(loc).us, title);
  if (others.length < list.length) {
    if (us !== false) return true;
    if (!others.length) return false; // US only: the classifier verdict is final
  }
  const named = namedCountries(loc);
  const listed = (c) => {
    const code = isoOf(c);
    return code ? named.has(code) || phraseRegex([code]).test(loc) : phraseRegex([fold(c)]).test(fold(loc));
  };
  if (others.some(listed)) return true;
  if (us === true) return false;
  const alpha3 = (loc.match(NON_US_COUNTRY_CODES) || [])[1];
  if (alpha3 && !others.some((c) => mayBeAlpha3(c, alpha3))) return false;
  // A city the US classifier knows as foreign stands for its country, unless
  // a region is written beside it ("London, ON" is not the London in the table).
  const city = us === false && !loc.split(/\s*[,;:|()/]\s*/).some(isRegion) && foldMarks(loc).match(foreignCities().re);
  if (city) return others.some((c) => isoOf(c) === foreignCities().of.get(city[0].toLowerCase().replace(/\s+/g, ' ')));
  return !named.size;
}

// The country of each city lib/posting.js NON_US_COUNTRIES names.
const FOREIGN_CITIES = {
  NL: 'amsterdam', GB: 'london|manchester', IE: 'dublin', CA: 'toronto|vancouver|montreal|ottawa',
  AU: 'sydney|melbourne', AE: 'dubai', SA: 'riyadh|jeddah', QA: 'doha', IS: 'reykjavik', RS: 'belgrade',
  BG: 'sofia', RO: 'bucharest', EE: 'tallinn', PL: 'warsaw|krakow', FI: 'helsinki', NO: 'oslo',
  SE: 'stockholm', DK: 'copenhagen', CH: 'zurich|geneva', AT: 'vienna', CZ: 'prague', HU: 'budapest',
  SK: 'bratislava', GR: 'athens', IL: 'tel aviv', IN: 'bangalore|mumbai|hyderabad', CN: 'shanghai|beijing',
  KR: 'seoul', TW: 'taipei', VN: 'hcmc|ho chi minh|hanoi', ID: 'jakarta', PH: 'manila', TH: 'bangkok',
  MY: 'kuala lumpur', BR: 'sao paulo', AR: 'buenos aires', CO: 'bogota', CL: 'santiago',
};
let _foreignCities = null;
function foreignCities() {
  if (_foreignCities) return _foreignCities;
  const of = new Map();
  for (const [code, names] of Object.entries(FOREIGN_CITIES)) for (const n of names.split('|')) of.set(n, code);
  return (_foreignCities = { of, re: phraseRegex([...of.keys()]) });
}

// Can a three letter country code stand for this list entry? Yes when the
// entry's two letter code, or the code itself, runs in order through a name
// of the country, first letter shared ("CA" in "CAN", "DEU" from "DE", "IRL"
// in "Ireland").
const inOrder = (needle, hay) => {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
};
function mayBeAlpha3(entry, alpha3) {
  const code = isoOf(entry);
  const names = code ? countryTable().byCode.get(code) || [] : [String(entry)];
  return (!!code && code[0] === alpha3[0] && inOrder(code, alpha3))
    || names.some((n) => n[0].toUpperCase() === alpha3[0] && inOrder(alpha3, n.toUpperCase()));
}

/**
 * Does a posting location fall inside the user's regions (discovery.regions)?
 * Callers apply it to hybrid and onsite postings only. An empty list is no
 * gate; an empty location, or one that names no place, is unknown and kept.
 */
// ponytail: naive whole phrase match, so an entry should be the distinctive
// place name ("Denver", "Ontario"). A state, province, or nation in REGIONS or
// the US table matches by its name and by its code in capitals, whichever the
// user wrote ("Colorado" keeps "Aurora, CO", "ON" keeps "Ottawa, Ontario"); a
// name that is both a city and a region ("New York") therefore keeps the
// whole region. Any other entry of two or three capitals is read as a code
// and matched in capitals only. Upgrade path: a geocoder with a radius.
const foldMarks = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
function regionOk(location, regions) {
  const list = strings(regions).map(foldMarks);
  if (!list.length) return true;
  const loc = foldMarks(String(location || '').trim());
  if (namesNoPlace(loc)) return true;
  const { byCode, byName } = regionTable();
  const names = [];
  const codes = [];
  for (const r of list) {
    const code = /^[A-Za-z]{2,3}$/.test(r) && (byCode.has(r.toUpperCase()) || r === r.toUpperCase()) ? r.toUpperCase() : null;
    if (code) { codes.push(code); names.push(...(byCode.get(code) || [])); }
    else { names.push(r); codes.push(...(byName.get(r.toLowerCase()) || [])); }
  }
  const nameRe = phraseRegex(names.map(fold));
  if (nameRe && nameRe.test(fold(loc))) return true;
  // Capitals only, so "ON" never matches "On-site" and "OR" never matches "or".
  const hit = codes.length > 0
    && new RegExp(`(?<![A-Za-z0-9])(?:${codes.join('|')})(?![A-Za-z0-9])(?![\\s-]*(?:SITE|PERSON|OFFICE))`).exec(loc);
  if (!hit) return false;
  // The same letters in another country ("Medellin, CO, Colombia") are not the
  // region. ponytail: with no country named ("Bogota, CO") the code is trusted.
  const named = namedCountries(loc);
  const owners = regionTable().rows.filter((r) => r[0] === hit[0] && names.some((n) => n.toLowerCase() === r[1].toLowerCase())).map((r) => r[2]);
  return !named.size || !owners.length || owners.some((c) => named.has(c));
}

// The work modes the user accepts ([] = all). remoteOnly is the short form of
// exactly ["remote"]; a caller that switches remoteOnly off lifts that list.
function acceptedModes(filters) {
  if (filters.remoteOnly) return ['remote'];
  const modes = filters.workModes || [];
  return modes.length === 1 && modes[0] === 'remote' ? [] : modes;
}

// Work mode gate, two stages.
//   strict = false (listing stage): drop only a posting already KNOWN to be in
//     a mode the user excluded. 'unknown' (ambiguous country wide or "Multiple
//     Locations" strings, aggregator hits with no location) is kept so
//     enrichment can fetch the real JD and verify, and so is a city only
//     listing unless the policy is remote only.
//   strict = true (after enrichment): the mode must be one the user accepts.
//     A posting that still states no mode is kept only when the user accepts
//     onsite, which is what a posting that says nothing almost always is.
function modePass(p, filters, strict) {
  const modes = acceptedModes(filters);
  if (!modes.length) return true;
  if (!p.remote || p.remote === 'unknown') return strict ? modes.includes('onsite') : true;
  // A city alone reads as 'onsite' but states no mode: a hybrid role is listed
  // with its city and says hybrid only in the JD. Enrichment decides, unless
  // the policy is remote only, where a city listing is out (same as before).
  if (!strict && p.remote === 'onsite' && !(modes.length === 1 && modes[0] === 'remote')) return true;
  return modes.includes(p.remote);
}

/**
 * The recency window in days as the pipeline and every source read it, or
 * null when the cut is off (maxAgeDays 0). A missing or unusable value is the
 * shipped default.
 */
function recencyDays(filters) {
  const days = numOr(filters && filters.maxAgeDays, DEFAULTS.discovery.maxAgeDays);
  return days > 0 ? days : null;
}

// Titles that get the user's seniorityExtensionDays. "staff" is left out: it
// is above senior in some fields and the entry grade in others ("Staff Nurse").
const seniorTitle = (title) => /\b(senior|sr|principal|lead)\b/i.test(title || '');

/**
 * Feed side date test. `when` is a date string or epoch milliseconds, `days`
 * comes from recencyDays(). A null window keeps every row, dated or not; with
 * a window, a row whose date cannot be read is dropped (the feeds always date
 * their rows, so an unreadable date means a malformed row).
 */
function withinAge(when, days) {
  if (days == null) return true;
  const t = typeof when === 'number' ? when : Date.parse(when || '');
  return Number.isFinite(t) && t > 0 && (Date.now() - t) <= days * 86400000;
}

// Countries whose standard paper is Letter; everywhere else is A4.
const LETTER_COUNTRIES = new Set('US CA MX PH CL CO CR DO GT PA VE BZ NI SV PR'.split(' '));

/**
 * Page size and date locale for rendered documents. output.pageSize null
 * means Letter when the user's country list is empty or names a country that
 * uses Letter paper, A4 for every other list; output.dateLocale null means
 * en-US.
 */
function pageSetup(profile) {
  const o = (profile && profile.output) || {};
  const set = typeof o.pageSize === 'string' ? o.pageSize.trim().toLowerCase() : '';
  const countries = discoveryFilters(profile).countries;
  return {
    pageSize: set === 'a4' || set === 'letter' ? set
      : (!countries.length || countries.some((c) => LETTER_COUNTRIES.has(isoOf(c))) ? 'letter' : 'a4'),
    dateLocale: typeof o.dateLocale === 'string' && o.dateLocale.trim() ? o.dateLocale.trim() : 'en-US',
  };
}

module.exports = {
  DEFAULTS, loadProfile, discoveryFilters, titlePolicy, titleExcluded, countryOk, regionOk,
  acceptedModes, modePass, recencyDays, seniorTitle, withinAge, pageSetup, namedCountries, namesNoCity, isoOf, isRegion,
};
