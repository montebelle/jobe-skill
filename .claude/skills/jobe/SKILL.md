---
name: jobe
description: >
  Career intelligence skill: onboard (guided setup interview), evaluate (tailored
  resume + cover letter), find (19-source discovery pipeline), batch (multi-job),
  tracker (pipeline), interview-prep, followup, patterns (analytics), contacto
  (outreach), deep (company research), project (portfolio eval), linkedin-tab
  (ingest your open LinkedIn Jobs tab), calibrate, audit.
user-invocable: true
argument-hint: "onboard | find [role/location] | [URL] | batch [urls] | tracker | interview-prep | followup | patterns | contacto | deep | project | linkedin-tab | calibrate | audit"
allowed-tools: "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch"
effort: high
---

# Jobe: Career Intelligence

The user provided: `$ARGUMENTS`

## Step 0: First-run check

If `_profile.md` does not exist (or is still the unedited template), `data/resume-baseline.json` does not exist, and `data/bullet-library.json` does not exist — Jobe is unconfigured. Tell the user "Looks like Jobe hasn't been set up yet. Run `/jobe onboard` to walk through the 7-step interview that produces every personal file Jobe needs (15-30 min)." and stop. Do not try to run other modes against missing config.

## Step 1: Load shared context

Read these files to load common rules and user profile:
1. Read `modes/_shared.md` (scoring model, positioning reasoning (internal only), ATS rules, archetypes, anti-fabrication, ghost-job detection, empirical citations)
2. Read `modes/_profile.md` (the candidate's contact info, target roles, preferences)

Check for modes in repo first, then global install:
```bash
if [ -f .claude/skills/jobe/modes/_shared.md ]; then
  MODES_DIR=".claude/skills/jobe/modes"
elif [ -f "${HOME}/.claude/skills/jobe/modes/_shared.md" ]; then
  MODES_DIR="${HOME}/.claude/skills/jobe/modes"
else
  echo "ERROR: modes directory not found"
fi
echo "MODES_DIR=${MODES_DIR}"
```

## Step 2: Route to mode

Parse `$ARGUMENTS`:
- First word = mode keyword (see table)
- **Remaining words = free-form filter**: pass these into the mode's invocation so they influence pipeline queries / location filters / company scopes. Do NOT drop them.

| First Word | Mode File | What It Does |
|---|---|---|
| `onboard`, `init`, `setup`, `start` | `modes/onboard.md` | Guided 7-step interview that produces every personal file Jobe needs. Run this once after install. |
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
| `calibrate` | `modes/calibrate.md` | Human-label a sample of LLM-judge outputs; compute Cohen's kappa |
| `audit` | `modes/audit.md` | Run bias audit: perturb name/school/intl, measure score variance |

If the first word is a URL, `company role` pair, or pasted JD text, read `modes/evaluate.md`.

**If the first word is unrecognized and cannot be parsed as a URL or company-role**, respond with the mode list above rather than silently falling through.

Read the mode file with: `Read {MODES_DIR}/{mode_file}`

## Step 3: Execute

Follow the instructions in the loaded mode file exactly. Pass the free-form args tail to the mode so it can use it as filter input. All modes share the context from `_shared.md` and `_profile.md`.
