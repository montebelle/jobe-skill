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
      'Pick selectedProjects that match the JD (the ones whose focus matches the role), not the default two.',
      'Name the honest gaps (coverage.gaps): position the adjacency; never claim experience the evidence does not support.',
    ],
  };
}

// Resume-quality gate: a non-fatal check run on the resume JSON BEFORE
// rendering. Every signal here is field-agnostic — it flags a resume that reads
// as generic or is structurally incomplete regardless of profession. Fix
// flagged issues and re-check; the gate never blocks a render (callers warn,
// they do not throw).
//
// Metric density counts ANY concrete number as quantification (a specific count
// or a team size is real specificity, not just 3+ digit values), excluding
// standalone years so date ranges do not inflate density.
const METRIC_RE = /\$[\d,]+|\b\d+(\.\d+)?%|\b\d+(\.\d+)?x\b|\bp\d{2}\b|\b\d+-bit\b|c-index|rmse|mape|\bauc\b|\b(?!(?:19|20)\d{2}\b)\d+(\.\d+)?\b/gi;
// "Anchor" = a concrete, company-specific reference (a number, year, dollar
// figure, percentage, or a named product / market / regulation / technology),
// not generic filler. Field-agnostic: a finance, healthcare, retail, robotics,
// or any-other whyCompany that names the real thing passes.
const WHY_ANCHOR_RE = /\b(?:19|20)\d\d\b|\$|\b\d+(?:\.\d+)?%|\b(?:product|platform|api|sdk|launch|mission|market|customer|client|regulation|compliance|standard|act|section|rule|policy|feature|technology|release|industry|sector|service|infrastructure)\b/i;
const WHY_PLACEHOLDER_RE = /per-posting|goes here|placeholder|\bTODO\b|\bTBD\b/i;

// Tokens that read as AI-generated or code-inventory dumps in a resume bullet
// (2025-26 recruiter-survey evidence: over-quantification and generated-from-
// code trivia are documented anti-signals). Field-agnostic.
const AI_TELL_RE = /\babout \d|\broughly \d|lines? of (code|python|javascript)|\blocalhost:\d|arxiv|\b\d{4}\.\d{4,5}\b|spearheaded|leveraged synerg|results-driven|passionate about driving/i;

function countWords(value) {
  return (String(value || '').trim().match(/\b[\w'+.-]+\b/g) || []).length;
}

// Concatenate only the fields that actually render into the resume document, so
// the size/fill heuristic reflects what a reader sees (not internal metadata,
// the cover letter, or whyCompany).
function renderedResumeText(resume) {
  const parts = [resume.name];
  const contact = resume.contact || {};
  parts.push(contact.phone, contact.email, contact.location, contact.linkedin, contact.github, resume.summary);
  for (const e of (resume.experience || [])) {
    parts.push(e.title, e.company, e.location, e.dates, e.subtitle);
    for (const b of (e.bullets || [])) parts.push(typeof b === 'string' ? b : b && b.text);
  }
  for (const p of (resume.selectedProjects || [])) parts.push(p && p.name, p && p.summary);
  const skills = resume.skills || {};
  if (typeof skills === 'string') parts.push(skills);
  else if (Array.isArray(skills)) {
    for (const item of skills) parts.push(typeof item === 'string' ? item : item && (item.skills || item.values));
  } else {
    for (const [label, value] of Object.entries(skills)) parts.push(label, Array.isArray(value) ? value.join(', ') : value);
  }
  for (const e of (Array.isArray(resume.education) ? resume.education : [resume.education])) {
    if (e) parts.push(e.degree, e.school, e.location, e.dates);
  }
  return parts.filter(Boolean).join(' ');
}

function flattenSkillItems(skills) {
  const values = [];
  if (typeof skills === 'string') values.push(skills);
  else if (Array.isArray(skills)) {
    for (const item of skills) {
      if (typeof item === 'string') values.push(item.includes(':') ? item.split(':').slice(1).join(':') : item);
      else if (item) values.push(item.skills || item.values || '');
    }
  } else if (skills && typeof skills === 'object') values.push(...Object.values(skills));
  return values.flatMap((v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)))
    .map((v) => String(v).trim()).filter(Boolean);
}

function canonicalSkill(skill) {
  return String(skill || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[.]+$/, '').replace(/\s+/g, ' ').trim();
}

// auditResume(resume [, jdText] [, opts])
//   jdText          optional — enables the JD-vocabulary coverage gate
//   opts.pageMetrics { pages, lastPageFill } — when the caller has rendered the
//                   DOCX and measured it, the page render is gated on instead of
//                   the coarse word-count backstop.
function auditResume(resume, jdText, opts = {}) {
  const issues = [];
  const warnings = [];
  const bullets = (resume.experience || []).flatMap((e) => (e.bullets || []).map((b) => (typeof b === 'string' ? b : b.text)));
  const blob = (resume.summary || '') + ' ' + bullets.join(' ');

  // 0. Required sections. A hand-edited resume JSON can silently drop a
  // required section (e.g. education) and render skips the absent section
  // without complaint. Hard-gate the required sections so a structural omission
  // can never pass audit.
  if (!Array.isArray(resume.education) || !resume.education.length) issues.push('education section is missing — required; restore it from your baseline resume');
  if (!Array.isArray(resume.experience) || !resume.experience.length) issues.push('experience section is missing');
  if (!resume.contact || !resume.contact.email) issues.push('contact block is missing or incomplete');

  // 0b. Rendered-size / fill. The RENDERED PAGE is authoritative, NOT word
  // count. Capping on words produced short, under-filled second pages. When the
  // caller has rendered the DOCX and measured it (scripts/check-docx-pages.js
  // --min-fill), it passes { pages, lastPageFill } and we gate on THAT: at most
  // 2 pages, last page substantially full. Word count is only a COARSE backstop
  // when no page measurement is supplied.
  const wordCount = countWords(renderedResumeText(resume));
  const summaryWordCount = countWords(resume.summary);
  const projects = (resume.selectedProjects || []).filter((p) => p && String(p.summary || '').trim());
  const projectWordCounts = projects.map((p) => countWords(p.summary));
  const pm = opts.pageMetrics && Number.isFinite(opts.pageMetrics.pages) ? opts.pageMetrics : null;
  if (pm) {
    if (pm.pages > 2) issues.push(`resume renders ${pm.pages} pages — must be at most 2 (trim the least relevant content)`);
    else if (pm.pages < 2) issues.push(`resume renders only ${pm.pages} page — at this seniority it should fill 2 pages; add role-relevant, evidence-backed bullets/projects`);
    else if (Number.isFinite(pm.lastPageFill) && pm.lastPageFill < 0.85) issues.push(`page 2 is only ${Math.round(pm.lastPageFill * 100)}% full — the "half-empty page 2" defect; fill it with role-relevant, evidence-backed content, target at least 88%`);
  } else {
    // No render supplied — coarse backstop only; the page check is the real gate.
    if (wordCount < 560) warnings.push(`word count ${wordCount} is low — render and check page fill (the page render is authoritative, not this count)`);
    if (wordCount > 1000) warnings.push(`word count ${wordCount} is high — render and confirm it stays within 2 pages (the page render is authoritative)`);
  }
  if (summaryWordCount < 35) issues.push(`summary is ${summaryWordCount} words — target 35-80 words with role, strongest evidence, and scope`);
  if (summaryWordCount > 80) issues.push(`summary is ${summaryWordCount} words — cap at 80 so the center of gravity remains scannable`);
  if (projects.length > 4) issues.push(`${projects.length} selected projects — keep at most 4 role-relevant projects`);
  projectWordCounts.forEach((n, i) => { if (n > 65) issues.push(`selected project ${i + 1} is ${n} words — cap each project summary at 65`); });

  const skillCounts = new Map();
  for (const skill of flattenSkillItems(resume.skills)) {
    const key = canonicalSkill(skill);
    if (key) skillCounts.set(key, (skillCounts.get(key) || 0) + 1);
  }
  const duplicateSkills = [...skillCounts.entries()].filter(([, n]) => n > 1);
  if (duplicateSkills.length) issues.push(`duplicate skills: ${duplicateSkills.map(([s, n]) => `${s} (${n}x)`).join(', ')}`);

  // 1. Metric density is a BAND, not a floor. Too thin reads unsubstantiated;
  // too dense (a number in every clause) is a documented AI/fabrication tell.
  // Prefer fewer, mechanism-attached numbers.
  const metrics = (blob.match(METRIC_RE) || []).length;
  const density = bullets.length ? metrics / bullets.length : 0;
  if (density < 0.8) issues.push(`metric density ${density.toFixed(1)}/bullet is below 0.8 — add concrete numbers, parameters, or outcome values to the strongest bullets`);
  if (density > 2.5) issues.push(`metric density ${density.toFixed(1)}/bullet exceeds 2.5 — over-quantification reads as AI-generated/fabricated; keep the 1-2 strongest numbers per bullet and drop trivia (line counts, intervals, TTLs)`);
  const metricBearing = bullets.filter((b) => METRIC_RE.test(b)).length;
  if (bullets.length >= 8 && metricBearing === bullets.length) issues.push('every single bullet carries a metric — vary it; 60-80% metric-bearing reads human, 100% reads generated');

  // 1b. AI-tell tokens + uniform openers
  for (const b of bullets) { if (AI_TELL_RE.test(b)) { issues.push(`bullet contains an AI/code-inventory tell (about-hedge, line count, localhost, arXiv id, or buzzword): "${b.slice(0, 70)}..."`); break; } }
  const openers = bullets.map((b) => (b.trim().split(/\s+/)[0] || '').toLowerCase());
  const topOpener = [...new Set(openers)].map((o) => [o, openers.filter((x) => x === o).length]).sort((a, b) => b[1] - a[1])[0];
  if (topOpener && bullets.length >= 8 && topOpener[1] / bullets.length > 0.4) issues.push(`${topOpener[1]}/${bullets.length} bullets open with "${topOpener[0]}" — uniform openers are an AI tell; vary sentence structure`);

  // 1c. Bullet length: result-first scannability. Walls of text bury the
  // outcome; a couple of deep mechanism bullets are allowed.
  const words = (b) => b.trim().split(/\s+/).length;
  const over = bullets.filter((b) => words(b) > 65).length;
  if (bullets.length && over > 2) issues.push(`${over} bullets exceed 65 words — cap at ~45 (up to 2 deep mechanism bullets per resume may reach ~65); lead with the outcome, methods second`);

  // 2. whyCompany present + specific
  const why = (resume.whyCompany || '').trim();
  if (!why || why.length < 120 || WHY_PLACEHOLDER_RE.test(why)) issues.push('whyCompany is missing, a placeholder, or too short (need 120+ chars, role-specific)');
  else if (!WHY_ANCHOR_RE.test(why)) issues.push('whyCompany lacks a specific anchor (a product, regulation, metric, or technology of the company)');

  // 3. JD-vocabulary coverage gate (optional: pass the JD text). The top JD
  // keywords must appear in the resume — recruiters keyword-SEARCH inside the
  // ATS and scan for the JD's own language. This is the mechanical presence
  // check; the generator's reframe step owns translation. Gates 4-6 below
  // harden it: a keyword that appears only in the summary or skills block (with
  // no backing bullet) reads as an unsubstantiated claim under a human screen.
  // All of these operate on JD-extracted keywords — no hardcoded field vocab.
  let jdCoverage = null;
  if (jdText) {
    const projText = (resume.selectedProjects || []).map((p) => (p.summary || '') + ' ' + (p.name || '')).join(' ');
    const skillsText = JSON.stringify(resume.skills || {});
    const kws = analyzeJD(jdText).keywords.slice(0, 8).map((k) => String(k.term));
    const hay = (blob + ' ' + skillsText + ' ' + projText).toLowerCase();
    const missing = kws.filter((k) => !hay.includes(k.toLowerCase()));
    jdCoverage = { top: kws.length, covered: kws.length - missing.length, missing };
    if (kws.length && missing.length / kws.length > 0.4) issues.push(`JD-vocabulary coverage ${kws.length - missing.length}/${kws.length} — missing top JD terms: ${missing.join(', ')}. Reframe real evidence into the JD's own words (never invent).`);

    // 4. Requirement -> BULLET mapping: summaries and skills tokens do not
    // survive a human screen — each top JD term should be carried by at least
    // one BULLET or PROJECT line, not just a summary sentence. "Tailored summary
    // over an untailored body" is the most common tailoring failure.
    const bulletHay = (bullets.join(' ') + ' ' + projText).toLowerCase();
    const summaryOnly = kws.filter((k) => hay.includes(k.toLowerCase()) && !bulletHay.includes(k.toLowerCase()));
    if (kws.length && (missing.length + summaryOnly.length) / kws.length > 0.5) {
      issues.push(`requirement->bullet mapping weak: ${summaryOnly.length ? 'these top JD terms appear ONLY in summary/skills, no bullet carries them: ' + summaryOnly.join(', ') + '. ' : ''}Move real evidence into bullets — a summary claim without a backing bullet reads as unsubstantiated.`);
    }

    // 5. Center of gravity: the first things a reader sees — summary line 1 plus
    // the top role's first two bullets — must together carry at least 2 of the
    // JD's top-4 terms, so the resume leads with the evidence THIS role asks for
    // rather than the same lead bullets regardless of JD.
    const topRole = (resume.experience || [])[0] || {};
    const topBullets = (topRole.bullets || []).slice(0, 2).map((b) => (typeof b === 'string' ? b : b.text)).join(' ');
    const summaryLine1 = String(resume.summary || '').split(/(?<=\.)\s/)[0] || '';
    const cog = (topBullets + ' ' + summaryLine1).toLowerCase();
    const top4 = kws.slice(0, 4);
    const cogHits = top4.filter((k) => cog.includes(k.toLowerCase())).length;
    if (top4.length >= 3 && cogHits < 2) {
      issues.push(`center-of-gravity: the first things a reader sees (summary line 1 + top role's first 2 bullets) carry only ${cogHits}/4 of the JD's top terms (${top4.join(', ')}). Lead with the evidence this role asks for.`);
    }

    // 6. Unbacked skills tokens: a JD-relevant term that exists ONLY in the
    // skills block invites the "checked and found nothing" rejection. Either add
    // the backing bullet or remove the token.
    const skillsLower = skillsText.toLowerCase();
    const unbacked = kws.filter((k) => skillsLower.includes(k.toLowerCase()) && !bulletHay.includes(k.toLowerCase()) && !String(resume.summary || '').toLowerCase().includes(k.toLowerCase()));
    if (unbacked.length >= 2) {
      issues.push(`unbacked skills tokens (in skills block only, no bullet evidence): ${unbacked.join(', ')} — back them with a bullet or drop them.`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    metricDensity: +density.toFixed(2),
    bulletCount: bullets.length,
    wordCount,
    summaryWordCount,
    projectCount: projects.length,
    projectWordCounts,
    jdCoverage,
  };
}

// ── auditProse: evidence-grounded "AI-register" advisory for prose fields ──
// Runs on cover letters, summaries, and free-text application answers. Returns
// SOFT, advisory nudges ONLY — never a hard AI/human verdict and never a gate.
//
// WHY advisory-only (not a classifier): document-level AI detection is unreliable
// and false-positive-prone against legitimate and non-native-English human
// writing. Liang et al. 2023 (arXiv:2304.02819, Stanford) found GPT detectors
// misclassified non-native TOEFL essays as AI at a 61.22% false-positive rate;
// Krishna et al. NeurIPS 2023 (arXiv:2303.13408, DIPPER) collapsed DetectGPT
// from 70.3% to 4.6% via paraphrase; Sadasivan et al. (arXiv:2303.11156) argue
// reliable detection may be infeasible. So this NEVER emits a verdict.
//
// WHAT it flags: the ONE register signal with strong, replicated corpus support
// — a post-ChatGPT surge in specific "style/flourish" words (Kobak et al.,
// Science Advances 2025, doi:10.1126/sciadv.adt3813, excess-vocabulary over
// 15M+ PubMed abstracts; replicated on 1.29M arXiv abstracts by Geng & Trotta,
// Findings of ACL 2025, arXiv:2502.09606, and on 149k ASCE abstracts,
// arXiv:2602.03864). These are POPULATION frequency shifts (a lower bound), NOT
// per-document proof — hence advisory. And they are NON-STATIONARY (writers
// abandon flagged words within months of exposure), so the list is VERSIONED
// and must be refreshed; treat it as decaying, not canonical.
//
// WHAT it deliberately does NOT flag (no confirmed corpus backing in the
// evidence sweep; flagging them risks penalizing real human writing): em-dash
// overuse (measured NULL, arXiv:2602.03864), sentence uniformity / low
// burstiness (unconfirmed), rule-of-three/tricolon, participle-flourish tails,
// negative parallelism, aphorism formulas, and over-quantification / metric
// density. (jobe still strips em-dashes + hyphens at render, but for ATS
// legibility — a separate justification, not an AI-tell claim.)
const AI_STYLE_MARKERS = {
  version: '2026-07',
  // Strong signal: high excess-ratio flourish words, rarely load-bearing in a
  // resume/cover letter. A hit here is worth surfacing.
  strong: [
    'delve', 'delves', 'delving', 'underscore', 'underscores', 'underscoring',
    'showcase', 'showcases', 'showcasing', 'intricate', 'intricacies',
    'meticulous', 'meticulously', 'pivotal', 'realm', 'tapestry', 'commendable',
    'testament', 'boasts', 'multifaceted', 'nuanced', 'firstly', 'crucially',
  ],
  // Weaker/common: rising markers that ALSO appear in legitimate writing
  // ('crucial'/'enhance'/'additionally' over-fire per Kobak's own caveat).
  // Reported only as an aggregate density signal, never per-word.
  rising: [
    'additionally', 'moreover', 'furthermore', 'notably', 'crucial', 'enhance',
    'enhances', 'enhancing', 'leverage', 'leverages', 'leveraging', 'foster',
    'fosters', 'fostering', 'garner', 'seamless', 'robust', 'holistic',
    'streamline', 'streamlined', 'utilize', 'utilizes', 'utilizing',
  ],
};

/**
 * @param {string} text  prose to check (cover letter, summary, free-text answer)
 * @param {object} [opts] { risingDensityPer100 = 2.0 } aggregate-warn threshold
 * @returns {{ok:boolean, advisory:string[], strongMarkers:string[],
 *            risingMarkers:string[], words:number, markerVersion:string}}
 *   ok is TRUE unless a STRONG marker is present. Advisory only — callers should
 *   surface (never block) on it, and NEVER report a verdict about authorship.
 */
function auditProse(text, opts = {}) {
  const s = String(text || '');
  const words = countWords(s);
  const toks = s.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
  const strongSet = new Set(AI_STYLE_MARKERS.strong);
  const risingSet = new Set(AI_STYLE_MARKERS.rising);
  const strongMarkers = [];
  const risingMarkers = [];
  for (const t of toks) {
    if (strongSet.has(t)) strongMarkers.push(t);
    else if (risingSet.has(t)) risingMarkers.push(t);
  }
  const advisory = [];
  if (strongMarkers.length) {
    advisory.push(`AI-register flourish word(s): ${[...new Set(strongMarkers)].join(', ')} — these surged post-ChatGPT (Kobak et al. 2025) and rarely earn their place in a resume/cover letter; consider a plainer word. Advisory, not a verdict.`);
  }
  // rising markers: only an AGGREGATE density warning (individually legitimate)
  const per100 = words ? (risingMarkers.length / words) * 100 : 0;
  const thresh = Number.isFinite(opts.risingDensityPer100) ? opts.risingDensityPer100 : 2.0;
  if (words >= 40 && per100 >= thresh) {
    advisory.push(`elevated density of common AI-favored connectors/verbs (${risingMarkers.length} in ${words} words: ${[...new Set(risingMarkers)].slice(0, 6).join(', ')}...) — each is fine alone, but the cluster reads generated. Advisory only; do not strip legitimate usage.`);
  }
  return {
    ok: strongMarkers.length === 0,
    advisory,
    strongMarkers: [...new Set(strongMarkers)],
    risingMarkers: [...new Set(risingMarkers)],
    words,
    markerVersion: AI_STYLE_MARKERS.version,
  };
}

module.exports = {
  analyzeJD, rankEvidence, tailorBrief, stripHtml, auditResume, auditProse,
  countWords, renderedResumeText, flattenSkillItems, canonicalSkill,
  AI_STYLE_MARKERS,
};
