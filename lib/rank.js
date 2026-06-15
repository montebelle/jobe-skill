/**
 * Posting ranking.
 *
 * Two stages:
 *   quickScore(posting)  - URL/title-level heuristic, no JD text required.
 *                          Cheap. Used to filter the top-K for enrichment.
 *   fullScore(posting)   - JD-aware ranking. Requires jdText. Produces
 *                          matchScore 0-100, archetype, gaps, rankReason.
 *
 * Both functions mutate posting in place and return the updated posting.
 */

const { detectArchetype } = require('./archetypes');
const { rrf } = require('./rrf');

// ── Signal patterns against John's portfolio (reference.md A1-A12) ───

const PORTFOLIO_SIGNALS = [
  // Agentic - A1
  { pattern: /\b(agent|agentic|autonomous|multi[- ]agent|tool[- ]call|mcp\b|orchestr|workflow engine)\b/i, weight: 1.2, archetype: 'Agentic' },
  { pattern: /\b(prompt inject|guardrail|safety|alignment|eval\w*|red[- ]team)\b/i, weight: 0.8, archetype: 'Agentic' },
  { pattern: /\b(rag\b|retrieval aug|vector search|hybrid search|bm25|embedding)\b/i, weight: 0.9, archetype: 'Agentic' },

  // AI Platform - A1, A5, A9
  { pattern: /\b(llm inference|model serving|vllm|sglang|tensorrt|triton|tgi\b|kv[- ]cache|speculative decoding|prefill|quantiz)\b/i, weight: 1.1, archetype: 'AI Platform' },
  { pattern: /\b(mlops|llmops|model deploy|feature store|model registry)\b/i, weight: 0.7, archetype: 'AI Platform' },
  { pattern: /\b(on[- ]device|edge inference|apple silicon|mlx\b|metal|coreml)\b/i, weight: 0.9, archetype: 'AI Platform' },
  { pattern: /\b(fine[- ]tun|rlhf|dpo|sft\b|lora\b|qlora|peft\b|distill)\b/i, weight: 0.6, archetype: 'AI Platform' },

  // Applied ML - A2, A10, A11
  { pattern: /\b(forecast|time[- ]series|sarimax|prophet|holt[- ]winters|panel data)\b/i, weight: 0.7, archetype: 'Applied ML' },
  { pattern: /\b(recommend|ranking|personaliz|search rank|ads? ranking)\b/i, weight: 0.6, archetype: 'Applied ML' },
  { pattern: /\b(audience|lookalike|customer segmentation|propensity)\b/i, weight: 0.6, archetype: 'Applied ML' },
  { pattern: /\b(mmm\b|marketing mix|media mix)\b/i, weight: 0.8, archetype: 'Applied ML' },

  // Causal - A3, A4, A8
  { pattern: /\b(causal|incremental|synthetic control|geo[- ]lift|did\b|sdid|diff[- ]in[- ]diff)\b/i, weight: 1.0, archetype: 'Causal' },
  { pattern: /\b(a\/b test|experiment|randomized|treatment effect|uplift|lift model)\b/i, weight: 0.7, archetype: 'Causal' },
  { pattern: /\b(survival|kaplan[- ]meier|cox|cloglog|hazard|churn)\b/i, weight: 0.9, archetype: 'Causal' },
  { pattern: /\b(bayesian|mcmc|pmmh|particle filter|bsts|structural time series)\b/i, weight: 0.8, archetype: 'Causal' },

  // ML Infra - A2, A9
  { pattern: /\b(pipeline|airflow|dagster|prefect|spark|pyspark|databricks|snowflake|bigquery)\b/i, weight: 0.6, archetype: 'ML Infra' },
  { pattern: /\b(etl\b|data platform|data engineering|feature engineering)\b/i, weight: 0.5, archetype: 'ML Infra' },
  { pattern: /\b(kubernetes|k8s|docker|terraform|helm\b|slurm|gpu cluster)\b/i, weight: 0.5, archetype: 'ML Infra' },

  // Forward Deployed - A1, A12
  { pattern: /\b(forward[- ]deployed|customer[- ]facing|solutions architect|implementation engineer|customer engineer|field engineer)\b/i, weight: 0.8, archetype: 'Forward Deployed' },
  { pattern: /\b(full[- ]stack|django|next[. ]js|react|fastapi|supabase)\b/i, weight: 0.5, archetype: 'Forward Deployed' },

  // Generic tech (weak)
  { pattern: /\b(python|pytorch|tensorflow|scikit|numpy|pandas)\b/i, weight: 0.3 },
  { pattern: /\b(aws|gcp|azure|ec2|s3|lambda|vertex)\b/i, weight: 0.3 },
  { pattern: /\b(production|scale|real[- ]time|low[- ]latency)\b/i, weight: 0.2 },
];

// ── Title / seniority filters ───────────────────────────────

const SENIORITY_BOOST = [
  { pattern: /\bstaff\b/i, weight: 0.6 },
  { pattern: /\bsenior\b/i, weight: 0.5 },
  { pattern: /\bprincipal\b/i, weight: 0.6 },
  { pattern: /\blead\b/i, weight: 0.3 },
];

const TITLE_EXCLUDE = [
  /\bintern(ship)?\b/i,
  /\bnew[- ]?grad\b/i,
  /\bapprentice\b/i,
  /\bentry[- ]?level\b/i,
  /\bstudent\b/i,
  /\bfellow(ship)?\b/i,
  /\bmanager\b/i,
  /\bdirector\b/i,
  /\bhead of\b/i,
  /\bvp\b/i,
  /\bvice president\b/i,
  /\bcto\b|\bcio\b|\bceo\b/i,
  /\bchief\b/i,
  /\brecruit\w*/i,
  /\bsales\b/i,
  /\b(sdr|bdr)\b/i,
  /\bcustomer success\b/i,
  /\bmarketing\b/i,
  /\bsupport engineer\b/i,
  /\bsolutions consultant\b/i,
  /\b(hr|business|financial|game|investment) (analyst|analytics)\b/i,
  /\btableau (developer|consultant)\b/i,
  /\bannotation qa\b/i,
  /\b(qa|quality) analyst\b/i,
  // NOTE: "marketing" is intentionally NOT excluded. "Marketing Data
  // Scientist" / "Marketing Science" / MMM roles are among John's strongest
  // fits; only ML-titled marketing roles pass the ML_VOCAB gate below anyway,
  // so a non-ML "Marketing Coordinator" is filtered by absence of ML vocab.
];

// "This title is ML/AI/DS work" gate. Requires a real ML head-noun or
// unambiguous acronym — NOT bare generic tokens. The previous version matched
// 'intelligence' / 'vision' / 'learning' / 'insights' / 'agent', which let
// "Business Intelligence Developer", "Vision Care Specialist", "Insurance
// Agent", etc. through; JD scoring then floated them near the 50 baseline.
// Each alternative carries its own \b boundaries so a trailing boundary does
// not land mid-word (e.g. \bdata scien\b would fail on "Data Scientist").
const ML_VOCAB = new RegExp(
  '\\b(?:' + [
    'machine learning',
    'data scien(?:tist|ce)',
    'decision scien(?:tist|ce)',
    'data engineer',
    'analytics engineer',
    'applied (?:scientist|science|ml|ai|machine|research)',
    'research (?:engineer|scientist)',
    'ml(?:[/-]|\\b)',           // ML, ML/ML-Ops, AI/ML
    'ai(?:[/-]|\\b)',           // AI, AI/ML, AI-Enabled
    'artificial intelligence',
    'llm',
    'gen[- ]?ai',
    'genai',
    'deep learning',
    'nlp',
    'computer vision',
    'mlops',
    'llmops',
    'neural network',
    'causal',                   // "Causal Inference Scientist"
    'quantitative (?:research|analyst|scientist)',
    'mts',
    'member of technical staff',
  ].join('|') + ')\\b',
  'i'
);

function isRoleMatch(title) {
  if (!title) return false;
  if (TITLE_EXCLUDE.some(re => re.test(title))) return false;
  return ML_VOCAB.test(title);
}

// ── Pre-enrichment ordering (no JD required) ────────────────
//
// Decides which postings get JD fetched first when budget is limited. NOT a
// fit signal — fit comes from fullScore on JD content. This only encodes
// "of the title-allowed postings, which should we enrich first?":
//
//   - seniority (senior/staff/principal score higher)
//   - freshness (newer first)
//   - ATS confidence (canonical ATS URL > aggregator URL)
//
// We retain the function name `quickScore` and write to `posting.quickScore`
// for backwards compat with display code that falls back to it.
function quickScore(posting) {
  if (!isRoleMatch(posting.title)) {
    posting.quickScore = 0;
    posting.rankReason = 'title-excluded';
    return posting;
  }

  let s = 1; // baseline pass

  // Seniority hint (used to prioritize who gets enriched first)
  if (/\bstaff\b/i.test(posting.title)) s += 1.5;
  else if (/\bprincipal\b/i.test(posting.title)) s += 1.5;
  else if (/\bsenior\b|\bsr\.?\b/i.test(posting.title)) s += 1;
  else if (/\blead\b/i.test(posting.title)) s += 0.5;

  // Freshness boost
  if (posting.postedDate) {
    const ageDays = (Date.now() - new Date(posting.postedDate)) / 86400000;
    if (ageDays <= 7) s += 0.6;
    else if (ageDays <= 14) s += 0.3;
  }

  // ATS-canonical URL boost (we want to enrich those before aggregator URLs)
  const url = posting.canonicalUrl || '';
  if (/(greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|icims\.com)/i.test(url)) {
    s += 0.4;
  }

  posting.quickScore = s;
  // Archetype now comes from JD content via fullScore -> detectArchetype.
  // Set a neutral default here so downstream code that reads .archetype has something.
  posting.archetype = posting.archetype || 'Applied ML';
  posting.rankReason = `enrich-priority: ${s.toFixed(2)}`;
  return posting;
}

// ── Full score (JD required) ────────────────────────────────

const FULL_SIGNALS = {
  strong: [
    { regex: /\bagent\b.*?\b(orchestr|framework|platform|engine|eval)\b/i, points: 12, why: 'agent-platform' },
    { regex: /\b(4[- ]?hook|multi[- ]?hook|defense[- ]in[- ]depth)\b/i, points: 8, why: 'safety-arch' },
    { regex: /\bpersona drift\b|\bdrift detection\b/i, points: 8, why: 'drift-eval' },
    { regex: /\b(llm inference|model serving).*?(scale|production)\b/i, points: 10, why: 'inference-prod' },
    { regex: /\b(kv[- ]cache|speculative decoding|quantiz)\b/i, points: 8, why: 'inference-opt' },
    { regex: /\b(causal inference|synthetic control|geolift|incremental)\b/i, points: 10, why: 'causal' },
    { regex: /\b(mmm\b|marketing mix)\b/i, points: 8, why: 'mmm' },
    { regex: /\bsurvival analysis|kaplan[- ]meier\b/i, points: 8, why: 'survival' },
    { regex: /\b(mcmc|pmmh|particle filter|bsts)\b/i, points: 6, why: 'bayesian' },
    { regex: /\b(on[- ]device|apple silicon|mlx\b)\b/i, points: 7, why: 'on-device' },
    { regex: /\b(fastapi|openai[- ]compatible|embedding server)\b/i, points: 5, why: 'serving' },
    { regex: /\b(rag\b|retrieval).*?(hybrid|bm25|mmr|vector)\b/i, points: 7, why: 'rag-hybrid' },
  ],
  preferred: [
    { regex: /\bpython\b/i, points: 2, why: 'python' },
    { regex: /\bpytorch\b/i, points: 3, why: 'pytorch' },
    { regex: /\b(aws|gcp|azure)\b/i, points: 2, why: 'cloud' },
    { regex: /\b(docker|kubernetes)\b/i, points: 2, why: 'container' },
    { regex: /\b(databricks|pyspark|snowflake|bigquery)\b/i, points: 3, why: 'data' },
    { regex: /\b(react|next[. ]js|django)\b/i, points: 2, why: 'fullstack' },
  ],
  negative: [
    { regex: /\b(ph\.?d\.?\s+(required|only)|must hold ph\.?d)\b/i, points: -10, why: 'phd-hard-req' },
    { regex: /\b(10\+|ten\+)\s*years\b/i, points: -3, why: '10y' },
    { regex: /\b(active clearance|ts\/sci|secret clearance)\b/i, points: -8, why: 'clearance' },
    { regex: /\b(c\+\+.*required|rust required|go required)\b/i, points: -5, why: 'lang-hard' },
  ],
};

// John's VERIFIED skill inventory (traceable to reference.md / repos). Each
// entry maps a JD skill-demand pattern to John's proficiency:
//   1.0 = exact match with shipped proof   0.6 = solid working proficiency
//   0.3 = exposure / not at production scale
// fullScore measures bidirectional FIT: of the skills a JD actually demands,
// how many does John hold, weighted by proficiency? This replaces the old
// "baseline 50 + does the JD contain John's niche vocabulary" model, which
// compressed every posting near 50 and rewarded keyword resemblance rather
// than fit.
const CANDIDATE_SKILLS = [
  // Core strengths (shipped, deep proof)
  { re: /\b(causal infer\w*|incremental\w*|synthetic control|geo[- ]?lift|diff[- ]in[- ]diff|sdid|\bdid\b)\b/i, level: 1.0, label: 'causal' },
  { re: /\b(a\/b test\w*|experiment\w*|randomized|uplift|treatment effect|incrementality)\b/i, level: 1.0, label: 'experimentation' },
  { re: /\b(survival analysis|kaplan[- ]meier|\bcox\b|hazard model|cloglog|churn model\w*)\b/i, level: 1.0, label: 'survival' },
  { re: /\b(forecast\w*|time[- ]series|sarimax|prophet|holt[- ]winters|panel data|demand planning)\b/i, level: 1.0, label: 'forecasting' },
  { re: /\b(mmm\b|marketing mix|media mix)\b/i, level: 1.0, label: 'mmm' },
  { re: /\b(bayesian|mcmc|pmmh|particle filter|bsts|structural time series)\b/i, level: 0.9, label: 'bayesian' },
  { re: /\b(agent\w*|multi[- ]agent|orchestrat\w*|tool[- ]call\w*|mcp\b|function calling|autonomous)\b/i, level: 0.9, label: 'agents' },
  { re: /\b(audience|lookalike|propensity|segmentation)\b/i, level: 0.9, label: 'audience' },
  { re: /\b(on[- ]device|edge inference|mlx\b|coreml|apple silicon|kv[- ]cache|speculative decoding|quantiz\w*)\b/i, level: 0.9, label: 'on-device' },
  { re: /\b(full[- ]stack|django|next[. ]?js|\breact\b|fastapi|supabase)\b/i, level: 0.9, label: 'full-stack' },
  { re: /\b(gcp|bigquery|vertex ai|google cloud)\b/i, level: 0.9, label: 'gcp' },
  { re: /\bpython\b/i, level: 1.0, label: 'python' },
  // Working proficiency
  { re: /\b(recommend\w*|ranking|personaliz\w*|learning to rank|\bltr\b)\b/i, level: 0.6, label: 'recsys' },
  { re: /\b(rag\b|retrieval aug\w*|vector (search|db|store)|embedding|semantic search)\b/i, level: 0.6, label: 'rag' },
  { re: /\b(llm|large language model\w*|prompt\w*|transformer)\b/i, level: 0.6, label: 'llm' },
  { re: /\b(fine[- ]tun\w*|rlhf|\bdpo\b|\bsft\b|lora|qlora|peft)\b/i, level: 0.5, label: 'fine-tuning' },
  { re: /\b(mlops|model serving|model deploy\w*|model registry|feature store|inference (server|service))\b/i, level: 0.6, label: 'mlops' },
  { re: /\b(pytorch|tensorflow|scikit|xgboost|lightgbm)\b/i, level: 0.7, label: 'ml-frameworks' },
  { re: /\b(aws|ec2|s3|sagemaker)\b/i, level: 0.6, label: 'aws' },
  { re: /\b(docker|kubernetes|k8s|terraform)\b/i, level: 0.6, label: 'infra' },
  { re: /\b(airflow|dagster|prefect|spark|pyspark|databricks|snowflake|\bdbt\b|\betl\b)\b/i, level: 0.6, label: 'data-eng' },
  { re: /\b(sql|postgres|redshift)\b/i, level: 0.7, label: 'sql' },
  { re: /\b(nlp|sentiment|topic model\w*|\blda\b|\bner\b|text classification)\b/i, level: 0.6, label: 'nlp' },
  { re: /\b(computer vision|object detection|image classif\w*|\bocr\b)\b/i, level: 0.5, label: 'cv' },
  { re: /\b(speech|\basr\b|wav2vec|transcription)\b/i, level: 0.5, label: 'speech' },
  // Relative gaps — JD demand here drags coverage down honestly
  { re: /\b(rust|golang|\bc\+\+\b|cuda kernel\w*|triton kernel\w*)\b/i, level: 0.2, label: 'systems-lang' },
  { re: /\b(kafka|flink|kinesis|streaming pipeline|real[- ]time streaming)\b/i, level: 0.3, label: 'streaming' },
  { re: /\b(distributed training|deepspeed|megatron|\bfsdp\b|model parallel\w*|gpu cluster|thousands of gpus)\b/i, level: 0.3, label: 'distributed-training' },
];

// Hard blockers: requirements John cannot meet. Subtractive, capped.
const HARD_NEGATIVES = [
  { re: /\b(ph\.?d\.?\s+(is\s+)?(required|mandatory|preferred and required)|must (have|hold|possess)\s+(a\s+)?ph\.?d|requires?\s+a\s+ph\.?d)\b/i, pts: -15, why: 'phd-required' },
  { re: /\b((active|current|ts\/sci|top[- ]secret)\s*)?(security clearance|secret clearance|ts\/sci|polygraph)\b/i, pts: -18, why: 'clearance' },
  { re: /\b(1[0-5]\+|ten\+|twelve\+|fifteen\+)\s*years\b/i, pts: -5, why: '10y+-required' },
];

function fullScore(posting, opts = {}) {
  const jd = posting.jdText || '';
  if (!jd) {
    posting.matchScore = null;
    posting.rankReason = (posting.rankReason || '') + '; full: no-jd';
    return posting;
  }

  // Bidirectional fit: weight John's proficiency over the skills the JD demands.
  let demand = 0, supply = 0;
  const have = [], gaps = [];
  for (const s of CANDIDATE_SKILLS) {
    if (s.re.test(jd)) {
      demand += 1;
      supply += s.level;
      (s.level >= 0.6 ? have : gaps).push(s.label);
    }
  }
  // Coverage in [0,1]: of demanded skills, the proficiency-weighted share John
  // holds. Neutral prior (0.5) only when the JD names no recognized skill.
  const coverage = demand > 0 ? supply / demand : 0.5;
  // Calibrated so a typical relevant senior role (coverage ~0.7) lands in the
  // high 60s/low 70s ("Good"), and only standout fits (coverage >= 0.9 plus
  // differentiators) reach the low-to-mid 80s ("Strong"). Keeps the find.md
  // 80/65/55 bands meaningful instead of marking most survivors "Strong".
  let score = 34 + coverage * 44; // 34..78 from fit alone

  const reasons = [];
  if (have.length) reasons.push(`fit:${have.slice(0, 6).join('/')}`);
  if (gaps.length) reasons.push(`gap:${gaps.slice(0, 4).join('/')}`);

  // Differentiator bonus: rare, high-proof strengths present in the JD signal a
  // standout (not just adequate) candidate. Small, capped — never the spine.
  let bonus = 0;
  for (const s of CANDIDATE_SKILLS) if (s.level >= 0.9 && s.re.test(jd)) bonus += 1.2;
  bonus = Math.min(8, bonus);
  if (bonus) { score += bonus; reasons.push(`+${bonus.toFixed(1)} differentiators`); }

  // Hard blockers.
  for (const n of HARD_NEGATIVES) {
    if (n.re.test(jd)) { score += n.pts; reasons.push(`${n.pts} ${n.why}`); }
  }

  // Seniority alignment with John's target band.
  if (/\b(senior|staff|principal|lead|member of technical staff)\b/i.test(posting.title)) {
    score += 3; reasons.push('+3 seniority-fit');
  }

  // Archetype refinement using the fuller archetype detector on JD text
  const detected = detectArchetype(jd);
  posting.archetype = detected.primary;

  score = Math.max(0, Math.min(100, score));
  posting.matchScore = Math.round(score);
  posting.fitCoverage = Math.round(coverage * 100) / 100;

  // Gate-pass: Required-skills proxy via coverage; Experience via title/JD years.
  const hasSeniorTitle = /\b(senior|staff|principal|lead|member of technical staff)\b/i.test(posting.title);
  posting.gatePass = {
    gate1: coverage >= 0.5 && score >= 55,
    gate2: hasSeniorTitle || /\b(3\+|5\+|[3-9]\s*years|\bmid[- ]level\b)/i.test(jd),
  };

  posting.rankReason = reasons.slice(0, 8).join(', ');
  return posting;
}

/**
 * RRF-fused ordering across independent signal rankings.
 *
 * Replaces the linear weighting used elsewhere in the skill. Each signal
 * produces its own ranked list of postings; RRF with k=60 combines them.
 * Reference: Bruch et al, ACM TOIS 2024.
 *
 * Signals used:
 *   - portfolio match density (PORTFOLIO_SIGNALS hits against title+dept)
 *   - seniority boost
 *   - posting freshness (most recent first)
 *   - archetype keyword density (if jd text present)
 */
function fuseRanking(postings, { k = 60 } = {}) {
  if (!postings.length) return [];

  const portfolioScore = (p) => {
    const corpus = `${p.title} ${p.department || ''} ${p.jdText || ''}`;
    let s = 0;
    for (const sig of PORTFOLIO_SIGNALS) if (sig.pattern.test(corpus)) s += sig.weight;
    return s;
  };
  const seniorityScore = (p) => {
    let s = 0;
    for (const sig of SENIORITY_BOOST) if (sig.pattern.test(p.title)) s += sig.weight;
    return s;
  };
  const freshnessScore = (p) => {
    if (!p.postedDate) return 0;
    const ageDays = (Date.now() - new Date(p.postedDate)) / 86400000;
    return Math.max(0, 60 - ageDays); // 60 -> 0 linearly over 60 days
  };
  const jdScore = (p) => {
    if (!p.jdText) return 0;
    let s = 0;
    for (const sig of FULL_SIGNALS.strong) if (sig.regex.test(p.jdText)) s += sig.points;
    return s;
  };

  const rankings = [portfolioScore, seniorityScore, freshnessScore, jdScore].map(fn =>
    [...postings].sort((a, b) => fn(b) - fn(a))
  );

  const fused = rrf(rankings, p => p.canonicalUrl, { k });
  for (let i = 0; i < fused.length; i++) {
    const p = fused[i].item;
    p.rrfScore = fused[i].score;
    p.rrfRank = i + 1;
  }
  return fused.map(x => x.item);
}

module.exports = { quickScore, fullScore, fuseRanking, isRoleMatch, PORTFOLIO_SIGNALS };
