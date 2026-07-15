/**
 * Per-JD bullet selection from data/bullet-library.json.
 *
 * Replaces the deprecated "fixed integer-permutation over a 7-bullet baseline"
 * pattern (which produced near-identical resume bodies across postings) with a
 * real per-posting selection step:
 *
 *   1. Filter the per-role bullet pool to entries whose `archetypes` tag list
 *      intersects the posting's archetype.
 *   2. Score remaining entries by keyword overlap against the posting's
 *      `jdText`.
 *   3. Take the top N per role, where N is configurable per spec.
 *
 * Output: an `experience[]` array ready to drop into the resume JSON.
 *
 * Spec contract (per posting):
 *   {
 *     archetype: 'Agentic / Safety',
 *     jdText: '...',
 *     bulletCounts: { current: 6, prior1: 2, prior2: 1, sideproject: 1 },
 *     pinBullets: ['current-safety-hooks', ...],   // optional must-include IDs
 *     excludeBullets: [...]                         // optional skip IDs
 *   }
 *
 * The `bulletCounts` keys must match the role-keys defined in the user's
 * `data/bullet-library.json`. The library can also expose a top-level
 * `companyKeyMap` ({ "Acme Corp": "current", ... }) to bridge resume-baseline
 * `experience[].company` strings to the library's role-keys; otherwise the
 * fallback heuristic is `companySlug(experience.company)`.
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');

let _library = null;
function loadLibrary() {
  if (_library) return _library;
  const p = path.join(getProjectRoot(), 'data', 'bullet-library.json');
  _library = JSON.parse(fs.readFileSync(p, 'utf8'));
  return _library;
}

function tokenize(s) {
  return (s || '').toLowerCase().match(/[a-z][a-z0-9-]+/g) || [];
}

function archetypeMatches(bullet, archetype) {
  if (!archetype) return true;
  const tags = (archetype || '').toLowerCase().split(/[/,&+]/).map(s => s.trim()).filter(Boolean);
  for (const t of bullet.archetypes || []) {
    const tl = t.toLowerCase();
    for (const want of tags) {
      if (tl.includes(want) || want.includes(tl)) return true;
    }
  }
  return false;
}

// Top JD requirement terms (from lib/tailor.analyzeJD), cached per jdText.
// They weight bullets that carry what the JD actually asks for above generic
// token overlap, so a requirement-relevant bullet cannot rotate out of exactly
// the JDs that name it. Field-agnostic: analyzeJD extracts terms from the JD
// itself (no hardcoded vocabulary). GENERIC_REQ drops cross-industry filler
// words that show up in nearly every posting and so carry no discriminating
// signal.
const GENERIC_REQ = new Set([
  'production', 'product', 'team', 'teams', 'system', 'systems', 'solution',
  'solutions', 'scale', 'business', 'cross-functional', 'stakeholder',
  'stakeholders', 'design', 'build', 'building', 'development', 'develop',
  'company', 'project', 'projects', 'process', 'delivery', 'quality',
]);
let _reqCache = { jd: null, terms: [] };
function requirementTerms(jdText) {
  if (!jdText) return [];
  if (_reqCache.jd === jdText) return _reqCache.terms;
  let terms = [];
  try {
    // Lazy require: lib/tailor requires this module (loadLibrary), so a
    // top-level import here would be circular.
    const { analyzeJD } = require('./tailor');
    terms = (analyzeJD(jdText).keywords || [])
      .map((k) => String(k.term).toLowerCase())
      .filter((t) => t.length >= 3 && !GENERIC_REQ.has(t))
      .slice(0, 12);
  } catch (_) { /* tailor unavailable -> selection falls back to token overlap */ }
  _reqCache = { jd: jdText, terms };
  return terms;
}

function scoreBullet(bullet, jdTokens, reqTerms = []) {
  let score = 0;
  const set = new Set(jdTokens);
  for (const kw of bullet.keywords || []) {
    const parts = kw.toLowerCase().split(/\s+/);
    let allMatched = true;
    for (const p of parts) {
      if (!set.has(p)) { allMatched = false; break; }
    }
    if (allMatched) score += 2;
    else {
      for (const p of parts) {
        if (set.has(p)) { score += 0.5; break; }
      }
    }
  }
  // Requirement weighting: a bullet whose text OR keywords carry one of the
  // JD's top requirement terms is what the screen actually looks for — weight
  // it well above generic overlap so it cannot rotate out.
  if (reqTerms.length) {
    const hay = ((bullet.text || '') + ' ' + (bullet.keywords || []).join(' ')).toLowerCase();
    for (const t of reqTerms) if (hay.includes(t)) score += 3;
  }
  return score;
}

function companySlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 32);
}

/**
 * Pick top N bullets for a role.
 *
 * @param {string} role - role-key matching a top-level array in bullet-library.json
 * @param {object} spec - per-posting spec (see module header)
 * @param {number} n   - max bullets to return
 * @returns {string[]} ordered array of bullet text
 */
function pickBullets(role, spec, n) {
  const lib = loadLibrary();
  const pool = lib[role] || [];
  const jdTokens = tokenize(spec.jdText || '');
  const reqTerms = requirementTerms(spec.jdText || '');
  const exclude = new Set(spec.excludeBullets || []);
  const pinIds = (spec.pinBullets || []).filter(id => pool.find(b => b.id === id && !exclude.has(id)));

  const candidates = pool.filter(b => !exclude.has(b.id) && !pinIds.includes(b.id));

  // Single-tier ranking: archetype match is a BONUS (+1.5), not a hard gate.
  // A two-tier split ranked every archetype-matched bullet above every
  // non-matched one, so a bullet that directly answered the JD's stated
  // requirements could never outrank a loosely-archetyped one. Requirement
  // relevance now wins.
  const ranked = candidates
    .map(b => ({ b, score: scoreBullet(b, jdTokens, reqTerms) + (archetypeMatches(b, spec.archetype) ? 1.5 : 0) }))
    .sort((a, b) => b.score - a.score);

  const pinned = pool.filter(b => pinIds.includes(b.id));
  const remainingSlots = Math.max(0, n - pinned.length);

  // Same-study mutual exclusion: bullets sharing a `studyGroup` describe ONE
  // underlying project/result (e.g. a business framing and a method framing of
  // the same work). Two of them on one resume read as near-duplicates, so take
  // only the highest-ranked bullet per group.
  const seenGroups = new Set(pinned.map(b => b.studyGroup).filter(Boolean));
  const picked = [...pinned];
  for (const x of ranked) {
    if (picked.length >= pinned.length + remainingSlots) break;
    if (x.b.studyGroup) {
      if (seenGroups.has(x.b.studyGroup)) continue;
      seenGroups.add(x.b.studyGroup);
    }
    picked.push(x.b);
  }
  return picked.map(b => b.text);
}

/**
 * Build the experience[] array for a resume from a per-posting spec and
 * a baseline whose experience entries supply the title/company/dates/etc.
 *
 * Resolves baseline `company` -> bullet-library role-key via, in order:
 *   1. spec.companyKeyMap (per-call override)
 *   2. library.companyKeyMap (declared in data/bullet-library.json)
 *   3. companySlug(company) fallback
 *
 * @param {object} baseline - data/resume-baseline.json
 * @param {object} spec - per-posting spec
 * @returns {object[]} new experience[] with role-targeted bullets
 */
function buildExperience(baseline, spec) {
  const lib = loadLibrary();
  const counts = spec.bulletCounts || {};
  const map = { ...(lib.companyKeyMap || {}), ...(spec.companyKeyMap || {}) };
  const resolveRole = (company) => map[company] || companySlug(company);

  const out = [];
  for (const exp of baseline.experience) {
    const role = resolveRole(exp.company);
    const wantCount = counts[role];
    if (role && wantCount > 0 && Array.isArray(lib[role])) {
      out.push({ ...exp, bullets: pickBullets(role, spec, wantCount) });
    } else if (role && wantCount === 0) {
      continue;
    } else {
      out.push(exp);
    }
  }
  return out;
}

/**
 * Pick a subset of selectedProjects from the library based on archetype + JD
 * keyword scoring. Returns the array ready to drop into resume.selectedProjects.
 */
function pickProjects(spec, n = 2) {
  const lib = loadLibrary();
  const pool = lib.selectedProjects || [];
  const jdTokens = tokenize(spec.jdText || '');
  const reqTerms = requirementTerms(spec.jdText || '');
  const exclude = new Set(spec.excludeBullets || []);
  const candidates = pool.filter(b => !exclude.has(b.id));
  const scored = candidates.map(b => ({
    b,
    score: scoreBullet(b, jdTokens, reqTerms) + (archetypeMatches(b, spec.archetype) ? 1 : 0),
  })).sort((a, b) => b.score - a.score);
  // Prefer an explicit `name` field; dedup by name so a resume never lists two
  // entries for the same project (highest-scoring one wins).
  const out = [];
  const seen = new Set();
  for (const x of scored) {
    const name = x.b.name || x.b.id.replace(/^proj-/, '');
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, summary: x.b.text });
    if (out.length >= n) break;
  }
  return out;
}

module.exports = { pickBullets, buildExperience, pickProjects, loadLibrary };
