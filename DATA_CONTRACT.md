# Data Contract

Defines the boundary between user data and system data.

## Multi-user workspaces (one machine, many people)

Jobe separates a shared **system layer** (code, configs, field-neutral ATS seeds — installed once at the install root, `~/.jobe`) from a per-user **workspace layer** (everything personal). Each person on the machine gets an isolated workspace at `users/<slug>/`, so a film-focused user and an operations-focused user never see each other's profile, evidence, queue, or reports.

- The active user is resolved in `lib/config.js` from the `JOBE_USER` env var, else the `users/.active` pointer file, else — when no workspace is configured — the install root. Existing single-user installs are therefore unchanged.
- `getUserRoot()` returns the active workspace; `getSystemRoot()` returns the shared install root. Every **User Layer** file below resolves under the workspace; every **System Layer** file under the install root.
- Manage workspaces with `node scripts/user.js <list | current [--path] | new <name> | use <name> | migrate <name>>`, or the skill commands `/jobe onboard <name>`, `/jobe use <name>`, `/jobe users`. `migrate` moves an existing single-user install's data into a named workspace.
- Workspaces are gitignored (`/users/`). `JOBE_USER` overrides the pointer for a single command or process.

## User Layer (NEVER auto-modified by install or update) — per workspace

These files contain user-specific data and live under the active workspace (`users/<slug>/`, or the install root in single-user mode). Install and `scripts/user.js new` create them only if they don't exist.

- `data/tracker.md` - Application pipeline
- `data/story-bank.md` - STAR+R interview stories
- `data/followups.md` - Follow-up cadence tracking
- `data/apply-queue.json` - Ordered apply queue with applied/skipped status
- `data/contacts.json` - Referral network for `/jobe contacto`
- `data/apply-profile.json` - Optional apply-harness answers not in a resume (work authorization, salary target, "how did you hear about us", an optional `postalCode` for required ZIP fields, and OPT-IN EEO self-identification). Copy from `templates/apply-profile.template.json`; EEO declines by default.
- `data/resume-baseline.json` - Most recent tailored resume (user-edited)
- `data/companies/index.json` - Emergent company index, per workspace (grows every discovery run; user can curate)
- `data/queries/seeds.json` - Discovery queries (role x location x archetype). Per workspace, read via `getProjectRoot()`. Ships as shared industry-neutral EXAMPLES; each workspace gets its own copy scaffolded by `scripts/user.js`, and `/jobe onboard` regenerates it from that user's target roles x locations so discovery searches their field, not ML-by-default.
- `data/companies/negative-list.json` - Slugs to exclude from discovery. Per workspace (each person curates their own exclusions); scaffolded per-workspace by `scripts/user.js` from a shared template.
- `_profile.md` - User identity, contact, preferences (at the workspace root; legacy single-user installs keep it at `modes/_profile.md`, which the router still falls back to)
- `configs/default.json` - Scoring weights, company tiers (guarded with if-not-exists). NOTE: `configs/` is SHARED system layer — read from the install root, same for every workspace
- `.env` - API keys
- `reference.md` - Portfolio evidence. Every resume bullet must trace to an entry here.

## System Layer (overwritten on install/update)

These files contain skill logic and can be safely replaced.

- `.claude/CLAUDE.md` - Project documentation
- `.claude/skills/jobe/SKILL.md` - Router
- `.claude/skills/jobe/modes/*.md` - All mode files except `_profile.md`
- `.claude/agents/jobe-*.md` - 4 agent definitions (jd-analyzer, company-intel, competitor, job-discovery)
- `lib/*.js` + `lib/apply/*.js` - 32 modules (28 `lib/*.js` + 4 `lib/apply/*.js`) including:
  - Infrastructure: config, normalize, rate-limiter, network, snapshot, sync-check
  - Discovery: posting, dedup, minhash, enrich, slug-harvest, agent-import, role-queries
  - Ranking + archetypes: rank, rrf, archetypes
  - Resume tailoring: tailor (JD-grounded brief + advisory `auditResume` / `auditProse`), bullet-select
  - Quality + audit: ghost-score, calibration, bias-audit, tailoring
  - Tracker: tracker, tracker-stats, tracker-writer, patterns
  - LinkedIn ingest: linkedin (search-URL build + accessibility parse for the logged-in / open-tab modes)
  - Apply harness (`lib/apply/`): camoufox (stealth-Firefox launcher, persistent warm profile), answers, filler, url-normalize (canonical + Greenhouse-embed rewrite)
- `collectors/pipeline.js` - Unified orchestrator across all plugin sources
- `collectors/sources/**/*.js` - 19 source plugins:
  - `aggregators/` - Brave Search, SerpAPI Google Jobs, SerpAPI site:, HN Who-is-hiring, Remotive, RemoteOK, WeWorkRemotely, Himalayas, LinkedIn guest, Adzuna, JSearch
  - `company-specific/` - Amazon public JSON, Apple SSR
  - `ats-directories/` - Ashby customer-board enumeration
  - `ats-direct/` - Greenhouse, Lever, Workday, SmartRecruiters, iCIMS by slug
- `scripts/*.js` - Render scripts (render-docx + render-cover-letter both call normalize(), render-pdf, render-pptx); `tailor-brief.js` emits the per-JD JD-grounded tailoring brief (`lib/tailor.js`)
- `configs/portals.json` - Starting tech-side slugs for the emergent company index (slug-harvest grows it over time; not field-specific by design)
- `data/companies/non-tech-seed.json` - Workday tenants + SmartRecruiters companies + iCIMS hosts, tagged by industry. This is how Workday/SmartRecruiters/iCIMS reach non-tech industries (finance, pharma, retail, media, healthcare, energy, auto, ...). Ships with ~24 example employers; users add their own target employers. SHARED across all workspaces (industry-neutral, read from the install root).
- `data/companies/staffing-list.json` - 33 staffing-agency / recruiter / AI-data-labeling marketplace slugs dropped from discovery (they dominate LinkedIn deep-search pages as "Promoted" noise); applied by `ingest-manual` as a union with negative-list. SHARED across all workspaces (read from the install root).

(Note: `data/queries/seeds.json` and `data/companies/negative-list.json` are PER-USER, not system — see the User Layer list above. They ship as shared industry-neutral templates but each workspace gets its own copy.)

## Reports Directory Structure

Reports are organized by pipeline status. Move folders as status changes so the top-level `reports/` only shows ACTIVE work.

- `reports/{slug}/` - **Evaluated** roles: generated but not yet applied or decided against. This is the active pipeline.
- `reports/applied/{slug}/` - **Applied** roles: submitted. Archive here when status flips from Evaluated -> Applied.
- `reports/skipped/{slug}/` - **Skipped** roles: intentionally not applied to (ghost job, level mismatch, duplicate, etc.). Archive here when status flips to Skipped.
- `reports/needs-manual/{slug}/` - **Needs-manual** roles: the resume is built but the ATS blocks automated submit (e.g. a login wall or a spam gate). Archive here so they surface for a manual apply.

Auto-archive behavior (enforced by apply.md and apply-all.md):
- On Apply submission: `mkdir -p reports/applied && mv reports/{slug} reports/applied/{slug}` AND rewrite the Resume path in `data/tracker.md` from `reports/{slug}/` to `reports/applied/{slug}/`.
- On Skip: `mkdir -p reports/skipped && mv reports/{slug} reports/skipped/{slug}` AND rewrite the Resume path in `data/tracker.md` from `reports/{slug}/` to `reports/skipped/{slug}/`.
- On Needs-manual: same relocation into `reports/needs-manual/{slug}` when the resume is built but the ATS blocks automated submit.
- These relocations are performed atomically by `lib/tracker-writer.js moveReportFolder(slug, bucket)` (`bucket` = `applied` | `skipped` | `needs-manual`), which also rewrites the queue entry's `resumeDocx` + `coverLetterDocx` paths and the tracker `reportDir` column.
- Evaluated folders stay at the top level until one of those transitions happens.

## Discovery Pipeline Gates

Every job posting passes through these filters before entering the queue:

1. **Recency**: ATS collectors filter by `updated_at` / `createdAt` / `publishedAt` within 30 days. WebSearch uses `after:` operator. Seniority-adjusted +15 days for senior/staff per Review of Accounting Studies 2023.
2. **Liveness**: HTTP HEAD check. 404 / 403 / timeout rejected.
3. **Role match**: Title / department / JD keyword signals against the archetype index.
4. **Three-pass dedup**: URL exact -> `dedupKey` sha1(companySlug, roleNormalized, locationPrimary) -> MinHash LSH fuzzy at Jaccard >= 0.70 (128 permutations, 18x7 bands, bigram shingles, per LSHBloom arXiv 2411.04257).
5. **Cross-run history**: drop any posting whose company+role `dedupKey` was already applied to or skipped in `data/apply-queue.json` (keys on company+role, not URL, so the same job re-discovered from a different source never re-surfaces). Counted as `applied/skipped=N` in the after-filter log; bypass with `--include-applied`.

## Signals + Cache (per-run)

Not user-layer; not system-layer. Disposable per-run output, safe to delete.

- `signals/discovered/{date}/` - Per-run raw, merged, filtered, ranked, enriched posting sets (one JSONL per stage).
- `signals/cache/jd/` - 30-day JD-fetch cache, sha1-keyed.
- `signals/apply/{slug}/` - Camoufox apply harness channel: `state.json` (harness -> agent), `control.json` (agent -> harness), and `preview.png` (the glance screenshot). Disposable per application.
- `signals/apply/_profiles/{ats}/` - Persistent fingerprinted Camoufox profile for the Ashby reCAPTCHA-v3 warm mode (accumulates Google/reCAPTCHA cookies across runs). Gitignored (covered by `/signals/`), lock-guarded so Ashby runs one at a time; safe to delete (a cold profile just scores lower on the next Ashby run).
