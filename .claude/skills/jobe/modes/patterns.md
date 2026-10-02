# Patterns Mode

Analyze application history for conversion insights.

## Process

Read `${WORKSPACE}/data/tracker.md` and compute the sections below. `node lib/patterns.js` (from `${JOBE_HOME}`) prints the funnel, the score distribution, and the archetype counts as JSON; use it as the base and add the rest by reading the tracker.

### 1. Conversion Funnel
Discovered -> Evaluated -> Applied -> Responded -> Interviewing -> Offer
Show count and conversion rate at each stage.

### 2. Performance by Archetype (only if you defined emphasis buckets)
Archetypes are optional and user defined (`${WORKSPACE}/data/archetypes.json`; none ship). The analysis counts YOUR bucket names where they appear in tracker notes (the full name, or the part before a slash). With no buckets defined this table is empty: skip the section and say why.
Which buckets lead to the most interviews?

### 3. Score Distribution
- Average score of Applied roles vs Skipped roles
- Score threshold where conversion drops off
- Data-driven recommendation: "Based on your history, apply to roles scoring X+ for best results"

### 4. Common Blockers
- Most frequent gap categories across evaluations
- Top reasons for Skipped/Rejected
- Location, seniority, or domain patterns in rejections (use `rejectionSegment`, shaped `domain|level|companytype`, when queue entries carry it)

### 5. Time Analysis
- Average days in each status
- Fastest and slowest pipelines
- Which companies respond fastest

### 6. Recommendations
Based on all patterns:
- Suggested score threshold for future applications. A threshold is a FILTER the user may set (`discovery.minScore` in `${WORKSPACE}/data/profile.json`); it never changes how a posting is scored
- Emphasis buckets to prioritize (if any are defined)
- Gaps to address (study plan)
- Companies with best response rates

## Minimum Data
Requires at least 5 applications beyond "Evaluated" before analysis is meaningful.
If insufficient data, say so and recommend building the pipeline first.
