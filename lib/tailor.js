/**
 * lib/tailor.js - JD-grounded tailoring brief (the missing pipeline step).
 *
 * Real resume tailoring is NOT "pick pre-written bullets by keyword overlap" —
 * that produces resumes that do not speak to the role (a ranking JD led by an
 * MMM-data-platform bullet because both contain the token "platform"). Real
 * tailoring is: read what the role asks for, map the candidate's REAL evidence
 * to each ask, LEAD with the highest-relevance evidence, and reframe it in the
 * JD's own language.
 *
 * Division of labor:
 *   - This module does the DETERMINISTIC half: extract the JD's requirements,
 *     keywords, stack, and archetype; then rank the candidate's evidence pool
 *     against them and surface coverage + gaps.
 *   - The REFRAMING is an LLM step (modes/evaluate.md Block E), because
 *     truthfully rewording real evidence into a JD's vocabulary cannot be done
 *     by string code without fabricating. The generator consumes this brief and
 *     writes the final resume: reorder experience by relevance, reframe each
 *     bullet into the JD's language, write a role-specific summary, pick
 *     relevant projects. Nothing is invented; everything traces to reference.md
 *     / the bullet library.
 *
 * API:
 *   analyzeJD(jdText)            -> { archetype, keywords[], responsibilities[], qualifications[], stack[], seniority }
 *   rankEvidence(jd, library?)   -> { [role]: [{ id, text, matched[], score }] }  (ranked candidates)
 *   tailorBrief(jdText, baseline)-> { jd, evidenceByRole, coverage, gaps[], checklist[] }
 */

const { loadLibrary } = require('./bullet-select');
const { detectArchetype } = require('./archetypes');

// JD vocabulary is NOT a hardcoded allowlist -- analyzeJD() extracts the JD's
// own salient terms generically (see topTerms below) so the brief works for any
// field. STACK below is an additive hint for surfacing named tools when present.

const STACK = ['python', 'go', 'golang', 'c++', 'rust', 'java', 'scala', 'typescript', 'javascript',
  'react', 'next.js', 'node', 'postgres', 'postgresql', 'mysql', 'redis', 'memcached', 'kafka', 'flink',
  'spark', 'databricks', 'bigquery', 'snowflake', 'kubernetes', 'docker', 'aws', 'gcp', 'azure',
  'pytorch', 'tensorflow', 'jax', 'vllm', 'sglang', 'cuda', 'fastapi', 'graphql', 'elasticsearch', 'lancedb'];

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(s) { return (s || '').toLowerCase().match(/[a-z][a-z0-9+/.-]*/g) || []; }

const STOPWORDS = new Set(['the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'at', 'as', 'by', 'is', 'are', 'be', 'will', 'you', 'your', 'our', 'we', 'they', 'this', 'that', 'from', 'have', 'has', 'it', 'its', 'their', 'them', 'who', 'what', 'how', 'all', 'any', 'can', 'may', 'must', 'should', 'work', 'team', 'role', 'job', 'years', 'year', 'experience', 'strong', 'ability', 'including', 'etc', 'able', 'using', 'use', 'used', 'help', 'make', 'new', 'across', 'within', 'into', 'more', 'most', 'well', 'also', 'per', 'via']);

// Extract the JD's salient terms generically: frequency-ranked non-stopword
// unigrams + adjacent bigrams. No field assumptions -- a nursing JD yields
// nursing terms, an accounting JD yields accounting terms.
function topTerms(low, n = 25) {
  const toks = (low.match(/[a-z][a-z0-9+/.#-]{2,}/g) || []).filter(t => !STOPWORDS.has(t));
  const counts = new Map();
  for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
  for (let i = 0; i + 1 < toks.length; i++) {
    const bg = `${toks[i]} ${toks[i + 1]}`;
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

function analyzeJD(jdText) {
  const text = stripHtml(jdText);
  const low = text.toLowerCase();

  // Salient JD terms, extracted generically (frequency of non-stopword unigrams
  // + bigrams) so the brief reflects ANY field's vocabulary.
  const keywords = topTerms(low);

  // Archetype is optional + user-defined (configs/archetypes.json); 'General' by
  // default, in which case evidence ranks purely by JD-term overlap.
  const archetype = detectArchetype(text).primary;

  // stack mentions
  const stack = STACK.filter(t => new RegExp('\\b' + t.replace(/[+.]/g, '\\$&') + '\\b').test(low));

  // pull responsibilities + qualifications regions, split into lines
  const grab = (re, span = 1600) => {
    const i = text.search(re);
    if (i < 0) return [];
    return text.slice(i, i + span)
      .split(/(?:[.•;]|\s-\s|\d\+?\s*years)/)
      .map(s => s.trim()).filter(s => s.length > 25 && s.length < 220).slice(0, 8);
  };
  const responsibilities = grab(/What You.ll Do|Responsibilit|Key Responsib|How You.ll Have Impact|You will/i);
  const qualifications = grab(/Qualif|Who You Might Be|You may be a good fit|What You.ll Need|requirements/i);

  // seniority hint
  const seniority = /\bstaff\b/i.test(text) ? 'staff' : /\bprincipal\b/i.test(text) ? 'principal'
    : /\bsenior\b|\bsr\.?\b/i.test(text) ? 'senior' : /\blead\b/i.test(text) ? 'lead' : 'mid';

  return { archetype, keywords, responsibilities, qualifications, stack, seniority };
}

function rankEvidence(jd, library = loadLibrary()) {
  // Match the JD's salient terms against the bullet's TEXT and keywords (not
  // keywords alone) so on-topic evidence is not falsely flagged as a gap.
  const jdTerms = jd.keywords.map(k => k.term.toLowerCase());
  const out = {};
  for (const role of Object.keys(library)) {
    if (!Array.isArray(library[role])) continue;
    const ranked = library[role].map(b => {
      const hay = ((b.text || '') + ' ' + (b.keywords || []).join(' ')).toLowerCase();
      const matched = jdTerms.filter(t => hay.includes(t));
      const archetypeFit = (b.archetypes || []).some(a => jd.archetype.toLowerCase().includes(a.toLowerCase().split(' ')[0]));
      return { id: b.id, text: b.text, matched, score: matched.length + (archetypeFit ? 1.5 : 0) };
    }).sort((a, b) => b.score - a.score);
    out[role] = ranked;
  }
  return out;
}

function tailorBrief(jdText, baseline) {
  const jd = analyzeJD(jdText);
  const evidenceByRole = rankEvidence(jd);
  // coverage: which top JD keywords have at least one matching evidence item
  const covered = new Set();
  for (const role of Object.keys(evidenceByRole)) {
    for (const e of evidenceByRole[role]) for (const m of e.matched) covered.add(m);
  }
  const topJdTerms = jd.keywords.slice(0, 12).map(k => k.term);
  const gaps = topJdTerms.filter(t => !covered.has(t) && !t.split(/\s+/).some(p => covered.has(p)));

  return {
    jd, evidenceByRole,
    coverage: { topJdTerms, gaps },
    checklist: [
      'Lead each experience entry with the highest-relevance evidence for THIS jd.archetype, not the default order.',
      'Reframe every bullet into the JD vocabulary (jd.keywords) WITHOUT inventing — only reword real evidence from reference.md / the library.',
      'Write a role-specific summary that mirrors the JD responsibilities and leads with the strongest matching evidence.',
      'Pick selectedProjects that match the JD (retrieval/ranking/agentic/inference), not the default two.',
      'Name the honest gaps (coverage.gaps): position the adjacency; never claim experience the evidence does not support.',
    ],
  };
}

// Resume-quality gate: a non-fatal check run on the resume JSON BEFORE
// rendering. Two field-agnostic signals — metric density and an anchored
// whyCompany — flag a resume that reads as generic. Fix flagged issues and
// re-check; the gate never blocks a render (callers warn, they do not throw).
const METRIC_RE = /\$[\d,]+|\b\d+(\.\d+)?%|\b\d+(\.\d+)?x\b|\bp\d{2}\b|\b\d+-bit\b|c-index|rmse|mape|\bauc\b|\b\d{3,}\b/gi;
// "Anchor" = a concrete, company-specific reference (a number, year, dollar
// figure, percentage, or a named product / market / regulation / technology),
// not generic filler. Field-agnostic: a finance, healthcare, retail, robotics,
// or any-other whyCompany that names the real thing passes.
const WHY_ANCHOR_RE = /\b(?:19|20)\d\d\b|\$|\b\d+(?:\.\d+)?%|\b(?:product|platform|api|sdk|launch|mission|market|customer|client|regulation|compliance|standard|act|section|rule|policy|feature|technology|release|industry|sector|service|infrastructure)\b/i;
const WHY_PLACEHOLDER_RE = /per-posting|goes here|placeholder|\bTODO\b|\bTBD\b/i;

function auditResume(resume) {
  const issues = [];
  const bullets = (resume.experience || []).flatMap((e) => (e.bullets || []).map((b) => (typeof b === 'string' ? b : b.text)));
  const blob = (resume.summary || '') + ' ' + bullets.join(' ');

  // 1. metric density (concrete numbers / params per bullet)
  const metrics = (blob.match(METRIC_RE) || []).length;
  const density = bullets.length ? metrics / bullets.length : 0;
  if (density < 1.5) issues.push(`metric density ${density.toFixed(1)}/bullet is below 1.5 — add concrete numbers, parameters, or algorithm values to bullets`);

  // 2. whyCompany present + specific
  const why = (resume.whyCompany || '').trim();
  if (!why || why.length < 120 || WHY_PLACEHOLDER_RE.test(why)) issues.push('whyCompany is missing, a placeholder, or too short (need 120+ chars, role-specific)');
  else if (!WHY_ANCHOR_RE.test(why)) issues.push('whyCompany lacks a specific anchor (a product, regulation, metric, or technology of the company)');

  return { ok: issues.length === 0, issues, metricDensity: +density.toFixed(2), bulletCount: bullets.length };
}

module.exports = { analyzeJD, rankEvidence, tailorBrief, stripHtml, auditResume };
