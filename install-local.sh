#!/bin/bash
# Jobe: install from a local clone to ~/.claude/ (skill text) and ~/.jobe/ (code).
# Run from inside the cloned repo: ./install-local.sh
#
# This installs the SKILL LOGIC globally so `/jobe` works from any directory.
# It does NOT create your personal files (profile, resume baseline, bullet
# library, evidence): run `/jobe onboard` once after install to generate those
# from a guided interview. This script never ships or overwrites a personal
# file, and your own ~/.claude/CLAUDE.md is never touched. (Updating an older
# CLONE with git is a separate matter: see "Upgrading from an older clone" in
# the README before the first pull.)
#
# What gets copied is derived from the tree (whole folders and globs), so a new
# module, source plugin, script, template, mode, or agent ships with no edit
# here. test/root-integration-install.test.js runs this script into a temporary
# home and fails when a shipped file does not arrive.
#
# JOBE_INSTALL_SKIP_DEPS=1 copies files only (no `npm install`, no browser
# download). Use it for an offline install; the test suite uses it too.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${HOME:?HOME is not set}/.claude"
JOBE_DIR="${HOME}/.jobe"

# Verify we are in the repo
if [ ! -f "${SCRIPT_DIR}/.claude/skills/jobe/SKILL.md" ]; then
  echo "Error: Run this from inside the jobe repo directory."
  exit 1
fi

echo "Installing Jobe career intelligence skill from local repo..."

# -- Skill, modes, agents (system layer) -> ~/.claude --------------------------
mkdir -p "${CLAUDE_DIR}/skills/jobe/modes" "${CLAUDE_DIR}/agents"
cp "${SCRIPT_DIR}/.claude/skills/jobe/SKILL.md" "${CLAUDE_DIR}/skills/jobe/SKILL.md"
cp "${SCRIPT_DIR}"/.claude/agents/jobe-*.md "${CLAUDE_DIR}/agents/"

# Mode files. NEVER overwrite a person's own _profile.md: it is user layer,
# created by `/jobe onboard` (an older layout kept it in this folder).
for f in "${SCRIPT_DIR}"/.claude/skills/jobe/modes/*.md; do
  name=$(basename "$f")
  if [ "$name" = "_profile.md" ] && [ -f "${CLAUDE_DIR}/skills/jobe/modes/_profile.md" ]; then
    continue
  fi
  cp "$f" "${CLAUDE_DIR}/skills/jobe/modes/$name"
done

# -- Codex host (only when Codex is present on this machine) -------------------
# Same skill, generated copies. ~/.codex/AGENTS.md is YOUR global instructions
# file and is never written by this script.
if [ -d "${HOME}/.codex" ] || command -v codex > /dev/null 2>&1; then
  AGENTS_SKILL_DIR="${HOME}/.agents/skills/jobe"
  mkdir -p "${AGENTS_SKILL_DIR}/modes" "${HOME}/.codex/agents"
  cp "${SCRIPT_DIR}/.agents/skills/jobe/SKILL.md" "${AGENTS_SKILL_DIR}/SKILL.md"
  for f in "${SCRIPT_DIR}"/.agents/skills/jobe/modes/*.md; do
    name=$(basename "$f")
    if [ "$name" = "_profile.md" ] && [ -f "${AGENTS_SKILL_DIR}/modes/_profile.md" ]; then
      continue
    fi
    cp "$f" "${AGENTS_SKILL_DIR}/modes/$name"
  done
  cp "${SCRIPT_DIR}"/.codex/agents/jobe-*.toml "${HOME}/.codex/agents/"
  echo "        Codex found: skill -> ${AGENTS_SKILL_DIR}/, agents -> ${HOME}/.codex/agents/"
fi

echo "  [1/4] Skill, modes, agents -> ${CLAUDE_DIR}/"

# -- Code and templates (system layer) -> ~/.jobe ------------------------------
# Whole folders, so nothing has to be listed: lib/ (with lib/apply/),
# collectors/ (pipeline plus every folder under sources/), scripts/ (with
# apply-helpers/), templates/.
# ponytail: copy over, never delete, so anything a person added survives. A file
# removed upstream therefore lingers in an existing install (a retired source
# plugin would keep registering). Upgrade path: write a manifest of shipped
# files and prune against it on the next install.
for d in lib collectors scripts templates; do
  mkdir -p "${JOBE_DIR}/${d}"
  cp -R "${SCRIPT_DIR}/${d}/." "${JOBE_DIR}/${d}/"
done

# Shared configs, replaced on every install (nothing personal lives in them).
# Three names under configs/ are PERSONAL files from older layouts and are never
# copied. The wrapper map may carry machine wide additions, so it is copied only
# when absent.
mkdir -p "${JOBE_DIR}/configs"
for f in "${SCRIPT_DIR}"/configs/*.json; do
  name=$(basename "$f")
  case "$name" in
    local.json|archetypes.json|apply-profile.json|_temp-*) continue ;;
  esac
  if [ "$name" = "apply-wrappers.json" ] && [ -f "${JOBE_DIR}/configs/${name}" ]; then
    continue
  fi
  cp "$f" "${JOBE_DIR}/configs/${name}"
done

# Shared list. The broker list is system data and is replaced every time (your
# own additions belong in your negative list). Your employer seed
# (data/companies/non-tech-seed.json) is a personal file: onboarding creates it
# from the template, and this script never writes it.
mkdir -p "${JOBE_DIR}/data/queries" "${JOBE_DIR}/data/companies"
cp "${SCRIPT_DIR}/data/companies/staffing-list.json" "${JOBE_DIR}/data/companies/staffing-list.json"

# Run folders, and the home of the per person workspaces (one machine, many
# people, different fields). Report stage folders are created on demand.
mkdir -p "${JOBE_DIR}/reports" "${JOBE_DIR}/signals/snapshots" "${JOBE_DIR}/signals/cache/jd" "${JOBE_DIR}/users"

cp "${SCRIPT_DIR}/package.json" "${JOBE_DIR}/package.json"
if [ -f "${SCRIPT_DIR}/package-lock.json" ]; then
  cp "${SCRIPT_DIR}/package-lock.json" "${JOBE_DIR}/package-lock.json"
fi
cp "${SCRIPT_DIR}/.env.example" "${JOBE_DIR}/.env.example"

# Project guidance sits next to the code. ~/.claude/CLAUDE.md is YOUR global
# instructions file and is never written by this script.
if [ -f "${SCRIPT_DIR}/.claude/CLAUDE.md" ]; then
  cp "${SCRIPT_DIR}/.claude/CLAUDE.md" "${JOBE_DIR}/CLAUDE.md"
fi
if [ -f "${SCRIPT_DIR}/AGENTS.md" ]; then
  cp "${SCRIPT_DIR}/AGENTS.md" "${JOBE_DIR}/AGENTS.md"
fi

# NOTE: personal user layer files (_profile.md, reference.md, data/profile.json,
# data/resume-baseline.json, data/bullet-library.json, data/queries/seeds.json,
# data/tracker.md, ...) are NOT seeded here. `/jobe onboard` creates them from
# your answers using the shipped templates/.

echo "  [2/4] Code, configs, templates -> ${JOBE_DIR}/"

# -- Node dependencies ---------------------------------------------------------
if [ -n "${JOBE_INSTALL_SKIP_DEPS:-}" ]; then
  echo "  [3/4] JOBE_INSTALL_SKIP_DEPS is set: skipped npm install and the browser download"
elif command -v node > /dev/null 2>&1 && command -v npm > /dev/null 2>&1; then
  if (cd "${JOBE_DIR}" && npm install --silent); then
    echo "  [3/4] Node dependencies installed"
  else
    echo "  [3/4] npm install FAILED (see above). Run 'npm install' in ${JOBE_DIR} before using the collectors."
  fi
  # Camoufox stealth Firefox binary for the default auto apply path.
  if [ ! -d "${HOME}/.cache/camoufox" ]; then
    echo "        Fetching the Camoufox browser binary (one time, about 311MB)..."
    (cd "${JOBE_DIR}" && npx --yes camoufox-js fetch 2> /dev/null) \
      || echo "        (camoufox fetch failed: run 'npx camoufox-js fetch' in ${JOBE_DIR} before using auto apply)"
  fi
else
  echo "  [3/4] Node.js not found: skipped (web search still works, collectors unavailable)"
fi

# -- .env ----------------------------------------------------------------------
if [ ! -f "${JOBE_DIR}/.env" ]; then
  cp "${JOBE_DIR}/.env.example" "${JOBE_DIR}/.env"
  echo "  [4/4] .env created: add API keys to ${JOBE_DIR}/.env (every key is optional)"
else
  echo "  [4/4] .env already exists, not overwriting"
fi

count() { find "$1" -type f -name "$2" | wc -l | tr -d ' '; }

echo ""
echo "Jobe career intelligence skill installed."
echo ""
echo "  Skill:        ${CLAUDE_DIR}/skills/jobe/ ($(count "${CLAUDE_DIR}/skills/jobe/modes" '*.md') mode files)"
echo "  Code:         ${JOBE_DIR}/ ($(count "${JOBE_DIR}/collectors/sources" '*.js') discovery sources)"
echo "  Guidance:     ${JOBE_DIR}/CLAUDE.md"
echo "  Templates:    ${JOBE_DIR}/templates/ ($(count "${JOBE_DIR}/templates" '*') files, each one empty until onboarding fills your copy)"
echo "  Seeds:        created per workspace by /jobe onboard (nothing about any field ships)"
echo "  Employers:    created per workspace by /jobe onboard (no employer list ships)"
echo "  Reports:      <workspace>/reports/<stage>/<company>/"
echo ""
echo "Next step: set up your personal files (15 to 30 minutes, one time):"
echo "  /jobe onboard                        guided interview: profile, preferences, resume baseline, bullets, evidence, keys"
echo ""
echo "Several people share this machine? Each gets an isolated workspace under ${JOBE_DIR}/users/<name>/:"
echo "  /jobe onboard <name>                 create and set up one person's workspace"
echo "  /jobe use <name>                     switch the active person"
echo "  /jobe users                          list workspaces (* = active)"
echo "  (or:  node ${JOBE_DIR}/scripts/user.js new|use|list|current)"
echo ""
echo "Then (against the active workspace):"
echo "  /jobe find                           discover jobs from employer job boards and web search"
echo "  /jobe https://url                    generate a tailored resume and cover letter"
echo "  /jobe apply-all                      apply to the queue through the Camoufox browser automation"
echo "  /jobe tracker                        view the application pipeline"
