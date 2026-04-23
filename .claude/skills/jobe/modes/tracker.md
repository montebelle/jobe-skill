# Tracker Mode

View and manage the application pipeline.

## Display

Read tracker:
```bash
JOBE_HOME="${HOME}/.jobe"; [ -f data/tracker.md ] && JOBE_HOME="."
cat "${JOBE_HOME}/data/tracker.md"
```

Show the full table, then compute stats:
- Total applications
- By status: Discovered / Evaluated / Applied / Responded / Interviewing / Offer / Rejected / Skipped
- Conversion rates: Evaluated->Applied, Applied->Responded, Responded->Interviewing, Interviewing->Offer

If `data/followups.md` exists, show upcoming follow-ups (see followup mode).

## Updates

If user wants to update a status (e.g., "mark #3 as Interviewing"):
- Edit tracker.md directly
- If status changes to Applied/Responded/Interviewing, add/update entry in followups.md

## Orphan Check

After displaying the tracker table, check for orphaned reports:
```bash
JOBE_HOME="${HOME}/.jobe"; [ -d reports ] && JOBE_HOME="."
ls "${JOBE_HOME}/reports/" 2>/dev/null
```

Compare report directory slugs against company-role entries in tracker.md. If any reports exist that are NOT in the tracker, display:
```
ORPHANED REPORTS (not in tracker):
  - {slug}: {list of files found}
Add these to the tracker? (yes/no)
```
If yes, read the resume JSON from each orphaned report to get company, role, and score, then add entries to tracker.md with status "Evaluated".
