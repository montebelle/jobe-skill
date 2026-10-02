# Batch Mode

Process multiple job postings, generating resume + cover letter + tracker entry for each.

## Input
Parse `$ARGUMENTS` after "batch" for:
- **URLs** (space separated)
- **File path** (.txt with one URL per line)

## Process

For each URL, run a focused per posting evaluation:

1. **Block A, role summary**: detect the archetype if the user defined any (see `_shared.md` Archetype Detection; `General` otherwise).
2. **Block B, portfolio match**: launch `jobe-jd-analyzer` + `jobe-company-intel` (cached if under 14 days old, at `${WORKSPACE}/signals/company-intel/{company-slug}/`) + `jobe-competitor` agents in parallel. Pass each agent the inputs listed in `evaluate.md` Block B (among them the absolute Output path for the intel cache and the absolute Ledger path of the evidence file), plus the relevant standing rules (SKILL "Subagent propagation").
3. **Block E, resume + cover letter generation**: source the evidence per `modes/evaluate.md` Block E Step 0. Read each JD, then the candidate's evidence that matches it (the evidence roots when the profile lists any, then the evidence file), and write the bullets from that. `lib/bullet-select.js` `buildExperience(baseline, spec)` and `pickProjects(spec, 2)` supply the per JD candidate pool from `${WORKSPACE}/data/bullet-library.json` (spec: `archetype`, `jdText`, and `bulletCounts` whose keys match the role keys of the library, or omit it to use `baseline.defaultBulletCounts`). With evidence roots the pool is a phrasing aid; without them it is the evidence. It is never the finished resume: the JD grounded reframe, the role posture check, the quality gate with the JD, and the depth gate from Block E all apply to every posting in the batch.
4. **Block G, legitimacy / ghost score** check.
5. Render DOCX via `scripts/render-docx.js --strict` and `scripts/render-cover-letter.js --strict` (see `_shared.md` Render Gates).
6. **Adversarial verify and repair, then a number provenance sweep.** Writers that rewrite many resumes in a row merge things that are separate. Reread each generated resume against its sources and the attribution rules (`companyKeyMap`, `evidence.attribution`, the "Attribution rules" section of the profile):
   - repair any bullet that merges two different bodies of work into one, or that lists a project under the wrong employer (side project work under the main job is the classic case);
   - then confirm EVERY number traces to a source, the evidence file, or the "Verified figures" section of the profile, and remove or correct any that does not;
   - confirm nothing under "Known corrections" reappears, in any wording.
   Cover every output of the batch, the queued ones AND the ones headed for `manual`, not a sample. Render again after any repair.
7. Update the tracker and queue via `lib/tracker-writer.js` `upsertTrackerRow(row, slug)` and `pushQueueEntry()` (both are safe to run twice for one slug). New report folders live in `${WORKSPACE}/reports/queue/{slug}/`. The slug is the one `lib/dedup.js reportSlug` returns (`evaluate.md` Block E): `{company-slug}-{role-slug}`, plus the city unless the work mode policy is exactly `["remote"]`, so two cities of one title stay two folders and two rows. Pass the posting's `location` to `pushQueueEntry` (the bulk helper's `--json` items and `_genctx.json` carry `location` and the slug already built this way), so history can tell the cities apart.
8. If gate pass fails (Required Skills < 50% or Experience < 0.7): skip and note in summary.

After each: report company, role, match score, archetype, files generated, which evidence leads, and any unmet stated minimum (so cross posting differentiation is visible).

## Differentiation: Hard Requirement

Two postings with different asks MUST lead with different evidence. A posting about coordinating care and a posting about bedside critical care do not open with the same bullet; neither do a tax compliance role and a tax advisory role. Verify that the two resumes' lead bullets and summaries differ. If they read the same, the batch ranked keywords instead of reading each JD: redo `evaluate.md` Block E Step 0 for those postings. Only when the user has no evidence beyond the library, and the library truly has nothing else for that role, is the fix to add more specific entries to `${WORKSPACE}/data/bullet-library.json` (from real evidence in `reference.md`) before continuing the batch.

Sanity check between two batched postings:
```bash
diff <(jq '.experience[].bullets' "${WORKSPACE}"/reports/queue/{slug-A}/resume-*.json) \
     <(jq '.experience[].bullets' "${WORKSPACE}"/reports/queue/{slug-B}/resume-*.json)
```
For postings with different asks, the diff should show more than 50% of bullets different. If less, the tailoring is shallow and those postings are redone as above.

## Bulk helper: candidate pools for many postings (fast path into Block E)

For a long list, `scripts/bulk-resume-from-list.js` prepares the inputs for every posting in one pass:

```bash
node scripts/bulk-resume-from-list.js urls.txt
# or
node scripts/bulk-resume-from-list.js https://... https://...
# or, for the workflow scripts below (stdout is the items array, progress goes to stderr)
node scripts/bulk-resume-from-list.js --json urls.txt
```

The helper:
- looks up each URL in the most recent `${WORKSPACE}/signals/discovered/{date}/ranked-enriched.json`
- runs `bullet-select` against the JD already in the enriched output
- writes, per posting, into `${WORKSPACE}/reports/queue/{slug}/` (or the folder the slug already has in another lifecycle bucket): `candidate-pool-{date}-{slug}.json` (flagged `candidatePool: true`), `jd.txt`, and `_genctx.json` (the tailoring brief: JD keywords, honest gaps, ranked evidence)

It renders NOTHING and queues NOTHING. The pool is keyword selected library content, and the JD grounded reframe of `evaluate.md` Block E is still required before a resume exists.

**With the Workflow tool** (parallel, one agent per posting). Pass the `--json` output as `items`; every path in `items` is absolute:

- `scripts/wf-generate-batch.js` with args `{ root: "${JOBE_HOME}", workspace: "${WORKSPACE}", user: "<workspace slug, or omit>", date: "<today, YYYY-MM-DD>", ledger: "<evidence.ledger>", items }`. It generates each resume + cover letter JSON from its pool, then adversarially verifies attribution, role posture, method depth, forbidden terms, ATS characters, and the cover letter bar, and fixes in place.
- Follow ups on the generated files. Each takes the same `root: "${JOBE_HOME}"`, `workspace: "${WORKSPACE}"` (both required), and optional `user` and `ledger` as `wf-generate-batch.js`, plus its own arguments: `scripts/wf-recenter-batch.js` (`items: [{ slug, company, role, archetype, dir, jsonPath }]`; makes each resume lead with what THAT role asks for) and `scripts/wf-fill-batch.js` (`maxPages: <output.targetPages>`, `minFill: 0.85`, optional `exemplar`, `items: [{ slug, company, role, jsonPath, dir }]`; fills to the page target using the rendered page as the authority). `scripts/wf-compress-batch.js` (same `root` and `workspace`) is superseded by the fill workflow and is kept for a host where the page fill measurement is unavailable.
- The workflow agents read the user's profile sections ("Standing rules", "Attribution rules", "Role posture leads", "Verified figures", "Known corrections", "What not to use in output") from the workspace by name.
- After the workflows pass, YOU queue each posting (`pushQueueEntry`, `upsertTrackerRow`); the workflows do not.

**Without the Workflow tool**: process the pools one at a time through `evaluate.md` Block E (the sequential path above).

Use the helper when you want many postings prepared quickly; use the full evaluate flow when you want the deep A to G analysis on a single high priority posting.

## Summary

After all jobs processed:
- Total processed / skipped / failed
- Ranked by match score
- Tracker entries added for each
- Archetype distribution of processed roles (when the user defined archetypes)
- Cross posting overlap audit (verify per JD differentiation)
- What the verify and repair pass changed (bullets repaired, numbers removed or corrected)
