# Interview Prep Mode

Prepare for interviews using the story bank + JD analysis.

## Input
`$ARGUMENTS` after "interview-prep": a company name, role slug, or report directory path.

## Process

1. **Find the evaluation**: the report folder for the slug holds the companion analysis and the resume JSON. It can sit in any lifecycle bucket (`${WORKSPACE}/reports/{bucket}/{slug}/`: `queue`, `manual`, `applied`, ...), so resolve it, never assume a flat path. From `${JOBE_HOME}`:
   ```bash
   node -e "console.log(require('./lib/tracker-writer').locateReportDir(require('./lib/config').getProjectRoot(), '{slug}'))"
   ```
   Given a company name instead of a slug, find the matching `slug` in `${WORKSPACE}/data/apply-queue.json` or the report path column of `${WORKSPACE}/data/tracker.md`.
2. **Load story bank**: Read `${WORKSPACE}/data/story-bank.md`
3. **Load JD requirements**: From the report's JSON or companion analysis

4. **Generate story mapping matrix**:

| JD Requirement | Best Story | Fit | Key Metric |
|---|---|---|---|
| Core requirement #1 | &lt;your strongest story in this area&gt; | Strong | &lt;its headline figure&gt; |
| Core requirement #2 | &lt;a story that shows this skill&gt; | Strong | &lt;a scale, volume, or reliability figure&gt; |
| Core requirement #3 | &lt;a story that shows this skill&gt; | Strong | &lt;a quantified outcome&gt; |
| Adjacent/secondary skill | &lt;closest related story&gt; | Partial | &lt;what you have vs. what is missing&gt; |
| Stated preference you lack | N/A | Gap | &lt;the strength you lead with instead&gt; |

5. **Generate likely interview questions** based on JD + company intel:
   - Role specific: the methods, tools, regulations, and situations of the role's own domain, taken from the JD
   - Behavioral: mapped to STAR+R stories
   - Case or scenario: whatever format this field uses to test judgment (a design exercise, a clinical scenario, a technical accounting case, a work sample), based on what the team actually does
   - Red flags: questions about career transitions, gaps, education, and any stated minimum the evaluation marked unmet

6. **For each story, tag "Best for questions about:"**
   Append new tags to `${WORKSPACE}/data/story-bank.md` if discovered during prep.

7. **Company-specific prep**:
   - Values vocabulary (from company intel)
   - Things to emphasize
   - Things to avoid saying
   - Interview process (rounds, format, duration from Glassdoor)

## Rules
- Stories and figures come only from `${WORKSPACE}/data/story-bank.md`, the report, and `${WORKSPACE}/reference.md`. Never invent a metric or an outcome (anti fabrication rules in `_shared.md`).
- Internal names on the user's do not render list (`output.forbiddenTerms`) may be spoken about in prep notes only as the user chooses; keep them out of anything meant to be sent.

## Output
Interview prep document saved into the report folder resolved in step 1 (wherever it currently sits; do not create a second folder).
