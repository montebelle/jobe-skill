# Calibrate Mode

Human-label a random sample of prior LLM-judge outputs; compute Cohen's kappa to detect silent judgment drift.

## Empirical motivation

arXiv 2506.13639 (2025): LLM-as-judge agreement with humans in expert/nuanced domains ranges 60-68%. Persona-drift labels, cover-letter quality verdicts, and safety-hook behavioral reviews all depend on LLM judgment. Without periodic calibration, these decisions drift silently.

## Run

```bash
node -e "
const { pendingHumanReview, recordHumanAdjudication, kappaForKind } = require('./lib/calibration');
const sample = pendingHumanReview('persona-drift', 10);
console.log('Sample of 10 unlabeled persona-drift decisions:');
for (const entry of sample) {
  console.log('---');
  console.log('id:', entry.id);
  console.log('subject:', entry.subjectId);
  console.log('LLM label:', entry.llmLabel);
  console.log('LLM rationale:', entry.llmRationale || '(none)');
}
"
```

Then for each entry, ask the user (John) to label true/false on whether the LLM was right. Feed back with:

```bash
node -e "require('./lib/calibration').recordHumanAdjudication('<id>', <true|false>, '<optional note>')"
```

After all samples labeled, compute kappa:

```bash
node -e "
const { kappaForKind } = require('./lib/calibration');
const result = kappaForKind('persona-drift');
console.log('n =', result.n);
console.log('observed agreement (po):', result.po?.toFixed(3));
console.log('expected agreement (pe):', result.pe?.toFixed(3));
console.log('Cohen kappa:', result.kappa?.toFixed(3));
if (result.kappa < 0.75) {
  console.log('WARNING: kappa below 0.75 threshold. Review the LLM prompt or threshold.');
}
"
```

## Kinds to calibrate

- `persona-drift` (embedding EMA threshold)
- `cover-letter-quality` (LLM review of generated text)
- `safety-hook-3` (deterministic regex + LLM behavioral review)
- `ghost-score` (ghost-job classification)

## Output

Report kappa per kind. Flag any kind with kappa < 0.75.
