---
name: jobe
description: >
  Career intelligence skill for any profession: onboard (guided setup interview),
  evaluate (tailored resume + cover letter), find (job discovery through the source
  plugin pipeline), batch (several postings), tracker (pipeline), interview-prep,
  followup, patterns (analytics), contacto (outreach), deep (company research),
  project (portfolio eval), apply (fill + submit one application), apply-all
  (process the apply queue), apply-assisted (paste ready fallback), linkedin-tab
  (ingest your open LinkedIn Jobs tab), linkedin-search (drive your logged in
  LinkedIn search), calibrate, audit.
user-invocable: true
argument-hint: "onboard [name] | use <name> | users | find [role/location] | [URL] | batch [urls] | tracker | interview-prep | followup | patterns | contacto | deep | project | apply | apply-all | apply-assisted | linkedin-tab | linkedin-search | calibrate | audit"
allowed-tools: "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch"
effort: high
---

# Jobe: Career Intelligence

The user provided: `$ARGUMENTS`

## Step 0: Resolve the active workspace (multi user)

Jobe runs for many people on one machine, each with an isolated workspace (their own profile, evidence, tracker, queue, reports). Resolve the shared code root, the shared modes dir, and the ACTIVE user's workspace first:

```bash
# Shared code root (repo in dev; ~/.jobe when installed)
if [ -f ./collectors/pipeline.js ] && [ -f ./scripts/user.js ]; then JOBE_HOME="$(pwd)"; else JOBE_HOME="${HOME}/.jobe"; fi
# Shared modes dir: the repo copy in dev, the installed copy otherwise. The
# .agents paths are the generated mirror used by other agent hosts.
MODES_DIR=""
for d in .claude/skills/jobe/modes .agents/skills/jobe/modes "${HOME}/.claude/skills/jobe/modes" "${HOME}/.agents/skills/jobe/modes"; do
  if [ -f "${d}/_shared.md" ]; then MODES_DIR="${d}"; break; fi
done
[ -n "${MODES_DIR}" ] || echo "ERROR: modes directory not found"
# Active user's workspace: all personal files live here. Prints the install
# root when no user is configured (single user, back compatible).
WORKSPACE="$(node "${JOBE_HOME}/scripts/user.js" current --path 2>/dev/null || echo "${JOBE_HOME}")"
echo "JOBE_HOME=${JOBE_HOME}  MODES_DIR=${MODES_DIR}  WORKSPACE=${WORKSPACE}"
```

**Workspace commands**: if the first word of `$ARGUMENTS` is one of these, handle it here and STOP (do not load a mode):
- `users` or `whoami`: run `node "${JOBE_HOME}/scripts/user.js" list`; report who exists and who is active.
- `use <name>`: run `node "${JOBE_HOME}/scripts/user.js" use <name>`; confirm the switch, then stop.
- `onboard <name>` (a workspace name given after `onboard`): run `node "${JOBE_HOME}/scripts/user.js" new <name>` to create and activate that person's workspace, then continue into `modes/onboard.md` for it. The step keywords of onboard mode (`profile`, `resume`, `evidence`, `keys`, `seeds`, `apply`, `narrative`) are NOT names: `onboard seeds` goes straight to `modes/onboard.md` for the active workspace.

All personal paths in every mode resolve under `${WORKSPACE}`; shared files (`configs/`, `templates/`, `data/companies/staffing-list.json`, and the code) stay under `${JOBE_HOME}`.

## Step 1: First run check

Set `PROFILE="${WORKSPACE}/_profile.md"`. ONLY in single user mode (when `${WORKSPACE}` equals `${JOBE_HOME}`) fall back to the legacy location `PROFILE="${MODES_DIR}/_profile.md"` if the workspace file is absent. In multi user mode (a workspace is active), NEVER fall back to the shared modes dir: a missing workspace `_profile.md` means that person has not onboarded, so treat the workspace as unconfigured below.

**Exception:** if the routed mode is `onboard`/`init`/`setup`/`start`, SKIP this check and proceed into onboarding. A freshly created workspace is legitimately empty, and this is the command that fills it.

Otherwise the workspace is unconfigured when ALL of these hold:
- `${PROFILE}` does not exist, or is still the unedited template;
- `${WORKSPACE}/data/resume-baseline.json` does not exist, or is still the scaffold (its `name` is empty);
- `${WORKSPACE}/data/bullet-library.json` does not exist, or is still the scaffold (its `companyKeyMap` is empty).

A workspace created by `user.js new` holds scaffold copies of every template, so "the file exists" alone proves nothing. If the workspace is unconfigured and other workspaces already exist on this machine, tell the user "Run `/jobe onboard <your-name>` to create your workspace and set it up (15 to 30 min)." Otherwise "Looks like Jobe hasn't been set up yet. Run `/jobe onboard` (15 to 30 min)." Then stop. Do not run other modes against missing config.

## Step 2: Load shared context

1. Read `${MODES_DIR}/_shared.md` (workspace rules, the profile and standing rules contract, report folder lifecycle, scoring model, positioning reasoning (internal only), ATS rules, render gates, evidence sourcing, anti fabrication, ghost job detection, empirical citations).
2. Read `${PROFILE}` (the active user's contact info, target roles, preferences, and the optional sections "Standing rules", "Attribution rules", "Role posture leads", "Verified figures", "Known corrections", "What not to use in output").
3. Load the structured policy. Code reads ONLY this file, never the prose profile, so these are the values every filter and gate actually uses:
   ```bash
   cd "${JOBE_HOME}" && node -e "const {loadProfile,discoveryFilters}=require('./lib/profile');const p=loadProfile();console.log(JSON.stringify({candidate:p.candidate,discovery:p.discovery,skills:p.skills,evidence:p.evidence,output:p.output,mergedFilters:discoveryFilters(p)},null,2))"
   ```
   It prints `${WORKSPACE}/data/profile.json` merged over the permissive defaults. An absent key means no filter and no check. Never substitute a default of your own (no assumed work mode, country, recency window, title level, or salary floor).
4. **Standing rules are hard constraints.** Every line under "Standing rules" in `${PROFILE}`, and every item under "Known corrections", applies to this run on top of `_shared.md`. They are the user's own repeated corrections; a rule there outranks a default written in any mode file. A section that is absent adds no rule.
5. **Record new standing rules.** When the user states a standing correction in any mode ("from now on", "always", "never", or the same fix a second time), append one line to the "Standing rules" section of `${PROFILE}` (create the section if it is missing) and confirm it back in one sentence. When the rule maps to a structured key (a title to exclude, a work mode, a country, a region, a recency window, a salary floor, a name that must never render), ALSO write that key in `${WORKSPACE}/data/profile.json`, because code reads only the JSON file.

### Subagent propagation (hard)

A subagent inherits NOTHING: no profile, no standing rules, no workspace, no policy. A subagent handed a bare task falls back to generic defaults and reintroduces a mistake the user already corrected. Whenever ANY mode spawns ANY subagent (discovery, JD analysis, company research, resume or cover letter generation, verification, apply), inline into its prompt, as literal text:

- the absolute `${WORKSPACE}` path (and `${JOBE_HOME}` when it runs code), with every output path written as an absolute path under it;
- the user's policy values from step 3 that the task touches. Title policy: the title exclude and keep lists. Location and recency policy: work modes and the hybrid office share, countries, regions, recency window. Pay: salary floor and currency. An unset value is passed as "not set", never replaced by a default;
- when the task lists, ranks, or verifies postings: the presentation rule from `find.md` (only rows that clear every gate the user set, never padded with flagged rows, and a compensation figure on every row: published, else fetched from the live listing, else a clearly labeled estimate);
- the names that must never render (`output.forbiddenTerms` plus "What not to use in output");
- when the task writes resume, cover letter, or application answer text:
  - the evidence sourcing rule from `_shared.md` (read the JD, then the user's real evidence: the evidence roots when the profile lists any, the evidence file, and the bullet library as a candidate pool only; then write; never invent a figure);
  - the "Attribution rules", "Role posture leads", and "Verified figures" sections of `${PROFILE}` verbatim (an absent section adds nothing), so no body of work is listed under the wrong employer or project;
  - the ATS character rule (`_shared.md` ATS Format Rules: none of `< > [ ] { } " \`, no em dash, en dash, smart quote or other typographic punctuation; hyphens are removed at render only when `output.stripHyphens` is true);
  - the method depth rule (`evaluate.md` Depth gate: state how the work was done, not only its scale or outcome, and lead with what the candidate built or ran at the deepest layer the JD asks about, not only the applications on top of it);
- every line of "Standing rules" and "Known corrections" that is relevant to the task, verbatim.

The six `scripts/wf-*.js` workflow scripts are the one exception in form: they tell each agent to read those profile sections from the workspace by name instead of receiving them inline.

## Step 3: Route to mode

Parse `$ARGUMENTS`:
- First word = mode keyword (see table)
- **Remaining words = free form filter**: pass these into the mode's invocation so they influence pipeline queries / location filters / company scopes. Do NOT drop them.

| First Word | Mode File | What It Does |
|---|---|---|
| `onboard`, `init`, `setup`, `start` | `modes/onboard.md` | Guided interview that produces every personal file Jobe needs. `onboard <name>` first creates that person's workspace (multi user, one machine); plain `onboard` sets up the active/only workspace. Run once per person. |
| `find`, `search`, `discover`, `jobs` | `modes/find.md` | Discover jobs through the source plugin pipeline (search aggregators, job boards, a LinkedIn guest search, and per company ATS crawlers), filtered by your own policy, then resolve, verify, and rank |
| `tracker`, `pipeline`, `status` | `modes/tracker.md` | View application pipeline with stats |
| `batch` | `modes/batch.md` | Process multiple postings |
| `interview-prep`, `interview`, `prep` | `modes/interview-prep.md` | Prepare for interviews with story mapping |
| `followup`, `follow-up`, `follow` | `modes/followup.md` | Manage follow up cadence |
| `patterns`, `analytics`, `insights` | `modes/patterns.md` | Analyze application history |
| `contacto`, `outreach`, `linkedin` | `modes/contacto.md` | Draft LinkedIn outreach messages |
| `deep`, `research` | `modes/deep.md` | Deep company research (6 axes) |
| `project`, `portfolio` | `modes/project.md` | Evaluate a portfolio project |
| `apply` | `modes/apply.md` | Fill + submit one application via Camoufox stealth automation (default); glance before submit + email confirm loop. `--paste` falls back to paste ready blocks. |
| `apply-all` | `modes/apply-all.md` | Process the apply queue via Camoufox stealth automation (default); `--top N`, `--paste` fallback, `--headless`. |
| `apply-assisted` | `modes/apply-assisted.md` | Fallback: paste ready blocks for login walled forms (or `--paste`). |
| `linkedin-tab`, `tab`, `linkedin-jobs`, `ingest` | `modes/linkedin-tab.md` | Read your OPEN LinkedIn Jobs tab (Chrome extension, read only) and ingest postings into the pipeline |
| `linkedin-search`, `li-search`, `linkedin-sweep` | `modes/linkedin-search.md` | Drive your LOGGED IN LinkedIn search across profile queries + paginate (Chrome extension), staffing filter, ingest. Opt in + user present only (account risk); never unattended. Also reachable as `find --linkedin`. |
| `calibrate` | `modes/calibrate.md` | Human label a sample of LLM judge outputs; compute Cohen's kappa |
| `audit` | `modes/audit.md` | Run bias audit: perturb name/school/intl, measure score variance |

If the first word is a URL, a `company role` pair, or pasted JD text, read `modes/evaluate.md`.

**If the first word is unrecognized and cannot be parsed as a URL or a company and role**, respond with the mode list above rather than silently falling through.

Read the mode file with: `Read {MODES_DIR}/{mode_file}`

## Step 4: Execute

Follow the instructions in the loaded mode file exactly. Pass the free form args tail to the mode so it can use it as filter input. All modes share the context from `_shared.md`, the active user's `_profile.md`, the structured policy from Step 2.3, and the standing rules from Step 2.4, and resolve every personal path under `${WORKSPACE}`.
