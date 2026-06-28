# Apply-All Mode

Process the entire apply queue sequentially. **Default: Camoufox stealth auto-apply** (the per-job flow in `apply.md`). Each job: auto-fill → quick glance → submit → email-confirm if needed → record, then on to the next. The user watches the stream of glances and can interrupt at any time.

## Input
`/jobe apply-all` — Camoufox auto-apply over the whole queue (default)
`/jobe apply-all --top 5` — top N unapplied by score
`/jobe apply-all [slug]` — one role
`/jobe apply-all --paste` — fallback: paste-ready blocks (no browser; for login-walled forms — see apply-assisted.md)
`/jobe apply-all --headless` — unattended (no visible windows; screenshots are still the glance)

## Why Camoufox is the default
Job sites detect automation (the `navigator.webdriver` / DevTools fingerprints a CDP-driven Chrome leaks) and respond with CAPTCHAs and email-confirmation walls. Camoufox patches Firefox at the C++ level so those leaks never reach JS, adds human-like cursor/timing, and uses an IP-consistent locale/timezone. It fills and submits real ATS forms (Greenhouse / Lever / Ashby) without tripping those walls, and the agent closes the email-confirmation loop via the Gmail MCP. The old `--chrome` (Claude-in-Chrome MCP) path is **deprecated** — it was the detectable thing. Paste-ready (`--paste`) remains the fallback for forms behind a login the harness should not touch.

## Process
1. Read `data/apply-queue.json`.
2. Filter to entries where `applied` is false and `skipped` is not true.
3. Drop entries with no `reports/{slug}/` evaluation (they need `/jobe [url]` first — list them at the end so the user knows).
4. Sort by `score` descending (or take `--top N`).

For each remaining entry, run the **full `apply.md` flow**:

### Step A: Announce
```
=== APPLICATION {n}/{total} ===
Company: {company}   Role: {role}   Score: {score}
URL: {url}
```

### Step B: Run the Camoufox per-job flow (apply.md Steps 1–5)
- `node scripts/camoufox-apply.js run {slug} &` (background)
- Wait for `phase:filled`; generate + inject answers for `state.questions[]`
- Present the glance (screenshot + summary)
- Submit; handle email confirmation via Gmail MCP if `needsEmailConfirm`
- (`--paste`: instead follow apply-assisted.md for this entry)

### Step C: Record (apply.md Step 6)
`moveReportFolder(slug,'applied')` + tracker `Applied` + queue `applied:true` + 7-day follow-up. Report: "Applied to {company} — {role}. {remaining} left."

### Step D: Next
Proceed to the next entry automatically. No re-typed commands.

## Controls during the session
- **"skip"** — write `{action:"skip"}` to the current job's control file, mark Skipped, move on
- **"stop"** — halt the queue, save progress (remaining entries stay unapplied)
- **"headful {slug}"** — re-run a job with a visible window (for a login wall / CAPTCHA the user must clear)
- **"show"** — re-display the current glance screenshot

## Resume on restart
`/jobe apply-all` is idempotent: it re-reads `applied`/`skipped` from the queue and skips anything already processed.

## Safety
- Always show the glance before submit. Stop on any required-unfilled field, CAPTCHA, or login wall — hand to the user.
- Never automate the user's logged-in LinkedIn session. Camoufox runs a fresh fingerprinted session.
- One-time Gmail MCP auth is required before the email-confirmation loop can run.
