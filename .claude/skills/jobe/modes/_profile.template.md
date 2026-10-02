# Candidate Profile

> TEMPLATE, not yet filled in. `/jobe onboard` writes your real values and saves this file as `_profile.md` at the root of your workspace (`${WORKSPACE}/_profile.md`). Until then nothing here is assumed about you or your field. It never leaves your machine.
>
> This file is prose for the assistant. Code never reads it. Every preference that should FILTER job results also has to be in `${WORKSPACE}/data/profile.json` (template: `templates/profile.template.json`); each section below names its matching key. Keep the two files in agreement. A preference you leave out applies no filter.

---

## Identity

```
Name:     <your full name>
Email:    <you@example.com>
Phone:    <your phone number>
LinkedIn: <your LinkedIn URL, or leave out>
Website:  <portfolio, publications page, or code host profile, or leave out>
Location: <city and region, or "Remote">
```

## Current role

- Title and employer: <your current or most recent title> at <employer>
- Years of experience: <a number> (also `candidate.yearsExperience`; used to check a posting's years requirement)
- Degrees, licenses, certifications: <as written on your resume> (also `candidate.degrees`)
- Security clearance: <the clearance you hold, "none", or leave out if not relevant> (also `candidate.clearance`)

## Target roles

List 3 to 5 titles you want, in the words postings use. These become your discovery seeds (`data/queries/seeds.json`).

- <a role title you want>
- <another title>

A seniority word you include in a target title (senior, lead, junior, entry) is what makes postings at that level rank first. No level is preferred otherwise.

## Targeting rules

- The match score measures ONE thing: how well a role's stated requirements map to your real experience. Preferences never change the score; they are filters.
- Title levels or words to leave out of discovery: <for example "intern", "director", "travel", or none> (also `discovery.titleExclude`)
- Phrases that shield their own words from an exclusion, for example "travel coordinator" when "travel" is excluded: <or none> (also `discovery.titleKeep`)
- Companies to hide: listed in `data/companies/negative-list.json`
- Staffing agencies and brokers: <hide them (default) / show them, they are a normal channel in my field> (also `discovery.excludeStaffing`)
- Lowest score worth showing: <a number, or none> (also `discovery.minScore`)
- Check my contacts for a referral before a cold application: <yes / no (default)> (also `discovery.referralFirst`)

## Target locations

- Work modes I accept: <any of remote, hybrid, onsite; leave empty to accept all> (also `discovery.workModes`)
- Hybrid tolerance: <the largest share of time in an office I accept, for example "at most 25 percent", or none> (also `discovery.hybridMaxOfficeShare`; applied by the assistant when it reads each hybrid posting)
- Countries where I can work: <country codes or names; leave empty for no country filter> (also `discovery.countries`)
- Metros or regions for hybrid and onsite roles: <list, or none> (also `discovery.regions`, and the `location` of your discovery seeds)

## Target recency

- Only show postings from the last <N> days (also `discovery.maxAgeDays`; the shipped default is 30, and 0 means no limit)
- Extra days allowed for senior titles: <a number, default 0> (also `discovery.seniorityExtensionDays`)
- Postings with no detectable date are kept and labeled "date unknown".

## Target compensation

- Range I am aiming for: <base, total, currency> (a talking point for the assistant)
- Hard floor for discovery: <a yearly amount and currency, or none> (also `discovery.salaryFloor` and `discovery.salaryCurrency`; a posting is hidden only when its PUBLISHED yearly range in that same currency tops out below the floor, never for unknown pay or pay in another currency)

## Work eligibility

Answers to application form questions (work authorization, sponsorship, citizenship, residence, relocation, restrictive covenants, optional EEO self identification) live in `data/apply-profile.json`, never here. A blank answer there is never guessed.

## Emphasis buckets (optional)

If your target roles fall into clearly different kinds, you may define your own buckets in `data/archetypes.json` and note here which ones your evidence is deepest in. Jobe ships none and works without them. See `modes/_shared.md` Archetype Detection.

- <your bucket name, or delete this section>

## Rare combinations (resume spine)

List the combinations of skills in your background that are uncommon among people who apply to your target roles. Jobe uses this list to decide which bullets lead a tailored resume.

1. <your own, for example hands on depth in one area plus the system or process behind it>
2. <your own>

## Evidence sources

- Evidence file (every claim must trace to it): `reference.md` in your workspace (also `evidence.ledger`)
- Folders of my own work product on this machine, if any: <absolute paths, or none> (also `evidence.roots`; optional, most professions have none)
- Accounts on a code or document host that hold work not on this machine: <account names only, never tokens, or none> (also `evidence.githubAccounts`)
- Career narrative for cover letters (optional): `data/career-narrative.md` (also `evidence.narrative`)
- Story bank: `data/story-bank.md`. Tracker: `data/tracker.md`. Follow ups: `data/followups.md`.

## Attribution rules

Which employer or project each body of work belongs to, and what must never be listed under another. One line each. (Also `companyKeyMap` in `data/bullet-library.json` and `evidence.attribution` in `data/profile.json`.)

- (none yet)

## Role posture leads

Which of your evidence leads for each kind of role.

- People leader roles: (none yet)
- Senior specialist or technical lead roles: (none yet)
- Individual contributor roles: (none yet)

## Verified figures

The money and scale figures that may be used, each with its exact scope (what it measures, over what period, at whose level). A figure not listed here or in your evidence file is never used.

- (none yet)

## Known corrections

Claims that were wrong in an earlier draft and must not reappear, in any wording.

- (none yet)

## Standing rules

Your own durable instructions to the assistant, one per line. Every line is a hard constraint on every run and is copied into every helper agent's instructions. The assistant appends a line here whenever you state a lasting correction ("from now on", "always", "never").

- (none yet)

## What not to use in output

Names and topics that must never appear in a resume, cover letter, or application answer. Work is described by function instead. (The machine checked list is `output.forbiddenTerms` in `data/profile.json`; a rendered document that contains one of those terms is refused.)

- Internal project names from any current or former employer
- Client names tied to a method or a result
- Anything under NDA

## Output style

- Resume length target: <1 page / 2 pages / no target> (also `output.targetPages`)
- Remove plain hyphens from rendered documents: <no (default) / yes> (also `output.stripHyphens`)

---

This file is part of the user layer contract and is never modified by an update. Personalize freely.
