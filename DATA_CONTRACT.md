# Data Contract

Defines the boundary between user data and system data, and what every file is for.

## Two layers

Jobe separates a shared **system layer** (code, configs, shared seed files, templates: installed once at the install root) from a **user layer** (everything personal). Each person on a machine gets an isolated workspace at `users/<slug>/`, so two people in unrelated fields never see each other's profile, evidence, queue, or reports. With no workspace configured the workspace is the install root itself (single user mode).

Path resolution lives in `lib/config.js`:

| Function | Returns |
|---|---|
| `getSystemRoot()` | The install root: the cloned repo, or `~/.jobe` for a global install. |
| `getUserRoot()`, `getProjectRoot()` | The active workspace. Resolution order: env `JOBE_USER_ROOT` (absolute path), then env `JOBE_USER` (a workspace name), then the `users/.active` pointer file, then the install root. |

Rules every reader follows:

* Personal data resolves through `getUserRoot()`. Shared seeds and configs resolve through `getSystemRoot()`. Code resolves from its own folder. Nothing reads the process working directory for data.
* A shared file that a person may extend follows one pattern: the workspace copy is read first, the shared copy second, and a missing file means the permissive default.
* A missing or malformed user file is never an error. The reader returns the empty value and continues.

Manage workspaces with `node scripts/user.js <list | current [--path] | new <name> | use <name> | migrate <name>>` or the skill commands `/jobe onboard <name>`, `/jobe use <name>`, `/jobe users`. Workspaces are ignored by git (`/users/`).

* `new <name>` creates the eight report stage folders and copies every template to its place (the table is `TEMPLATE_DESTS` in `scripts/user.js`). It never overwrites a file. A scaffolded file that still equals its template counts as not filled in.
* `current --path` prints `getUserRoot()`, so the router and the Node code always agree on the workspace.
* `migrate <name>` moves an existing single user install's `data/`, `reports/`, `signals/`, `_archive/`, `_profile.md`, `reference.md`, and `.env` into a named workspace. It also pulls personal files out of older shared locations (a profile or evidence file in the skill folder, `configs/archetypes.json`, `configs/apply-profile.json`), puts the shared staffing list back at the install root, and copies `.env` back so machine level keys stay shared.

Process switches (environment, not `.env` keys):

| Variable | Effect |
|---|---|
| `JOBE_USER` | Workspace name for this process. Beats `users/.active`. |
| `JOBE_USER_ROOT` | Absolute path used as the workspace root. Beats `JOBE_USER`. Used by the test suite and by smoke runs so they never touch real data. A relative value is an error. |
| `JOBE_CONFIG` | Path of a config file to load in place of `configs/default.json`. |
| `JOBE_STRICT_AUDIT=1` | Makes the renderers block on audit failures (same as `--strict`). |
| `JOBE_EVIDENCE_ROOTS` | Extra evidence folders for `scripts/evidence-index.js`, as a path list. |
| `LINKEDIN_SWEEP_MAX_QUERIES`, `RESOLVE_LIMIT` | Depth of `scripts/linkedin-guest-sweep.js` (default 20 seed roles) and `scripts/resolve-index-backlog.js` (default 700 entries). |
| `JOBE_INSTALL_SKIP_DEPS=1` | Makes `install-local.sh` copy files only (no `npm install`, no browser download). |

These are read from the shell environment only. The scripts that read them do not load `.env`; only `collectors/pipeline.js`, `collectors/enrich-run.js`, and `collectors/ingest-manual.js` do.

Several modules capture the workspace root when they load, so set these before starting Node and never switch inside one process.

## User layer (never modified by install or update)

All paths are relative to the active workspace. `/jobe onboard` and `node scripts/user.js new <name>` create a file from its template only when the file does not exist yet. In single user mode these paths sit inside the clone, where `.gitignore` keeps them out of version control.

### Who you are

| File | Purpose | Template |
|---|---|---|
| `_profile.md` | Prose profile the skill router loads on every command: identity, contact, target roles, preferences, and the optional sections Standing rules, Attribution rules, Role posture leads, Verified figures, Known corrections, What not to use in output. Read by the model only, never by code. A legacy single user install may keep it at `.claude/skills/jobe/modes/_profile.md`; the router still falls back to that. | `.claude/skills/jobe/modes/_profile.template.md` |
| `data/profile.json` | Structured per user policy: candidate facts, discovery filters, title rules, salary floor, skill overrides, evidence pointers, output rules. Read only through `lib/profile.js`. Every key is optional and an absent key means the permissive default. See "The profile file" below. | `templates/profile.template.json` |
| `reference.md` | Evidence file. Every resume claim must trace to an entry here. `evidence.ledger` in the profile can point at another path. | `templates/reference.template.md` |
| `data/resume-baseline.json` | The canonical resume structure: name, contact, summary, experience entries, education, skills, optional `defaultBulletCounts`. Its `skills` and `education[].degree` also feed scoring, and the resume audit compares a tailored resume against it. | `templates/resume-baseline.template.json` |
| `data/bullet-library.json` | Per role bullet pool keyed through `companyKeyMap`. Each bullet has `id`, `keywords[]`, `text`, optional `archetypes[]`, optional `studyGroup` (bullets that share one describe the same work; one is selected per resume). `selectedProjects` entries also take `name`. Read by `lib/bullet-select.js`, `lib/rank.js buildProfile` (keywords become your proven skills), and `lib/tailor.js rankEvidence`. | `templates/bullet-library.template.json` |
| `data/career-narrative.md` | Optional career story. When present with real content, cover letters take the chronological career arc form; when absent they take the three paragraph form. | `templates/career-narrative.template.md` |
| `data/story-bank.md` | STAR+R interview stories. | none |
| `data/contacts.json` | Referral network for `/jobe contacto` and the referral check (`lib/network.js`). | none |

### What you want

| File | Purpose | Template |
|---|---|---|
| `data/queries/seeds.json` | Your target roles and locations (`queries[]` of `{ query, location }`). Every source builds its searches from these, and the title gate is derived from them. Not shipped: with no seeds, discovery is permissive and thin. | `templates/seeds.template.json` (empty) |
| `data/companies/negative-list.json` | Employers you do not want to see (`companySlugs[]`). | `templates/negative-list.template.json` (empty) |
| `data/companies/staffing-list.json` | Optional additions to the shared staffing list, for a named workspace. In single user mode this path IS the shared file, which every install replaces, so put your own brokers in the negative list there. | none (same shape as the shared file) |
| `data/companies/portals.json` | Your own ATS tenants per platform, combined with the shared `configs/portals.json`. Read by the per company crawlers through `collectors/seed-files.js` and `lib/ats-tenants.js`. | `templates/portals.template.json` (empty) |
| `data/companies/non-tech-seed.json` | Your target employers on Workday, SmartRecruiters, and iCIMS. Read by those three sources through `collectors/seed-files.js`. No shared copy ships, and the path is ignored by git like every other personal file. | `templates/non-tech-seed.template.json` |
| `data/archetypes.json` | Optional emphasis buckets you define: `{ "Bucket": { "keywords": [], "portfolioDomains": [] } }`. Lookup order: this file, then workspace `configs/archetypes.json` (older location), then system `configs/archetypes.json`. None ship; with none, every posting classifies as `General`. | `templates/archetypes.template.json` (defines no bucket) |
| `data/apply-profile.json` | Optional answers a resume does not carry, read by `lib/apply/answers.js`. Eligibility gates (`workAuthorized`, `requireSponsorship`, `citizen`, `citizenOrPermanentResident`, `domiciled`, `federalEligible`, `clearance`, `relocation`, `nonCompete`), each "Yes", "No", or blank; `salaryStrategy` (`midpoint` default, `top`, `bottom`) and `salaryExpectation` (the band read off the live posting is used only when it is a yearly salary in `discovery.salaryCurrency`, a bare `$` being read as USD; an hourly, weekly, or monthly rate, a stipend or bonus, or another currency leaves `salaryExpectation` in place; only currencies written with a dollar sign are read (USD, CAD, AUD, NZD, SGD, HKD, MXN), so with any other `salaryCurrency` the stored `salaryExpectation` is always used); `howHeard`; identity fallbacks (`state`, `stateName`, `postalCode`, `country`, links, `degreeLevel`, and, by hand when a report lacks them, `fullName`, `email`, `phone`, `location`, `currentCompany`, `currentTitle`, `school`, `degree`, `gradYear`); optional browser `locale` (a blank `state` is read off a "City, ST" location only when `country` is the United States or the location ends with it; anywhere else, and for a US user who leaves `country` blank, write `state` and `stateName` or the field is left for the glance); opt in EEO (`eeoSelfIdentify`, `eeoValues`, each value a string or a list of wordings). A blank value is never guessed: the question is surfaced for you at the glance. EEO declines by default. | `templates/apply-profile.template.json` (every answer blank) |
| `data/apply-wrappers.json` | Optional map `{ "<careers host>": "<greenhouse board token>" }` for a careers site whose Greenhouse board token differs from its domain label. Read by `lib/apply/url-normalize.js`; wins over the shared map. | none (created by hand when needed) |
| `.env` | API keys and opt in flags. Load order: workspace `.env`, then install root `.env`, then `~/.jobe/.env`. The first value found wins per key, and a variable already in the environment always wins. | `.env.example` |

### What Jobe records for you

| File | Purpose |
|---|---|
| `data/tracker.md` | Application pipeline table. Written only through `lib/tracker-writer.js`. |
| `data/apply-queue.json` | Ordered apply queue with applied and skipped status. Also the history the pipeline reads so a job you already handled never comes back. |
| `data/apply-queue.json.bak` | The queue as it was before `scripts/prune-queue.js` last removed rows. Safe to delete. |
| `data/followups.md` | Follow up cadence tracking. |
| `data/calibration.jsonl` | Judge labels and human adjudications for `/jobe calibrate` (kinds `cover-letter-quality`, `fit-score`, `ghost-score`). Empty until a run records a judgment. |
| `data/companies/index.json` | Emergent company index. Grows on every discovery run; entries are tagged with one of eleven ATS names (greenhouse, lever, ashby, workday, smartrecruiters, icims, workable, recruitee, breezy, bamboohr, personio) or `other`, and keyed by the tenant slug when the address names one. Never shipped. |
| `data/evidence-index.json` | Generated by `scripts/evidence-index.js build` from your own work folders. Holds absolute paths. Optional. |
| `data/evidence-anchors.json`, `data/evidence-depth.json` | Optional inputs of the evidence coverage and depth gates. Each gate exits 0 when its file is absent or empty, and exits 2 when the file (or the bullet library) exists but is not valid JSON. Templates: `templates/evidence-anchors.template.json`, `templates/evidence-depth.template.json` (both empty). |
| `data/.evidence-corpus/` | Optional folder for copies of work that lives only on a remote. |
| `data/evidence/` | Optional. Per project evidence markdown and bullet fragment JSON written by `scripts/wf-evidence-extract.js` and `scripts/wf-bullets-from-evidence.js` during onboarding. Intermediate: merged into `reference.md` and `data/bullet-library.json`. Holds a deep read of your own work. |
| `reports/` | Per posting output. See "Reports directory lifecycle". |
| `signals/` | Per run output and caches. See "Signals and cache". |

## The profile file (`data/profile.json`)

The one machine readable policy file. `lib/profile.js` is its only reader. Shape, with the permissive defaults:

```json
{
  "version": 1,
  "candidate": { "yearsExperience": null, "degrees": [], "clearance": null },
  "discovery": {
    "workModes": [],
    "hybridMaxOfficeShare": null,
    "countries": [],
    "regions": [],
    "maxAgeDays": 30,
    "seniorityExtensionDays": 0,
    "titleExclude": [],
    "titleKeep": [],
    "salaryFloor": null,
    "salaryCurrency": "USD",
    "excludeStaffing": true,
    "companySites": [],
    "minScore": null,
    "referralFirst": false
  },
  "skills": { "levels": {}, "gaps": [] },
  "evidence": {
    "ledger": "reference.md",
    "narrative": "data/career-narrative.md",
    "roots": [],
    "githubAccounts": [],
    "tools": [],
    "attribution": []
  },
  "output": { "forbiddenTerms": [], "targetPages": null, "stripHyphens": false, "asciiOnly": false, "pageSize": null, "dateLocale": null }
}
```

| Key | Read by | Meaning when set |
|---|---|---|
| `candidate.yearsExperience` | `lib/rank.js` | The largest years requirement in a job description is compared against it. `null` skips the check. |
| `candidate.degrees[]` | `lib/rank.js` | Degrees as written on your resume. The level (associate, bachelor, master, doctorate) is read from common words and abbreviations. An unrecognized credential skips the degree checks. |
| `candidate.clearance` | `lib/rank.js` | A name means you hold that clearance. `null` means unknown, so no check runs. `false` or `"none"` means you hold none, and only then does a posting that requires one lose points. |
| `discovery.workModes[]` | pipeline, sources, apply harness, `final-list.js`, `lib/linkedin.js` | Any of `remote`, `hybrid`, `onsite`. Empty keeps all. |
| `discovery.hybridMaxOfficeShare` | the find mode (model applied) | Largest share of office time you accept for a hybrid role. Not enforced in code. To use it, list both `remote` and `hybrid` in `workModes`. |
| `discovery.countries[]` | pipeline, sources, apply harness, `final-list.js` | Empty keeps every country. Exactly `["US"]` uses the US location classifier. Under any other list a posting is dropped only when its location names a country outside the list (or is recognizably in the US); a city alone, a city and region, or a location that names no place is unknown and kept. Write another country as its code, its name, or a common alias (`"UK"` is read as GB); code plus name, for example `["CA", "Canada"]`, counts as one country. When the list resolves to exactly one country, that country is the market for the search sources that take one. |
| `discovery.regions[]` | pipeline, agent import, `final-list.js` | Place names where you can work on site, for example `["Denver", "Colorado"]`. Applies only to hybrid and onsite postings (after enrichment, also to a posting that states no work mode): the location must name one of them as a whole phrase. A remote posting is never touched, and a location that names no place is kept. A US state, a Canadian province or territory, an Australian state, or a UK nation matches by its name and by its code, whichever you write (`["Denver", "Colorado"]` keeps "Aurora, CO"). For a region in any other country, list both the name and the code postings use, the code in capitals (for example `["Munich", "Bavaria", "BY"]`). Empty keeps every place. |
| `discovery.maxAgeDays` | pipeline, sources, slug harvest, `lib/ghost-score.js` | Recency window in days. `0` turns the cut off, in the pipeline and in every source. The ghost age signal measures against the larger of 30 days and this window, and is off when the window is `0`. |
| `discovery.seniorityExtensionDays` | pipeline, `lib/ghost-score.js` | Extra days for titles that carry senior, sr, principal, or lead. |
| `discovery.titleExclude[]`, `titleKeep[]` | `lib/rank.js isRoleMatch`, `lib/linkedin.js`, `prune-queue.js`, `final-list.js` | Whole phrase, case insensitive. A title is dropped when an exclude phrase matches outside every keep phrase (a keep phrase shields only its own words). |
| `discovery.salaryFloor`, `salaryCurrency` | pipeline strict gate | A posting is dropped only when its published YEARLY band, in a stated currency equal to `salaryCurrency`, tops out below the floor. Free text is parsed for the codes USD, GBP, EUR, CAD, AUD, NZD, SGD, CHF and the dollar, pound, and euro signs; a bare `$` is read as USD only for a posting placed in the US. Any other pay (another or an unstated currency, per hour, month, or pay period, none) is unknown and kept. So only bands in your own currency can be compared with your floor. |
| `discovery.excludeStaffing` | `lib/exclusions.js` | `false` turns the shared staffing list off. |
| `discovery.companySites[]` | `brave-search`, `serpapi-site-search` | Career site domains to search. An entry is a domain, optionally with a path, or `{ "site": "...", "company": "..." }`. Empty skips that fan out. |
| `discovery.minScore` | `classify-gate.js`, `final-list.js` | Hide results scored below this. `null` means no floor. |
| `discovery.referralFirst` | the find mode | Check your contacts for a referral before a cold application. |
| `skills.levels{}` | `lib/rank.js` | Overrides the derived proficiency of a skill with a number from 0 to 1. A skill you rate 0.9 or above here is a differentiator: only those earn the small differentiator bonus in the score. A level changes the score only when the table says more than "all of this is a strength": rate skills you hold but cannot prove at 0.6, and the skills your target postings ask for that you hold weakly or not at all below 0.6. A table in which every level is 0.9 or above is not counted as a rating (its terms still count as evidence that you hold the skill, at the level you gave, so a posting that names rated skills your bullets do not carry scores a point or two higher for each one, about twelve for a table of ten, and can cross the 55 floor). A table of 40 terms with about one in five at 0.5 or below stands alone: postings are then scored by the rated skills they name, not by the vocabulary estimate. On a posting whose title names no target role word the table is read only as far as your material covers the posting (three rated skills named halve the coverage needed, they do not replace it). A rated term is also evidence, so rate only skills specific to your field and leave out words that postings in every field use (leadership, communication, training, mentoring, hiring, budget, compliance, coaching and the like) and general tools and methods that other fields share (spreadsheets, SQL, reporting, data analysis, forecasting, process improvement, project management, automation), even when postings for your own role ask for them; rated, they lift a posting from another field that is built around them (six or more named in a short description) to 65 and above. `skills.gaps` entries are not rated terms; a weakness must be in `levels` to count. |
| `skills.gaps[]` | `lib/rank.js` | Honest gaps. An entry is a string, or `{ "label", "terms": [], "unlessAlso": [] }` when one gap has several names or should not count next to an alternative you hold. |
| `evidence.ledger`, `evidence.narrative` | `lib/sync-check.js`, the modes | Paths of the evidence file and the optional career narrative. A missing evidence file is a warning, not an error. |
| `evidence.roots[]`, `evidence.tools[]` | `scripts/evidence-index.js` | Folders to scan and extra names to look for. See `docs/evidence-retrieval-layer.md`. |
| `evidence.githubAccounts[]`, `evidence.attribution[]` | the modes | Account names only (never tokens), and rows `{ "source", "belongsTo" }` that say which role a body of work belongs to. |
| `output.forbiddenTerms[]` | `lib/tailor.js scanCodenames`, both renderers | Names that must never appear in a rendered document. A hit refuses the render. |
| `output.targetPages` | `lib/tailor.js auditResume`, `check-docx-pages.js`, the fill workflow | Resume page target. `null` means no page fill check. |
| `output.stripHyphens` | `lib/normalize.js` | `true` also removes plain hyphens from rendered text. Dashes, smart quotes, and ATS illegal characters are always folded. Hyphens in names, phone numbers, employer and school names, places and date ranges are kept either way. |
| `output.asciiOnly` | `lib/normalize.js` | boolean, default `false`. `false` keeps the letters of every script and their accents in rendered documents and form answers; `true` folds accented Latin letters to their base letter, writes out symbols that carry meaning (micro sign, degree, plus minus, currency signs), and removes everything else outside ASCII, other scripts included. Dashes, smart quotes, bullets, invisible characters, emoji and ATS illegal characters are cleaned in both settings. It applies to every rendered field (name, contact line, employer, place, dates, school, skill labels, headings); a name written wholly in a non Latin script is kept as written, and a heading in such a script falls back to English. |
| `output.pageSize` | both renderers (`lib/profile.js pageSetup`) | `"letter"` or `"a4"`. `null` picks Letter when the country list is empty or names a country that uses Letter paper (the US, Canada, Mexico, the Philippines and several countries in Latin America), A4 otherwise. |
| `output.dateLocale` | `render-cover-letter.js` (`lib/profile.js pageSetup`) | A BCP 47 tag such as `"en-GB"` for the date on a cover letter. `null` means en-US. |
| `output.sectionHeadings{}` | `render-docx.js`, `docx-to-pdf.js` | Optional; the template names it in its comment only. Your own words for the resume section headings, for a resume not written in English: keys `summary`, `projects`, `experience`, `skills`, `education`, `awards`. An unset key keeps the English heading. |

Precedence everywhere: a command line flag beats `data/profile.json`, which beats the permissive default. Keys that start with `$` are notes and are ignored. Unknown keys are kept. A value of the wrong kind for a list or object key is ignored.

## System layer (replaced on install or update)

These files hold skill logic and shared data. They contain nothing personal and can be replaced safely.

* `.claude/CLAUDE.md`: project guidance for the model.
* `.claude/skills/jobe/SKILL.md`: the router.
* `.claude/skills/jobe/modes/*.md`: 18 workflow modes, `_shared.md`, and `_profile.template.md`. A user's own `modes/_profile.md` (legacy location) is never overwritten.
* `.claude/agents/jobe-*.md`: 4 agent definitions (`jd-analyzer`, `company-intel`, `competitor`, `job-discovery`).
* `AGENTS.md`, `.codex/agents/jobe-*.toml`, `.agents/skills/jobe/**`: the same skill for the Codex harness, generated from `.claude/CLAUDE.md`, `.claude/agents/jobe-*.md`, and `.claude/skills/jobe/**` by `scripts/sync-agents-mirror.js`.
* `lib/*.js` (31 modules) and `lib/apply/*.js` (4 modules):
  * Infrastructure: `config`, `profile`, `exclusions`, `normalize`, `rate-limiter`, `network`, `snapshot`, `sync-check`
  * Discovery: `posting`, `dedup`, `minhash`, `enrich`, `slug-harvest`, `slug-resolve`, `ats-tenants`, `agent-import`, `role-queries`, `linkedin`
  * Ranking: `rank`, `rrf`, `archetypes`, `ghost-score`
  * Resume tailoring: `tailor`, `bullet-select`, `tailoring`
  * Quality and audit: `calibration`, `bias-audit`
  * Tracker: `tracker`, `tracker-stats`, `tracker-writer`, `patterns`
  * Apply harness (`lib/apply/`): `camoufox` (`launchCamoufox`, `newStealthPage`), `answers` (`buildAnswers`, `findResumeJson`, `findDocx`, `findResumeUpload`, `loadApplyProfile`, `fromBand`, `bandFromText`), `filler` (`detectAts`, `fillForm`, `fillQuestions`, `matchField`, `eeoSubtype`, `eeoMatcher`, `pickOption`, `degreeLevelRe`), `url-normalize` (`normalizeApplyUrl`, `wrapperBoards`, `deriveBoardToken`)
* `collectors/pipeline.js`: the discovery orchestrator. `collectors/ingest-manual.js`: the manual LinkedIn ingest. `collectors/enrich-run.js`: enrich an existing list. `collectors/seed-files.js`: workspace first reader for the portals and employer seeds. It reads the employer seed from the workspace and from an optional `<install>/configs/non-tech-seed.json` (none ships), never from `data/` at the install root.
* `collectors/sources/**/*.js`: 33 source plugins (20 aggregators, 2 company specific, 1 ATS directory, 10 ATS direct). The full list with keys and limits is in `docs/discovery-sources.md`.
* `scripts/*.js`:
  * Rendering: `render-docx.js`, `render-cover-letter.js` (both accept `--strict`), `render-pptx.js`, `docx-to-pdf.js`, `check-docx-pages.js`
  * Tailoring: `tailor-brief.js`, `bulk-resume-from-list.js`
  * Evidence: `evidence-index.js`, `check-evidence-coverage.js`, `check-evidence-depth.js`
  * Discovery helpers: `prune-queue.js`, `resolve-linkedin-to-ats.js`, `verify-remote.js`, `verify-listing.js`, `classify-gate.js`, `final-list.js`, `linkedin-guest-sweep.js`, `resolve-index-backlog.js`
  * Apply: `camoufox-apply.js`, `apply-helpers/drive.js`, `apply-helpers/launch.sh`, `apply-helpers/submit.sh`
  * Workspaces and maintenance: `user.js`, `sync-agents-mirror.js`
  * Workflow tool scripts: `wf-generate-batch.js`, `wf-recenter-batch.js`, `wf-fill-batch.js`, `wf-compress-batch.js`, `wf-evidence-extract.js`, `wf-bullets-from-evidence.js`. These run only under the Claude Code Workflow tool, not under `node`.
* `configs/default.json`: shared config. Holds scoring weights, score bands (80, 65, 55), API key names, `output_dir`, `report_dir`. No candidate block and no company lists.
* `configs/portals.json`: shared ATS tenant seed. Ships empty with eight keys (`greenhouse`, `lever`, `ashby`, `workable`, `recruitee`, `breezy`, `bamboohr`, `personio`). An entry is a slug string or `{ "slug", "name" }`.
* `configs/apply-wrappers.json`: shared careers host to Greenhouse board token map. Ships `{}`.
* `configs/archetypes.json`: optional install wide archetype default. Not shipped.
* `data/companies/staffing-list.json`: 111 staffing agency and broker slugs. Applied by the pipeline, the manual ingest, the agent import, and `final-list.js` through `lib/exclusions.js`, together with your negative list, unless `discovery.excludeStaffing` is `false`.
* `templates/*`: `profile`, `resume-baseline`, `bullet-library`, `reference`, `apply-profile`, `seeds`, `negative-list`, `archetypes`, `non-tech-seed`, `portals`, `evidence-anchors`, `evidence-depth`, `career-narrative`. Every template is inert when copied: live keys are empty and examples sit under `$examples` or `$comment` keys that no reader loads.
* `test/*.test.js`, `docs/`, `web/`: the test suite, these documents, and the optional dashboard. Part of the repo, not needed by a global install.

No personal file ships. `data/queries/seeds.json`, `data/companies/negative-list.json`, and `data/companies/non-tech-seed.json` are user files created from templates; nothing exists at those paths in a fresh clone.

## Reports directory lifecycle

A report folder lives at `reports/{bucket}/{slug}/` and moves through these buckets as its status changes, so the layout always shows where each job is.

| Bucket | Meaning |
|---|---|
| `verify` | Resume generated; verification and repair pending or failed. |
| `evaluate` | Scored and verified; decision pending. |
| `queue` | Resume generated, verified, and present in `data/apply-queue.json`. Ready to apply. New evaluations land here. |
| `manual` | A person must finish it: the ATS has gates the harness cannot complete, or it blocks automated submit. An active parking bucket, not an archive. |
| `applied` | Submitted. |
| `skipped` | Deliberately not applied to. |
| `archive` | Aged out or done; kept for reference. |
| `audit` | Audit reports. |

`lib/tracker-writer.js` owns the lifecycle:

* `LIFECYCLE_BUCKETS`: the list above, in stage order.
* `locateReportDir(root, slug)`: the folder for a slug wherever it sits. Search order: flat `reports/{slug}/` (older installs), each lifecycle bucket in stage order, the older bucket names `needs-manual`, `gated`, `non-gated`, then dated archives `reports/{bucket}/archive/{date}/{slug}/` newest first. `lib/apply/answers.js`, `scripts/prune-queue.js`, and the dashboard all use it, so there is one bucket list.
* `moveReportFolder(slug, bucket)`: moves the folder to `reports/{bucket}/{slug}/` and rewrites the queue entry (`resumeDocx`, `coverLetterDocx`, `reportDir`) and every tracker reference. `needs-manual` is still accepted as a destination and means `manual`.
* `upsertTrackerRow(row, slug)`: inserts or replaces the tracker row for a slug, so a step that runs twice never duplicates a row. `updateTrackerStatus({ slug, newStatus })` works for a folder in any bucket.

Files in a report folder: `resume-{date}-{slug}.json` (the resume source, also carrying `coverLetter` and `whyCompany`), the rendered resume and cover letter DOCX, an optional PDF, the analysis markdown, and `jd.txt` (the job description; the renderers and the audit read it from beside the JSON). `scripts/bulk-resume-from-list.js` writes `candidate-pool-{date}-{slug}.json` (flag `candidatePool: true`), `jd.txt`, and `_genctx.json`; a candidate pool is not a resume.

## Discovery pipeline gates

Every posting passes these, in this order (`collectors/pipeline.js`):

1. **Normalize.** Each source emits postings in the canonical schema (`lib/posting.js createPosting`).
2. **Three pass dedup** (`lib/dedup.js`). URL exact, then `dedupKey` = sha1(company slug, normalized role), then MinHash LSH at Jaccard 0.70 or higher (128 permutations, 18 by 7 bands, bigram shingles). Location is not part of the key, so under a remote only policy one requisition listed in several places collapses. Under any other policy the city is part of the merge, so the same title in two cities stays two rows: every remote, country only, or empty location of one employer and title is one row per country, a hybrid location with no city is a row of its own, and real cities stay apart. The report slug follows the same rule (`lib/dedup.js reportSlug`), so each city has its own report folder, queue row, and tracker row.
3. **Role.** Your title policy (a `discovery.titleExclude` phrase outside every `titleKeep` phrase drops the title), then the title against the role tokens derived from your seeds (`lib/role-queries.js`, inflection tolerant). Permissive when you have neither.
4. **Excluded companies.** Your negative list plus the staffing list (`lib/exclusions.js`).
5. **Queue and history.** A posting whose address is already in the apply queue is dropped. A posting whose `dedupKey` matches a requisition you already applied to or skipped is dropped, whatever source found it this time. Outside a remote only policy the match also needs the same city when the queue row carries a `location` (a row with none matches every city). `--include-applied` lifts the history rule.
6. **Country, work mode, and region, permissive pass.** Dropped only when the posting is already known to be outside your policy. Unknown is kept so enrichment can decide. The region rule (`discovery.regions`) reads only postings already labeled hybrid or onsite.
7. **Recency.** `postedDate` older than `maxAgeDays` (plus the senior extension when set). A posting with no date is kept, and a window of `0` keeps every date. The date is the ORIGINAL publish date where the ATS provides one (`first_published` on Greenhouse, `publishedAt` on Ashby); for a known ATS address that date replaces any aggregator date during enrichment.
8. **Ghost score** (`lib/ghost-score.js`). Postings labeled Suspicious are hidden unless `--show-ghosts`.
9. **Enrich** the top 300 by priority (`lib/enrich.js`): job description, compensation, location, original date. Cached for 30 days under `signals/cache/jd/`.
10. **Score** (`lib/rank.js fullScore`). Fit only. See ARCHITECTURE.md.
11. **Strict pass** on enriched data: country, work mode (the mode must be one you accept; a posting that states none is kept only when you accept onsite), region (every posting that is not remote must name one of your regions, when you set any), recency, and the pay floor.

There is no separate liveness gate. Enrichment marks a posting it could not fetch with `alive: false` and it sinks to the bottom with no score. `scripts/verify-listing.js` confirms a listing is still open on the employer's ATS, and `scripts/final-list.js` leaves out the ones verified closed and applies the same strict work mode, country, region, and title rules to the verified data.

Fields the pipeline and the helper scripts add to a posting:

| Field | Set by | Meaning |
|---|---|---|
| `dedupKey`, `companySlug` | `lib/posting.js` | Identity. |
| `hqLocation` | sources | The location the source displayed, kept as a cross check. |
| `remoteVerified` | verification only | `true` only when a step that read the real posting confirmed remote. |
| `ghost`, `reqRuns` | pipeline | Ghost score with label, and how many runs this requisition has appeared in. |
| `quickScore` | `lib/rank.js` | Enrichment priority. Not a fit claim. |
| `matchScore`, `fitCoverage`, `archetype`, `rankReason` | `lib/rank.js fullScore` | The fit score, the coverage behind it, and its reasons. |
| `minimumsUnmet[]`, `gatePass { gate1, gate2, minimums }` | `lib/rank.js fullScore` | Stated minimums you do not meet, and the three gate results. |
| `salaryCheck` | pipeline strict pass | `published` when a yearly band in your currency was parsed, `unknown` otherwise. |
| `rrfScore`, `rrfRank` | `lib/rank.js fuseRanking` | Tie break and diagnostic. |
| `atsResolved`, `atsBoard`, `atsMatchScore`, `linkedinUrl` | `resolve-linkedin-to-ats.js` | Result of resolving a LinkedIn lead to the employer's listing. |
| `verifyStatus`, `verifiedLocation`, `verifiedWorkplace` | `verify-remote.js` | `remote`, `not-remote`, `unreachable`, or `inconclusive`, and what the page showed. |
| `verify { status, stillOpen, titleSim, location, remote, postedDate, comp }` | `verify-listing.js` | What the employer's ATS says. `needs-agent` means the script could not confirm either way. |

## Signals and cache

Per run output, under the active workspace. Safe to delete.

* `signals/discovered/{date}/`: `raw-{source}.json` per source, `merged.json` (after dedup), `filter-report.json` (the merged filters and reject counts), `ranked-all.json`, `ranked-enriched.json` (the final list), `ranked.json` (when run with `--no-enrich`), `discovery-summary.json` (`perSource`, `totalRaw`, `afterDedup`, `afterFilter`, `enriched`, `finalCount`, `rejected`, `postEnrichRejected` including `salary`, `payUnknown`, `withUnmetMinimums`, `needsAgentFallback`, `fallbackReason`), `agent-discovered.json` (the agent fallback), `manual-{source}.json` (manual ingest).
* `signals/cache/jd/`: job description cache, 30 days, sha1 keyed. Entries written before the original publish date change may hold a refresh date until they expire; deleting the folder clears them.
* `signals/req-history.json`: which runs each requisition appeared in (feeds the repost signal).
* `signals/snapshots/`: company snapshots.
* `signals/company-intel/{company-slug}/`: company research cache, and the `/jobe deep` report `deep-research-{date}.md`.
* `signals/apply/{slug}/`: apply harness channel. `state.json` (harness to agent), `control.json` (agent to harness), `preview.png` (the glance screenshot), and helper logs `launch.log`, `drive-run.log`. Phases in `state.json`: `filled` (with `submitRejected: true` when a submit was refused and the form was scanned again), `submitted`, `needs-security-code`, `submit-blocked-spam` (terminal, never retried), `submit-failed`, `needs-manual`, `blocked-location` (carries `policy: { workModes, countries }`), `skip`, `timeout`, `confirmed`, `done`, `error`.
* `signals/apply/_profiles/{ats}/`: persistent browser profile for the Ashby warm mode. Lock guarded so Ashby runs one at a time. Safe to delete.

## Install behavior per file

| File | Layer | On install or update |
|---|---|---|
| Code, modes, agents, `templates/*` | system | replaced |
| `configs/default.json`, `configs/portals.json`, `data/companies/staffing-list.json` | system | replaced |
| `configs/apply-wrappers.json` | system (shared map) | copied only when absent |
| Everything in the user layer | user | never touched by the install script or by a later update |

One time exception, for a clone made before these became personal files: `data/queries/seeds.json`, `data/companies/negative-list.json` and `data/companies/non-tech-seed.json` were tracked in older versions, and onboarding wrote your roles into the first. The first `git pull` across that change removes the tracked copies, and stops when you edited them. Follow "Upgrading from an older clone" in the README before that pull; afterwards git ignores all three and no update touches them.

`install-local.sh` installs the skill text under `~/.claude/skills/jobe/` and `~/.claude/agents/`, and the code under `~/.jobe/` (project guidance goes to `~/.jobe/CLAUDE.md`). It seeds no personal file and never writes your own `~/.claude/CLAUDE.md`. It copies whole folders (`lib`, `collectors`, `scripts`, `templates`) and every mode and agent file, so a new module or source ships with no edit to the script. It copies over and never deletes, so a file removed upstream lingers in an existing install until you remove it.
