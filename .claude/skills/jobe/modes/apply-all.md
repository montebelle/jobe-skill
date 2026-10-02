# Apply-All Mode

Process the entire apply queue in sequence. **Default: Camoufox stealth auto apply** (the per job flow in `apply.md`). Each job: fill, quick glance, submit, security code or email confirmation if asked, record, then on to the next. The user watches the stream of glances and can interrupt at any time.

## Input
`/jobe apply-all`: Camoufox auto apply over the whole queue (default)
`/jobe apply-all --top 5`: top N unapplied by score
`/jobe apply-all [slug]`: one role
`/jobe apply-all --paste`: fallback, paste ready blocks (no browser; for forms behind a login, see `apply-assisted.md`)

**Headless is the default.** Unattended, no visible windows, screenshots still serve as the glance, and it is the **preferred mode for real submissions**: CAPTCHAs, spam blocks, and email confirmation walls fire MORE often headful than headless under Camoufox (a real display leaks signals that conflict with the spoofed fingerprint). Pass `--headful` only to watch a run or clear a visible wall.

**Ashby needs different handling (reCAPTCHA v3).** Ashby job boards run invisible reCAPTCHA v3. It silently scores the browser session, and Ashby's server rejects a low score with "flagged as possible spam" (a terminal state, no recovery). A fresh fingerprint per run (which beats the Greenhouse email wall) scores COLD and is the wrong default here. The harness detects `ats==='ashby'` and switches to **warm mode**: a persistent profile (`${WORKSPACE}/signals/apply/_profiles/ashby`, ignored by git, accumulates Google and reCAPTCHA cookies across runs), a Google warm up visit in the session, slower typing at a human cadence, and a dwell and scroll before submit. Two hard rules:
- **Run Ashby jobs ONE AT A TIME.** The shared profile is guarded by a lock; a second concurrent Ashby run bails with `needs-manual`. Never launch Ashby in the parallel rounds you use for Greenhouse.
- **NEVER try again on an Ashby tenant that already returned `submit-blocked-spam`.** Retries score progressively worse. Hand those to the user to apply by hand from their normal browser.

Toggle with `--warm` / `--no-warm`. The score is per Google session, so warm mode is best effort, not a guarantee; some strict tenants may still block.

## Why Camoufox is the default
Job sites detect automation (the `navigator.webdriver` and DevTools fingerprints a Chrome driven over CDP leaks) and respond with CAPTCHAs and email confirmation walls. Camoufox patches Firefox at the C++ level so those leaks never reach page scripts, adds human like cursor movement and timing, and uses a locale and timezone consistent with the IP. It fills and submits real ATS forms (Greenhouse, Lever, Ashby) without tripping those walls, and the agent closes the email confirmation loop with your mail tools. The old `--chrome` (Claude in Chrome) path is **deprecated**: it was the detectable thing. Paste ready (`--paste`) remains the fallback for forms behind a login the harness should not touch.

## Process
1. Read `${WORKSPACE}/data/apply-queue.json`.
2. Filter to entries where `applied` is false and `skipped` is not true.
3. Drop entries with no generated resume in a `${WORKSPACE}/reports/{bucket}/{slug}/` folder (normally `reports/queue/{slug}/`; the harness resolves any lifecycle bucket). They need `/jobe [url]` first. List them at the end so the user knows.
4. Sort by `score` descending (or take `--top N`).
5. Read `${WORKSPACE}/data/apply-profile.json` once. If `nonCompete` is `Yes`, say so before the first job (see Hold rules).

For each remaining entry, run the **full `apply.md` flow**:

### Step A: Announce
```
=== APPLICATION {n}/{total} ===
Company: {company}   Role: {role}   Score: {score}
URL: {url}
```

### Step B: Run the Camoufox per job flow (apply.md Steps 1 to 5)
- `node scripts/camoufox-apply.js run {slug} &` (background)
- Wait for `phase:filled`; write and inject answers for `state.questions[]`. The control channel shape (`answers` is an ARRAY of `{label, text}` or `{label, option}`, optional `nth`) and the full phase list are in `apply.md` Steps 2 and 4.
- Present the glance (screenshot plus summary)
- Submit; handle `needs-security-code` and `needsEmailConfirm` with your mail tools
- (`--paste`: follow `apply-assisted.md` for this entry instead)

Salary needs no flag: the harness reads the pay band the live posting publishes and enters the figure the user's `salaryStrategy` picks. The live band is used only when it is a yearly salary in the user's currency (`discovery.salaryCurrency`; a bare `$` is read as USD); an hourly, weekly, or monthly rate, a stipend or bonus, or another currency leaves the stored `salaryExpectation` in place. Only currencies written with a dollar sign are read (USD, CAD, AUD, NZD, SGD, HKD, MXN); with any other `salaryCurrency` the stored `salaryExpectation` is always used. Pass `--salary N` only when the user gives an explicit figure for a job.

### Hold rules (never decide these unattended)
- **Blank eligibility answers.** A job whose `questions[]` contains an eligibility question (work authorization, sponsorship, citizenship, permanent residence, domicile, federal eligibility, clearance, relocation, non compete) with no value on file is HELD for the user. The agent does not answer it. Ask once, offer to save the answer to the apply profile, then continue.
- **Non compete.** When `nonCompete` is `Yes` in the apply profile, hold each job for an explicit go ahead instead of submitting it unattended. The harness answers the form question; whether this employer is a restricted competitor is the user's decision.
- **`blocked-location`.** The live posting is outside the user's location policy. Do not override it yourself. List it at the end; the user may run it again with `--allow-onsite`.
- **`needs-manual`, `submit-blocked-spam`, a required field nobody can fill, a CAPTCHA, a login wall.** `moveReportFolder(slug, 'manual')` and move on. `manual` is the folder bucket; `needs-manual` is only the harness phase name.

### Step C: Record (apply.md Step 6)
`moveReportFolder(slug,'applied')`, tracker `Applied`, queue `applied:true`, a 7 day follow up. Report: "Applied to {company}, {role}. {remaining} left."

### Step D: Next
Proceed to the next entry automatically. No retyped commands.

## Controls during the session
- **"skip"**: write `{action:"skip"}` to the current job's control file, mark Skipped (queue `skipped:true`, tracker, `moveReportFolder(slug,'skipped')`), move on
- **"stop"**: halt the queue, save progress (remaining entries stay unapplied)
- **"headful {slug}"**: run a job again with a visible window (for a login wall or CAPTCHA the user must clear)
- **"show"**: display the current glance screenshot again

## Resume on restart
`/jobe apply-all` is idempotent: it reads `applied` and `skipped` from the queue again and skips anything already processed.

## End of run summary
List: applied, skipped, held for the user (with the question or reason), moved to `manual`, blocked by the location policy, and entries that still need an evaluation.

## Safety
- Always show the glance before submit. Stop on any required unfilled field, CAPTCHA, or login wall, and hand it to the user.
- Never automate the user's logged in LinkedIn session. Camoufox runs a fresh fingerprinted session.
- A one time authorization of your mail tools is required before the security code and email confirmation loop can run.
