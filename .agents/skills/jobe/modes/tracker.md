# Tracker Mode

View and manage the application pipeline.

## Display

Read tracker:
```bash
cat "${WORKSPACE}/data/tracker.md"
```

Show the full table, then compute stats:
- Total applications
- By status: Discovered / Evaluated / Applied / Responded / Interviewing / Offer / Rejected / Skipped
- Conversion rates: Evaluated->Applied, Applied->Responded, Responded->Interviewing, Interviewing->Offer

**Benchmark the funnel honestly**: the conversion from a cold application to a conversation is structurally low across the labor market, often single digit percent (Gem 140M applicant benchmarks: about 6% aggregate inbound to screen; NY Fed complete funnel study: about 6% ever interviewed). Present Applied->Responded AGAINST a realistic base rate: a handful of conversations per few hundred cold applications is ON CURVE, not failure. Do not treat fast (1 to 6 day) rejections as feedback on resume content; they are inferences about level, industry, or acceptance likelihood (Kessler/Low/Sullivan), not a verdict on your resume text.

**Rejection segmentation (optional)**: queue entries may carry rejection metadata (`rejected`, `rejectedDate`, `rejectionStage`, `rejectionSegment`). `rejectionSegment` is one string shaped `domain|level|companytype` (for example `acute-care|senior|hospital-system` or `tax|manager|regional-firm`). When any entry carries it, break rejections and responses out by segment when showing stats, so targeting refines on real data: which domains, levels, and company types actually convert for you (see the target roles in your `_profile.md`).

If `${WORKSPACE}/data/followups.md` exists, show upcoming follow-ups (see followup mode).

## Updates

If user wants to update a status (e.g., "mark #3 as Interviewing"):
- Prefer `lib/tracker-writer.js` `updateTrackerStatus({slug, newStatus, notesAppend})` (atomic, finds the row for a folder in any lifecycle bucket; run from `${JOBE_HOME}`); otherwise edit `${WORKSPACE}/data/tracker.md` directly
- If status changes to Applied/Responded/Interviewing, add/update entry in `${WORKSPACE}/data/followups.md`

## Orphan Check

After displaying the tracker table, check for orphaned reports:
```bash
# Reports are nested reports/{bucket}/{slug}/ (an older workspace may still hold flat reports/{slug}/).
# List job slugs, skipping the bucket folders themselves and the buckets that hold no live job.
# find, not a glob: under zsh one unmatched glob aborts the whole loop.
find "${WORKSPACE}/reports" -mindepth 1 -maxdepth 2 -type d 2>/dev/null | while IFS= read -r d; do
  case "$d" in */reports/audit/*|*/reports/archive/*|*/reports/sample/*) continue;; esac
  case "$(basename "$d")" in verify|evaluate|queue|manual|applied|skipped|archive|audit|sample|needs-manual|gated|non-gated) continue;; esac
  basename "$d"
done | sort -u
```

Compare report directory slugs against company-role entries in `${WORKSPACE}/data/tracker.md`. If any reports exist that are NOT in the tracker, display:
```
ORPHANED REPORTS (not in tracker):
  - {slug}: {list of files found}
Add these to the tracker? (yes/no)
```
If yes, read the resume JSON from each orphaned report to get company, role, and score, then add entries with status "Evaluated" through `lib/tracker-writer.js` `upsertTrackerRow(row, slug)` (it never duplicates a slug), with `reportDir` set to the folder's real location, for example `reports/queue/{slug}/`.
