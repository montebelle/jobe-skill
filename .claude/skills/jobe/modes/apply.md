# Apply Mode

Fill out and submit ONE job application using **Camoufox stealth automation** (the default). Camoufox is a patched Firefox that does not leak the `navigator.webdriver` / DevTools fingerprints a CDP-driven Chrome leaks, so it does not trip the automation-detection + email-confirmation walls that broke the old Chrome path. Flow: auto-fill → quick glance (screenshot + field summary) → submit → handle any email confirmation → record.

The agent orchestrates `scripts/camoufox-apply.js` (the browser harness) through a tiny file channel, because the harness (Node) and the Gmail MCP tools live in different layers and cannot call each other directly.

## Input
`$ARGUMENTS` after "apply": a company-role slug (matching a `reports/{slug}/` folder) or a URL.
Flags: `--paste` (skip the browser, fall back to paste-ready blocks — see apply-assisted.md, for login-walled forms) · `--headful` is the default (visible window); pass `--headless` for an unattended run.

## Prerequisites
1. A completed evaluation in `reports/{slug}/` with a resume JSON + DOCX (and ideally a cover letter DOCX). If none exists, run `/jobe [url]` (evaluate) first.
2. `camoufox-js` + `playwright-core` installed and the binary fetched (`npx camoufox-js fetch`). One-time.
3. `modes/_profile.md` contact info, and (optionally) `data/apply-profile.json` for work authorization + EEO choices — the harness pulls contact + answers from the report JSON + that profile via `lib/apply/answers.js`.

## Step 1: Launch the harness (background, holds the form open)
```bash
node scripts/camoufox-apply.js run {slug} [--url {override}] [--headless] &
```
Run it in the **background** — the process keeps the browser alive across the glance and the email-confirm step. It writes status to `signals/apply/{slug}/state.json` and waits for the agent to write `signals/apply/{slug}/control.json`.

The harness automatically: navigates, **verifies the live posting matches the user's location filter and aborts (`phase:"blocked-location"`) if it is out of scope** (defense-in-depth against a discovery leak; override with `--allow-onsite`), clicks Apply if the form is not inline, fills contact fields + the Location combobox, uploads the resume DOCX (uploaded LAST so ATS resume-autofill re-renders do not invalidate earlier fields), handles EEO questions per the user's apply-profile (declining by default), and **detects free-text + choice custom questions without inventing answers** — they come back in `state.questions[]` (with `type` and, for choice widgets, `options`).

## Step 2: Wait for the fill, then answer custom questions
Poll `signals/apply/{slug}/state.json` until `phase === "filled"`. Read `filled`, `unfilled`, and `questions`.

For each entry in `questions[]`, WRITE a grounded answer (this is the agent's job — never let the harness guess):
- Pull evidence from `reports/{slug}/resume-*.json` (summary, experience bullets) and the analysis markdown.
- Follow `_shared.md` anti-fabrication + the user's `reference.md` evidence. Real metrics only. No internal project names. **ATS-clean: no `< > [ ] { } " \`** (the harness types raw text — it does NOT run `lib/normalize.js`).
- Apply the Content Differentiation Rules (below): each field leads with different evidence.

Inject the answers (matched by label substring, re-scanned to survive re-render):
```bash
node -e 'require("fs").writeFileSync("signals/apply/{slug}/control.json", JSON.stringify({action:"answers", answers:[{label:"<question label substring>", text:"<answer>"}]}))'
```
Poll `state.json` for the updated `answeredIdx` (`ok:true`). Repeat if multiple questions.

## Step 3: The glance (always shown before submit)
Read `signals/apply/{slug}/preview.png` and present to the user:
```
=== APPLICATION GLANCE: {company} - {role} ===
Name / Email / Phone / Location / LinkedIn:  <values>
Resume uploaded: yes ({file})
Custom Q answers: <one-line each>
Could-not-fill: <unfilled[]>  (if any required, STOP and ask the user)
Screenshot: signals/apply/{slug}/preview.png
```
This is the glance checkpoint. If `unfilled[]` contains a REQUIRED field, or the screenshot shows a CAPTCHA / login wall, STOP and hand control to the user (re-run `--headful` so they can intervene). Otherwise proceed.

## Step 4: Submit
```bash
node -e 'require("fs").writeFileSync("signals/apply/{slug}/control.json", JSON.stringify({action:"submit"}))'
```
Poll `state.json` for `phase === "submitted"`. Read `postSubmitExcerpt` (the success/confirmation text) and `needsEmailConfirm`.

## Step 5: Email confirmation (only if needed)
If `needsEmailConfirm === true` (post-submit page says "confirm/verify your email", "check your inbox", "we sent…"):
1. Use the Gmail MCP tools to find the most recent confirmation mail from the company/ATS (search sender domain + "confirm"/"verify"/"application"). Needs a one-time Gmail MCP auth — prompt the user if not yet authed.
2. Extract the confirmation/verification link.
3. Inject it into the SAME stealth session:
   ```bash
   node -e 'require("fs").writeFileSync("signals/apply/{slug}/control.json", JSON.stringify({action:"confirm", link:"<url>"}))'
   ```
4. Poll for `phase === "confirmed"`.

If `needsEmailConfirm === false`, send `{action:"done"}` to close the browser cleanly.

## Step 6: Record (real submission = record it)
Using `lib/tracker-writer.js`:
1. `moveReportFolder(slug, 'applied')` → relocates `reports/{slug}/` to `reports/applied/{slug}/`, rewrites queue docx paths + tracker `reportDir`.
2. `updateTrackerStatus({slug, newStatus:'Applied'})` if the slug is in the tracker, else `appendTrackerRow({date, company, role, score, status:'Applied', reportDir, notes})`. Note "Camoufox auto-apply; submitted {date}; <on-page success | email-confirmed>".
3. `updateQueueEntry(slug, {applied:true, appliedDate:TODAY})` if it is in the queue.
4. Append a follow-up to `data/followups.md` (next follow-up = +7 days).
5. Report success with the confirmation screenshot path.

If the user skipped: `{action:"skip"}` to the harness + `updateQueueEntry(slug, {skipped:true, skipReason})` + `updateTrackerStatus('Skipped')` + `moveReportFolder(slug, 'skipped')`.

## Content Differentiation Rules
Each field carries GENUINELY different evidence — no cross-field repetition.
| Field | Lead With | Tone |
|---|---|---|
| Cover Letter | Strongest technical achievement + the WHY behind a design decision | Confident, analytical |
| "Why {company}?" | Specific things about THEIR mission/product/team | Genuine, forward-looking |
| Custom Questions | One narrow technical deep-dive not covered elsewhere | Precise, technical |
Before writing any field, check what the others already say.

## NEVER
- Never submit when a required field is unfilled or a CAPTCHA/login wall is on screen — hand to the user.
- Never invent free-text answers — the harness returns questions for the agent to write from real evidence.
- EEO / demographic questions: self-identification is OPT-IN and the user's own choice. By default the harness **declines** every demographic question. A user who wants to self-identify sets `eeoSelfIdentify: true` and fills `eeoValues` (with their OWN gender / race / veteran / disability / etc. answers) in `data/apply-profile.json`; the harness then matches those against each form's rendered options via `lib/apply/answers.js` `eeoValues` + `lib/apply/filler.js`. Any question with no value on file always declines.
- Never automate the user's logged-in LinkedIn session (account-safety rule, hard). Camoufox uses a fresh fingerprinted session, not the user's profile.
- Never enter passwords or create accounts on the user's behalf.
