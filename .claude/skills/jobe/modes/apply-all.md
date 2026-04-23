# Apply-All Mode

Process the entire apply queue sequentially. Default: paste-ready blocks (fastest, most reliable). Opt-in: browser automation with `--chrome` flag.

## Input
`/jobe apply-all` - paste-ready blocks (default)
`/jobe apply-all --chrome` - browser automation via Chrome (requires `mcp__Claude_in_Chrome__*` MCP tools; see apply.md for exact tool names)
`/jobe apply-all --top 5` - top N by score

## Why Paste-Ready Is Default
Browser automation is fragile: blank screenshots on Greenhouse forms, dropdown values flipping, file uploads blocked by browser security. Paste-ready blocks let the user fill forms in their own logged-in browser where cookies, sessions, and CAPTCHA trust are already established. It is faster and more reliable.

## Process

1. Read `data/apply-queue.json`
2. Filter to entries where `applied` is false and `skipped` is not true
3. Sort by score descending

For each entry in the queue:

### Step A: Announce
```
=== APPLICATION {n}/{total} ===
Company: {company}
Role: {role}
Score: {score}
URL: {url}

Proceeding in 3 seconds... (type "skip" to skip this one)
```

### Step B: Fill Application

**Default (paste-ready):** Follow the apply-assisted.md workflow:
- Run `open "{url}"` to open in the user's default browser
- Print the paste-ready application block (contact info, resume path, cover letter text, pre-written answers)
- Follow Content Differentiation Rules from apply-assisted.md (no cross-field repetition)
- Wait for "yes" or "skip" or "stop"

**--chrome flag:** Follow the apply.md workflow:
- Navigate to URL in Chrome via MCP tools
- Find and click Apply button
- Read form fields
- Fill contact info, upload resume DOCX, write answers
- Show review of everything filled
- Wait for "submit" or "skip" or "change [field]"

### Step C: After Submit/Yes
- Update `data/apply-queue.json`: set `applied: true`, `appliedDate: {today}`
- Update `data/tracker.md`: change status from "Evaluated" to "Applied"
- Add entry to `data/followups.md` with 7-day follow-up date
- Report: "Applied to {company} - {role}. {remaining} left in queue."

### Step D: Next
Immediately proceed to the next role in the queue. No need to re-type any commands.

## Controls During the Session
- **"yes"** (paste-ready) / **"submit"** (chrome) - mark applied and move to next
- **"skip"** - skip this role and move to next (marks as Skipped in tracker)
- **"stop"** - stop the queue, save progress (remaining roles stay in queue)
- **"change [field]"** - modify a specific field before submitting (chrome mode only)
- **"show"** - re-display what was filled

## Resume on Restart
If the session is interrupted, `/jobe apply-all` picks up where you left off. It reads `applied: true/false` from the queue and skips already-applied and skipped roles.
