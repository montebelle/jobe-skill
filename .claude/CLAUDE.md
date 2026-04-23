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
```

## Architecture
- `SKILL.md` is a 57-line router. Reads `modes/_shared.md` + `modes/_profile.md` + the appropriate mode file.
- 15 mode files in `modes/` (13 workflow modes + 2 shared context files)
- 4 agents: jd-analyzer, company-intel, competitor, job-discovery
- `lib/` modules: config (env loader with repo + ~/.jobe fallback), scoring, portfolio, tracker, normalize (ATS chars), sync-check, archetypes, patterns, snapshot, **posting (canonical Posting schema + parsers)**, **minhash (MinHash + LSH, pure JS)**, **dedup (URL exact + dedupKey + MinHash LSH fuzzy)**, **rrf (Reciprocal Rank Fusion k=60)**, **rank (quickScore + fullScore + fuseRanking via RRF)**, **enrich (JD fetch + 30-day cache)**, **ghost-score (multi-signal: age, repost, company-ratio, layoff, title-fuzz)**, **calibration (LLM-judge + human, Cohen's kappa)**, **bias-audit (name/school perturbation)**, **tailoring (generic/light/deep depth tracking)**
- `collectors/pipeline.js` orchestrates the unified discovery pipeline
- `collectors/sources/` is a source-plugin registry. Each plugin exports `{id, name, requires, discover}`:
  - `aggregators/` - SerpAPI Google Jobs, SerpAPI site: search, HN Who-is-hiring
  - `company-specific/` - Amazon (public JSON), Apple (SSR scrape)
  - `ats-directories/` - Ashby customer boards
  - `ats-direct/` - Greenhouse, Lever by known slug
- `data/queries/seeds.json` - seed queries driving discovery (role + location pairs)
- `data/companies/index.json` - emergent company index, auto-grown from every run
- `data/companies/negative-list.json` - slugs to exclude
- `signals/discovered/{date}/` - per-run raw, merged, ranked, enriched outputs
- `signals/cache/jd/` - 30-day JD cache (sha1-keyed)
- `scripts/` renders DOCX resumes + cover letters, both with ATS normalization via normalize()
- `data/` tracker, story-bank, followups, apply-queue
- `reports/{company-slug}/` per-job output

## Key Design Decisions
- Modes beat a long prompt: 15 files vs one monolith
- A-G block evaluation with ghost job detection (Block G)
- 6 archetypes drive evidence emphasis
- Positioning reasoning internal only, never in output
- ATS normalization in both render-docx.js AND render-cover-letter.js
- Recency: ATS collectors extract and filter by date fields (createdAt/publishedAt/updatedAt). WebSearch uses after: operator. Dead URLs filtered.
- **Discovery is query-driven, not company-driven.** The pipeline asks "what jobs in the market match the candidate?" not "what is new at this fixed watchlist?". The company whitelist (portals.json) is now a seed for the emergent company index (data/companies/index.json), not the primary source of truth.
- **Source plugin contract**: every file under collectors/sources/ exports `{id, name, requires, rateLimit, discover(ctx)}`. Missing env vars (listed in `requires`) cause the source to return `[]`; pipeline continues with remaining sources.
- **Dedup is downstream, not upstream.** Every source emits raw Posting[]; canonical schema in lib/posting.js normalizes, lib/dedup.js merges URL-exact then fuzzy on (company-slug, role-normalized, location-primary) sha1.
- **Enrichment is lazy.** Top-K (default 60) ranked postings get JD text fetched + comp extracted + 30-day cached. Rest skip enrich for speed.
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
