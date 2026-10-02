# Project Evaluation Mode

Assess how strong a piece of the user's own work is as resume evidence.

## Input
`$ARGUMENTS` after "project": a path to the work (for example `/path/to/any/project`). It can be a code repository, a folder of work samples, a report, a case file, a portfolio document, or a ledger entry in `${WORKSPACE}/reference.md`.

## Process

1. **Read the work**: explore the folder structure, any overview document, and the key files. Read the source itself, not only a summary of it.
2. **Assess depth**: size and complexity in the terms of its own field (for code: files, modules, tests, deployment; for other work: scope, duration, people or sites covered, volume handled, review or sign off it passed).
3. **Classify how well it holds up under questioning** (internal label only, never printed in a resume):
   - ANTIFRAGILE: substantial, in real use or delivered, and verified (tests, an audit, a sign off, measured outcomes)
   - MODERATE: real and working or complete, but with no evidence of real use or verification
   - FRAGILE: small, exercise level, or a draft; follows a tutorial or a template
4. **Map to emphasis buckets**: if the user defined archetypes (`${WORKSPACE}/data/archetypes.json`; none ship), say which of THEIR buckets this work supports. With none defined, skip this step.
5. **Identify the best metrics**: what quantified outcomes can honestly be claimed? Only figures found in the work itself or in the ledger. Never invent a number; if there is none, say so and ask the user.
6. **Attribution**: say where it belongs. Work done for an employer goes under that employer's entry (its role key in `data/bullet-library.json`); a personal or side effort goes in `selectedProjects`, never under an employer. If unsure, ask.
7. **Suggest resume bullets**: draft 2 or 3 bullets grounded in the source, result first, each stating the mechanism or method and not only scale. Describe internal work by function: no term from the user's do not render list (`output.forbiddenTerms`), no ATS illegal characters (`< > [ ] { } " \`).
8. **Rate interview defensibility** (1 to 5):
   - 5: Can answer any follow up question with confidence
   - 4: Strong on most dimensions, minor gaps
   - 3: Good surface knowledge, some areas would be thin
   - 2: Basic familiarity, limited depth
   - 1: Listed on the resume but cannot be defended

## Output

| Dimension | Score | Notes |
|---|---|---|
| Depth | X/5 | |
| Holds up under questioning | Antifragile/Moderate/Fragile | |
| Emphasis bucket fit | [list, or n/a] | |
| Interview defensibility | X/5 | |
| Best metric | [quantified claim and where it comes from] | |
| Belongs to | [role key, or selectedProjects] | |

Verdict: **FEATURE** (lead with it) / **INCLUDE** (mention it) / **DEMOTE** (skills section only) / **OMIT** (do not list)

Suggested bullets for resume use. Offer to add them to `${WORKSPACE}/data/bullet-library.json` under the role key or `selectedProjects` named above, each with `keywords[]` (and `archetypes[]` only if the user has buckets).
