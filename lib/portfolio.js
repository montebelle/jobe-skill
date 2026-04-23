/**
 * Portfolio evidence loader and keyword indexer.
 *
 * Parses reference.md and builds a keyword-to-domain index so the scoring
 * engine can quickly find matching evidence for any JD requirement.
 */

const fs = require('fs');
const path = require('path');

// Keyword index: maps lowercase keywords to domain IDs
const KEYWORD_INDEX = {
  // A1: LLM / Agent Systems
  'llm': 'A1', 'agent': 'A1', 'multi-agent': 'A1', 'orchestration': 'A1',
  'rag': 'A1', 'prompt engineering': 'A1', 'prompt injection': 'A1',
  'guardrails': 'A1', 'safety': 'A1', 'agentic': 'A1', 'tool calling': 'A1',
  'mcp': 'A1', 'context engineering': 'A1', 'langchain': 'A1',
  'vector database': 'A1', 'lancedb': 'A1', 'embeddings': 'A1',
  'hybrid search': 'A1', 'mmr': 'A1', 'knowledge graph': 'A1',
  'fastembed': 'A1', 'nomic': 'A1', 'fastapi': 'A1',
  'google adk': 'A1', 'vertex ai': 'A1',
  'competitive intelligence': 'A1',

  // A2: Enterprise ML Pipelines / Forecasting
  'forecasting': 'A2', 'time series': 'A2', 'sarimax': 'A2',
  'xgboost': 'A2', 'random forest': 'A2', 'svm': 'A2',
  'ensemble': 'A2', 'parallel processing': 'A2', 'production ml': 'A2',
  'pipeline orchestration': 'A2', 'bayesian': 'A2', 'smc': 'A2',
  'pmcmc': 'A2', 'particle filter': 'A2', 'monte carlo': 'A2',
  'bias correction': 'A2', 'quantile regression': 'A2',
  'cross-validation': 'A2', 'holt-winters': 'A2',

  // A3: Survival Analysis
  'survival analysis': 'A3', 'hazard model': 'A3', 'kaplan-meier': 'A3',
  'concordance': 'A3', 'glm': 'A3', 'cloglog': 'A3', 'time-to-event': 'A3',
  'propensity score': 'A3', 'ipw': 'A3', 'doubly robust': 'A3',
  'incrementality': 'A3', 'segmentation': 'A3', 'clustering': 'A3',
  'pca': 'A3', 'customer analytics': 'A3', 'ltv': 'A3', 'rfm': 'A3',

  // A4: Geo-Experimentation / Causal Inference
  'causal inference': 'A4', 'synthetic control': 'A4',
  'geo-experimentation': 'A4', 'geolift': 'A4', 'sdid': 'A4',
  'a/b testing': 'A4', 'experimentation': 'A4', 'dowhy': 'A4',
  'ate': 'A4', 'causal impact': 'A4', 'bsts': 'A4',
  'prophet': 'A4', 'mcmc': 'A4',

  // A5: On-Device LLM Infrastructure
  'mlx': 'A5', 'whisper': 'A5', 'speech-to-text': 'A5',
  'on-device': 'A5', 'inference optimization': 'A5', 'kv cache': 'A5',
  'speculative decoding': 'A5', 'real-time': 'A5', 'websocket': 'A5',
  'diffusion model': 'A5', 'video generation': 'A5', 'apple silicon': 'A5',
  'fp8': 'A5', 'quantization': 'A5', 'vae': 'A5', 'lora': 'A5',
  'bm25': 'A5', 'reciprocal rank fusion': 'A5',

  // A6: Computer Vision
  'computer vision': 'A6', 'yolo': 'A6', 'object detection': 'A6',
  'detectron2': 'A6', 'panoptic segmentation': 'A6', 'resnet': 'A6',
  'opencv': 'A6', 'asr': 'A6', 'wav2vec2': 'A6',
  'hugging face': 'A6', 'transformers': 'A6',

  // A7: NLP
  'nlp': 'A7', 'sentiment analysis': 'A7', 'topic modeling': 'A7',
  'lda': 'A7', 'vader': 'A7',
  'gensim': 'A7', 'text mining': 'A7', 'diminishing returns': 'A7',
  'saturation curve': 'A7', 'creative optimization': 'A7',
  'curve fitting': 'A7',

  // A8: Change Point / Econometrics
  'change point': 'A8', 'structural break': 'A8',
  'intervention analysis': 'A8', 'cusum': 'A8', 'ruptures': 'A8',
  'hodrick-prescott': 'A8', 'stl decomposition': 'A8',

  // A9: GCP Data Engineering
  'gcp': 'A9', 'bigquery': 'A9', 'cloud storage': 'A9',
  'cloud functions': 'A9', 'pub/sub': 'A9', 'data engineering': 'A9',
  'etl': 'A9', 'data pipeline': 'A9', 'data quality': 'A9',

  // A10: Audience Modeling
  'audience modeling': 'A10', 'lookalike': 'A10', 'pyspark': 'A10',
  'databricks': 'A10', 'logistic regression': 'A10',
  'gradient boosting': 'A10', 'mlp': 'A10', 'geospatial': 'A10',
  'k-d tree': 'A10', 'nearest neighbor': 'A10', 'spark': 'A10',

  // A11: Marketing Mix Modeling
  'mmm': 'A11', 'media mix': 'A11', 'marketing analytics': 'A11',
  'regression': 'A11', 'ridge': 'A11', 'lasso': 'A11',
  'elasticnet': 'A11', 'svr': 'A11',

  // A12: Full-Stack Development
  'full-stack': 'A12', 'django': 'A12', 'next.js': 'A12',
  'react': 'A12', 'typescript': 'A12', 'supabase': 'A12',
  'rest api': 'A12', 'openai': 'A12', 'image generation': 'A12',

  // Cross-cutting
  'python': 'CROSS', 'sql': 'CROSS', 'docker': 'A9',
  'kubernetes': 'A9', 'aws': 'A9', 'azure': 'A9',
  'pytorch': 'CROSS', 'tensorflow': 'CROSS', 'scikit-learn': 'A2',
  'pandas': 'CROSS', 'numpy': 'CROSS', 'scipy': 'CROSS',
  'statsmodels': 'A2', 'matplotlib': 'CROSS',
  'node.js': 'A12', 'javascript': 'A12',
  'machine learning': 'CROSS', 'deep learning': 'A6',
  'neural networks': 'A6', 'reinforcement learning': 'A1'
};

function findDomains(keyword) {
  const lower = keyword.toLowerCase().trim();
  const matches = [];

  for (const [key, domain] of Object.entries(KEYWORD_INDEX)) {
    if (lower.includes(key) || key.includes(lower)) {
      matches.push(domain);
    }
  }

  return [...new Set(matches)];
}

function loadPortfolio(referencePath) {
  if (!fs.existsSync(referencePath)) return null;
  return fs.readFileSync(referencePath, 'utf8');
}

module.exports = { KEYWORD_INDEX, findDomains, loadPortfolio };
