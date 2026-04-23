---
name: jobe
description: >
  Career intelligence skill with 15 modes: evaluate (tailored resume + cover letter),
  find (job discovery via 8-source pipeline), batch (multi-job), tracker (pipeline),
  interview-prep, followup, patterns (analytics), contacto (outreach),
  deep (company research), project (portfolio eval), calibrate, audit.
user-invocable: true
argument-hint: "find [role/location] | [URL] | batch [urls] | tracker | interview-prep | followup | patterns | contacto | deep | project | calibrate | audit"
allowed-tools: "Bash Read Write Edit Glob Grep Agent WebSearch WebFetch"
effort: high
---

# Jobe: Career Intelligence

The user provided: `$ARGUMENTS`

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
| `find`, `search`, `discover`, `jobs` | `modes/find.md` | Discover jobs via 8-source pipeline (ATS APIs + SerpAPI + HN + company sites) |
| `tracker`, `pipeline`, `status` | `modes/tracker.md` | View application pipeline with stats |
| `batch` | `modes/batch.md` | Process multiple postings |
| `interview-prep`, `interview`, `prep` | `modes/interview-prep.md` | Prepare for interviews with story mapping |
| `followup`, `follow-up`, `follow` | `modes/followup.md` | Manage follow-up cadence |
| `patterns`, `analytics`, `insights` | `modes/patterns.md` | Analyze application history |
| `contacto`, `outreach`, `linkedin` | `modes/contacto.md` | Draft LinkedIn outreach messages |
| `deep`, `research` | `modes/deep.md` | Deep company research (6-axis) |
| `project`, `portfolio` | `modes/project.md` | Evaluate a portfolio project |
| `apply` | `modes/apply.md` | Fill + submit one job application via Chrome (human-in-the-loop) |
| `apply-all` | `modes/apply-all.md` | Process entire apply queue. Default: paste-ready blocks. `--chrome` flag for browser automation. |
| `apply-assisted` | `modes/apply-assisted.md` | Opens each URL in your browser, prints paste-ready blocks. No CAPTCHA issues. |
| `calibrate` | `modes/calibrate.md` | Human-label a sample of LLM-judge outputs; compute Cohen's kappa |
| `audit` | `modes/audit.md` | Run bias audit: perturb name/school/intl, measure score variance |

If the first word is a URL, `company role` pair, or pasted JD text, read `modes/evaluate.md`.

**If the first word is unrecognized and cannot be parsed as a URL or company-role**, respond with the mode list above rather than silently falling through.

Read the mode file with: `Read {MODES_DIR}/{mode_file}`

## Step 3: Execute

Follow the instructions in the loaded mode file exactly. Pass the free-form args tail to the mode so it can use it as filter input. All modes share the context from `_shared.md` and `_profile.md`.
