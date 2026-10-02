# Apply Mode

Fill out and submit ONE job application using **Camoufox stealth automation** (the default). Camoufox is a patched Firefox that does not leak the `navigator.webdriver` and DevTools fingerprints a Chrome driven over CDP leaks, so it does not trip the automation detection and email confirmation walls that broke the old Chrome path. Flow: fill, quick glance (screenshot plus field summary), submit, handle any security code or email confirmation, record.

The agent orchestrates `scripts/camoufox-apply.js` (the browser harness) through a small file channel, because the harness (Node) and your mail tools (MCP) live in different layers and cannot call each other directly.

Run every `node` command below from `${JOBE_HOME}`. The harness and `lib/tracker-writer.js` resolve the active workspace by themselves.

## Input
`$ARGUMENTS` after "apply": a company and role slug (the name of the report folder) or a posting URL. Given a URL, look up its slug in `${WORKSPACE}/data/apply-queue.json` (`primaryUrl`); if it is not there, evaluate it first.

Flags:
- `--paste`: skip the browser and print paste ready blocks instead (see `apply-assisted.md`; for forms behind a login).
- `--headless` is the default and the preferred mode for real submissions: no visible window, and it runs cleaner under Camoufox (a real display leaks signals that conflict with the spoofed fingerprint and trip security and spam checks). Pass `--headful` only to watch a run or to clear a visible wall; headful can trigger the checks headless avoids.
- `--salary N`: an explicit figure for this run. It wins over every pay band.
- `--allow-onsite`: skip the location guard for this one run.
- `--url U`: use this posting URL instead of the one on file.
- `--no-submit`: fill only, then close. Nothing is submitted (a smoke test).
- `--warm` / `--no-warm`: force or disable warm mode. **Ashby turns warm mode on by itself** (persistent profile, a warm up visit, slow typing, a dwell before submit) to survive its reCAPTCHA v3 spam gate. Run Ashby jobs ONE AT A TIME and never retry a tenant that returned `submit-blocked-spam` (see `apply-all.md`).

## Prerequisites
1. A completed evaluation with a resume JSON plus DOCX (and ideally a cover letter DOCX). New evaluations land in `${WORKSPACE}/reports/queue/{slug}/`, the ready to apply bucket. The harness finds the folder in ANY lifecycle bucket (`lib/apply/answers.js` calls `lib/tracker-writer.js locateReportDir`), so never hard code a path. If no evaluation exists, run `/jobe [url]` (evaluate) first.
2. `camoufox-js` and `playwright-core` installed and the browser binary fetched (`npx camoufox-js fetch`). One time.
3. Answers on file. Identity (name, contact, links, school, current role) comes from the report's resume JSON. Everything a resume does not carry comes from `${WORKSPACE}/data/apply-profile.json`: eligibility answers, `salaryStrategy`, `salaryExpectation`, `howHeard`, and the opt in EEO values. Every key is optional. A blank value is never guessed.

### Report folder lifecycle
(Full rules: `_shared.md`, "Report folder lifecycle".) `${WORKSPACE}/reports/{bucket}/{slug}/`, in order: `verify` (generated, checks pending) -> `evaluate` (scored, decision pending) -> `queue` (ready to apply) -> `manual` (a human must finish it) or straight to `applied` or `skipped` -> `archive` (aged out). `audit` holds audit reports. `moveReportFolder(slug, bucket)` finds the folder wherever it sits, files it flat at `reports/{bucket}/{slug}/`, and rewrites the queue entry paths and every tracker reference.

`manual` is an ACTIVE parking bucket, not an archive: the user still submits from it. Use it for anything a human must finish (a knockout or eligibility gate the harness cannot register, an ATS that blocks the automated submit, an account wall).

## Step 1: Launch the harness (background, holds the form open)
```bash
node scripts/camoufox-apply.js run {slug} [--url {override}] [--salary N] [--allow-onsite] &
```
Run it in the **background**. The process keeps the browser alive across the glance and the confirmation step. It writes status to `${WORKSPACE}/signals/apply/{slug}/state.json` and waits (up to 30 minutes per step) for the agent to write `${WORKSPACE}/signals/apply/{slug}/control.json`.

What the harness does by itself:
- Rewrites the URL to the page that actually shows the form (for example a careers wrapper to its Greenhouse embed form). A Workday posting stops at once with `phase:"needs-manual"` (account wall). If a careers site wraps a Greenhouse board whose token is not its domain name and the form does not load, add `{ "<careers host>": "<board token>" }` to `${WORKSPACE}/data/apply-wrappers.json` (your entries win over the shared `configs/apply-wrappers.json`, which ships empty).
- **Location guard.** Checks the live posting against YOUR location policy (`discovery.workModes` and `discovery.countries` in `${WORKSPACE}/data/profile.json`) and stops with `phase:"blocked-location"` when the page clearly states a work mode or country outside it. With no policy on file nothing is blocked. `--allow-onsite` skips the check for one run. This is defense in depth against a discovery leak.
- Clicks Apply when the form is not inline, and follows the application into an embed iframe when the form lives in one.
- Fills contact fields and the location combobox.
- Reads the pay band the live posting publishes and enters the figure your `salaryStrategy` picks (`midpoint` by default, or `top`, or `bottom`), unless `--salary` was passed. The live band is used only when it is a yearly salary in the user's currency (`discovery.salaryCurrency`; a bare `$` is read as USD). An hourly, weekly, or monthly rate, a stipend or bonus, a band in another currency, or no band on the page leaves the stored `salaryExpectation` in place. Only currencies written with a dollar sign are read (USD, CAD, AUD, NZD, SGD, HKD, MXN); with any other `salaryCurrency` the stored `salaryExpectation` is always used.
- Answers eligibility questions (work authorization, sponsorship, citizenship, permanent residence, domicile, federal eligibility, clearance, relocation, non compete) ONLY from the apply profile. One with no value on file is not answered; it comes back in `questions[]`. For a yes or no gate, the entry in `state.filled` carries the text of the option actually selected (not "Yes" or "No"). A gate whose options offer two possible matches, or only negated sentences, is not answered and comes back in `questions[]` or `unfilled[]`. The `clearance` and `relocation` values answer only "do you hold an active security clearance" and "are you willing to relocate": a question about obtaining a clearance (or a past, expired, or other kind of clearance), about relocation assistance or whether a move is needed, and any question about current pay are always left for the user at the glance.
- Handles EEO questions per the apply profile (declining by default, see NEVER below).
- Uploads the resume LAST, so an ATS resume parse that re renders the form cannot wipe earlier fields. It uploads the resume PDF when one exists, else the DOCX. The cover letter goes into the cover letter file input, or into the remaining unlabeled file input when the form labels none (never into a portfolio, work sample, or transcript slot).
- Detects free text and choice questions **without inventing answers**. They come back in `state.questions[]` with `type` and, for choice widgets, `options`.

## Step 2: Wait for the fill, then answer the questions
Poll `${WORKSPACE}/signals/apply/{slug}/state.json` until `phase === "filled"` (or one of the stop phases in Step 4). Read `filled`, `unfilled`, `questions`, and `resumeUploaded`.

**Eligibility questions in `questions[]`: ASK THE USER.** Never pick Yes or No for them. Offer to save the answer into `${WORKSPACE}/data/apply-profile.json` so it is not asked again.

For every other entry in `questions[]`, WRITE a grounded answer (this is the agent's job; the harness never guesses):
- Pull evidence from the report folder's `resume-*.json` (summary, experience bullets) and the analysis markdown.
- Follow the anti fabrication rules in `_shared.md`. Evidence comes from `${WORKSPACE}/reference.md` (the ledger) and, when your profile lists evidence sources, the sources themselves. Real figures only. No term from your do not render list (`output.forbiddenTerms`).
- Write answers ATS clean: none of `< > [ ] { } " \`. Free text is passed through `lib/normalize.js` on the way in (dashes, smart quotes, and ATS illegal characters are folded; plain hyphens are removed only when `output.stripHyphens` is true). A bare URL, email, or handle is typed as written.
- Apply the Content Differentiation Rules (below): each field leads with different evidence.

Inject the answers by writing `control.json`. Use the Write tool for the file (answer text often contains quotes), or for a short answer:
```bash
node -e "require('fs').writeFileSync('${WORKSPACE}/signals/apply/{slug}/control.json', JSON.stringify({action:'answers', answers:[{label:'<question label substring>', text:'<answer>'}]}))"
```
Control channel shape, exactly:
- `answers` is an ARRAY. Each item is `{label, text}` for free text or `{label, option}` for a choice widget (dropdown, radio, button group, checkbox), with an optional `nth` (0 based) when several controls share one label.
- `label` is matched as a substring of the field label (the first 24 characters are what count), and the form is scanned again before each item so a re render cannot lose it.
- `text` sent for a field that turns out to be a choice widget is applied as the option.
- A partial option value the dropdown typeahead can narrow (the first word of a long option) is more robust than the full string.
- A required field can appear only after a rejected submit. Pass it by its label even when it was not in `state.questions[]`.

Poll `state.json` again: `phase` stays `filled` and `answeredIdx` lists each item as `{label, ok}` (with `reason` when `ok` is false). Fix and resend any item that failed.

## Step 3: The glance (always shown before submit)
Read `${WORKSPACE}/signals/apply/{slug}/preview.png` and present to the user:
```
=== APPLICATION GLANCE: {company} - {role} ===
Name / Email / Phone / Location / Links:  <values>
Resume uploaded: yes ({file})
Salary entered: <figure and where it came from: flag, live band, or stored>
Eligibility answers: <each answered gate and the option text selected, from state.filled>
Custom Q answers: <one line each>
Could not fill: <unfilled[]>  (if any is required, STOP and ask the user)
Screenshot: ${WORKSPACE}/signals/apply/{slug}/preview.png
```
This is the glance checkpoint. Read the option text of every eligibility answer in `filled[]` and check it says what the apply profile says: an option that negates the intended answer ("I am not authorized ...") must never go out under a Yes. If `unfilled[]` contains a REQUIRED field, or the screenshot shows a CAPTCHA or a login wall, STOP and hand control to the user (run again with `--headful` so they can step in). Otherwise proceed.

**Non compete warning.** If `nonCompete` is `Yes` in the apply profile, say so at the glance and get an explicit go ahead before submit. The harness answers the form question; it never decides whether THIS employer is a restricted competitor. That decision stays with the user.

## Step 4: Submit
```bash
node -e "require('fs').writeFileSync('${WORKSPACE}/signals/apply/{slug}/control.json', JSON.stringify({action:'submit'}))"
```
Poll `state.json`. Every phase the agent can see:

| Phase | Meaning | What to do |
|---|---|---|
| `submitted` | Success text confirmed on the page | Read `postSubmitExcerpt` and `needsEmailConfirm`, go to Step 5 |
| `filled` with `submitRejected:true` | The form rejected the submit and was scanned again | Read `submitError`, answer the newly surfaced `questions[]`, submit again (the harness allows 6 rescans) |
| `filled` with `transient:true` | A recoverable page error | Send the same action again |
| `needs-security-code` | The ATS emailed a code | Step 5 |
| `submit-blocked-spam` | Flagged as possible spam. Terminal | NEVER retry. Move the folder to `manual` and hand it to the user |
| `submit-failed` | No success text and nothing to rescan | Read `error`, show the screenshot, hand to the user |
| `needs-manual` | Workday or another account wall, or the warm Ashby profile is busy | Account wall: move to `manual`. Busy profile: run it again when the other Ashby run ends |
| `blocked-location` | The live page is outside the location policy (`policy` shows it) | Tell the user. Skip it, or run again with `--allow-onsite` if they say so |
| `error` | The harness failed | Read `error`, report it |

Other phases: `skip` and `timeout` (the run closed without submitting), `confirmed` and `done` (Step 5).

## Step 5: Security code or email confirmation (only if asked)
**Security code** (`phase === "needs-security-code"`): find the newest mail from the company or ATS with your mail tools (for example the Gmail MCP connector; it needs a one time authorization, prompt the user if it is missing), read the code, and send:
```bash
node -e "require('fs').writeFileSync('${WORKSPACE}/signals/apply/{slug}/control.json', JSON.stringify({action:'security-code', code:'<code>'}))"
```
The harness types it and submits again. If the phase comes back as `needs-security-code` with an `error`, a newer code was issued: read the latest mail once more. If it fails twice, stop and hand the form to the user with `--headful`. Do not hammer it.

**Email confirmation** (`phase === "submitted"` and `needsEmailConfirm === true`; the page said to confirm or verify your email):
1. Find the most recent confirmation mail from the company or ATS (search the sender domain plus "confirm", "verify", "application").
2. Extract the confirmation link.
3. Inject it into the SAME stealth session:
   ```bash
   node -e "require('fs').writeFileSync('${WORKSPACE}/signals/apply/{slug}/control.json', JSON.stringify({action:'confirm', link:'<url>'}))"
   ```
4. Poll for `phase === "confirmed"`.

If `needsEmailConfirm === false`, send `{action:"done"}` to close the browser cleanly (it closes by itself after 10 minutes).

## Step 6: Record (a real submission is always recorded)
Using `lib/tracker-writer.js`:
1. `moveReportFolder(slug, 'applied')`. It finds the folder in any bucket, moves it to `reports/applied/{slug}/`, and rewrites the queue entry paths and the tracker references.
2. `updateTrackerStatus({slug, newStatus:'Applied', notesAppend})`. If it returns false (no row yet), `upsertTrackerRow({date, company, role, score, status:'Applied', reportDir:'reports/applied/{slug}/', notes}, slug)`. Use `upsertTrackerRow`, not `appendTrackerRow`: this step can run twice for one slug. Note "Camoufox auto apply; submitted {date}; <on page success | email confirmed>".
3. `updateQueueEntry(slug, {applied:true, appliedDate:TODAY})` if it is in the queue.
4. Append a follow up to `${WORKSPACE}/data/followups.md` (next follow up = +7 days).
5. Report success with the confirmation screenshot path.

If the user skipped: `{action:"skip"}` to the harness, `updateQueueEntry(slug, {skipped:true, skipReason})`, `updateTrackerStatus({slug, newStatus:'Skipped'})`, `moveReportFolder(slug, 'skipped')`. Keep the `skipped:true` flag: discovery reads it to never surface that job again.

If a human must finish it: `moveReportFolder(slug, 'manual')` and leave the queue entry unapplied. The folder BUCKET is `manual`; `needs-manual` is only the name of the harness state phase. When the user reports they submitted it by hand, record it with steps 1 to 5.

## Optional helpers
- `node scripts/apply-helpers/drive.js <slug> [answers.json] [--no-record]` runs one application end to end: launch, inject the answers array from the file, submit, ride the rescan loop, and record ONLY on `submitted`. Any other end phase is printed for the agent to handle.
- `scripts/apply-helpers/launch.sh <slug> [url]` and `scripts/apply-helpers/submit.sh <slug> "<company>" "<role>"` are the two halves as shell steps.

All three resolve the active workspace through `lib/config.js`. `drive.js` and `submit.sh` submit WITHOUT pausing for a glance. Use them only for a job the user already approved (they saw the glance from a `--no-submit` run, or told you to run it unattended), and never when an eligibility answer is blank or `nonCompete` is `Yes` without the user's go ahead for that employer.

## Content Differentiation Rules
Each field carries GENUINELY different evidence. No repetition across fields.
| Field | Lead With | Tone |
|---|---|---|
| Cover Letter | Per the Cover Letter Rules in `_shared.md` | Confident, shows how you think |
| "Why {company}?" | Specific things about THEIR mission, product, service, or team | Genuine, forward looking |
| Custom Questions | One narrow, role relevant deep dive not covered elsewhere | Precise, specific |
Before writing any field, check what the others already say.

## NEVER
- Never submit when a required field is unfilled or a CAPTCHA or login wall is on screen. Hand it to the user.
- Never invent free text answers. The harness returns questions for the agent to write from real evidence.
- Never answer an eligibility question the user has no value on file for. Ask.
- EEO and demographic questions: self identification is OPT IN and the user's own choice. By default the harness **declines** every demographic question. A user who wants to self identify sets `eeoSelfIdentify: true` and fills `eeoValues` in `${WORKSPACE}/data/apply-profile.json` with their OWN answers (recognized keys: `gender`, `race`, `veteran`, `disability`, `hispanic`, `transgender`, `orientation`, `pronouns`). A value may be a list of acceptable wordings. Matching is by whole phrase, so a question whose options do not contain the user's wording is declined, never approximated. A question with no value on file always declines.
- Never decide a non compete question of substance for the user (see the warning in Step 3).
- Never automate the user's logged in LinkedIn session (account safety rule, hard). Camoufox uses a fresh fingerprinted session, not the user's browser profile.
- Never enter passwords or create accounts on the user's behalf.
- Never solve or bypass a CAPTCHA.
