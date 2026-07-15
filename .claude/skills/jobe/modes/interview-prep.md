# Interview Prep Mode

Prepare for interviews using the story bank + JD analysis.

## Input
`$ARGUMENTS` after "interview-prep": a company name, role slug, or report directory path.

## Process

1. **Find the evaluation**: Look in `${WORKSPACE}/reports/{slug}/` for the companion analysis and JSON
2. **Load story bank**: Read `${WORKSPACE}/data/story-bank.md`
3. **Load JD requirements**: From the report's JSON or companion analysis

4. **Generate story mapping matrix**:

| JD Requirement | Best Story | Fit | Key Metric |
|---|---|---|---|
| Core requirement #1 | &lt;your strongest project in this area&gt; | Strong | &lt;the headline number, e.g. multi-region, sub-day refresh&gt; |
| Core requirement #2 | &lt;a project that shows this skill&gt; | Strong | &lt;scale or reliability metric, e.g. 20+ workflows, zero incidents&gt; |
| Core requirement #3 | &lt;a project that shows this skill&gt; | Strong | &lt;a quantified outcome, e.g. 30% cost reduction&gt; |
| Adjacent/secondary skill | &lt;closest related project&gt; | Partial | &lt;what you have vs. what is missing&gt; |
| Stated preference you lack | N/A | Gap | &lt;the strength you lead with instead&gt; |

5. **Generate likely interview questions** based on JD + company intel:
   - Technical: specific to the role's domain
   - Behavioral: mapped to STAR+R stories
   - System design: based on what the team builds
   - Red flags: questions about career transitions, gaps, education

6. **For each story, tag "Best for questions about:"**
   Append new tags to `${WORKSPACE}/data/story-bank.md` if discovered during prep.

7. **Company-specific prep**:
   - Values vocabulary (from company intel)
   - Things to emphasize
   - Things to avoid saying
   - Interview process (rounds, format, duration from Glassdoor)

## Output
Interview prep document saved to the report directory (`${WORKSPACE}/reports/{slug}/`).
