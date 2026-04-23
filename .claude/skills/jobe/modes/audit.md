# Audit Mode

Run a demographic bias audit on an LLM-driven resume scoring pipeline.

## Empirical motivation

Brookings 2024, PMC 11937954: LLM resume screeners show measurable gender + racial disparities; direction sometimes reversed from traditional bias. Eightfold production model achieved race-wise impact ratio 0.957 vs best general LLM at 0.809. A system that scores resumes with an LLM should self-audit periodically.

## Procedure

1. Pick a target resume (usually the candidate's most-recent deep-tailored resume).
2. Pick a scoring function. This can be:
   - An internal rank.js fullScore
   - An external LLM (gpt-4 / sonnet / etc.) prompted to rate 0-100 against a JD
   - A third-party API

3. Run the audit:

```bash
node -e "
const { auditScorer } = require('./lib/bias-audit');
const resumeJson = require('./reports/<slug>/resume-<date>-<slug>.json');

// Example scoreFn: plug in your actual scorer here
const scoreFn = async (resume) => {
  // Minimal mock: score = length of summary + 0.2 * bullet count
  // Replace with your real scorer
  const summaryLen = (resume.summary || '').length / 10;
  const bullets = (resume.experience || []).reduce((n, r) => n + (r.bullets || []).length, 0);
  return Math.min(100, summaryLen + bullets * 2);
};

(async () => {
  const report = await auditScorer(resumeJson, scoreFn, { flagThreshold: 15 });
  console.log('mean:',     report.mean.toFixed(1));
  console.log('min:',      report.min.toFixed(1));
  console.log('max:',      report.max.toFixed(1));
  console.log('variance:', report.variance.toFixed(1));
  console.log('flagged:',  report.flagged ? 'YES (> '+report.flagThreshold+')' : 'no');
  console.log('---');
  for (const [kind, list] of Object.entries(report.byKind)) {
    console.log(kind + ':');
    for (const r of list) console.log('  ' + r.label.padEnd(24) + r.score.toFixed(1));
  }
})();
"
```

## Interpretation

- Variance ≤ 15 (configurable threshold): scorer treats perturbations equivalently. OK.
- Variance > 15: scorer is sensitive to name/school/nationality. Investigate:
  - Is variance concentrated on one axis (e.g., all school variants score tightly but name variants vary)?
  - Is direction of bias traditional or reversed?
  - Is the scorer the internal rank.js (controllable) or an external LLM (escalate)?

## Output

Save the report to `signals/audits/{date}-{scorer-name}.json` for longitudinal tracking.
