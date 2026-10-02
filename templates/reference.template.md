# Evidence Reference

This file is the single source of truth for every claim Jobe puts on a resume or in a cover letter. If it is not in this file, it does not go on the resume.

Group your entries however you think about your own work: by employer, by kind of work, or by the optional buckets you define in `data/archetypes.json`. The headings matter only for your own organization. Jobe assumes no field and ships no headings.

For every piece of work, document:

- **Project**: a short label you will recognize
- **Where the proof lives**: a document, a system, a repository, a published result, a review, or a person who can confirm it
- **Role held**: the employer and role this belongs to (it must match a role in your resume baseline), or "outside a job"
- **What you did**: 1 or 2 sentences that describe the work by function, with no internal names
- **Specifics**: methods, tools, scale, volumes, timelines, and the numbers that make it concrete
- **Outcome**: the result for the organization, the client, or the people served, quantified where you can
- **What could have gone wrong**: the risk you handled and the choice that prevented it
- **Limits**: anything you did not do or cannot claim (shared credit, estimates, figures you may not disclose)

These specifics are what Jobe turns into resume bullets (`data/bullet-library.json`) and cover letter reasoning. The more precise the entry, the more defensible the output.

---

## Your entries

Add one group heading per employer or kind of work, then one block per project in this shape:

**Project**:
- **Where the proof lives**:
- **Role held**:
- **What you did**:
- **Specifics**:
- **Outcome**:
- **What could have gone wrong**:
- **Limits**:

---

## Example entries (shape only, NOT your evidence, delete this section)

Two unrelated professions, so the pattern is clear. Nothing in this section may ever be cited on a resume or in a cover letter.

**Project**: EXAMPLE, discharge teaching redesign (a registered nurse)
- **Where the proof lives**: unit quality dashboard, two quarters; nurse manager can confirm
- **Role held**: Registered Nurse at Example Hospital
- **What you did**: Redesigned discharge teaching for cardiac patients into three short bedside sessions with a teach back check.
- **Specifics**: 28 bed unit, 22 nurses trained, sessions at admission, midpoint, and day of discharge
- **Outcome**: 30 day readmissions down 18 percent over two quarters; adopted by two sister units
- **What could have gone wrong**: added workload per shift; kept each session under ten minutes and folded it into existing rounds
- **Limits**: unit level figure, not a controlled study; the idea came from a team huddle

**Project**: EXAMPLE, state nexus review (a tax accountant)
- **Where the proof lives**: client workpapers and the signed engagement memo
- **Role held**: Senior Tax Accountant at Example Tax Group
- **What you did**: Reviewed where a manufacturing client owed state tax and restructured where inventory is held.
- **Specifics**: four states, three years of sales and payroll records, written positions for each state
- **Outcome**: 210,000 dollars lower state tax in the first year
- **What could have gone wrong**: an unsupported position on audit; documented each position with the governing rule before filing
- **Limits**: the client name is confidential; the saving is the first year only

---

## Anti fabrication rules

When Jobe drafts a resume or cover letter:

1. Every bullet must trace to a specific entry under "Your entries". If it does not, the bullet does not ship.
2. Describe work by function, never by an internal name: "discharge teaching program for cardiac patients", not the nickname your team used for it. List internal names in `output.forbiddenTerms` in `data/profile.json` so a render stops if one slips through.
3. Numbers come from you. Jobe never infers a figure, and never treats a missing record as proof that something did not happen.
4. If evidence is thin, say so in the entry. The scorer then reports a weak adjacency instead of an exact match, and the fit score stays honest.
5. An entry marked EXAMPLE is not evidence.
