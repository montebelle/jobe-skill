# Deep Research Mode

Comprehensive company research for interview preparation.

## Input
`$ARGUMENTS` after "deep": company name.

## 6-Axis Research

### Axis 1: Product and Technology
- What they build (core product, platform, APIs)
- Tech stack evidence (engineering blog, GitHub org, job postings)
- Open source contributions
- ML/AI use cases in production
- Recent product launches or pivots

### Axis 2: Business and Market
- Revenue model and scale
- Competitive landscape
- Market position and differentiation
- Recent funding, valuation, or IPO trajectory
- Growth rate signals

### Axis 3: People and Culture
- Engineering culture (from blog posts, talks, Glassdoor)
- Leadership team and recent changes
- Team structure (how many engineers, DS, ML)
- Remote/hybrid/onsite policy
- Work-life balance signals
- Diversity and inclusion indicators

### Axis 4: Growth and Trajectory
- Hiring velocity (how many open roles, which teams)
- Headcount trends (growing vs flat vs contracting)
- Geographic expansion
- New team formation signals

### Axis 5: Risk and Red Flags
- Recent layoffs or restructuring
- Leadership turnover
- Glassdoor negative trends
- Litigation or regulatory issues
- Acqui-hire risk (being acquired and team dissolved)

### Axis 6: Interview Intelligence
- Interview process (rounds, format, duration)
- Question types from Glassdoor/Blind
- What they value (from JD language and interview reports)
- Vocabulary to use (their terminology, not generic)
- Things to avoid saying

## Process
Launch **jobe-company-intel** agent with expanded scope. Supplement with targeted WebSearch queries per axis.

## Output
Structured company intelligence report saved to `${WORKSPACE}/reports/{company-slug}/deep-research-{date}.md`.
