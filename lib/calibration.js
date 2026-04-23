/**
 * LLM-judge calibration loop.
 *
 * Empirical backing: "An Empirical Study of LLM-as-a-Judge" (arXiv
 * 2506.13639, 2025) reports Pearson up to 0.85 with humans in extractive
 * QA but only 60-68% agreement in expert/nuanced domains. Implication:
 * LLM-based cover-letter review and persona-drift decisions need periodic
 * human calibration to avoid silent drift.
 *
 * This module records LLM-judge outputs + human adjudications in
 * data/calibration.jsonl and computes Cohen's kappa on any sample.
 * Recommended schedule: 10 random samples weekly; flag if kappa < 0.75.
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');

const LOG_PATH = () => path.join(getProjectRoot(), 'data', 'calibration.jsonl');

/**
 * Record an LLM-judge label (will be compared to a later human adjudication).
 *
 * @param {object} sample
 * @param {string} sample.kind    - what was judged (e.g. "cover-letter-quality", "persona-drift")
 * @param {string} sample.subjectId - stable id (e.g. posting canonicalUrl or resume slug)
 * @param {any}    sample.llmLabel - LLM's verdict (boolean or categorical)
 * @param {string} sample.llmRationale - short text
 */
function recordLlmJudge(sample) {
  const entry = {
    id: `${sample.kind}:${sample.subjectId}:${Date.now()}`,
    kind: sample.kind,
    subjectId: sample.subjectId,
    llmLabel: sample.llmLabel,
    llmRationale: sample.llmRationale || null,
    llmAt: new Date().toISOString(),
    humanLabel: null,
    humanRationale: null,
    humanAt: null,
  };
  fs.mkdirSync(path.dirname(LOG_PATH()), { recursive: true });
  fs.appendFileSync(LOG_PATH(), JSON.stringify(entry) + '\n');
  return entry.id;
}

function recordHumanAdjudication(id, humanLabel, humanRationale = null) {
  const lines = readAll();
  const updated = lines.map(l => {
    if (l.id !== id) return l;
    return { ...l, humanLabel, humanRationale, humanAt: new Date().toISOString() };
  });
  fs.writeFileSync(LOG_PATH(), updated.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function readAll() {
  if (!fs.existsSync(LOG_PATH())) return [];
  return fs.readFileSync(LOG_PATH(), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

// Cohen's kappa for two-rater categorical agreement.
function cohensKappa(pairs) {
  if (!pairs.length) return { kappa: null, n: 0, po: null, pe: null };
  const labels = [...new Set(pairs.flatMap(p => [String(p.a), String(p.b)]))];
  const n = pairs.length;
  let agree = 0;
  const marginalA = new Map(), marginalB = new Map();
  for (const { a, b } of pairs) {
    if (String(a) === String(b)) agree++;
    marginalA.set(String(a), (marginalA.get(String(a)) || 0) + 1);
    marginalB.set(String(b), (marginalB.get(String(b)) || 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const lbl of labels) pe += (marginalA.get(lbl) || 0) / n * (marginalB.get(lbl) || 0) / n;
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa, n, po, pe };
}

function kappaForKind(kind) {
  const pairs = readAll()
    .filter(r => r.kind === kind && r.humanLabel != null)
    .map(r => ({ a: r.llmLabel, b: r.humanLabel }));
  return cohensKappa(pairs);
}

function pendingHumanReview(kind, limit = 10) {
  return readAll()
    .filter(r => r.kind === kind && r.humanLabel == null)
    .slice(-limit);
}

module.exports = {
  recordLlmJudge,
  recordHumanAdjudication,
  cohensKappa,
  kappaForKind,
  pendingHumanReview,
  readAll,
};
