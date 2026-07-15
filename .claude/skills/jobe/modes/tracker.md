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

**Benchmark the funnel honestly**: cold-apply -> conversation conversion is structurally low across the labor market, often single-digit percent (Gem 140M-applicant benchmarks: ~6% aggregate inbound->screen; NY Fed complete-funnel study: ~6% ever interviewed). Present Applied->Responded AGAINST a realistic base rate — a handful of conversations per few hundred cold applications is ON-CURVE, not failure. Do not treat fast (1-6 day) rejections as resume-content feedback; they are level / industry / acceptance-likelihood inferences (Kessler/Low/Sullivan), not a verdict on your resume text.

**Rejection segmentation (optional)**: if your queue entries carry rejection metadata (e.g. `rejected` / `rejectedDate` / `rejectionStage` / `rejectionSegment`), break rejections and responses out by segment when showing stats so targeting refines on real data — which domains, levels, and company types actually convert for you (see your `_profile.md` target roles).

If `${WORKSPACE}/data/followups.md` exists, show upcoming follow-ups (see followup mode).

## Updates

If user wants to update a status (e.g., "mark #3 as Interviewing"):
- Edit `${WORKSPACE}/data/tracker.md` directly
- If status changes to Applied/Responded/Interviewing, add/update entry in `${WORKSPACE}/data/followups.md`

## Orphan Check

After displaying the tracker table, check for orphaned reports:
```bash
ls "${WORKSPACE}/reports/" 2>/dev/null
```

Compare report directory slugs against company-role entries in `${WORKSPACE}/data/tracker.md`. If any reports exist that are NOT in the tracker, display:
```
ORPHANED REPORTS (not in tracker):
  - {slug}: {list of files found}
Add these to the tracker? (yes/no)
```
If yes, read the resume JSON from each orphaned report to get company, role, and score, then add entries to `${WORKSPACE}/data/tracker.md` with status "Evaluated".
