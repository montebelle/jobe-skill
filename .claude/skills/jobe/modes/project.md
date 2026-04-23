# Project Evaluation Mode

Assess a portfolio project's strength as resume evidence.

## Input
`$ARGUMENTS` after "project": a repo path (e.g., `/path/to/any/repo`)

## Process

1. **Read the project**: Explore the directory structure, README, key source files
2. **Assess depth**: Lines of code, number of files, complexity indicators
3. **Classify fragility** (Talebian Lens 1):
   - ANTIFRAGILE: 3,000+ lines, production patterns, tests, deployment scripts
   - MODERATE: 500-3,000 lines, working code but no production evidence
   - FRAGILE: under 500 lines, notebook-only, tutorial-level

4. **Map to archetypes**: Which of the 6 archetypes does this project support?
5. **Identify best metrics**: What quantifiable outcomes can be claimed?
6. **Suggest resume bullets**: Draft 2-3 XYZ-formula bullets grounded in the code
7. **Rate interview defensibility** (1-5):
   - 5: Can answer any follow-up question with confidence
   - 4: Strong on most dimensions, minor gaps
   - 3: Good surface knowledge, some areas would be thin
   - 2: Basic familiarity, limited depth
   - 1: Listed on resume but can't defend

## Output

| Dimension | Score | Notes |
|---|---|---|
| Depth (lines, files) | X/5 | |
| Fragility | Antifragile/Moderate/Fragile | |
| Archetype fit | [list] | |
| Interview defensibility | X/5 | |
| Best metric | [quantified claim] | |

Verdict: **FEATURE** (lead with it) / **INCLUDE** (mention it) / **DEMOTE** (skills section only) / **OMIT** (don't list)

Suggested bullets for resume use.
