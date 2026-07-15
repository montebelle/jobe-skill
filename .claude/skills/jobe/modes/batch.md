# Batch Mode

Process multiple job postings, generating resume + cover letter + tracker entry for each.

## Input
Parse `$ARGUMENTS` after "batch" for:
- **URLs** (space-separated)
- **File path** (.txt with one URL per line)

## Process

For each URL, run a focused per-posting evaluation that uses the bullet library:

1. **Block A — Role summary**: detect archetype from JD keywords (see `_shared.md` Archetype Detection table).
2. **Block B — Portfolio match**: launch `jobe-jd-analyzer` + `jobe-company-intel` (cached if `<14 days old`) + `jobe-competitor` agents in parallel.
3. **Block E — Resume + cover letter generation**: use `lib/bullet-select.js` `buildExperience(baseline, spec)` and `pickProjects(spec, 2)` to select per-JD bullets and projects from `data/bullet-library.json`. Per-posting spec must include `archetype` (from Block A), `jdText` (raw JD), and `bulletCounts` (keys must match the role-keys defined in your bullet library). See `modes/evaluate.md` Block E for full step.
4. **Block G — Legitimacy / ghost-score** check.
5. Render DOCX via `scripts/render-docx.js` and `scripts/render-cover-letter.js`.
6. Update tracker via `lib/tracker-writer.js` `appendTrackerRow()` and `pushQueueEntry()`.
7. If gate-pass fails (Required Skills < 50% or Experience < 0.7): skip and note in summary.

After each: report company, role, match score, archetype, files generated, and which bullets were selected (so cross-posting differentiation is visible).

## Bullet Selection — Hard Requirement

For two postings of different archetypes (e.g., on-device-MLX vs causal/personalization), the selected bullet set per role must differ by at least one bullet. If two specs produce identical bullet sets, expand `${WORKSPACE}/data/bullet-library.json` with more archetype-specific entries before continuing the batch.

Sanity-check between two batched postings:
```bash
diff <(jq '.experience[].bullets' ${WORKSPACE}/reports/{slug-A}/resume-*.json) \
     <(jq '.experience[].bullets' ${WORKSPACE}/reports/{slug-B}/resume-*.json)
```
For postings of different archetypes, the diff should show >50% of bullets different. If less, the tailoring is shallow and the batch should be re-run with expanded library coverage.

## Bulk-resume helper (skip A-G, fast path)

For triage runs where you want a resume-skeleton-and-DOCX for many URLs without the full A-G LLM analysis, use `scripts/bulk-resume-from-list.js`:

```bash
node scripts/bulk-resume-from-list.js urls.txt
# or
node scripts/bulk-resume-from-list.js https://... https://...
```

The helper:
- looks up each URL in today's `${WORKSPACE}/signals/discovered/{date}/ranked-enriched.json`
- runs `bullet-select` against the JD already in the enriched output
- writes `${WORKSPACE}/reports/{slug}/resume-{date}-{slug}.json` + renders DOCX
- pushes a queue entry with `tailoringDepth: 'pending-cover-letter'`
- leaves `coverLetter` empty for follow-up composition (cover letter quality bar requires LLM tailoring per posting)

Use this when you want to ship many resumes quickly and follow up with cover letters in waves; use the full evaluate flow when you want the deep A-G analysis on a single high-priority posting.

## Summary

After all jobs processed:
- Total processed / skipped / failed
- Ranked by match score
- Tracker entries added for each
- Archetype distribution of processed roles
- Cross-posting bullet-overlap audit (verify per-JD differentiation)
