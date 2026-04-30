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

function scoreBullet(bullet, jdTokens) {
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
  const exclude = new Set(spec.excludeBullets || []);
  const pinIds = (spec.pinBullets || []).filter(id => pool.find(b => b.id === id && !exclude.has(id)));

  const candidates = pool.filter(b => !exclude.has(b.id) && !pinIds.includes(b.id));
  const archetypeOk = candidates.filter(b => archetypeMatches(b, spec.archetype));
  const archetypeMiss = candidates.filter(b => !archetypeMatches(b, spec.archetype));

  // Score archetype-match candidates by keyword overlap; archetype-miss
  // candidates only fill remaining slots and at lower priority.
  const ranked = [
    ...archetypeOk.map(b => ({ b, score: scoreBullet(b, jdTokens) + 1 })).sort((a, b) => b.score - a.score),
    ...archetypeMiss.map(b => ({ b, score: scoreBullet(b, jdTokens) })).sort((a, b) => b.score - a.score),
  ];

  const pinned = pool.filter(b => pinIds.includes(b.id));
  const remainingSlots = Math.max(0, n - pinned.length);
  const picked = [...pinned, ...ranked.slice(0, remainingSlots).map(x => x.b)];
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
  const exclude = new Set(spec.excludeBullets || []);
  const candidates = pool.filter(b => !exclude.has(b.id));
  const scored = candidates.map(b => ({
    b,
    score: scoreBullet(b, jdTokens) + (archetypeMatches(b, spec.archetype) ? 1 : 0),
  })).sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map(x => ({
    name: x.b.id.replace(/^proj-/, ''),
    summary: x.b.text,
  }));
}

module.exports = { pickBullets, buildExperience, pickProjects, loadLibrary };
