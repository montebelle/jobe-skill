# Patterns Mode

Analyze application history for conversion insights.

## Process

Read `data/tracker.md` and compute:

### 1. Conversion Funnel
Discovered -> Evaluated -> Applied -> Responded -> Interviewing -> Offer
Show count and conversion rate at each stage.

### 2. Performance by Archetype
If archetype is stored in tracker notes, show conversion rate per archetype.
Which archetypes lead to the most interviews?

### 3. Score Distribution
- Average score of Applied roles vs Skipped roles
- Score threshold where conversion drops off
- Data-driven recommendation: "Based on your history, apply to roles scoring X+ for best results"

### 4. Common Blockers
- Most frequent gap categories across evaluations
- Top reasons for Skipped/Rejected
- Location, seniority, or domain patterns in rejections

### 5. Time Analysis
- Average days in each status
- Fastest and slowest pipelines
- Which companies respond fastest

### 6. Recommendations
Based on all patterns:
- Suggested score threshold for future applications
- Archetypes to prioritize
- Gaps to address (study plan)
- Companies with best response rates

## Minimum Data
Requires at least 5 applications beyond "Evaluated" before analysis is meaningful.
If insufficient data, say so and recommend building the pipeline first.
