# Batch Mode

Process multiple job postings, generating resume + cover letter + tracker entry for each.

## Input
Parse `$ARGUMENTS` after "batch" for:
- **URLs** (space-separated)
- **File path** (.txt with one URL per line)

## Process

For each URL:
1. Run the full evaluate mode (Blocks A-G)
2. After each: report company, role, match score, archetype, files generated
3. If gate-pass fails: skip and note in summary

## Summary

After all jobs processed:
- Total processed / skipped / failed
- Ranked by match score
- Tracker entries added for each
- Archetype distribution of processed roles
