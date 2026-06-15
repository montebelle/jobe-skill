# Data Contract

Defines the boundary between user data and system data.

## User Layer (NEVER auto-modified by install or update)

These files contain user-specific data. Install scripts create them only if they don't exist.

- `data/tracker.md` - Application pipeline
- `data/story-bank.md` - STAR+R interview stories
- `data/followups.md` - Follow-up cadence tracking
- `data/apply-queue.json` - Ordered apply queue with applied/skipped status
- `data/contacts.json` - Referral network for `/jobe contacto`
- `data/resume-baseline.json` - Most recent tailored resume (user-edited)
- `data/companies/index.json` - Emergent company index (grows every discovery run; user can curate)
- `modes/_profile.md` - User identity, contact, preferences
- `configs/default.json` - Scoring weights, company tiers (guarded with if-not-exists)
- `.env` - API keys
- `reference.md` - Portfolio evidence. Every resume bullet must trace to an entry here.

## System Layer (overwritten on install/update)

These files contain skill logic and can be safely replaced.

- `.claude/CLAUDE.md` - Project documentation
- `.claude/skills/jobe/SKILL.md` - Router
- `.claude/skills/jobe/modes/*.md` - All mode files except `_profile.md`
- `.claude/agents/jobe-*.md` - 4 agent definitions (jd-analyzer, company-intel, competitor, job-discovery)
- `lib/*.js` - 23 modules including:
  - Infrastructure: config, normalize, rate-limiter, network, snapshot, sync-check
  - Scoring + ranking: scoring, portfolio, archetypes, rank, rrf
  - Discovery: posting, dedup, minhash, enrich
  - Quality + audit: ghost-score, calibration, bias-audit, tailoring
  - Tracker: tracker, tracker-stats, tracker-writer, patterns
- `collectors/pipeline.js` - Unified orchestrator across all plugin sources
- `collectors/sources/**/*.js` - 19 source plugins:
  - `aggregators/` - Brave Search, SerpAPI Google Jobs, SerpAPI site:, HN Who-is-hiring, Remotive, RemoteOK, WeWorkRemotely, Himalayas, LinkedIn guest, Adzuna, JSearch
  - `company-specific/` - Amazon public JSON, Apple SSR
  - `ats-directories/` - Ashby customer-board enumeration
  - `ats-direct/` - Greenhouse, Lever, Workday, SmartRecruiters, iCIMS by slug
- `scripts/*.js` - Render scripts (render-docx + render-cover-letter both call normalize(), render-pdf, render-pptx); `tailor-brief.js` emits the per-JD JD-grounded tailoring brief (`lib/tailor.js`)
- `configs/portals.json` - Seed slugs for the emergent company index
- `data/queries/seeds.json` - Seed discovery queries (query x location x archetype)
- `data/companies/negative-list.json` - Slugs to exclude from discovery

## Reports Directory Structure

Reports are organized by pipeline status. Move folders as status changes so the top-level `reports/` only shows ACTIVE work.

- `reports/{slug}/` - **Evaluated** roles: generated but not yet applied or decided against. This is the active pipeline.
- `reports/applied/{slug}/` - **Applied** roles: submitted. Archive here when status flips from Evaluated -> Applied.
- `reports/skipped/{slug}/` - **Skipped** roles: intentionally not applied to (ghost job, level mismatch, duplicate, etc.). Archive here when status flips to Skipped.

Auto-archive behavior (enforced by apply.md and apply-all.md):
- On Apply submission: `mkdir -p reports/applied && mv reports/{slug} reports/applied/{slug}` AND rewrite the Resume path in `data/tracker.md` from `reports/{slug}/` to `reports/applied/{slug}/`.
- On Skip: `mkdir -p reports/skipped && mv reports/{slug} reports/skipped/{slug}` AND rewrite the Resume path in `data/tracker.md` from `reports/{slug}/` to `reports/skipped/{slug}/`.
- Evaluated folders stay at the top level until one of those transitions happens.

## Discovery Pipeline Gates

Every job posting passes through these filters before entering the queue:

1. **Recency**: ATS collectors filter by `updated_at` / `createdAt` / `publishedAt` within 30 days. WebSearch uses `after:` operator. Seniority-adjusted +15 days for senior/staff per Review of Accounting Studies 2023.
2. **Liveness**: HTTP HEAD check. 404 / 403 / timeout rejected.
3. **Role match**: Title / department / JD keyword signals against the archetype index.
4. **Three-pass dedup**: URL exact -> `dedupKey` sha1(companySlug, roleNormalized, locationPrimary) -> MinHash LSH fuzzy at Jaccard >= 0.70 (128 permutations, 18x7 bands, bigram shingles, per LSHBloom arXiv 2411.04257).

## Signals + Cache (per-run)

Not user-layer; not system-layer. Disposable per-run output, safe to delete.

- `signals/discovered/{date}/` - Per-run raw, merged, filtered, ranked, enriched posting sets (one JSONL per stage).
- `signals/cache/jd/` - 30-day JD-fetch cache, sha1-keyed.
