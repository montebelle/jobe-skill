/**
 * Role queries + title matching derived from the USER's profile.
 *
 * The pipeline passes the user's seed queries (data/queries/seeds.json, written
 * by `/jobe onboard` from their target roles) into every source as ctx.queries.
 * This module turns those into:
 *   - roleStrings(ctx)       search terms for keyword/search-based sources
 *   - makeTitleMatcher(ctx)  a title filter for feed-based sources
 *   - tokenize(s)            shared content tokenizer (also used by lib/rank.js)
 *
 * There is NO hardcoded role vocabulary here. A nurse's seeds produce nurse
 * queries; an accountant's produce accountant queries. When the user has no
 * seeds yet (unconfigured), the matcher is permissive (matches everything)
 * rather than excluding by field.
 */

const { foldText } = require('./normalize');
const { namesNoCity } = require('./profile');

// Generic, field-agnostic stopwords: seniority qualifiers, broad job-class
// suffixes too generic to gate on, employment/location words, and linguistic
// stopwords. NOT domain terms.
const STOP = new Set([
  'senior', 'sr', 'staff', 'principal', 'lead', 'junior', 'jr', 'mid', 'entry', 'level',
  'engineer', 'manager', 'analyst', 'specialist', 'associate', 'coordinator',
  'representative', 'rep', 'assistant', 'officer', 'consultant', 'director', 'intern',
  'i', 'ii', 'iii', 'iv', 'v',
  'remote', 'hybrid', 'onsite', 'us', 'usa', 'united', 'states', 'contract',
  'fulltime', 'full', 'part', 'time', 'the', 'of', 'and', 'or', 'a', 'an', 'to',
  'for', 'in', 'on', 'with', 'at',
]);

// Both sides of every comparison come through here. foldText folds accents
// the way stored posting text is folded ("Educateur" for an E acute), and a
// hyphen splits, because stored posting text has none ("E commerce").
function tokenize(s) {
  return foldText(s)
    .replace(/[^a-z0-9+#./ -]/g, ' ')
    .split(/[\s/,&+-]+/)
    .map(t => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter(t => t && t.length > 1 && !STOP.has(t));
}

function rawRoleStrings(ctx) {
  const out = [];
  const seen = new Set();
  for (const q of (ctx && ctx.queries) || []) {
    const r = (typeof q === 'string' ? q : (q && q.query) || '').trim();
    if (!r) continue;
    const k = r.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

// Distinct role query strings from the user's seeds, optionally capped + quoted.
function roleStrings(ctx, { max = 8, quoted = false } = {}) {
  const out = rawRoleStrings(ctx).slice(0, max);
  return quoted ? out.map(r => `"${r}"`) : out;
}

function roleTokens(ctx) {
  const set = new Set();
  for (const r of rawRoleStrings(ctx)) for (const t of tokenize(r)) set.add(t);
  return set;
}

// Where each seed role is to be searched when the work needs the candidate
// on site: Map(lowercased role -> the distinct seed locations that name a
// place). A blank, "Remote", or country only seed location is no place.
function seedPlaces(ctx) {
  const map = new Map();
  for (const q of (ctx && ctx.queries) || []) {
    const role = String((q && q.query) || '').trim().toLowerCase();
    const loc = String((q && q.location) || '').trim();
    if (!role || namesNoCity(loc)) continue;
    const list = map.get(role) || [];
    if (!list.some((x) => x.toLowerCase() === loc.toLowerCase())) list.push(loc);
    map.set(role, list);
  }
  return map;
}

// Inflection tolerant token equality. Two tokens match when they are equal or
// share a common prefix of at least max(4, ceil(0.7 * shorter length)), so a
// seed "nurse" matches the title word "nursing" and "accountant" matches
// "accounting", while "nurse" and "number" stay apart. Exact stems would
// silently drop every inflected title.
// ponytail: prefix heuristic, not a stemmer; it also joins a few unrelated
// words that share a long prefix. Upgrade path: a real stemmer if that noise
// ever shows up in results (the JD based score ranks after this gate anyway).
function tokensMatch(a, b) {
  if (a === b) return true;
  const short = Math.min(a.length, b.length);
  const need = Math.max(4, Math.ceil(0.7 * short));
  if (short < need) return false;
  let i = 0;
  while (i < short && a[i] === b[i]) i++;
  return i >= need;
}

// True when `token` matches any member of `tokenSet` (a Set or array).
function tokenInSet(token, tokenSet) {
  if (tokenSet.has && tokenSet.has(token)) return true;
  for (const r of tokenSet) if (tokensMatch(token, r)) return true;
  return false;
}

// Title filter for feed-based sources. Permissive (never excludes by field)
// when the user has no seeds yet.
function makeTitleMatcher(ctx) {
  const toks = roleTokens(ctx);
  if (toks.size === 0) return () => true;
  return (title) => {
    for (const t of tokenize(title)) if (tokenInSet(t, toks)) return true;
    return false;
  };
}

module.exports = {
  tokenize, rawRoleStrings, roleStrings, roleTokens, makeTitleMatcher,
  tokensMatch, tokenInSet, seedPlaces,
};
