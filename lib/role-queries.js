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

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]/g, ' ')
    .split(/[\s/,&+]+/)
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

// Title filter for feed-based sources. Permissive (never excludes by field)
// when the user has no seeds yet.
function makeTitleMatcher(ctx) {
  const toks = roleTokens(ctx);
  if (toks.size === 0) return () => true;
  return (title) => {
    for (const t of tokenize(title)) if (toks.has(t)) return true;
    return false;
  };
}

module.exports = { tokenize, rawRoleStrings, roleStrings, roleTokens, makeTitleMatcher };
