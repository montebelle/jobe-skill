# Apply-Assisted Mode (fallback)

**Fallback path.** The default apply mechanism is Camoufox stealth auto apply (see `apply.md` and `apply-all.md`). Use this mode only when the browser harness should not touch a form, for example it sits behind a login the user must complete themselves, or the user passes `--paste`. It prepares everything for the user to paste into their own browser, where they are already logged in.

## Input
`/jobe apply-assisted`: processes the entire apply queue (paste ready)
`/jobe apply-assisted [slug]`: processes one role
`/jobe apply-assisted --top 5`: top N by score
(Reached automatically when `/jobe apply` or `/jobe apply-all` is invoked with `--paste`.)

## For Each Role in the Queue

### Step 1: Load the answers on file
The paste block uses the SAME answer map the harness would type, so both paths say the same thing. From `${JOBE_HOME}`:
```bash
node -e "console.log(JSON.stringify(require('./lib/apply/answers').buildAnswers('{slug}'), null, 2))"
```
It resolves the report folder in any lifecycle bucket (`reports/queue/{slug}/` for a new evaluation, `reports/manual/{slug}/` for a parked one, and so on) and returns:
- identity from the report's resume JSON (name, email, phone, location, links, current role, school), with `${WORKSPACE}/data/apply-profile.json` as the fallback;
- the eligibility answers from the apply profile (`workAuthorized`, `requireSponsorship`, `citizen`, `citizenOrPermanentResident`, `domiciled`, `federalEligible`, `clearance`, `relocation`, `nonCompete`), each `Yes`, `No`, or blank;
- `salaryExpectation`, already resolved (the band stored with the report through the user's `salaryStrategy`, used only when it is a yearly band in the user's currency, else the stored figure);
- `howHeard`, `coverLetterText`, `whyCompany`, the EEO opt in and values, and the absolute paths `resumeDocx` and `coverLetterDocx`.

A blank value is printed as `ASK: not on file`. Never print a guessed Yes or No.

### Step 2: Open the URL
Run `open "{url}"` (or the platform's equivalent) to open the posting in the user's default browser (their normal browser with its cookies, logins, and established trust).

### Step 3: Print the Paste Ready Application Block

```
================================================================
APPLICATION: {company} - {role}
Score: {score} | Archetype: {archetype, omit when General}
URL: {url}
Resume: {resumeDocx}
Cover Letter: {coverLetterDocx}
================================================================

CONTACT INFO (copy each field):
  Name:     {fullName}
  Email:    {email}
  Phone:    {phone}
  LinkedIn: {linkedin}
  GitHub:   {github}        (print this line only when a value is on file)
  Website:  {website}       (print this line only when a value is on file)
  Location: {location}

RESUME FILE TO UPLOAD:
  {resumeDocx}

COVER LETTER (if there is a text field, paste this):
  {coverLetterText}

COMMON QUESTIONS - ANSWERS READY TO PASTE:

Q: Why do you want to work at {company}?
A: {whyCompany, or a tailored answer from the evaluation analysis, 150 words}

Q: Describe your most relevant experience for this role.
A: {tailored answer built from the best STAR story match, 200 words}

Q: What is your expected salary/compensation?
A: {salaryExpectation; if the posting publishes a yearly pay band in the user's currency, the figure the user's salaryStrategy picks from it (midpoint by default, or top, or bottom); with neither, "Open to discussing based on the total compensation package"}

Q: Are you legally authorized to work in {country of the role}?
A: {workAuthorized | ASK: not on file}

Q: Do you now or will you in the future require visa sponsorship?
A: {requireSponsorship | ASK: not on file}

Q: Are you a citizen of {country}?
A: {citizen | ASK: not on file}

Q: Are you a citizen or permanent resident?
A: {citizenOrPermanentResident | ASK: not on file}

Q: Are you subject to a non-competition agreement?
A: {nonCompete | ASK: not on file}

Q: Are you willing to relocate?
A: {relocation | ASK: not on file}

Q: How did you hear about this position?
A: {howHeard}

(Print the domicile, federal eligibility, and security clearance answers the
same way, from domiciled, federalEligible, and clearance, only when the form
asks them.)

EEO / DEMOGRAPHIC QUESTIONS:
  {eeoSelfIdentify is false: "Decline to self identify" for every question}
  {eeoSelfIdentify is true: one line per key in eeoValues, in the user's own
   wording; any question with no value on file: "Decline to self identify"}

================================================================
```

Rules for the block:
- Eligibility answers come ONLY from the apply profile. If the user answers an `ASK` item now, offer to save it to `${WORKSPACE}/data/apply-profile.json`.
- **Non compete warning.** When `nonCompete` is `Yes`, say so above the block: the answer only fills the form question. Whether this employer is a restricted competitor is the user's decision.
- EEO: self identification is opt in. Never print demographic values the user did not put on file, and never suggest one.
- The cover letter text follows the Cover Letter Rules in `_shared.md` (the form depends on whether the user has a career narrative).

### Step 4: Wait for Confirmation

Ask: "Have you submitted {company} - {role}? (yes/skip/stop)"

- **yes**: Record it exactly as `apply.md` Step 6 does, through `lib/tracker-writer.js` (it resolves the active workspace by itself; do not edit `${WORKSPACE}/data/tracker.md` or `${WORKSPACE}/data/apply-queue.json` by hand): `moveReportFolder(slug, 'applied')`, tracker status `Applied`, queue `applied:true`, a follow up entry. Then move to the next.
- **skip**: `updateQueueEntry(slug, {skipped:true, skipReason})`, tracker status `Skipped`, `moveReportFolder(slug, 'skipped')`. Then move to the next.
- **stop**: Pause the queue.

### Step 5: Next Role

Open the next URL, print the next paste block. Repeat.

## Generating Free Text Answers

For each role, read from the report folder (the `reportDir` of the queue entry, or the folder Step 1 resolved):
- The evaluation JSON (`resume-*.json`) for summary, experience bullets, skills
- The analysis markdown (`analysis-*.md`) for match scores, gaps, talking points
- The cover letter text, so the other fields do not repeat it

Use these to write concise, specific answers to common application questions. Every answer must:
- Reference specific work and real figures from the resume
- Use the JD's own keywords
- Be 100 to 200 words (not walls of text)
- Contain no term from the user's do not render list (`output.forbiddenTerms`) and no internal project names
- Contain no generic filler
- Be ATS clean: none of `< > [ ] { } " \`

## Content Differentiation Rules

Each field in the application must contain GENUINELY DIFFERENT evidence and framing. Never repeat the same achievement or argument across fields.

| Field | Purpose | Lead With | Tone |
|---|---|---|---|
| Cover Letter | Per the Cover Letter Rules in `_shared.md` | What those rules call for | Confident, shows how you think |
| "Why [Company]?" | Motivation first: what draws you to THIS team or problem | Specific things about their mission, product, service, or team | Genuine, specific, forward looking |
| Custom Questions | Go narrow on one specific topic | A single deep dive into a relevant problem you solved | Depth, precision |

Rules:
- If the cover letter discusses one piece of work, "Why X?" must NOT also discuss it. Use a different piece of work or a different angle.
- "Why X?" should reference specific company details (a recent launch, a public statement of mission, a program, a team publication), not rehash the resume.
- Custom question answers go deeper on ONE narrow topic not covered elsewhere.
- Before generating any field, check what was already written for other fields. No repetition across fields.
