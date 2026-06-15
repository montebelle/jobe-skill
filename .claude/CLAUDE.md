# Jobe - Career Intelligence Skill

Full-pipeline job search automation: discover, evaluate, apply, track, follow up, interview prep, analyze.

## Commands
```
/jobe find                          Discover recent jobs (30-day filter + liveness check) + auto-generate resumes
/jobe [URL]                         Evaluate posting with A-G blocks, generate resume + cover letter
/jobe [company] [role]              Same, finds the posting first
/jobe apply [slug]                  Fill one application form via Chrome (human-in-the-loop)
/jobe apply-all                     Process entire apply queue (paste-ready default, --chrome for browser)
/jobe apply-assisted                Same as apply-all default: paste-ready blocks
/jobe batch url1 url2 ...           Evaluate multiple postings
/jobe tracker                       View pipeline + stats + conversion rates + orphan check
/jobe interview-prep [company]      STAR+R story mapping + likely questions
/jobe followup                      Follow-up cadence + message drafting
/jobe patterns                      Application history analytics
/jobe contacto [company]            LinkedIn outreach (4 contact types, 300 char)
/jobe deep [company]                6-axis company research
/jobe project [path]                Portfolio project evaluation
/jobe linkedin-tab                  Ingest YOUR open LinkedIn Jobs tab (read-only via Chrome ext)
```

## Architecture
- `SKILL.md` is a 57-line router. Reads `modes/_shared.md` + `modes/_profile.md` + the appropriate mode file.
- 19 mode files in `modes/` (17 workflow modes + 2 shared context files; `linkedin-tab` reads the user's open LinkedIn Jobs tab)
- 4 agents: jd-analyzer, company-intel, competitor, job-discovery
- `lib/` modules: config (env loader with repo + `~/.jobe` fallback), scoring, portfolio, tracker, normalize (ATS chars), sync-check, archetypes, patterns, snapshot, **posting (canonical Posting schema + parsers)**, **minhash (MinHash + LSH, pure JS)**, **dedup (URL exact + dedupKey + MinHash LSH fuzzy)**, **rrf (Reciprocal Rank Fusion k=60)**, **role-queries (derives role search terms + a title matcher from the user's seeds; shared by every source and by rank)**, **rank (profile-driven: title gate + fullScore from the user's target-role tokens + bullet-library keywords; permissive when unconfigured; RRF fusion of profile-overlap/seniority/freshness)**, **enrich (JD fetch + 30-day cache, with extractors for Greenhouse / Lever / Ashby / Workday / SmartRecruiters)**, **ghost-score (multi-signal: age, repost, company-ratio, layoff, title-fuzz)**, **calibration (LLM-judge + human, Cohen's kappa)**, **bias-audit (name/school perturbation)**, **tailoring (generic/light/deep depth tracking)**, **bullet-select (per-JD bullet selection from `data/bullet-library.json` filtered by archetype, scored by JD-keyword overlap, returning experience[] + selectedProjects[] ready for resume JSON)**, **slug-harvest (role-less Brave queries that enumerate unknown ATS slugs into the index before each run, making the seed list vestigial)**, **agent-import (merges WebSearch-agent fallback discoveries into the pipeline output: extracts ATS slugs into `data/companies/index.json`, normalizes, filters, enriches, fullScores, dedups, updates in place)**, **tracker-writer (atomic-write tracker.md + apply-queue.json mutations, plus `moveReportFolder` helper for `reports/{slug}` -> `reports/{applied|skipped}/{slug}` relocation)**, **tailor (JD-grounded tailoring: analyzeJD + rankEvidence + tailorBrief — the deterministic half of the reframe-to-JD step the generator runs)**
- `collectors/pipeline.js` orchestrates the unified discovery pipeline. Phase 0 = slug-harvest, phase 1 = parallel sources, phase 2 = filter + enrich (top 300) + score, phase 3 = persist + write `discovery-summary.json` with `needsAgentFallback` boolean
- `collectors/sources/` is a source-plugin registry. Each plugin exports `{id, name, requires, rateLimit, discover(ctx) -> Posting[]}`:
  - `aggregators/` - **Brave Search (recommended free path: 2K queries/mo, set `BRAVE_API_KEY`)**, SerpAPI Google Jobs, SerpAPI site: search, HN Who-is-hiring, **Remotive / RemoteOK / WeWorkRemotely / Himalayas (key-free remote boards)**, **linkedin-guest (public logged-out endpoint, no account automation)**, **Adzuna (ADZUNA_APP_ID/KEY)**, **JSearch (JSEARCH_API_KEY)**. Brave + SerpAPI use a per-(domain x role) query fan-out (~80 queries / run) instead of a single OR-megaquery, so specialty roles surface instead of being drowned under common terms
  - `company-specific/` - Amazon (public JSON), Apple (SSR scrape)
  - `ats-directories/` - Ashby customer boards
  - `ats-direct/` - Greenhouse, Lever, **Workday (multi-tenant)**, **SmartRecruiters (multi-company)**, **iCIMS (best-effort HTML scrape)**
- `collectors/ingest-manual.js` - human-in-the-loop ingest feeding the `linkedin-tab` mode: reads the user's OWN open LinkedIn Jobs tab via the Chrome extension (read-only); the logged-in session is never automated.
- `data/queries/seeds.json` - seed queries driving discovery (role + location pairs; covers tech + finance + pharma + retail + CPG + media + auto + telecom + energy + healthcare + insurance + defense)
- `data/companies/index.json` - emergent company index, auto-grown from every run + slug-harvest phase
- `data/companies/negative-list.json` - slugs to exclude
- `data/companies/non-tech-seed.json` - verified Workday tenants + SmartRecruiters companies + iCIMS hosts for non-tech industry coverage
- `data/resume-baseline.json` - canonical resume structure (your own experience entries)
- `data/bullet-library.json` - per-role bullet pool with optional top-level `companyKeyMap`; each bullet tagged with `archetypes[]` and `keywords[]` for per-JD selection via `lib/bullet-select.js`
- `signals/discovered/{date}/` - per-run raw, merged, ranked, enriched, **discovery-summary** outputs
- `signals/cache/jd/` - 30-day JD cache (sha1-keyed)
- `scripts/` renders DOCX resumes + cover letters with ATS normalization, plus `bulk-resume-from-list.js` for fast triage runs over many URLs
- `data/` tracker, story-bank, followups, apply-queue
- `reports/applied/{slug}/` and `reports/skipped/{slug}/` per-job output (relocated by `moveReportFolder()` after apply or skip)

## Key Design Decisions
- Modes beat a long prompt: 15 files vs one monolith
- A-G block evaluation with ghost job detection (Block G)
- Archetypes are optional + user-defined (`configs/archetypes.json`); default is `General` (rank evidence by JD-keyword overlap). No field-specific archetypes ship.
- Positioning reasoning internal only, never in output
- ATS normalization in both render-docx.js AND render-cover-letter.js
- Recency: ATS collectors extract and filter by date fields (createdAt/publishedAt/updatedAt). WebSearch uses after: operator. Dead URLs filtered.
- **Discovery is query-driven, not company-driven.** The pipeline asks "what jobs in the market match the candidate?" not "what is new at this fixed watchlist?". The company whitelist (portals.json) is now a seed for the emergent company index (data/companies/index.json), not the primary source of truth.
- **Source plugin contract**: every file under collectors/sources/ exports `{id, name, requires, rateLimit, discover(ctx)}`. Missing env vars (listed in `requires`) cause the source to return `[]`; pipeline continues with remaining sources.
- **Dedup is downstream, not upstream.** Every source emits raw Posting[]; canonical schema in lib/posting.js normalizes, lib/dedup.js merges URL-exact then fuzzy on (company-slug, role-normalized, location-primary) sha1.
- **Enrichment is broad, scoring is JD-driven.** Top-K (default 300, was 60) gate-passing postings get JD text fetched + comp extracted + 30-day cached. The title gate + fullScore are profile-driven: postings are matched and scored against the user's target-role tokens (`data/queries/seeds.json`) and bullet-library keywords, permissive when unconfigured — no hardcoded role vocabulary. The pre-enrich quickScore only sets enrichment priority (seniority + freshness + ATS-canonical-URL boost).
- **Slug-harvest before discovery.** Phase 0 issues 21 role-less Brave queries (`site:boards.greenhouse.io after:DATE`, etc.) to enumerate unknown ATS slugs into `data/companies/index.json` before the parallel source loop runs. Direct-ATS plugins re-read the index at discover-time, so the same run reaps the new slugs. Over time the seed list becomes irrelevant — the index becomes the source of truth.
- **Bullet selection per JD (required for resume generation).** `lib/bullet-select.js` `buildExperience(baseline, spec)` + `pickProjects(spec, n)` filter `data/bullet-library.json` by archetype, score remaining bullets by JD-keyword overlap, and return ordered bullet/project arrays. Reordering a fixed bullet pool produces resumes that share identical body content across postings (only summary + cover letter differ); per-JD selection produces real differentiation.
- **WebSearch agent fallback.** When `discovery-summary.json.needsAgentFallback` is true (Brave returned <100 OR merged set <300), the find mode launches the `jobe-job-discovery` agent which uses Claude Code's WebSearch tool (no API quota) to targetedly hunt slugs the search APIs missed. The agent writes `signals/discovered/{date}/agent-discovered.json`; `lib/agent-import.js` extracts slugs into the index, normalizes + filters + enriches + scores, and merges into `ranked-enriched.json`.
- **Cover letter quality bar.** Every cover letter must contain (1) a specific dollar amount or measurable business outcome, (2) one leadership / scope signal, (3) one decision-grade outcome. The `_shared.md` Cover Letter section enforces this. Bulk-resume helper (`scripts/bulk-resume-from-list.js`) ships resume DOCX with `coverLetter` blank for follow-up composition.
- **Empirical backing (citations in lib/ modules):**
  - MinHash LSH fuzzy dedup (lib/minhash.js, lib/dedup.js): LSHBloom arXiv 2411.04257 (2024); datasketch defaults (128 perms, 18x7 bands, Jaccard >= 0.70 with bigram shingles).
  - RRF hybrid-ranking k=60 (lib/rrf.js, lib/rank.js): Bruch et al ACM TOIS 2024; +1.4% nDCG over dense, +18% over BM25 on BEIR/MS MARCO.
  - Multi-signal ghost detection (lib/ghost-score.js): Clarify Capital 2024 (n=1,200), Revelio Labs 2024, Hunter Ng arXiv 2410.21771.
  - Seniority-aware recency (+15 days for senior/staff in pipeline.js): Review of Accounting Studies 2023 on high-skill vacancy duration.
  - LLM-judge calibration (lib/calibration.js, Cohen's kappa >= 0.75 flag): arXiv 2506.13639 (2025).
  - Bias-audit (lib/bias-audit.js, name/school perturbations): Bertrand & Mullainathan AER 2004, Brookings 2024.
  - Referral-first pipeline ordering (modes/find.md): Burks et al QJE 2015 + Friebel et al NBER 2019 (field experiment).
  - Tailoring-depth tracking (lib/tailoring.js): Resume2Vec MDPI 2024 (+15.85% nDCG) as the strongest available anchor; tracking in tracker verifies the prior.
- **Unsourced numeric claims removed** from `_shared.md` ATS Format Rules (old "8.2% interview rate", "2.5x callbacks", "40% more callbacks" had no traceable methodology).
- Content differentiation: cover letter, "Why X?", and custom questions use different evidence. Rules in both evaluate.md and apply-assisted.md.
- Gate-pass scoring before resume generation
- Anti-fabrication: every claim traces to code. No internal project names.
- Deep technical bullets: algorithms, parameter values, architectural patterns
- Data contract: user-layer never overwritten. System-layer replaced on install. default.json protected with if-not-exists guard.
- install scripts copy CLAUDE.md, all 23 lib files, all modes, all agents
