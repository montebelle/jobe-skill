/**
 * JD archetype detection.
 * Classifies a job description into one of 6 archetypes
 * to drive which portfolio evidence to emphasize.
 */

const ARCHETYPES = {
  'AI Platform / LLMOps': {
    keywords: ['llm', 'platform', 'infrastructure', 'serving', 'inference', 'mlops',
      'model deployment', 'model serving', 'training infrastructure', 'gpu', 'cuda',
      'model registry', 'feature store', 'ml platform', 'llmops'],
    portfolioDomains: ['A1', 'A5', 'A9']
  },
  'Agentic / Automation': {
    keywords: ['agent', 'agentic', 'automation', 'workflow', 'orchestration',
      'tool calling', 'mcp', 'function calling', 'multi-agent', 'autonomous',
      'safety', 'guardrails', 'prompt injection', 'rag', 'retrieval'],
    portfolioDomains: ['A1', 'A5']
  },
  'Applied ML': {
    keywords: ['recommendation', 'ranking', 'search', 'ads', 'advertising',
      'personalization', 'applied ml', 'applied machine learning', 'prediction',
      'classification', 'scoring', 'targeting', 'bidding', 'pricing'],
    portfolioDomains: ['A2', 'A10', 'A11']
  },
  'Causal / Experimentation': {
    keywords: ['causal', 'experiment', 'a/b test', 'incrementality', 'measurement',
      'attribution', 'geo-experiment', 'synthetic control', 'bayesian',
      'survival analysis', 'uplift', 'treatment effect', 'propensity'],
    portfolioDomains: ['A3', 'A4', 'A8']
  },
  'ML Infrastructure': {
    keywords: ['pipeline', 'airflow', 'spark', 'data platform', 'feature store',
      'batch', 'streaming', 'etl', 'data engineering', 'orchestration',
      'kubernetes', 'docker', 'ci/cd', 'mlflow', 'kubeflow'],
    portfolioDomains: ['A2', 'A9', 'A10']
  },
  'Forward Deployed': {
    keywords: ['customer-facing', 'solutions', 'implementation', 'consulting',
      'enterprise', 'deployment', 'forward deployed', 'customer engineer',
      'sales engineer', 'solutions architect', 'proof of concept', 'poc'],
    portfolioDomains: ['A1', 'A12']
  }
};

function detectArchetype(jdText) {
  const lower = jdText.toLowerCase();
  const scores = {};

  for (const [name, config] of Object.entries(ARCHETYPES)) {
    let count = 0;
    for (const kw of config.keywords) {
      const regex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = lower.match(regex);
      if (matches) count += matches.length;
    }
    scores[name] = count;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const primary = sorted[0];
  const secondary = sorted[1] && sorted[1][1] > 0 ? sorted[1] : null;

  return {
    primary: primary[0],
    primaryScore: primary[1],
    secondary: secondary ? secondary[0] : null,
    secondaryScore: secondary ? secondary[1] : 0,
    portfolioDomains: ARCHETYPES[primary[0]].portfolioDomains,
    allScores: Object.fromEntries(sorted)
  };
}

// CLI mode
if (require.main === module) {
  const text = process.argv[2] || '';
  if (!text) {
    console.error('Usage: node lib/archetypes.js "JD text here"');
    process.exit(1);
  }
  const result = detectArchetype(text);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { ARCHETYPES, detectArchetype };
