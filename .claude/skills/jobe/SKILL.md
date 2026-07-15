---
name: jobe
description: >
  Career intelligence skill: onboard (guided setup interview), evaluate (tailored
  resume + cover letter), find (19-source discovery pipeline), batch (multi-job),
  tracker (pipeline), interview-prep, followup, patterns (analytics), contacto
  (outreach), deep (company research), project (portfolio eval), linkedin-tab
  (ingest your open LinkedIn Jobs tab), linkedin-search (drive your logged-in
  LinkedIn search), calibrate, audit.
user-invocable: true
argument-hint: "onboard [name] | use <name> | users | find [role/location] | [URL] | batch [urls] | tracker | interview-prep | followup | patterns | contacto | deep | project | linkedin-tab | linkedin-search | calibrate | audit"
allowed-tools: "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch"
effort: high
---

# Jobe: Career Intelligence

The user provided: `$ARGUMENTS`

## Step 0: Resolve the active workspace (multi-user)

Jobe runs for many people on one machine, each with an isolated workspace (their own profile, evidence, tracker, queue, reports). Resolve the shared code root, the shared modes dir, and the ACTIVE user's workspace first:

```bash
# Shared code root (repo in dev; ~/.jobe when installed)
if [ -f ./package.json ] && [ -d ./lib ]; then JOBE_HOME="$(pwd)"; else JOBE_HOME="${HOME}/.jobe"; fi
# Shared modes dir (repo in dev; ~/.claude when installed)
if [ -f .claude/skills/jobe/modes/_shared.md ]; then MODES_DIR=".claude/skills/jobe/modes"; else MODES_DIR="${HOME}/.claude/skills/jobe/modes"; fi
# Active user's workspace — all personal files live here. Prints the install
# root when no user is configured (single-user / back-compat).
WORKSPACE="$(node "${JOBE_HOME}/scripts/user.js" current --path 2>/dev/null || echo "${JOBE_HOME}")"
echo "JOBE_HOME=${JOBE_HOME}  MODES_DIR=${MODES_DIR}  WORKSPACE=${WORKSPACE}"
```

**Workspace commands** — if the first word of `$ARGUMENTS` is one of these, handle it here and STOP (do not load a mode):
- `users` or `whoami` → run `node "${JOBE_HOME}/scripts/user.js" list`; report who exists and who is active.
- `use <name>` → run `node "${JOBE_HOME}/scripts/user.js" use <name>`; confirm the switch, then stop.
- `onboard <name>` (a name given after `onboard`) → run `node "${JOBE_HOME}/scripts/user.js" new <name>` to create + activate that person's workspace, then continue into `modes/onboard.md` for it.

All personal paths in every mode resolve under `${WORKSPACE}`; shared files (`configs/`, `data/companies/non-tech-seed.json`, `data/companies/staffing-list.json`, and the code) stay under `${JOBE_HOME}`.

## Step 1: First-run check

Set `PROFILE="${WORKSPACE}/_profile.md"`. ONLY in single-user mode (when `${WORKSPACE}` equals `${JOBE_HOME}`) fall back to the legacy location `PROFILE="${MODES_DIR}/_profile.md"` if the workspace file is absent. In multi-user mode (a workspace is active), NEVER fall back to the shared modes dir — a missing workspace `_profile.md` means that person has not onboarded, so treat the workspace as unconfigured below.

**Exception:** if the routed mode is `onboard`/`init`/`setup`/`start`, SKIP this check and proceed into onboarding — a freshly created workspace is legitimately empty, and this is the command that fills it.

Otherwise, if `${PROFILE}` does not exist (or is still the unedited template) AND `${WORKSPACE}/data/resume-baseline.json` does not exist AND `${WORKSPACE}/data/bullet-library.json` does not exist — this workspace is unconfigured. If other workspaces already exist on this machine, tell the user "Run `/jobe onboard <your-name>` to create your workspace and set it up (15-30 min)." Otherwise "Looks like Jobe hasn't been set up yet. Run `/jobe onboard` (15-30 min)." Then stop. Do not run other modes against missing config.

## Step 2: Load shared context

1. Read `${MODES_DIR}/_shared.md` (scoring model, positioning reasoning (internal only), ATS rules, archetypes, anti-fabrication, ghost-job detection, empirical citations, and the workspace rules)
2. Read `${PROFILE}` (the active user's contact info, target roles, preferences)

## Step 3: Route to mode

Parse `$ARGUMENTS`:
- First word = mode keyword (see table)
- **Remaining words = free-form filter**: pass these into the mode's invocation so they influence pipeline queries / location filters / company scopes. Do NOT drop them.

| First Word | Mode File | What It Does |
|---|---|---|
| `onboard`, `init`, `setup`, `start` | `modes/onboard.md` | Guided interview that produces every personal file Jobe needs. `onboard <name>` first creates that person's workspace (multi-user, one machine); plain `onboard` sets up the active/only workspace. Run once per person. |
| `find`, `search`, `discover`, `jobs` | `modes/find.md` | Discover jobs via 19-source pipeline (Brave + SerpAPI + HN + remote boards [Remotive/RemoteOK/WeWorkRemotely/Himalayas] + LinkedIn guest + Adzuna + JSearch + Amazon + Apple + Ashby + Greenhouse + Lever + Workday + SmartRecruiters + iCIMS) |
| `tracker`, `pipeline`, `status` | `modes/tracker.md` | View application pipeline with stats |
| `batch` | `modes/batch.md` | Process multiple postings |
| `interview-prep`, `interview`, `prep` | `modes/interview-prep.md` | Prepare for interviews with story mapping |
| `followup`, `follow-up`, `follow` | `modes/followup.md` | Manage follow-up cadence |
| `patterns`, `analytics`, `insights` | `modes/patterns.md` | Analyze application history |
| `contacto`, `outreach`, `linkedin` | `modes/contacto.md` | Draft LinkedIn outreach messages |
| `deep`, `research` | `modes/deep.md` | Deep company research (6-axis) |
| `project`, `portfolio` | `modes/project.md` | Evaluate a portfolio project |
| `apply` | `modes/apply.md` | Fill + submit one application via Camoufox stealth automation (default); glance before submit + email-confirm loop. `--paste` falls back to paste-ready blocks. |
| `apply-all` | `modes/apply-all.md` | Process the apply queue via Camoufox stealth auto-apply (default); `--top N`, `--paste` fallback, `--headless`. |
| `apply-assisted` | `modes/apply-assisted.md` | Fallback: paste-ready blocks for login-walled forms (or `--paste`). |
| `linkedin-tab`, `tab`, `linkedin-jobs`, `ingest` | `modes/linkedin-tab.md` | Read your OPEN LinkedIn Jobs tab (Chrome extension, read-only) and ingest postings into the pipeline |
| `linkedin-search`, `li-search`, `linkedin-sweep` | `modes/linkedin-search.md` | Drive your LOGGED-IN LinkedIn search across profile queries + paginate (Chrome extension), staffing-filter, ingest. Opt-in + user-present only (account-risk); never unattended. Also reachable as `find --linkedin`. |
| `calibrate` | `modes/calibrate.md` | Human-label a sample of LLM-judge outputs; compute Cohen's kappa |
| `audit` | `modes/audit.md` | Run bias audit: perturb name/school/intl, measure score variance |

If the first word is a URL, `company role` pair, or pasted JD text, read `modes/evaluate.md`.

**If the first word is unrecognized and cannot be parsed as a URL or company-role**, respond with the mode list above rather than silently falling through.

Read the mode file with: `Read {MODES_DIR}/{mode_file}`

## Step 4: Execute

Follow the instructions in the loaded mode file exactly. Pass the free-form args tail to the mode so it can use it as filter input. All modes share the context from `_shared.md` and the active user's `_profile.md`, and resolve every personal path under `${WORKSPACE}`.
