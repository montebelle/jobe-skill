/**
 * Posting ranking — profile-driven and field-agnostic.
 *
 * "Fit" means fit to THE USER, derived entirely from their profile:
 *   - target-role tokens from data/queries/seeds.json  (what they search for)
 *   - skill keywords from data/bullet-library.json      (what they can prove)
 * There is NO hardcoded role/skill vocabulary. An unconfigured profile makes
 * the title gate permissive (nothing excluded by field) and scoring neutral,
 * so the tool degrades to recency/seniority ordering rather than to ML-only.
 *
 *   buildProfile({queries, root})    -> { roleTokens, skillKeywords, configured }
 *   isRoleMatch(title, profile)      -> bool (permissive when unconfigured)
 *   quickScore(posting, {profile})   -> enrich-priority (seniority/freshness/ATS)
 *   fullScore(posting, {profile})    -> matchScore 0-100 from JD/profile overlap
 *   fuseRanking(postings, {profile}) -> RRF over [profile-overlap, seniority, freshness]
 *
 * All functions mutate posting in place and return it.
 */

const fs = require('fs');
const path = require('path');
const { detectArchetype } = require('./archetypes');
const { rrf } = require('./rrf');
const { tokenize } = require('./role-queries');

// ── Profile: the single source of "fit" ─────────────────────

function buildProfile({ queries, root } = {}) {
  root = root || process.cwd();
  if (!queries) {
    try { queries = JSON.parse(fs.readFileSync(path.join(root, 'data/queries/seeds.json'), 'utf8')).queries; }
    catch { queries = []; }
  }
  const roleTokens = new Set();
  for (const q of queries || []) {
    const r = typeof q === 'string' ? q : (q && q.query) || '';
    for (const t of tokenize(r)) roleTokens.add(t);
  }
  const skillKeywords = new Set();
  try {
    const lib = JSON.parse(fs.readFileSync(path.join(root, 'data/bullet-library.json'), 'utf8'));
    for (const k of Object.keys(lib)) {
      if (!Array.isArray(lib[k])) continue;
      for (const b of lib[k]) for (const kw of (b.keywords || [])) {
        const s = String(kw).toLowerCase().trim();
        if (s.length >= 3) skillKeywords.add(s);
      }
    }
  } catch { /* no library yet -> role-token gate only */ }
  return { roleTokens, skillKeywords, configured: roleTokens.size > 0 || skillKeywords.size > 0 };
}

const EMPTY_PROFILE = { roleTokens: new Set(), skillKeywords: new Set(), configured: false };

// ── Title gate ──────────────────────────────────────────────

function isRoleMatch(title, profile = EMPTY_PROFILE) {
  if (!title) return false;
  // Permissive when unconfigured: do NOT exclude by field.
  if (!profile || !profile.configured || !profile.roleTokens || profile.roleTokens.size === 0) return true;
  for (const t of tokenize(title)) if (profile.roleTokens.has(t)) return true;
  return false;
}

// ── Generic, field-agnostic seniority signal ────────────────

const SENIORITY_BOOST = [
  { pattern: /\bstaff\b/i, weight: 0.6 },
  { pattern: /\bsenior\b|\bsr\.?\b/i, weight: 0.5 },
  { pattern: /\bprincipal\b/i, weight: 0.6 },
  { pattern: /\blead\b/i, weight: 0.3 },
];

function countMatches(haystackLower, keywords) {
  let n = 0;
  for (const kw of keywords) if (haystackLower.includes(kw)) n++;
  return n;
}

// ── Pre-enrichment ordering (no JD required) ────────────────
// Decides which title-allowed postings get JD-fetched first. NOT a fit signal.

function quickScore(posting, opts = {}) {
  const profile = opts.profile || EMPTY_PROFILE;
  if (!isRoleMatch(posting.title, profile)) {
    posting.quickScore = 0;
    posting.rankReason = 'title-excluded';
    return posting;
  }
  let s = 1;
  if (/\bstaff\b/i.test(posting.title)) s += 1.5;
  else if (/\bprincipal\b/i.test(posting.title)) s += 1.5;
  else if (/\bsenior\b|\bsr\.?\b/i.test(posting.title)) s += 1;
  else if (/\blead\b/i.test(posting.title)) s += 0.5;

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

// ── Full score (JD required) ────────────────────────────────
// Fit = how much of the user's provable skill set this JD calls for, plus
// whether the title matches what the user targets. No hardcoded vocabulary.

function fullScore(posting, opts = {}) {
  const jd = posting.jdText || '';
  if (!jd) {
    posting.matchScore = null;
    posting.rankReason = (posting.rankReason || '') + '; full: no-jd';
    return posting;
  }
  const profile = opts.profile || EMPTY_PROFILE;
  const jdLower = jd.toLowerCase();

  // Skill coverage: of the user's provable skills, how many does the JD call
  // for? Saturating denominator so a handful of strong hits reads as a good
  // fit. Neutral prior (0.5) only when the user has no library yet.
  const total = profile.skillKeywords.size;
  let matched = 0, coverage = 0.5;
  if (total > 0) {
    matched = countMatches(jdLower, profile.skillKeywords);
    coverage = Math.min(1, matched / Math.max(6, Math.min(total, 20)));
  }
  let score = 34 + coverage * 44; // 34..78 from fit alone
  const reasons = [];
  if (total > 0) reasons.push(`skills:${matched}/${total}`);

  // Title role-match: does this posting's title align with the user's targets?
  if (profile.roleTokens.size) {
    const tt = new Set(tokenize(posting.title));
    let hit = 0;
    for (const t of profile.roleTokens) if (tt.has(t)) hit++;
    if (hit) { const b = Math.min(8, hit * 3); score += b; reasons.push(`+${b} role-match`); }
  }

  // Seniority present in title — generic prioritization, not a fit claim.
  if (/\b(senior|staff|principal|lead)\b/i.test(posting.title)) { score += 2; reasons.push('+2 seniority'); }

  posting.archetype = detectArchetype(jd).primary;

  score = Math.max(0, Math.min(100, score));
  posting.matchScore = Math.round(score);
  posting.fitCoverage = Math.round(coverage * 100) / 100;
  posting.gatePass = { gate1: score >= 55, gate2: true };
  posting.rankReason = reasons.slice(0, 8).join(', ');
  return posting;
}

// ── RRF-fused ordering across independent signal rankings ────
// Reference: Bruch et al, ACM TOIS 2024. Signals: profile-keyword overlap,
// seniority, freshness. (Profile overlap is flat/zero when unconfigured, so
// ordering falls back to seniority + freshness.)

function fuseRanking(postings, opts = {}) {
  if (!postings.length) return [];
  const profile = opts.profile || EMPTY_PROFILE;

  const profileScore = (p) => {
    if (!profile.skillKeywords.size) return 0;
    const hay = `${p.title} ${p.department || ''} ${p.jdText || ''}`.toLowerCase();
    return countMatches(hay, profile.skillKeywords);
  };
  const seniorityScore = (p) => {
    let s = 0;
    for (const sig of SENIORITY_BOOST) if (sig.pattern.test(p.title)) s += sig.weight;
    return s;
  };
  const freshnessScore = (p) => {
    if (!p.postedDate) return 0;
    const ageDays = (Date.now() - new Date(p.postedDate)) / 86400000;
    return Math.max(0, 60 - ageDays);
  };

  const rankings = [profileScore, seniorityScore, freshnessScore].map(fn =>
    [...postings].sort((a, b) => fn(b) - fn(a))
  );

  const fused = rrf(rankings, p => p.canonicalUrl, { k: opts.k || 60 });
  for (let i = 0; i < fused.length; i++) {
    const p = fused[i].item;
    p.rrfScore = fused[i].score;
    p.rrfRank = i + 1;
  }
  return fused.map(x => x.item);
}

module.exports = { buildProfile, quickScore, fullScore, fuseRanking, isRoleMatch };
