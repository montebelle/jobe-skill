# Deep Research Mode

Comprehensive company research for interview preparation.

## Input
`$ARGUMENTS` after "deep": company name (and, when known, the role or the function the role sits in).

## 6-Axis Research

Research each axis from the point of view of the function the user's target role sits in (nursing, finance, engineering, operations, sales, whatever it is). Take the function from the role given in `$ARGUMENTS`, or from the target roles in the user's `_profile.md`. Assume no field.

### Axis 1: Product, Services, and Operations
- What they do (core product, service lines, platform, sites or facilities)
- How the target function shows up in that work, and what it is accountable for
- Tools, systems, and methods in use (company blog, job postings, public documentation, public repositories or filings where they exist)
- Published work, standards, accreditations, or certifications the organization holds
- Recent launches, expansions, or pivots

### Axis 2: Business and Market
- Revenue or funding model and scale
- Competitive landscape
- Market position and differentiation
- Recent funding, valuation, ownership change, or public listing trajectory
- Growth rate signals

### Axis 3: People and Culture
- Working culture of the target function (from the company's own posts, talks, employee reviews)
- Leadership team and recent changes
- Team structure (size and makeup of the target function, who it reports to)
- Remote, hybrid, or onsite policy
- Work life balance signals (hours, shifts, on call, travel, busy seasons)
- Diversity and inclusion indicators

### Axis 4: Growth and Trajectory
- Hiring velocity (how many open roles, which teams)
- Headcount trends (growing, flat, or contracting)
- Geographic expansion
- Signals that a new team is forming

### Axis 5: Risk and Red Flags
- Recent layoffs or restructuring
- Leadership turnover
- Negative trends in employee reviews
- Litigation or regulatory issues
- Acquisition risk (being acquired and the team dissolved)

### Axis 6: Interview Intelligence
- Interview process (rounds, format, duration)
- Question types from public interview reports
- What they value (from JD language and interview reports)
- Vocabulary to use (their terminology, not generic)
- Things to avoid saying

## Process
Launch the **jobe-company-intel** agent with expanded scope. A subagent inherits nothing, so put in its prompt: the company name, the role title, the function the role sits in, the industry if known, the absolute output path (substitute the real `${WORKSPACE}` value), and the Standing rules section of the user's `_profile.md`. Supplement with targeted WebSearch queries per axis.

If `${WORKSPACE}/signals/company-intel/{company-slug}/company-intel-{date}.json` exists and is under 14 days old, read it first and research only what it lacks.

Every claim names its source. Anything that cannot be sourced is marked `[unverified]`, never stated as fact.

## Output
Structured company intelligence report saved to `${WORKSPACE}/signals/company-intel/{company-slug}/deep-research-{date}.md`. It lives under `signals/`, not `reports/`, because `reports/` holds one folder per job inside lifecycle buckets and a company level folder there would be mistaken for a job.
