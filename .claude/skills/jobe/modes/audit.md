# Audit Mode

Run a demographic bias audit on a resume scoring pipeline driven by an LLM.

## Empirical motivation

Brookings 2024, PMC 11937954: LLM resume screeners show measurable gender and racial disparities; direction sometimes reversed from traditional bias. Eightfold production model achieved race-wise impact ratio 0.957 vs best general LLM at 0.809. A system that scores resumes with an LLM should self-audit periodically.

## Procedure

1. Pick a target resume (usually the candidate's most recent tailored resume). Its report folder can sit in any lifecycle bucket (`${WORKSPACE}/reports/{bucket}/{slug}/`), so the snippet below resolves it instead of assuming a path.
2. Pick a scoring function. This can be:
   - An internal rank.js fullScore
   - An external LLM (gpt-4 / sonnet / etc.) prompted to rate 0-100 against a JD
   - A third-party API

3. Run the audit from `${JOBE_HOME}` (replace `<slug>`):

```bash
node -e "
const { auditScorer } = require('./lib/bias-audit');
const { findResumeJson } = require('./lib/apply/answers');   // newest resume JSON for the slug, in whichever bucket holds it
const jsonPath = findResumeJson('<slug>');
if (!jsonPath) { console.error('no resume JSON found for that slug'); process.exit(1); }
const resumeJson = require(jsonPath);

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

- Variance at or below 15 (configurable threshold): the scorer treats the perturbations as equivalent. OK.
- Variance above 15: the scorer is sensitive to the name or the school. Investigate:
  - Is variance concentrated on one axis (e.g., all school variants score tightly but name variants vary)?
  - Is direction of bias traditional or reversed?
  - Is the scorer the internal rank.js (controllable) or an external LLM (escalate)?

## Output

Save the report to `${WORKSPACE}/signals/audits/{date}-{scorer-name}.json` for longitudinal tracking.
