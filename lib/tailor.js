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

// ── JD vocabulary (weighted role-relevant terms we look for) ──────────────
const KEYWORDS = [
  // ranking / recsys / personalization
  'ranking', 'personalization', 'recommendation', 'recommender', 'retrieval', 'representation learning',
  'embedding', 'two-tower', 'relevance', 'feed', 'candidate generation', 'ctr', 'propensity',
  // experimentation / measurement
  'experimentation', 'a/b', 'ab test', 'offline evaluation', 'incrementality', 'causal', 'attribution',
  'measurement', 'metric', 'uplift', 'holdout', 'monitoring', 'model health', 'reproducibility',
  // llm / inference / efficiency
  'llm', 'inference', 'latency', 'throughput', 'quantization', 'kv cache', 'speculative decoding',
  'distillation', 'gpu', 'cuda', 'kernel', 'moe', 'vllm', 'sglang', 'serving', 'optimization',
  'model execution', 'bottleneck', 'efficiency',
  // agentic / orchestration
  'agent', 'agentic', 'orchestration', 'multi-agent', 'tool calling', 'mcp', 'workflow', 'automation',
  'rag', 'context-aware', 'safety', 'guardrail', 'prompt injection', 'evaluation framework',
  // platform / infra / mlops
  'pipeline', 'platform', 'mlops', 'feature store', 'streaming', 'batch', 'kubernetes', 'docker',
  'airflow', 'spark', 'bigquery', 'data platform', 'etl', 'scalability', 'reliability', 'production',
  // forecasting / stats / ml
  'forecasting', 'time series', 'survival', 'bayesian', 'regression', 'classification', 'ensemble',
  'feature engineering', 'deep learning', 'computer vision', 'nlp',
  // ownership / leadership
  'end-to-end', 'end to end', 'cross-functional', 'mentor', 'technical direction', 'ownership',
  'stakeholder', 'lead', 'staff', 'principal', 'product',
  // languages / stack
  'python', 'go', 'c++', 'rust', 'typescript', 'javascript', 'postgres', 'redis', 'aws', 'gcp',
  'pytorch', 'tensorflow', 'sql', 'fastapi', 'graphql',
];

// archetype detection keywords (mirrors modes/_shared.md Archetype table)
const ARCHETYPES = {
  'AI Platform / LLMOps': ['llm', 'inference', 'serving', 'mlops', 'model deployment', 'platform', 'quantization', 'latency', 'throughput', 'gpu', 'kv cache', 'efficiency'],
  'Agentic / Automation': ['agent', 'agentic', 'automation', 'workflow', 'orchestration', 'tool calling', 'mcp', 'multi-agent', 'function calling'],
  'Applied ML / Personalization': ['recommendation', 'ranking', 'search', 'ads', 'personalization', 'applied ml', 'recommender', 'retrieval', 'relevance', 'ctr'],
  'Causal / Experimentation': ['causal', 'experiment', 'a/b', 'incrementality', 'measurement', 'attribution', 'uplift', 'holdout'],
  'ML Infrastructure': ['pipeline', 'airflow', 'spark', 'data platform', 'feature store', 'batch', 'streaming', 'etl', 'kafka'],
  'Forward Deployed': ['customer-facing', 'solutions', 'implementation', 'consulting', 'enterprise deployment', 'forward deployed'],
};

const STACK = ['python', 'go', 'golang', 'c++', 'rust', 'java', 'scala', 'typescript', 'javascript',
  'react', 'next.js', 'node', 'postgres', 'postgresql', 'mysql', 'redis', 'memcached', 'kafka', 'flink',
  'spark', 'databricks', 'bigquery', 'snowflake', 'kubernetes', 'docker', 'aws', 'gcp', 'azure',
  'pytorch', 'tensorflow', 'jax', 'vllm', 'sglang', 'cuda', 'fastapi', 'graphql', 'elasticsearch', 'lancedb'];

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(s) { return (s || '').toLowerCase().match(/[a-z][a-z0-9+/.-]*/g) || []; }

function analyzeJD(jdText) {
  const text = stripHtml(jdText);
  const low = text.toLowerCase();

  // weighted keyword hits
  const keywords = [];
  for (const kw of KEYWORDS) {
    const re = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
    const n = (low.match(re) || []).length;
    if (n > 0) keywords.push({ term: kw, count: n });
  }
  keywords.sort((a, b) => b.count - a.count);

  // archetype = best-covered archetype by its detection keywords
  let archetype = 'Applied ML', best = 0;
  for (const [name, terms] of Object.entries(ARCHETYPES)) {
    const score = terms.reduce((s, t) => s + (low.includes(t) ? 1 : 0), 0);
    if (score > best) { best = score; archetype = name; }
  }

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

module.exports = { analyzeJD, rankEvidence, tailorBrief, stripHtml };
