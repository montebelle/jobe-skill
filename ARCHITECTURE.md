# Jobe — Architecture

## Component diagram

```mermaid
flowchart TB
    User([User: /jobe <mode>]) --> SKILL[SKILL.md router]
    SKILL --> SharedCtx[modes/_shared.md<br/>scoring, positioning,<br/>ATS rules]
    SKILL --> Profile[modes/_profile.md<br/>identity + targets]
    SKILL --> Mode[modes/{mode}.md]

    Mode --> Pipeline{collectors/pipeline.js}

    subgraph Sources[collectors/sources/ — plugin registry]
      direction LR
      Agg[aggregators/<br/>Brave<br/>SerpAPI Jobs + site:<br/>HN Who-hiring<br/>Remotive/RemoteOK/WWR/Himalayas<br/>LinkedIn guest<br/>Adzuna + JSearch]
      Comp[company-specific/<br/>Amazon<br/>Apple SSR]
      AtsDir[ats-directories/<br/>Ashby dirs]
      AtsDirect[ats-direct/<br/>Greenhouse<br/>Lever]
    end

    Pipeline --> Agg
    Pipeline --> Comp
    Pipeline --> AtsDir
    Pipeline --> AtsDirect

    Sources --> PostingNorm[lib/posting.js<br/>canonical Posting schema]
    PostingNorm --> Dedup[lib/dedup.js + lib/minhash.js<br/>URL exact → dedupKey sha1 → MinHash LSH fuzzy<br/>Jaccard ≥ 0.70, 128 perms, 18×7 bands]
    Dedup --> Filter[Recency + location + role + negative-list]
    Filter --> QuickRank[lib/rank.js quickScore]
    QuickRank --> Enrich[lib/enrich.js<br/>JD fetch + 30-day cache<br/>top-K only]
    Enrich --> FullRank[lib/rank.js fullScore via RRF k=60<br/>+ lib/ghost-score.js<br/>+ lib/archetypes.js]
    FullRank --> Persist[(signals/discovered/{date}/)]

    subgraph Evaluation[Evaluate mode: A–G blocks]
      direction TB
      BlockA[A: Role Summary<br/>archetype detection]
      BlockB[B: Portfolio Match<br/>3 parallel agents:<br/>jd-analyzer,<br/>company-intel,<br/>competitor]
      BlockC[C: Positioning]
      BlockD[D: Compensation]
      BlockE[E: Resume + Cover Letter<br/>ATS-normalized DOCX]
      BlockF[F: Story Mapping<br/>STAR+R → JD requirements]
      BlockG[G: Legitimacy<br/>ghost score]
    end

    Persist --> Evaluation
    Evaluation --> Render[scripts/render-docx.js<br/>render-cover-letter.js<br/>render-pptx.js<br/>ATS normalization via lib/normalize.js]
    Render --> Artifacts[reports/{slug}/<br/>resume.docx + cover-letter.docx]

    subgraph Calibration[Calibration + audit loops]
      LLMJudge[lib/calibration.js<br/>LLM-judge + human adjudication<br/>Cohen's kappa ≥ 0.75]
      BiasAudit[lib/bias-audit.js<br/>9 name × 7 school perturbations<br/>15% variance threshold]
    end

    Evaluation -.-> LLMJudge
    FullRank -.-> BiasAudit
```

## Execution model

1. **Skill router** (`.claude/skills/jobe/SKILL.md`) dispatches on the subcommand, then loads `modes/_shared.md` + `modes/_profile.md` + the relevant `modes/{mode}.md`.
2. **Pipeline orchestration** (`collectors/pipeline.js`) runs all plugin sources in parallel with per-source rate limiting. Sources with unmet `requires` (env vars) return `[]` and the pipeline continues without them. A cross-run history filter drops any posting whose company+role `dedupKey` was already applied to or skipped in `data/apply-queue.json` (so the same job re-discovered from a different source URL never re-surfaces); `--include-applied` bypasses it.
3. **Three-pass dedup** (`lib/dedup.js`):
   - Pass 1: canonical URL equality (merges `alternateUrls` sets).
   - Pass 2: exact `dedupKey` match = `sha1(companySlug + roleNormalized + locationPrimary)`.
   - Pass 3: MinHash LSH over bigram shingles with Jaccard ≥ 0.70.
4. **Quick-rank → enrich → full-rank**. Quick-rank uses title heuristics and a 5-bucket score. Enrichment is lazy — only the top-K (default 60) postings get full JD fetch + compensation extraction + 30-day cache. Full-rank fuses four independent scorers (portfolio match density, seniority, freshness, JD-keyword density) through RRF with k=60.
5. **Ghost-job detection** (`lib/ghost-score.js`) runs over the full-ranked set and attaches `ghostScore` + confidence label to each posting.
6. **Archetype detection** (`lib/archetypes.js`) is optional: with a user-defined `configs/archetypes.json` it classifies each posting into one of those buckets by keyword density; with none it returns `General`. The archetype biases which portfolio evidence the evaluation block emphasizes (and is a no-op under `General`, where evidence ranks by JD-keyword overlap).
7. **Evaluation** (A–G blocks) runs per-posting. Block B spawns three parallel sub-agents defined in `.claude/agents/jobe-*.md`.
8. **Rendering** (`scripts/render-*.js`) produces ATS-normalized DOCX + cover letter + a selectable text-based PDF + optional PPTX positioning deck. Normalization strips em-dashes / smart quotes / non-ASCII Unicode in both renderers. The resume DOCX renders Selected Projects **before** Experience and uses `keepNext` + an optional per-entry `pageBreakBefore` to avoid orphaned section/job headers, targeting a full two-page recruiter layout. Before writing, an advisory pass runs: `lib/tailor.auditResume` (required-section presence, metric-density band, AI-tell / wall-bullet checks, and a JD-vocabulary coverage check when the JD is supplied) and `auditProse` (an AI-register linter for the summary and cover letter). Both are advisory — they print `[resume-audit]` / `[prose-advisory]` warnings and never block the render. The cover-letter renderer parses `YYYY-MM-DD` dates at local noon to avoid a negative-UTC-offset off-by-one.
9. **Persistence**. Raw source outputs, merged postings, filtered postings, ranked postings, and enriched postings are each written per-run under `signals/discovered/{date}/` so any stage can be inspected after the fact.

## Why these specific algorithms

### MinHash LSH for dedup (not string similarity)
String similarity measures don't compose — the similarity between postings 1 and 2 says nothing about 1 and 3. MinHash gives you a sub-linear index (LSH bands) that makes "find all near-duplicates above Jaccard 0.70" cheap even on thousands of postings.

Parameters (128 permutations, 18×7 bands = 126 hashes) come from the datasketch library's production defaults, chosen empirically to give a ~50% detection rate at Jaccard 0.5 and near-100% at 0.7. Bigram shingles (not trigrams) to tolerate typical company-name / role-title variations across ATS mirrors.

Reference: [LSHBloom arXiv 2411.04257 (2024)](https://arxiv.org/abs/2411.04257).

### RRF for ranking (not learned-to-rank)
The signals we fuse (portfolio match density, seniority, freshness, JD keyword density) are on different scales with different noise profiles. Linear weighting requires picking coefficients and re-tuning them every time a new scorer is added. RRF does rank fusion — each scorer votes with ranks, not scores — and has no hyperparameters besides k.

k=60 empirically beats dense-only retrieval by +1.4% nDCG@10 and BM25-only by +18% on BEIR/MS MARCO in Bruch et al. For a job-ranking task where the scorers are cheap and we want robustness to any single scorer being miscalibrated, RRF is the right default.

Reference: [Bruch et al, ACM TOIS 2024](https://dl.acm.org/doi/10.1145/3654207).

### Max-pool for ghost-score (not sum)
If any one signal strongly suggests a ghost posting, the posting should be flagged — even if the other four signals look clean. Sum would wash out a strong individual signal with weak ones; max preserves it. The tradeoff is that max is more sensitive to false positives in any one signal, so we cap each signal at 0.85–0.9 rather than letting it reach 1.0.

References: [Clarify Capital 2024 (n=1,200)](https://www.clarifycapital.com/job-listings-survey); [Hunter Ng arXiv 2410.21771](https://arxiv.org/abs/2410.21771).

### Cohen's kappa for LLM-judge calibration (not raw agreement)
Two judges who both label 95% of postings as "high quality" will show 95% raw agreement even if they're guessing independently. Cohen's kappa corrects for chance agreement. The 0.75 threshold is from [arXiv 2506.13639 (2025)](https://arxiv.org/abs/2506.13639)'s survey of LLM-judge reliability studies — it's the kappa level above which LLM labels can be treated as roughly substitutable for human ones in downstream pipelines.

### Name × school perturbations for bias audit
Standard Bertrand & Mullainathan (2004) methodology: hold the resume content constant, perturb only the name and school, measure score variance. 9 names cover four broad demographic buckets; 7 schools cover Ivy / state / HBCU / international top / international other / community college.

15% variance threshold is a pragmatic choice — the AER 2004 paper found callback-rate differentials around that magnitude for the original audit — tuned further based on [Brookings 2024](https://www.brookings.edu/articles/rethinking-the-impact-of-ai-on-hiring/)'s AI-hiring-screener analysis.

## Data flow for a single run

```
/jobe find
  └─ load modes/{_shared, _profile, find}.md
  └─ collectors/pipeline.js
      ├─ spawn 19 sources in parallel (rate-limited)
      ├─ normalize to Posting[]
      ├─ dedup.js (URL → dedupKey → MinHash LSH)
      ├─ filter (recency ≤30d + location + role + negative-list + applied/skipped history)
      ├─ quickRank (title heuristic)
      ├─ enrich top-K (JD fetch + comp + 30d cache)
      ├─ fullRank (RRF k=60) + ghostScore + archetype
      └─ write signals/discovered/{date}/
  └─ for each top-N posting:
      ├─ evaluate (A–G blocks, 3 parallel sub-agents in Block B)
      ├─ render resume.docx + cover-letter.docx
      └─ append to tracker.md
```

## Manual ingest side-channel (LinkedIn)

The automated pipeline can only reach public, logged-out inventory. Two opt-in, user-present modes reach the personalized inventory through the Chrome extension without automating the user's session:

- `linkedin-tab` reads a LinkedIn Jobs tab the user already has open (read-only).
- `linkedin-search` drives the user's already-logged-in search across their profile queries and paginates, human-paced.

Both feed `collectors/ingest-manual.js`, which parses a Chrome-extension `read_page` accessibility dump (`lib/linkedin.parseSearchCards`), drops recruiter / staffing-agency slugs (`data/companies/staffing-list.json`) and negative-list companies, then normalizes → dedups → role-matches into the same `signals/discovered/{date}/` outputs the automated pipeline writes. The codifiable parts (URL build with Remote + Past-week filters, accessibility parse, staffing filter) live in `lib/linkedin.js`; the browser drive is agent-orchestrated because a headless source plugin cannot call the Chrome extension. Account-safety is hard: never unattended, headless, or scheduled; never solve a CAPTCHA.

## Extension points

- **Add a discovery source**: drop a new file under `collectors/sources/<category>/` exporting `{id, name, requires, rateLimit, discover(ctx)}`. Return canonical `Posting[]`. Dedup happens downstream.
- **Add a scorer signal**: add a function to `lib/rank.js` that maps a posting to a score (0–1). Include it in the list passed to `fuseRanking()`; RRF handles the combination.
- **Add an archetype**: extend `lib/archetypes.js` with the new archetype name, keyword list, and portfolio-domain mapping. `modes/_shared.md` also needs a row in the archetype detection table.
- **Swap the LLM judge**: `lib/calibration.js` treats the judge as a black box. Any callable that returns a label + rationale works.
