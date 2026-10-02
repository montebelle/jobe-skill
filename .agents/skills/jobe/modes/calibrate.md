# Calibrate Mode

Have a human label a random sample of earlier LLM judge outputs, then compute Cohen's kappa to detect silent drift in judgment.

## Empirical motivation

arXiv 2506.13639 (2025): agreement between an LLM judge and humans in expert or nuanced domains ranges 60 to 68 percent. Cover letter quality verdicts, fit calls, and ghost job calls all depend on LLM judgment. Without periodic calibration these decisions drift silently.

## Where the samples come from

Nothing is logged unless a run logs it. Whenever a mode makes an LLM judgment worth checking later, record it (from `${JOBE_HOME}`; the log is `${WORKSPACE}/data/calibration.jsonl`):

```bash
node -e "require('./lib/calibration').recordLlmJudge({ kind: process.argv[1], subjectId: process.argv[2], llmLabel: ({ true: true, false: false })[process.argv[3]] ?? process.argv[3], llmRationale: process.argv[4] })" cover-letter-quality "<report slug>" true "<one line reason>"
```

`kind` is any stable label you choose. `subjectId` is a stable id (a report slug or a posting URL). `llmLabel` is the verdict (true or false, or a category).

## Run

Pick the kind to calibrate (`KIND` below) and list up to 10 unlabeled decisions:

```bash
KIND=cover-letter-quality
node -e "
const { pendingHumanReview } = require('./lib/calibration');
const kind = process.argv[1];
const sample = pendingHumanReview(kind, 10);
console.log('Unlabeled ' + kind + ' decisions: ' + sample.length);
for (const entry of sample) {
  console.log('---');
  console.log('id:', entry.id);
  console.log('subject:', entry.subjectId);
  console.log('LLM label:', entry.llmLabel);
  console.log('LLM rationale:', entry.llmRationale || '(none)');
}
" "$KIND"
```

If the list is empty, say so: there is nothing to calibrate until runs record judgments (see above).

Then, for each entry, show the user the subject (open the cover letter, the posting, or the report it names) and ask for THEIR label, in the same terms as the LLM label (the same true or false question, or the same categories). Kappa compares the two labels directly. Feed each one back with:

```bash
node -e "require('./lib/calibration').recordHumanAdjudication(process.argv[1], ({ true: true, false: false })[process.argv[2]] ?? process.argv[2], process.argv[3] || null)" "<id>" "<true|false|category>" "<optional note>"
```

After all samples are labeled, compute kappa:

```bash
node -e "
const { kappaForKind } = require('./lib/calibration');
const result = kappaForKind(process.argv[1]);
console.log('n =', result.n);
console.log('observed agreement (po):', result.po?.toFixed(3));
console.log('expected agreement (pe):', result.pe?.toFixed(3));
console.log('Cohen kappa:', result.kappa?.toFixed(3));
if (result.kappa != null && result.kappa < 0.75) {
  console.log('WARNING: kappa below the 0.75 threshold. Review the LLM prompt or the threshold.');
}
" "$KIND"
```

## Kinds to calibrate

Any kind your runs recorded. The ones the skill's own judgments map to:

- `cover-letter-quality` (LLM review of generated text against the Cover Letter Quality Bar in `_shared.md`)
- `fit-score` (whether a posting the score called a good fit really was one, in the user's eyes)
- `ghost-score` (ghost job classification)

## Output

Report kappa per kind, with `n`. Flag any kind with kappa below 0.75. With fewer than about 10 labeled samples, say the estimate is not yet meaningful.
