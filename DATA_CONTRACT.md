# Data Contract

Defines the boundary between user data and system data.

## User Layer (NEVER auto-modified by install or update)

These files contain user-specific data. Install scripts create them only if they don't exist.

- `data/tracker.md` - Application pipeline
- `data/story-bank.md` - STAR+R interview stories
- `data/followups.md` - Follow-up cadence tracking
- `data/apply-queue.json` - Ordered apply queue with applied/skipped status
- `modes/_profile.md` - User identity, contact, preferences
- `configs/default.json` - Scoring weights, company tiers (guarded with if-not-exists)
- `.env` - API keys

## System Layer (overwritten on install/update)

These files contain skill logic and can be safely replaced.

- `.claude/CLAUDE.md` - Project documentation
- `.claude/skills/jobe/SKILL.md` - Router
- `.claude/skills/jobe/reference.md` - Portfolio evidence
- `.claude/skills/jobe/modes/*.md` - All mode files except `_profile.md`
- `.claude/agents/jobe-*.md` - Agent definitions (jd-analyzer, company-intel, competitor, job-discovery)
- `lib/*.js` - 9 modules (config, scoring, portfolio, tracker, normalize, sync-check, archetypes, patterns, snapshot)
- `collectors/**/*.js` - ATS collectors (greenhouse, lever, ashby with date field extraction + 30-day filter), jd/parse, company/research, market/salary, jobs/discover
- `scripts/*.js` - Render scripts (render-docx + render-cover-letter both call normalize(), render-pdf, render-pptx)
- `configs/portals.json` - Company portal registry (45+ companies)

## Reports Directory Structure

Reports are organized by pipeline status. Move folders as status changes so the top-level `reports/` only shows ACTIVE work.

- `reports/{slug}/` - **Evaluated** roles: generated but not yet applied or decided against. This is the active pipeline.
- `reports/applied/{slug}/` - **Applied** roles: submitted. Archive here when status flips from Evaluated → Applied.
- `reports/skipped/{slug}/` - **Skipped** roles: intentionally not applied to (ghost job, level mismatch, duplicate, etc.). Archive here when status flips to Skipped.

Auto-archive behavior (enforced by apply.md and apply-all.md):
- On Apply submission: `mkdir -p reports/applied && mv reports/{slug} reports/applied/{slug}` AND rewrite the Resume path in `data/tracker.md` from `reports/{slug}/` to `reports/applied/{slug}/`.
- On Skip: `mkdir -p reports/skipped && mv reports/{slug} reports/skipped/{slug}` AND rewrite the Resume path in `data/tracker.md` from `reports/{slug}/` to `reports/skipped/{slug}/`.
- Evaluated folders stay at the top level until one of those transitions happens.

## Discovery Quality Gates

Every job posting passes three filters before entering the queue:
1. **Recency**: ATS API date fields (`updated_at`, `createdAt`, `publishedAt`) within 30 days. WebSearch uses `after:` operator.
2. **Liveness**: HTTP status 200/301/302. Dead links (404/403/timeout) rejected.
3. **Keyword match**: ML/AI title keywords present, negative keywords absent.
