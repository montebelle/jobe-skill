# Apply-Assisted Mode (fallback)

**Fallback path.** The default apply mechanism is now Camoufox stealth auto-apply (see `apply.md` / `apply-all.md`). Use this mode only when the browser harness should not touch a form — e.g. it sits behind a login the user must complete themselves, or the user explicitly passes `--paste`. It prepares everything for the user to paste into their own already-logged-in browser.

## Input
`/jobe apply-assisted` - processes the entire apply queue (paste-ready)
`/jobe apply-assisted [slug]` - processes one role
`/jobe apply-assisted --top 5` - top N by score
(Reached automatically when `/jobe apply` or `/jobe apply-all` is invoked with `--paste`.)

## For Each Role in the Queue

### Step 1: Open the URL
Run `open "{url}"` to open the posting in your default browser (your normal Chrome with cookies, logins, established trust).

### Step 2: Print Paste-Ready Application Block

```
================================================================
APPLICATION: {company} - {role}
Score: {score} | Archetype: {archetype}
URL: {url}
Resume: {absolute path to .docx}
Cover Letter: {absolute path to cover-letter .docx}
================================================================

CONTACT INFO (copy each field — values from ${WORKSPACE}/_profile.md):
  Name:     {candidate.name}
  Email:    {candidate.email}
  Phone:    {candidate.phone}
  LinkedIn: {candidate.linkedin}
  Location: {candidate.location}

RESUME FILE TO UPLOAD:
  {full absolute path}/resume-{date}-{slug}.docx

COVER LETTER (if text field, paste this):
  {cover letter text - full 3 paragraphs}

COMMON QUESTIONS - PRE-WRITTEN ANSWERS:

Q: Why do you want to work at {company}?
A: {tailored answer from evaluation analysis, 150 words}

Q: Describe your most relevant experience for this role.
A: {tailored answer pulling from top STAR story match, 200 words}

Q: What is your expected salary/compensation?
A: {from Block D comp research, or "Open to discussing based on total compensation package"}

Q: Are you authorized to work in the US?
A: Yes

Q: Do you require visa sponsorship?
A: No

Q: How did you hear about this position?
A: Company careers page

Q: Are you willing to relocate?
A: {based on location from JD vs ${WORKSPACE}/_profile.md}

================================================================
```

### Step 3: Wait for Confirmation

Ask: "Have you submitted {company} - {role}? (yes/skip/stop)"

- **yes**: Mark applied via `lib/tracker-writer.js` (it self-resolves the active workspace; do not directly edit `${WORKSPACE}/data/tracker.md` or `${WORKSPACE}/data/apply-queue.json`), add follow-up entry, move to next
- **skip**: Mark skipped via `lib/tracker-writer.js` `moveReportFolder(slug, 'skipped')`, move to next
- **stop**: Pause queue

### Step 4: Next Role

Open the next URL, print the next paste block. Repeat.

## Generating Free-Text Answers

For each role, read:
- The evaluation JSON (`${WORKSPACE}/reports/{slug}/resume-*.json`) for summary, experience bullets, skills
- The analysis markdown (`${WORKSPACE}/reports/{slug}/analysis-*.md`) for match scores, gaps, talking points
- The cover letter text for the achievement-first framing

Use these to write concise, specific answers to common application questions. Every answer must:
- Reference specific projects and metrics from the resume
- Use JD keywords
- Be 100-200 words (not walls of text)
- No internal project names
- No generic filler

## Content Differentiation Rules

Each field in the application must contain GENUINELY DIFFERENT evidence and framing. Never repeat the same achievement or argument across fields.

| Field | Purpose | Lead With | Tone |
|---|---|---|---|
| Cover Letter | Achievement-first narrative with reasoning depth | Strongest technical achievement + WHY behind design decisions | Confident, analytical, shows how you think |
| "Why [Company]?" | Motivation-first, what draws you to THIS team/problem | Specific things about their mission/product/team | Genuine, specific, forward-looking |
| Custom Questions | Go narrow on one specific technical topic | A single deep-dive into a relevant problem you solved | Technical depth, precision |

Rules:
- If the cover letter discusses the safety enforcement layer, "Why X?" must NOT also discuss it. Use a different project or angle.
- "Why X?" should reference specific company details (recent product, team blog, open-source project, mission) -- not rehash the resume.
- Custom question answers go deeper on ONE narrow topic not covered elsewhere.
- Before generating any field, check what was already written for other fields. No cross-field repetition.
