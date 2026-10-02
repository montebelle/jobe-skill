/**
 * Posting ranking — profile-driven and field-agnostic.
 *
 * "Fit" means fit to THE USER, derived entirely from their own files:
 *   - target-role tokens from data/queries/seeds.json   (what they search for)
 *   - skills with a proficiency level                    (what they can prove)
 *       bullet backed (data/bullet-library.json keywords)        1.0
 *       listed only in the resume skills block or found in the
 *       optional evidence index                                  0.6
 *       declared gap (profile skills.gaps)                       0.2
 *       profile skills.levels overrides any of the above
 *     (in a library of hundreds of bullets a single word of bullet text is
 *     full evidence only when several bullets carry it; see DEPTH_SHARE)
 *   - candidate facts from data/profile.json (years, degrees, clearance)
 *   - title policy from data/profile.json (discovery.titleExclude / titleKeep)
 * There is NO hardcoded role/skill vocabulary. An unconfigured profile makes
 * the title gate permissive (nothing excluded by field) and the fit part of
 * the score neutral (56; with seeds on file only the title bonuses move it, to
 * at most 67), so the tool degrades to title words and freshness ordering
 * rather than to one profession.
 *
 *   buildProfile({queries, root})    -> fit profile (see EMPTY_PROFILE)
 *   isRoleMatch(title, profile)      -> bool (title policy, then role tokens)
 *   quickScore(posting, {profile})   -> enrich-priority (level/freshness/ATS)
 *   fullScore(posting, {profile})    -> matchScore 0-100, gatePass, minimumsUnmet
 *   statedMinimums(posting, profile) -> the JD's own minimums the user misses
 *   fuseRanking(postings, {profile}) -> RRF over [skill overlap, level, freshness]
 *
 * DESIGN INVARIANT (do not re-add): the score measures ONE thing, how well the
 * role's stated requirements map to the user's actual evidence (skill coverage
 * with honest proficiency levels, real requirement blockers, stated minimums).
 * There is NO preference, cluster, company type, or career direction boost.
 * Three such layers were tried and removed; preferences belong in filters
 * (data/profile.json), never in the score. The title policy is likewise a
 * discovery filter only, never a score modifier.
 *
 * All scoring functions mutate posting in place and return it.
 */

const fs = require('fs');
const path = require('path');
const { detectArchetype } = require('./archetypes');
const { rrf } = require('./rrf');
const { tokenize, tokenInSet, rawRoleStrings } = require('./role-queries');
const { loadProfile, titlePolicy, titleExcluded } = require('./profile');
const { foldText } = require('./normalize');

// ── Profile: the single source of "fit" ─────────────────────

const HELD = 0.6;     // at or above: a skill the user holds
const STRONG = 0.9;   // at or above: a skill with shipped proof

// Fit calibration (see fullScore).
// ponytail: constants tuned on synthetic postings from two professions and on
// one hand rated table; retune them together, against both, if the 80/65/55
// bands drift.
const COVERED_FLOOR = 0.16; // vocabulary share any resume reaches on any posting
const COVERED_FULL = 0.82;  // vocabulary share that counts as covering the posting
// A word of the user's bullets is full evidence when DEPTH_SHARE as many
// bullets carry it as carry the user's own 20th most common word. A library of
// a few dozen bullets has no such staples, so there one bullet is enough; in a
// library of hundreds, one passing mention is thin evidence.
const STAPLE_RANK = 20;
const DEPTH_SHARE = 0.08;
// A closing aside (see vocabularyCoverage) has under ASIDE_BELOW of its words
// in the user's vocabulary and is at most ASIDE_MAX of the posting.
const ASIDE_BELOW = 0.25;
const ASIDE_MAX = 0.4;
const FULL_WORDS = 60;     // content words judged at which the vocabulary estimate counts in full
const PRIOR_WEIGHT = 8;     // the vocabulary estimate is worth this many rated skills
const FULL_TABLE = 40;      // rated terms at which the user's own table stands alone
// A table that rates no weakness can say a skill is present, never that one is
// missing, so it stands alone only by the share of its terms rated below HELD
// (a term counts in full WEAK_RAMP below HELD, in proportion nearer to it).
// ponytail: one calibration point (a hand rated table has about a fifth of its
// terms below HELD); retune with FULL_TABLE.
const WEAK_SHARE = 0.2;     // share of rated weaknesses at which a full table stands alone
const WEAK_RAMP = 0.1;
// A rating changes the score as far as the table says more than "all of this is
// a strength": by its mean distance below STRONG, in full at DEFICIT.
const DEFICIT = 0.12;
// A rated table is read on a posting in the user's field: one whose title names
// a target role word, or whose vocabulary the user's evidence covers to
// FIELD_FULL (to half of it when the posting names three rated skills; two
// count half). Short of that, in proportion, the posting is scored as if
// nothing were rated: rated skills named do not open the table by themselves,
// since tools and methods shared across fields (measured on 1361 real postings
// of another field) would lift those postings into the 65 and 80 bands.
// ponytail: tuned on two synthetic professions against real postings of a
// third field; a title that shares a word with a target role switches the
// check off, so a poor fit under a familiar title is still scored by the
// rated skills it names alone. Upgrade path: weigh rated hits by where in the
// posting they sit (duties and requirements, not boilerplate).
const FIELD_FULL = 0.5;

// Seniority words a user may put in their own target titles. A title is
// boosted only when it carries one the user's seeds carry; nothing is assumed
// about which level anyone wants.
const LEVEL_WORDS = ['senior|sr', 'staff', 'principal', 'lead', 'junior|jr', 'entry', 'mid'];

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// One spelling per term: lower case, hyphens, dashes, a middle dot and runs of
// whitespace folded to a single space, so "follow-up" in a library and "follow
// up" in a JD agree (posting text often arrives with hyphens already stripped),
// and letters folded as stored posting text has them (lib/posting.js stores
// ASCII: accents stripped, a Latin letter with no ASCII form dropped), so a
// user's word and a stored posting agree in any Latin alphabet.
// A trademark or service mark sign after a name is dropped before the fold,
// which would spell it out as letters glued to the name.
// ponytail: mirrors the letter fold of posting text, not its symbol rewrites
// (a raw "<" stays a "<"); letters of other scripts are kept, though stored
// posting text has none. Upgrade path: one shared fold in lib/normalize.js.
const cleanTerm = (s) => foldText(String(s ?? '').replace(/[\u2120\u2122]/g, ' ')).replace(/[\u2018\u2019]/g, "'")
  .replace(/\p{Cf}|(?![\x00-\x7F])\p{Script=Latin}/gu, '').replace(/[\s\u00b7\p{Pd}]+/gu, ' ').trim();
const termSrc = (s) => escapeRe(s).replace(/ /g, '[\\s-]+');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole phrase match that tolerates common inflections ("audit" finds
// "audits" and "auditing", "nurse" finds "nursing") without the substring
// false positives ("excel" in "excellent", "scala" in "scalable", "java" in
// "javascript"). Never a bare trailing boundary after a stem: that silently
// drops every inflected form. Terms under 4 characters match whole only.
// ponytail: suffix list, not a stemmer; irregular forms ("analysis" vs
// "analyses") miss. Upgrade path: a real stemmer on both sides.
function termPattern(term) {
  const t = cleanTerm(term);
  if (t.length < 4 || !/[a-z]$/.test(t)) return { stem: t, src: termSrc(t) };
  const eDrop = /[a-z]e$/.test(t);
  const stem = eDrop ? t.slice(0, -1) : t;
  return { stem, src: `${termSrc(stem)}${eDrop ? '(?:e|es|ed|ing)' : '(?:s|es|ed|ing)?'}` };
}
// Light plural fold, applied to both sides ("taxes" and "tax", "nurses" and "nurse").
const foldPlural = (w) => (w.length > 3 ? w.replace(/(?<=[xs]|ch|sh)es$|(?<![su])s$/, '') : w);
// Words too common in any posting or resume to say anything about fit: function
// words, posting boilerplate, soft requirement staples, and generic duty verbs
// ("build", "lead", "manage", "run" head a duty in every field).
// Not domain terms.
const GENERIC = new Set(`a about above across after again all also am an and any are as at be because been before being
below between both but by can could did do does done down during each etc few for from further had has have having he
her here him his how i if in into is it its just may me might more most must my no nor not of off on once only onto or
other our out over own per same she should since so some such than that the their them then there these they this those
through to too toward under up us very via was we were what when where which who whom whose why will with within
without would yes you your one two three four five six
hour hours hybrid located location occasional occasionally office onsite remote site travel weekday weekend
evening holiday overtime january february march april june july august september october november december
ability able act activities additional am applicant applicants apply appropriate area areas assist attention based
basis benefit benefits bonus candidate candidates carry certification certifications certified company compensation
complete conduct current day days degree demonstrate demonstrated description detail develop direct duties education
effective effectively employee employees employer ensure environment equivalent essential evaluate excellent experience
expected experienced familiar familiarity follow friday full function functions general good great handle help high highly hire
hiring ideal identify implement include includes including initiate interpersonal issue issues item items job join
joining key knowledge least level licence license licensed licensure like looking maintain make member members minimum
monday need needed needs new open opportunities opportunity organization organizational overview part participate pay
people perform plus pm position preferred primary process proficiency proficient progress proven provide qualification
qualifications recent related relevant reliable require required requirement requirements requires resolve respond
responsibilities responsible role salary saturday seeking serve skill skills standard standards strong subject
successful summary sunday support task tasks team teams thursday time timely tuesday understanding use used using
utilize valid various want wednesday well work working works year years
build lead manage run`.split(/\s+/).map(foldPlural));
const contentWords = (text) => (cleanTerm(text).match(/[a-z][a-z0-9+#]*/g) || [])
  .map(foldPlural).filter((w) => w.length > 1 && !GENERIC.has(w));

const wholeRe = (srcs) => new RegExp(`(?<![a-z0-9])(?:${srcs.join('|')})(?![a-z0-9])`, 'i');

// Degree level from free text as written on a resume or in the profile:
// 1 associate, 2 bachelor, 3 master, 4 doctorate, 0 unknown.
// ponytail: abbreviation list, mostly US and UK credentials; an unrecognized
// credential reads as unknown, which skips the degree checks (permissive).
// Upgrade path: an explicit level key in candidate.degrees.
const DEGREE_LEVELS = [
  [4, /\b(phd|doctor\w*|dphil|md|jd|dnp|pharmd|edd|dba|psyd|dds|dvm)\b/],
  [3, /\b(master\w*|ms|msc|ma|meng|mba|msn|mph|mfa|msw|macc|mst|mpa|mpp|llm)\b/],
  [2, /\b(bachelor\w*|bs|bsc|ba|beng|bba|bsn|bfa|llb)\b/],
  [1, /\b(associate\w*|aa|aas|adn)\b/],
];
function degreeLevel(text) {
  const d = String(text || '').toLowerCase().replace(/\./g, '');
  for (const [level, re] of DEGREE_LEVELS) if (re.test(d)) return level;
  return 0;
}

function buildProfile({ queries, root } = {}) {
  // An omitted root resolves to the active workspace, not the process CWD.
  root = root || require('./config').getUserRoot();
  if (!queries) queries = (readJson(path.join(root, 'data/queries/seeds.json')) || {}).queries || [];
  const user = loadProfile({ root });

  // Role tokens, plus the seniority words the user's own target titles carry
  // (tokenize strips those, so read the raw seed strings).
  const roleTokens = new Set();
  const levels = [];
  for (const r of rawRoleStrings({ queries })) {
    for (const t of tokenize(r)) roleTokens.add(t);
    for (const w of LEVEL_WORDS) {
      if (!levels.includes(w) && new RegExp(`\\b(?:${w})\\b`, 'i').test(r)) levels.push(w);
    }
  }

  // Skill inventory: term -> proficiency level. The highest derived level
  // wins, so a skill the user holds can never be scored as a gap.
  const level = new Map();
  const put = (term, lv) => { const t = cleanTerm(term); if (t && !(level.get(t) >= lv)) level.set(t, lv); };

  const gapDefs = [];
  for (const g of user.skills.gaps || []) {
    // A gap is a plain string, or { label, terms[], unlessAlso[] } when one gap
    // has several names or should not count next to an alternative.
    const def = typeof g === 'string' ? { label: g, terms: [g] }
      : (g && typeof g === 'object' && Array.isArray(g.terms)) ? { label: g.label || g.terms[0], terms: g.terms, unlessAlso: g.unlessAlso } : null;
    if (!def) continue;
    def.terms = def.terms.map(cleanTerm).filter(Boolean);
    def.unlessAlso = (Array.isArray(def.unlessAlso) ? def.unlessAlso : []).map(cleanTerm).filter(Boolean);
    if (!def.terms.length) continue;
    gapDefs.push(def);
    for (const t of def.terms) put(t, 0.2);
  }

  // Optional evidence index (scripts/evidence-index.js): a tool proven present
  // in the user's own work product is held, whatever the gap list says.
  const index = readJson(path.join(root, 'data/evidence-index.json'));
  for (const tool of Object.keys((index && index.toolPresence) || {})) put(tool, HELD);

  const baseline = readJson(path.join(root, 'data/resume-baseline.json')) || {};
  if (baseline.skills) {
    const { flattenSkillItems, canonicalSkill } = require('./tailor');
    for (const s of flattenSkillItems(baseline.skills)) put(canonicalSkill(s), HELD);
  }

  // Evidence vocabulary: every word of the user's own material with the level
  // of its best source (bullets up to 1.0, skills block or evidence index 0.6,
  // declared gap 0.2), bucketed by its first four letters.
  const evidence = new Map();
  let hasEvidence = false;
  const learnWord = (w, lv) => {
    if (lv >= HELD) hasEvidence = true;
    const bucket = evidence.get(w.slice(0, 4)) || evidence.set(w.slice(0, 4), new Map()).get(w.slice(0, 4));
    if (!(bucket.get(w) >= lv)) bucket.set(w, lv);
  };
  const learn = (text, lv) => { for (const w of contentWords(text)) learnWord(w, lv); };
  // Skills block and evidence index 0.6, declared gap 0.2 (read before the
  // library keywords join the table).
  for (const [term, lv] of level) learn(term, lv);

  // The user's bullets, one document each (text and keywords together).
  const skillKeywords = new Set();
  const docs = new Set();
  const lib = readJson(path.join(root, 'data/bullet-library.json')) || {};
  for (const k of Object.keys(lib)) {
    if (!Array.isArray(lib[k])) continue;
    for (const b of lib[k]) {
      const kws = [];
      for (const kw of ((b && b.keywords) || [])) {
        const s = cleanTerm(kw);
        if (s.length >= 3) { skillKeywords.add(s); put(s, 1.0); kws.push(s); }
      }
      docs.add([b && typeof b.text === 'string' ? b.text : '', ...kws].join(' . '));
    }
  }
  for (const e of Array.isArray(baseline.experience) ? baseline.experience : []) {
    if (!e) continue;
    docs.add([e.title, e.subtitle].filter((x) => typeof x === 'string').join(' . '));
    for (const t of Array.isArray(e.bullets) ? e.bullets : []) if (typeof t === 'string') docs.add(t);
  }
  // Bullet backed words: level by how many bullets carry the word (see
  // STAPLE_RANK), 1.0 at full depth. Padding the library with unrelated bullets
  // does not move the staples, so it does not move any level.
  const df = new Map();
  for (const d of docs) for (const w of new Set(contentWords(d))) df.set(w, (df.get(w) || 0) + 1);
  const depth = Math.max(1, DEPTH_SHARE * ([...df.values()].sort((a, b) => b - a)[STAPLE_RANK - 1] || 1));
  for (const [w, n] of df) learnWord(w, Math.min(1, n / depth));

  // Explicit overrides replace the derived value in either direction. Only a
  // skill the user rated themselves can earn the differentiator bonus: a
  // library keyword is bullet backed (1.0) for coverage, but "every keyword I
  // ever wrote" is not a differentiator.
  const rated = new Set();
  for (const [term, lv] of Object.entries(user.skills.levels || {})) {
    const t = cleanTerm(term);
    if (t && typeof lv === 'number' && lv >= 0 && lv <= 1) { level.set(t, lv); rated.add(t); learn(t, lv); }
  }

  let weak = 0, deficit = 0;
  for (const t of rated) {
    weak += Math.min(1, Math.max(0, (HELD - level.get(t)) / WEAK_RAMP));
    deficit += Math.max(0, STRONG - level.get(t));
  }
  const ratedTrust = rated.size ? Math.min(1, deficit / (DEFICIT * rated.size)) : 0;

  const skills = [...level].map(([term, lv]) => {
    const { stem, src } = termPattern(term);
    return { term, level: lv, stem, re: wholeRe([src]), rated: rated.has(term) };
  });

  // Gaps that survive: every name of the gap is still below "held".
  const gapSkills = gapDefs
    .filter((g) => g.terms.every((t) => (level.get(t) || 0) < HELD))
    .map((g) => ({
      label: g.label,
      re: wholeRe(g.terms.map((t) => termPattern(t).src)),
      alt: g.unlessAlso.length ? wholeRe(g.unlessAlso.map((t) => termPattern(t).src)) : null,
    }));

  // Candidate facts a posting can require. Unknown means the check is skipped.
  const cand = user.candidate || {};
  const degrees = [
    ...(Array.isArray(cand.degrees) ? cand.degrees : []),
    ...(Array.isArray(baseline.education) ? baseline.education.map((e) => e && e.degree) : []),
  ].filter((d) => typeof d === 'string' && d.trim());
  let top = 0, degreeLabel = null;
  for (const d of degrees) { learn(d, 1.0); const lv = degreeLevel(d); if (lv > top) { top = lv; degreeLabel = d.trim(); } }
  const years = typeof cand.yearsExperience === 'number' && cand.yearsExperience >= 0 ? cand.yearsExperience : null;
  // clearance: a name means the user holds one; null means unknown (no check);
  // false (or "none") means the user holds none, so a required clearance blocks.
  const noClearance = cand.clearance === false || (typeof cand.clearance === 'string' && /^(none|no)$/i.test(cand.clearance.trim()));

  return {
    roleTokens,
    skillKeywords,
    configured: roleTokens.size > 0 || skillKeywords.size > 0,
    titlePolicy: titlePolicy(user),
    levelRe: levels.length ? new RegExp(`\\b(?:${levels.join('|')})\\b`, 'i') : null,
    skills,
    evidence,
    hasEvidence,
    // How far the user's own table stands alone, 0 to 1: its size, times how
    // far it also rates what the user lacks (see WEAK_SHARE).
    ratedness: rated.size ? Math.min(1, rated.size / FULL_TABLE) * Math.min(1, weak / (WEAK_SHARE * rated.size)) : 0,
    // How far a rated skill the JD names counts as rated (see DEFICIT).
    ratedTrust,
    heldCount: skills.filter((s) => s.level >= HELD).length,
    gapSkills,
    candidate: { years, degreeLevel: top, degreeLabel, noClearance },
  };
}

const EMPTY_PROFILE = {
  roleTokens: new Set(),
  skillKeywords: new Set(),
  configured: false,
  titlePolicy: { exclude: null, keep: null },
  levelRe: null,
  skills: [],
  evidence: new Map(),
  hasEvidence: false,
  ratedness: 0,
  ratedTrust: 0,
  heldCount: 0,
  gapSkills: [],
  candidate: { years: null, degreeLevel: 0, degreeLabel: null, noClearance: false },
};

// Older callers may hand over a partial profile; every field has a neutral default.
const withDefaults = (profile) => ({ ...EMPTY_PROFILE, ...(profile || {}) });

// ── Title gate ──────────────────────────────────────────────
// Discovery filter only (never a score modifier). Shared by the pipeline, the
// manual ingest, and the agent import.

function isRoleMatch(title, profile = EMPTY_PROFILE) {
  if (!title) return false;
  const p = withDefaults(profile);
  // The user's own title policy. Runs even with no seeds: a user can exclude
  // a level or a function before any target role is configured.
  // A keep phrase shields only its own words: an exclude phrase elsewhere in
  // the title still drops it.
  if (titleExcluded(title, p.titlePolicy)) return false;
  // Permissive when unconfigured: do NOT exclude by field.
  if (!p.roleTokens || p.roleTokens.size === 0) return true;
  for (const t of tokenize(title)) if (tokenInSet(t, p.roleTokens)) return true;
  return false;
}

const hasUserLevel = (title, profile) => !!(profile.levelRe && profile.levelRe.test(title || ''));

// ── Skill demand vs supply ──────────────────────────────────
// Of the user's known skills (held ones and declared gaps), which does this
// text call for, and at what proficiency does the user hold them?

function matchSkills(text, profile) {
  const hay = cleanTerm(text);
  const out = { demand: 0, supply: 0, held: 0, heldSupply: 0, strong: 0, have: [], gaps: [], hits: [] };
  for (const s of profile.skills) {
    if (!hay.includes(s.stem) || !s.re.test(hay)) continue;
    out.demand++;
    out.hits.push(s);
    out.supply += s.level;
    if (s.level >= HELD) { out.held++; out.heldSupply += s.level; out.have.push(s.term); }
    else out.gaps.push(s.term);
    if (s.rated && s.level >= STRONG) out.strong++;
  }
  return out;
}

// ── Pre-enrichment ordering (no JD required) ────────────────
// Decides which title-allowed postings get JD-fetched first. NOT a fit signal.

function quickScore(posting, opts = {}) {
  const profile = withDefaults(opts.profile);
  if (!isRoleMatch(posting.title, profile)) {
    posting.quickScore = 0;
    posting.rankReason = 'title-excluded';
    return posting;
  }
  let s = 1;
  // A level the user's own target titles name. No level words in the seeds
  // means no seniority boost at all.
  if (hasUserLevel(posting.title, profile)) s += 1;

  if (posting.postedDate) {
    const ageDays = (Date.now() - new Date(posting.postedDate)) / 86400000;
    if (ageDays <= 7) s += 0.6;
    else if (ageDays <= 14) s += 0.3;
  }

  const url = posting.canonicalUrl || '';
  if (/(greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|icims\.com)/i.test(url)) {
    s += 0.4;
  }

  posting.quickScore = s;
  posting.archetype = posting.archetype || 'General';
  posting.rankReason = `enrich-priority: ${s.toFixed(2)}`;
  return posting;
}

// ── Hard requirement blockers ───────────────────────────────
// Generic JD language. Each applies only when the matching candidate fact is
// known and is not met; an unknown fact skips the check.

const PHD_REQUIRED = /\b(ph\.?d\.?\s+(is\s+)?(required|mandatory|preferred and required)|must (have|hold|possess)\s+(a\s+)?ph\.?d|requires?\s+a\s+ph\.?d)\b/i;
const CLEARANCE_REQUIRED = /\b((active|current|ts\/sci|top[- ]secret)\s*)?(security clearance|secret clearance|ts\/sci|polygraph)\b/i;
const LONG_TENURE = /\b(1[0-5]|ten|twelve|fifteen)\+\s*years\b/i;
const WORD_YEARS = { ten: 10, twelve: 12, fifteen: 15 };

// ── Stated minimums ─────────────────────────────────────────
// A JD's OWN stated minimum qualifications are experience-to-role fit: parse
// them and count what the user's actual experience does not meet. Each unmet
// minimum costs points and is surfaced in reasons + posting.minimumsUnmet so
// targeting decisions are eyes-open.

const REQUIRED_CTX = /\b(required|must[- ]have|must have|minimum qualifications?|minimum requirements?|you (must|need)|proficiency in|strong (proficiency|foundation) in|expertise in)\b/i;
// An "example / alternatives" list means the named skill is one option, not a
// hard minimum.
const EXAMPLE_CTX = /\b(e\.?g\.?|such as|for example|including|like|one of|any of|or (similar|equivalent)|familiar(ity)? with)\b/i;
// "MS" directly before a product name (spaced or hyphenated) is the software
// vendor, not a degree.
// ponytail: closed product list; an unlisted product still reads as a degree.
const MS_DEGREE = String.raw`m\.?s\.?(?![\s-]*(?:office|excel|word|access|project|teams|dynamics|sql|windows|power|outlook|365|suite|sharepoint|visio|azure|publisher|onenote|exchange|fabric))`;
const ADVANCED_DEGREE_MIN = new RegExp(String.raw`\b(${MS_DEGREE}|master(?:'s)?|graduate degree|advanced degree)\b[^.]{0,60}\b(required|minimum)\b|\bminimum\b[^.]{0,80}\b(${MS_DEGREE}|master|ph\.?d)\b|\b(ms|master(?:'s)?) or ph\.?d\b`, 'i');

// The largest "N+ years" / "N or more years" ask in the JD (0 when none).
function maxYearsAsk(jd) {
  const asks = [...String(jd || '').matchAll(/(\d{1,2})\s*\+\s*years|\b(\d{1,2})\s+or more years/gi)]
    .map((m) => parseInt(m[1] || m[2], 10)).filter((n) => n >= 3 && n <= 20);
  return asks.length ? Math.max(...asks) : 0;
}

function statedMinimums(posting, profile = EMPTY_PROFILE) {
  const p = withDefaults(profile);
  const cand = p.candidate || EMPTY_PROFILE.candidate;
  const jd = posting.jdText || '';
  const unmet = [];
  // Years: the largest ask vs the user's own years. Unknown years: skipped.
  const maxYears = maxYearsAsk(jd);
  if (cand.years != null && maxYears > cand.years) unmet.push(`${maxYears}+ years (you: ${cand.years})`);
  // Advanced degree minimum, when the user's highest known degree is below it.
  if (cand.degreeLevel > 0 && cand.degreeLevel < 3 && ADVANCED_DEGREE_MIN.test(jd)) {
    unmet.push(`advanced degree minimum (you: ${cand.degreeLabel})`);
  }
  // Declared gaps named in a required context: check a window around the
  // first mention for required-language.
  // (Gap names are stored folded, so the JD is folded the same way here.)
  const folded = p.gapSkills && p.gapSkills.length ? cleanTerm(jd) : '';
  for (const g of p.gapSkills || []) {
    const m = g.re.exec(folded);
    if (!m) continue;
    const win = folded.slice(Math.max(0, m.index - 140), m.index + m[0].length + 140);
    if (!REQUIRED_CTX.test(win)) continue;
    // Not a hard minimum if the mention sits in an example/alternatives list,
    // or next to an alternative the user named for this gap (unlessAlso).
    if (EXAMPLE_CTX.test(win)) continue;
    if (g.alt && g.alt.test(win)) continue;
    unmet.push(g.label);
  }
  return unmet;
}

// ── Full score (JD required) ────────────────────────────────
// Fit, proficiency weighted: of what the JD asks for, how much does the user
// hold, and how well? Two estimates of that, blended by how much of their own
// skill table the user has rated (profile skills.levels):
//   rated     of the rated skills the JD names, the mean level. With a full
//             table this is the whole coverage; a JD naming none is neutral.
//             A table stands alone only as far as it also rates weaknesses;
//             short of that its hits are blended with the derived estimate,
//             and a table of strengths alone is not counted at all. On a
//             posting outside the user's field (see FIELD_FULL) the table is
//             set aside and the derived estimate decides.
//   derived   the share of the JD's own content words found in the user's
//             evidence (bullet text and keywords up to 1.0, skills block or
//             evidence index 0.6, declared gap 0.2), stretched so COVERED_FULL
//             of the words is full coverage. With nothing rated this is the
//             whole coverage. It reads the whole JD less its closing asides,
//             in any layout (headings, labels, bullets, plain lines, running
//             text), and keywords the JD never uses cannot move it. A snippet
//             of under FULL_WORDS content words is pulled toward neutral in
//             proportion, so a three line listing cannot outrank a posting.
// ponytail: the derived estimate tracks field and breadth, not the user's own
// ranking of their skills. On real postings inside one field it orders them
// much as the title and requirement checks alone would; only skills.levels
// adds the user's judgment. Upgrade path: onboarding writes skills.levels.
// The skills gate (gate1) follows the same blend: coverage of at least half is
// asked of the rated estimate only (0.5 times the rated share of the table), so
// with nothing rated the gate is the score floor alone.
// Neutral 0.5 when the user has nothing on file. Calibrated so a typical
// relevant role lands in the 65 to 79 band and only a posting the user covers
// almost entirely reaches 80. No hardcoded vocabulary.

// Pay, benefits, equal opportunity, and how to apply text is not a requirement.
const PAY_OR_BENEFITS = /[$\u00a3\u20ac]\s?\d|\b(?:salary|pay|compensation) (?:range|rate|band|scale)\b|\bper (?:year|hour|annum)\b|\b(?:dental|401\(?k\)?|paid time off|paid holidays|pto|vacation|sick leave|parental leave|tuition reimbursement|retirement plan|pension|stipend|employee assistance|(?:health|medical|vision|life|disability) (?:insurance|coverage|plan)|benefits package)\b/i;
// A sentence in the employer's own voice describes the employer, unless it
// states an ask ("We are seeking ...", "We require ...", "Our nurses must ...").
const EMPLOYER_VOICE = /^\W*(?:we|our|if you)\b/i;
const ASK_CUE = /\b(?:looking for|seeking|seeks?|needs?|requires?|required|expects?|must|should|who (?:can|will|has|have|is|are)|experience (?:with|in))\b/i;
// A heading or label that opens duties or requirements.
const ASK_HEAD = /\b(?:responsibilit\w*|dut(?:y|ies)|requirements?|required|qualifications?|skills|experience|education|essential|accountabilit\w*|you (?:will|bring|have|are|need|do)|you'll|about you|looking for|your (?:role|day|impact|profile|background|work)|the (?:role|job|position|opportunity|work)|(?:role|job|position) (?:summary|overview|description|purpose)|summary|must haves?|nice to haves?|preferred|minimum|competenc\w*|knowledge|scope|tasks?|functions)\b/i;
const LIST_ITEM = /^(?:[-*\u2022\u00b7]|\d+[.)])\s+/;
// Working conditions and pre-employment screening are not skills either.
const CONDITIONS = /\b\d+ ?(?:pounds|lbs?|kg)\b|\b(?:lifting|(?<!good )standing|sitting|walking|bending|stooping|kneeling|crouching|(?:stand|sit|walk) for|visual acuity|bloodborne|background (?:check|screening|investigation)|drug (?:screen|test)\w*|vaccinat\w+|immuni[sz]ations?|physical (?:demands|exam\w*)|reliable transportation|rotating (?:shifts?|weekends?|schedules?))\b/i;
// A line in the form of a duty (opens with a common duty verb, or with any
// word followed by an article: "Maintain the ...") or of a credential ask.
const DUTY_LEAD = /(?:^|\band )(?:administer|analy[sz]e|assess|assist|audit|build|calculate|collaborate|collect|communicate|complete|conduct|configure|coordinate|create|deliver|design|develop|direct|document|drive|ensure|establish|evaluate|execute|facilitate|handle|identify|implement|improve|inspect|install|investigate|lead|maintain|manage|model|monitor|negotiate|operate|organize|oversee|own|partner|perform|plan|prepare|present|process|produce|provide|reconcile|repair|report|research|resolve|respond|review|run|schedule|serve|supervise|support|teach|test|track|train|troubleshoot|update|write)\b|^[a-z]+ (?:the|an?)\b/i;
const CREDENTIAL = /\b(?:experience|certifi\w+|licen[sc]\w+|degree|diploma|\d\+? years)\b/i;
const EEO_OR_APPLY = /\bequal (?:opportunity|employment)\b|\bwithout regard to\b|\b(?:to apply|apply (?:now|online|today)|submit (?:your|a) (?:resume|application|cv)|accommodations?)\b/i;

// Level of the user's evidence for one JD word (0 when the user has none).
function evidenceLevel(word, evidence) {
  const bucket = evidence.get(word.slice(0, 4));
  if (!bucket) return 0;
  let best = bucket.get(word) || 0;
  if (best < 1 && word.length >= 4) for (const [w, lv] of bucket) if (lv > best && sameStem(word, w)) best = lv;
  return best;
}
// Two forms of one word: a shared base (at least four letters and most of the
// shorter word) with nothing but an inflection left on each side. Looser than
// that joins strangers ("audit" and "audio", "care" and "career").
// ponytail: suffix list, not a stemmer; "analysis" and "analyze" stay apart.
const ENDING = /^(?:|e|es|ed|ing|er|or|ion|ation|iation|ment|ement|ive|ial)$/;
function sameStem(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i < Math.max(4, Math.ceil(0.7 * Math.min(a.length, b.length)))) return false;
  if (a[i - 1] === 'e') i--;
  // A doubled final consonant before the ending ("plan", "planning").
  const rest = (w) => (w[i] === w[i - 1] && i + 1 < w.length ? w.slice(i + 1) : w.slice(i));
  return ENDING.test(rest(a)) && ENDING.test(rest(b));
}

// Share of the JD's own content words the user's evidence covers, weighted by
// how often the JD says each word and by the level of the evidence, with the
// number of words counted. Null when the JD has no content word left.
// ponytail: single words, no synonyms ("intravenous" does not find "IV") and
// no phrases. Upgrade path: phrase evidence from the bullet keywords.
function vocabularyCoverage(posting, profile, hits) {
  // The employer's own name is not a requirement: the whole name is dropped
  // where it stands, and its words elsewhere unless the user's evidence covers
  // them (a firm named after the user's field).
  const skip = new Set(contentWords(posting.company).filter((w) => !evidenceLevel(w, profile.evidence)));
  const company = cleanTerm(posting.company);
  const named = company ? new RegExp(`(?<![a-z0-9])${escapeRe(company)}(?![a-z0-9])`, 'g') : null;
  // One unit per sentence or line. A new part of the posting can open at a
  // short line with no end punctuation or at a "Label:".
  const units = [];
  let asks = false, sum = 0, total = 0, known = 0;
  for (const raw of String(posting.jdText).split(/\n+/)) {
    const line = raw.trim();
    const item = LIST_ITEM.test(line);
    const segs = line.replace(LIST_ITEM, '').split(/(?<=[.!?;:])\s+/);
    for (const seg of segs) {
      const head = !item && seg.split(/\s+/).length <= 6 && (/^[A-Z][^.!?;,:]*:$/.test(seg) || (segs.length === 1 && !/[.!?;,]$/.test(seg)));
      const unit = { head, ask: head && ASK_HEAD.test(seg), demand: false, sum: 0, total: 0, known: 0 };
      if (unit.ask) asks = true;
      units.push(unit);
      if ((EMPLOYER_VOICE.test(seg) && !ASK_CUE.test(seg)) || (company && cleanTerm(seg).startsWith(company))) continue;
      if (EEO_OR_APPLY.test(seg) || ((PAY_OR_BENEFITS.test(seg) || CONDITIONS.test(seg)) && !hits.some((s) => s.re.test(cleanTerm(seg))))) continue;
      for (const w of contentWords(named ? cleanTerm(seg).replace(named, ' ') : seg)) {
        if (skip.has(w)) continue;
        const lv = evidenceLevel(w, profile.evidence);
        unit.total++; unit.sum += lv; if (lv) unit.known++;
      }
      unit.demand = unit.total > 0 && (DUTY_LEAD.test(seg) || ASK_CUE.test(seg) || CREDENTIAL.test(seg));
      sum += unit.sum; total += unit.total; known += unit.known;
    }
  }
  // Closing asides: sections at the end of the posting, each under a heading
  // of its own that is not a duties or requirements heading, whose text is far
  // from the user's evidence (perks, the company's story) and shorter than the
  // rest. Unmet demand is far from the evidence too, so a section with a line
  // in the form of a duty or an ask is never an aside, whatever its heading
  // says; the walk back ends at a duties or requirements heading with such a
  // section under it; and the size limit keeps a posting from another field
  // whole.
  // ponytail: form is read from a line's first words and a few cue words, so an
  // aside with no heading of its own still counts as unmet demand; so does a
  // line under a requirements heading that is neither a skill nor a working
  // condition CONDITIONS knows; and unmet asks written only as bare noun
  // phrases under a heading ASK_HEAD does not know are taken for an aside.
  // Upgrade path: a sentence classifier (duty, ask, statement).
  let end = units.length, demand = false, tailSum = 0, tailTotal = 0, tailKnown = 0, cut = null;
  for (let i = units.length - 1; i >= 0; i--) {
    if (!units[i].head) continue;
    const sec = units.slice(i, end);
    end = i;
    if (sec.some((u) => u.demand)) demand = true;
    if (units[i].ask && demand) break;
    if (units[i].ask || sec.some((u) => u.demand)) continue;
    for (const u of sec) { tailSum += u.sum; tailTotal += u.total; tailKnown += u.known; }
    const inField = asks && (known - tailKnown) >= 0.5 * (total - tailTotal);
    if (tailKnown < ASIDE_BELOW * tailTotal && (inField || tailTotal <= ASIDE_MAX * total)) cut = { sum: tailSum, total: tailTotal };
  }
  if (cut) { sum -= cut.sum; total -= cut.total; }
  return total ? { raw: sum / total, words: total } : null;
}

function fullScore(posting, opts = {}) {
  const jd = posting.jdText || '';
  if (!jd) {
    posting.matchScore = null;
    posting.rankReason = (posting.rankReason || '') + '; full: no-jd';
    return posting;
  }
  const profile = withDefaults(opts.profile);
  const cand = profile.candidate || EMPTY_PROFILE.candidate;
  const title = posting.title || '';
  const reasons = [];

  // Target role words the title carries.
  let roleHits = 0;
  if (profile.roleTokens.size) {
    const tt = new Set(tokenize(title));
    for (const t of profile.roleTokens) if (tokenInSet(t, tt)) roleHits++;
  }

  const m = matchSkills(jd, profile);
  let r = profile.ratedness, trust = profile.ratedTrust;
  let coverage = 0.5, thin = false;
  if (profile.skills.length || profile.hasEvidence) {
    const vc = profile.hasEvidence ? vocabularyCoverage(posting, profile, m.hits) : null;
    // Too little of the JD is left to judge, and it names no skill of the user's.
    thin = profile.hasEvidence && (!vc || vc.words < 15) && !m.demand;
    const stretched = vc == null ? 0.5 : Math.max(0, Math.min(1, (vc.raw - COVERED_FLOOR) / (COVERED_FULL - COVERED_FLOOR)));
    // A snippet says little either way: the fewer words judged, the closer to neutral.
    const derived = 0.5 + (stretched - 0.5) * Math.min(1, (vc ? vc.words : 0) / FULL_WORDS);
    const rated = m.hits.filter((s) => s.rated);
    // Outside the user's field the table is set aside (see FIELD_FULL).
    if (!roleHits) {
      const named = Math.min(1, (rated.length - 1) / 2) * Math.min(1, 2 * derived / FIELD_FULL);
      const inField = Math.min(1, Math.max(derived / FIELD_FULL, named));
      r *= inField; trust *= inField;
    }
    const weight = PRIOR_WEIGHT * (1 - r), prior = (1 - r) * derived + r * 0.5;
    // Rated hits count as far as the table is trusted (see DEFICIT).
    const n = trust * rated.length;
    if (n + weight) coverage = (trust * rated.reduce((a, s) => a + s.level, 0) + weight * prior) / (n + weight);
    reasons.push(`skills:${m.held}/${profile.heldCount}`);
    if (m.have.length) reasons.push(`fit:${m.have.slice(0, 6).join('/')}`);
    if (m.gaps.length) reasons.push(`gap:${m.gaps.slice(0, 4).join('/')}`);
  }
  let score = 34 + coverage * 44; // 34..78 from fit alone

  // Differentiator bonus: strengths the user rated themselves (profile
  // skills.levels at 0.9 or above) present in the JD signal a standout (not
  // just adequate) candidate. Small, capped, never the spine. None rated, none.
  // Like the rated hits in coverage, it adds points as far as the table is
  // trusted (see DEFICIT). For the rest it takes the place of title role
  // points and adds none of its own, so a table of strengths alone earns no
  // more bonus than the same user with nothing rated (its terms still count
  // as evidence in the derived estimate).
  // ponytail: a rated table lists several spellings of one skill, so the count
  // of rated terms is dampened (one term 1.2, four 3.4, eight 5.7) rather than
  // grouped. Upgrade path: a group key in skills.levels, 1.2 per group.
  const full = Math.min(8, 1.2 * m.strong ** 0.75);

  // Title role-match: does this posting's title align with the user's targets?
  // It stands in for the differentiators of a user who has rated nothing, so it
  // shares their cap and fades as the user's own table fills in.
  const role = Math.min(8, roleHits * 3 * (1 - r));
  const bonus = trust * full + (1 - trust) * Math.min(full, role);
  if (bonus) { score += bonus; reasons.push(`+${bonus.toFixed(1)} differentiators`); }
  const b = Math.round((trust * Math.min(8 - full, role) + (1 - trust) * (role - Math.min(full, role))) * 10) / 10;
  if (b > 0) { score += b; reasons.push(`+${b} role-match`); }

  // Hard blockers: requirements the user's known facts do not meet.
  if (cand.degreeLevel > 0 && cand.degreeLevel < 4 && PHD_REQUIRED.test(jd)) { score -= 15; reasons.push('-15 phd-required'); }
  if (cand.noClearance && CLEARANCE_REQUIRED.test(jd)) { score -= 18; reasons.push('-18 clearance'); }
  const tenure = LONG_TENURE.exec(jd);
  if (tenure && cand.years != null) {
    const asked = WORD_YEARS[tenure[1].toLowerCase()] || parseInt(tenure[1], 10);
    if (asked > cand.years) { score -= 5; reasons.push('-5 10y+-required'); }
  }

  // Seniority alignment with a level the user's own target titles name.
  if (hasUserLevel(title, profile)) { score += 3; reasons.push('+3 seniority-fit'); }

  posting.archetype = detectArchetype(jd).primary;

  score = Math.max(0, Math.min(100, score));
  posting.fitCoverage = Math.round(coverage * 100) / 100;

  // Stated minimums the JD itself declares vs the user's actual experience:
  // each unmet minimum is a real fit deficit.
  const unmet = statedMinimums(posting, profile);
  if (unmet.length) {
    const pts = -6 * unmet.length;
    score = Math.max(0, score + pts);
    reasons.push(`${pts} unmet stated minimums: ${unmet.join('; ')}`);
  }
  posting.minimumsUnmet = unmet;
  posting.matchScore = Math.round(score);

  posting.gatePass = {
    // Required skills proxy: the score clears the floor, the JD gave enough to
    // judge, and coverage is at least half as far as the user rated their own
    // skills (the half mark is a property of the rated formula).
    gate1: coverage >= 0.5 * r && score >= 55 && !thin,
    // Experience: passes unless the JD's largest years ask exceeds the user's
    // years. Unknown years passes.
    gate2: cand.years == null || maxYearsAsk(jd) <= cand.years,
    minimums: unmet.length === 0,
  };
  posting.rankReason = reasons.slice(0, 10).join(', ');
  return posting;
}

// ── RRF-fused ordering across independent signal rankings ────
// Reference: Bruch et al, ACM TOIS 2024. Signals: held-skill overlap
// (proficiency weighted), a level the user targets, freshness. A signal the
// profile cannot express (no skills on file, no level words in the seeds) is
// left out rather than fused as a flat ranking, which would only reward input
// order.

function fuseRanking(postings, opts = {}) {
  if (!postings.length) return [];
  const profile = withDefaults(opts.profile);

  const freshnessScore = (p) => {
    if (!p.postedDate) return 0;
    const ageDays = (Date.now() - new Date(p.postedDate)) / 86400000;
    return Math.max(0, 60 - ageDays);
  };
  const signals = [freshnessScore];
  if (profile.skills.length) {
    signals.unshift((p) => matchSkills(`${p.title} ${p.department || ''} ${p.jdText || ''}`, profile).heldSupply);
  }
  if (profile.levelRe) signals.push((p) => (hasUserLevel(p.title, profile) ? 1 : 0));

  const rankings = signals.map((fn) => {
    const scored = new Map(postings.map((p) => [p, fn(p)]));
    return [...postings].sort((a, b) => scored.get(b) - scored.get(a));
  });

  const fused = rrf(rankings, p => p.canonicalUrl, { k: opts.k || 60 });
  for (let i = 0; i < fused.length; i++) {
    const p = fused[i].item;
    p.rrfScore = fused[i].score;
    p.rrfRank = i + 1;
  }
  return fused.map(x => x.item);
}

module.exports = { buildProfile, quickScore, fullScore, fuseRanking, isRoleMatch, statedMinimums, EMPTY_PROFILE };
