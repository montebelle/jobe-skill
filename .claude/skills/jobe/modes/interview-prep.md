# Interview Prep Mode

Prepare for interviews using the story bank + JD analysis.

## Input
`$ARGUMENTS` after "interview-prep": a company name, role slug, or report directory path.

## Process

1. **Find the evaluation**: Look in `reports/{slug}/` for the companion analysis and JSON
2. **Load story bank**: Read `data/story-bank.md`
3. **Load JD requirements**: From the report's JSON or companion analysis

4. **Generate story mapping matrix**:

| JD Requirement | Best Story | Fit | Key Metric |
|---|---|---|---|
| Production ML systems | 13-Model Forecasting | Strong | 700+ paths, 24h turnaround |
| LLM/agent experience | Output Gate | Strong | 28 pipelines, zero incidents |
| Causal inference | GeoLift 5-Gate | Strong | MDE 7.5%, 80% power |
| Kubernetes | GCP Workbench | Partial | BigQuery/Cloud Functions, not K8s depth |
| PhD preferred | N/A | Gap | Lead with Applied Math + statistical sophistication |

5. **Generate likely interview questions** based on JD + company intel:
   - Technical: specific to the role's domain
   - Behavioral: mapped to STAR+R stories
   - System design: based on what the team builds
   - Red flags: questions about career transitions, gaps, education

6. **For each story, tag "Best for questions about:"**
   Append new tags to story-bank.md if discovered during prep.

7. **Company-specific prep**:
   - Values vocabulary (from company intel)
   - Things to emphasize
   - Things to avoid saying
   - Interview process (rounds, format, duration from Glassdoor)

## Output
Interview prep document saved to the report directory.
