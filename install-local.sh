#!/bin/bash
# Jobe — Install from a local clone to global ~/.claude/ and ~/.jobe/
# Run from inside the cloned repo: ./install-local.sh
#
# This installs the SKILL LOGIC globally so `/jobe` works from any directory.
# It does NOT create your personal files (profile, resume baseline, bullet
# library, portfolio evidence) — run `/jobe onboard` once after install to
# generate those from a guided interview. Personal files are never shipped.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
JOBE_DIR="${HOME}/.jobe"

# Verify we're in the repo
if [ ! -f "${SCRIPT_DIR}/.claude/skills/jobe/SKILL.md" ]; then
  echo "Error: Run this from inside the jobe repo directory."
  exit 1
fi

echo "Installing Jobe career intelligence skill from local repo..."

# ── Skill + Agents + Modes (system layer) ───────────────────────
mkdir -p "${CLAUDE_DIR}/skills/jobe"
mkdir -p "${CLAUDE_DIR}/skills/jobe/modes"
mkdir -p "${CLAUDE_DIR}/agents"

cp "${SCRIPT_DIR}/.claude/CLAUDE.md" "${CLAUDE_DIR}/CLAUDE.md" 2>/dev/null || true
cp "${SCRIPT_DIR}/.claude/skills/jobe/SKILL.md" "${CLAUDE_DIR}/skills/jobe/SKILL.md"
cp "${SCRIPT_DIR}/.claude/agents/jobe-jd-analyzer.md" "${CLAUDE_DIR}/agents/jobe-jd-analyzer.md" 2>/dev/null || true
cp "${SCRIPT_DIR}/.claude/agents/jobe-company-intel.md" "${CLAUDE_DIR}/agents/jobe-company-intel.md"
cp "${SCRIPT_DIR}/.claude/agents/jobe-competitor.md" "${CLAUDE_DIR}/agents/jobe-competitor.md"
cp "${SCRIPT_DIR}/.claude/agents/jobe-job-discovery.md" "${CLAUDE_DIR}/agents/jobe-job-discovery.md"

# Copy mode files (system layer). NEVER overwrite a user's own _profile.md /
# reference.md — those are created by `/jobe onboard` and are user-layer.
for f in "${SCRIPT_DIR}"/.claude/skills/jobe/modes/*.md; do
  basename=$(basename "$f")
  if [ "$basename" = "_profile.md" ] && [ -f "${CLAUDE_DIR}/skills/jobe/modes/_profile.md" ]; then
    continue
  fi
  cp "$f" "${CLAUDE_DIR}/skills/jobe/modes/$basename"
done

echo "  [1/6] Skill + agents + modes → ${CLAUDE_DIR}/"

# ── Collectors + Libs + Scripts + Templates (system layer) ──────
mkdir -p "${JOBE_DIR}/collectors/sources/aggregators"
mkdir -p "${JOBE_DIR}/collectors/sources/company-specific"
mkdir -p "${JOBE_DIR}/collectors/sources/ats-directories"
mkdir -p "${JOBE_DIR}/collectors/sources/ats-direct"
mkdir -p "${JOBE_DIR}/lib/apply"
mkdir -p "${JOBE_DIR}/scripts/apply-helpers"
mkdir -p "${JOBE_DIR}/configs"
mkdir -p "${JOBE_DIR}/templates"
mkdir -p "${JOBE_DIR}/reports/applied"
mkdir -p "${JOBE_DIR}/reports/skipped"
mkdir -p "${JOBE_DIR}/data/queries"
mkdir -p "${JOBE_DIR}/data/companies"
mkdir -p "${JOBE_DIR}/signals/snapshots"
mkdir -p "${JOBE_DIR}/signals/cache/jd"
# Per-user workspaces (multi-user: one machine, many people, different fields)
mkdir -p "${JOBE_DIR}/users"

cp "${SCRIPT_DIR}"/collectors/*.js "${JOBE_DIR}/collectors/" 2>/dev/null || true
cp "${SCRIPT_DIR}"/collectors/sources/_interface.md "${JOBE_DIR}/collectors/sources/_interface.md" 2>/dev/null || true
cp "${SCRIPT_DIR}"/collectors/sources/aggregators/*.js "${JOBE_DIR}/collectors/sources/aggregators/" 2>/dev/null || true
cp "${SCRIPT_DIR}"/collectors/sources/company-specific/*.js "${JOBE_DIR}/collectors/sources/company-specific/" 2>/dev/null || true
cp "${SCRIPT_DIR}"/collectors/sources/ats-directories/*.js "${JOBE_DIR}/collectors/sources/ats-directories/" 2>/dev/null || true
cp "${SCRIPT_DIR}"/collectors/sources/ats-direct/*.js "${JOBE_DIR}/collectors/sources/ats-direct/" 2>/dev/null || true
cp "${SCRIPT_DIR}"/lib/*.js "${JOBE_DIR}/lib/"
cp "${SCRIPT_DIR}"/lib/apply/*.js "${JOBE_DIR}/lib/apply/" 2>/dev/null || true
cp "${SCRIPT_DIR}"/scripts/*.js "${JOBE_DIR}/scripts/"
cp "${SCRIPT_DIR}"/scripts/apply-helpers/* "${JOBE_DIR}/scripts/apply-helpers/" 2>/dev/null || true
cp "${SCRIPT_DIR}"/templates/* "${JOBE_DIR}/templates/" 2>/dev/null || true

# portals.json is system-layer (always overwrite); default.json is user-layer (only on first install)
cp "${SCRIPT_DIR}/configs/portals.json" "${JOBE_DIR}/configs/portals.json"
if [ ! -f "${JOBE_DIR}/configs/default.json" ]; then
  cp "${SCRIPT_DIR}/configs/default.json" "${JOBE_DIR}/configs/default.json"
fi
cp "${SCRIPT_DIR}/package.json" "${JOBE_DIR}/package.json"
cp "${SCRIPT_DIR}/.env.example" "${JOBE_DIR}/.env.example"

# Discovery seeds + non-tech-seed ship as industry-neutral examples (only on first install)
if [ ! -f "${JOBE_DIR}/data/queries/seeds.json" ]; then
  cp "${SCRIPT_DIR}/data/queries/seeds.json" "${JOBE_DIR}/data/queries/seeds.json"
fi
if [ ! -f "${JOBE_DIR}/data/companies/non-tech-seed.json" ]; then
  cp "${SCRIPT_DIR}/data/companies/non-tech-seed.json" "${JOBE_DIR}/data/companies/non-tech-seed.json"
fi
if [ ! -f "${JOBE_DIR}/data/companies/negative-list.json" ] && [ -f "${SCRIPT_DIR}/data/companies/negative-list.json" ]; then
  cp "${SCRIPT_DIR}/data/companies/negative-list.json" "${JOBE_DIR}/data/companies/negative-list.json"
fi
if [ ! -f "${JOBE_DIR}/data/companies/staffing-list.json" ] && [ -f "${SCRIPT_DIR}/data/companies/staffing-list.json" ]; then
  cp "${SCRIPT_DIR}/data/companies/staffing-list.json" "${JOBE_DIR}/data/companies/staffing-list.json"
fi

# NOTE: personal user-layer files (_profile.md, reference.md, data/resume-baseline.json,
# data/bullet-library.json, data/tracker.md, data/story-bank.md) are NOT seeded here —
# `/jobe onboard` creates them from your answers using the shipped templates/.

echo "  [2/6] Collectors, libs, scripts, configs, templates → ${JOBE_DIR}/"

# ── Install Node dependencies ───────────────────────────────────
if command -v node &> /dev/null && command -v npm &> /dev/null; then
  cd "${JOBE_DIR}" && npm install --silent 2>/dev/null
  # Camoufox stealth-Firefox binary for the default auto-apply path (~311MB + GeoIP)
  if [ ! -d "${HOME}/.cache/camoufox" ]; then
    echo "  [3/6] Fetching Camoufox browser binary (one-time, ~311MB)…"
    npx --yes camoufox-js fetch 2>/dev/null || echo "       (camoufox fetch failed — run 'npx camoufox-js fetch' manually for auto-apply)"
  fi
  echo "  [3/6] Node dependencies installed"
else
  echo "  [3/6] Node.js not found — skipping (WebSearch still works, collectors unavailable)"
fi

# ── Create .env ─────────────────────────────────────────────────
if [ ! -f "${JOBE_DIR}/.env" ]; then
  cp "${JOBE_DIR}/.env.example" "${JOBE_DIR}/.env"
  echo "  [4/6] .env created — add API keys to ${JOBE_DIR}/.env"
else
  echo "  [4/6] .env already exists, not overwriting"
fi

echo "  [5/6] System layer installed"
echo "  [6/6] Done"
echo ""
echo "Jobe career intelligence skill installed."
echo ""
echo "  Skill:        ${CLAUDE_DIR}/skills/jobe/"
echo "  Data + code:  ${JOBE_DIR}/"
echo "  Templates:    ${JOBE_DIR}/templates/ (resume-baseline, bullet-library, reference, apply-profile, non-tech-seed)"
echo "  Seeds:        ${JOBE_DIR}/data/queries/seeds.json (industry-neutral examples)"
echo "  Non-tech:     ${JOBE_DIR}/data/companies/non-tech-seed.json (Workday + SmartRecruiters + iCIMS)"
echo "  Reports:      ${JOBE_DIR}/reports/{applied,skipped}/"
echo ""
echo "Next step — set up your personal files (15-30 min, one time):"
echo "  /jobe onboard                        — guided interview: profile, resume baseline, bullets, evidence, keys"
echo ""
echo "Multiple people share this machine? Each gets an isolated workspace under ${JOBE_DIR}/users/<name>/:"
echo "  /jobe onboard <name>                 — create + set up one person's workspace (e.g. film, nonprofits, ops)"
echo "  /jobe use <name>                     — switch the active person"
echo "  /jobe users                          — list workspaces (* = active)"
echo "  (or:  node ${JOBE_DIR}/scripts/user.js new|use|list|current)"
echo ""
echo "Then (against the active workspace):"
echo "  /jobe find                           — discover jobs via ATS APIs + web search"
echo "  /jobe https://url                    — generate a tailored resume + cover letter"
echo "  /jobe apply-all                      — auto-apply the queue via Camoufox stealth automation"
echo "  /jobe tracker                        — view the application pipeline"
