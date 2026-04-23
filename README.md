# Jobe — Career Intelligence Skill

Jobe is a [Claude Code](https://claude.com/claude-code) skill that runs the full job-search pipeline: discover recent postings across 8 source types, dedup them with MinHash LSH, rank with Reciprocal Rank Fusion, detect ghost jobs with a multi-signal model, generate ATS-normalized DOCX resumes + cover letters whose every claim traces to your own portfolio evidence, and track the whole funnel. Every empirical claim it makes is anchored to a citation in the code — no invented conversion rates, no unsourced percentages.

```bash
/jobe find                          # discover recent postings + auto-generate resumes for top matches
/jobe <URL>                         # evaluate a single posting (A–G blocks) + tailored resume + cover letter
/jobe apply-all                     # paste-ready blocks for each role in the apply queue
/jobe tracker                       # discovered → evaluated → applied → responded → interviewing → offer
/jobe interview-prep <company>      # STAR+R story mapping + likely questions
/jobe calibrate                     # weekly LLM-judge calibration (Cohen's kappa ≥ 0.75)
/jobe audit                         # demographic bias audit (name × school perturbations)
```

---

## Why another job tool

Most job-search tools optimize for volume (auto-apply to 200 roles) or for opinion (ChatGPT rewrites your resume). Jobe optimizes for **defensibility**: every score, every dedup, every tailoring decision is grounded in a documented method with a citation. You can argue with the output because you can see the mechanism.

Concretely:

- **Dedup** uses MinHash LSH (128 permutations, 18×7 bands, Jaccard ≥ 0.70 on bigram shingles) per [LSHBloom (arXiv 2411.04257)](https://arxiv.org/abs/2411.04257) and the datasketch library's production defaults. Not string similarity.
- **Ranking** uses Reciprocal Rank Fusion with k=60 per [Bruch et al, ACM TOIS 2024](https://dl.acm.org/doi/10.1145/3654207), which empirically beats dense-only retrieval by +1.4% nDCG and BM25-only by +18% on BEIR/MS MARCO.
- **Ghost-job detection** uses a max-pooled multi-signal model (age-vs-seniority, repost cadence, company hires-per-posting ratio, layoff proximity, title-fuzz) citing [Clarify Capital 2024 (n=1,200)](https://www.clarifycapital.com/job-listings-survey), [Revelio Labs 2024](https://www.revelio.com/), and [Hunter Ng arXiv 2410.21771](https://arxiv.org/abs/2410.21771).
- **LLM-judge calibration** enforces a Cohen's kappa ≥ 0.75 gate against human adjudication per [arXiv 2506.13639 (2025)](https://arxiv.org/abs/2506.13639). If your judge and you disagree too often, the system flags it rather than pretending the labels are ground truth.
- **Bias audit** runs 9 name × 7 school perturbations per [Bertrand & Mullainathan, AER 2004](https://www.aeaweb.org/articles?id=10.1257/0002828042002561) and [Brookings 2024](https://www.brookings.edu/articles/rethinking-the-impact-of-ai-on-hiring/). If your scorer varies by more than 15% across perturbations, it gets flagged.

Unsourced numeric claims (earlier versions had floating "8.2% interview rate" / "2.5× callbacks" figures with no traceable methodology) have been removed from the prompt library.

---

## Install

Jobe installs into your Claude Code directory (`~/.claude/skills/jobe/`) and its runtime to `~/.jobe/`.

```bash
git clone https://github.com/montebelle/jobe-skill.git
cd jobe-skill

# Install globally as a Claude Code skill
mkdir -p ~/.claude/skills/jobe ~/.claude/agents ~/.jobe
cp -r .claude/skills/jobe/* ~/.claude/skills/jobe/
cp .claude/agents/jobe-*.md ~/.claude/agents/
cp -r lib collectors scripts templates configs ~/.jobe/
cp package.json ~/.jobe/
cd ~/.jobe && npm install

# Required: create your personal profile
cp ~/.claude/skills/jobe/modes/_profile.template.md ~/.claude/skills/jobe/modes/_profile.md
$EDITOR ~/.claude/skills/jobe/modes/_profile.md          # fill in name, contact, target roles

# Required: create your portfolio evidence file
$EDITOR ~/.claude/skills/jobe/reference.md              # populate A1–A12 evidence (or your own domains)

# Optional: enable broader discovery
echo "SERPAPI_KEY=your_key_here" >> ~/.jobe/.env
```

Then in any Claude Code session, invoke `/jobe find` (or any other mode).

---

## The 15 modes

| Command | What it does |
|---|---|
| `/jobe find` | 8-source discovery (ATS APIs + web search + HN), dedup, rank, ghost-score, auto-generate resumes for top matches. |
| `/jobe <URL>` | Evaluate one posting against A–G blocks. |
| `/jobe <company> <role>` | Same, finds the posting first. |
| `/jobe apply <slug>` | Fill one application via Chrome (human-in-the-loop). |
| `/jobe apply-all` | Process entire apply queue; default paste-ready blocks, `--chrome` for automation. |
| `/jobe apply-assisted` | Alias for the paste-ready mode. |
| `/jobe batch url1 url2 …` | Evaluate multiple postings at once. |
| `/jobe tracker` | Pipeline view + conversion rates + orphan check. |
| `/jobe interview-prep <company>` | STAR+R story mapping + likely questions + company-specific prep. |
| `/jobe followup` | Follow-up cadence (7d/1d/same-day) + draft messages. |
| `/jobe patterns` | Analytics: conversion funnel, archetype performance, score thresholds. |
| `/jobe contacto <company>` | LinkedIn outreach drafts (4 types: recruiter / HM / peer / interviewer, 300 chars). |
| `/jobe deep <company>` | 6-axis company research (product / business / people / growth / risk / interview). |
| `/jobe project <path>` | Evaluate a portfolio project for archetype fit + interview defensibility. |
| `/jobe calibrate` | Weekly LLM-judge calibration loop (Cohen's kappa tracking). |
| `/jobe audit` | Demographic bias audit over the scorer. |

---

## A–G evaluation blocks

Each evaluation produces seven structured outputs:

| Block | Output |
|---|---|
| **A: Role Summary** | Archetype (AI Platform / Agentic / Applied ML / Causal / ML Infra / Forward Deployed) |
| **B: Portfolio Match** | 3 parallel sub-agents (jd-analyzer, company-intel, competitor) scoring every requirement against evidence from `reference.md` |
| **C: Positioning** | Gate-pass check + internal-only positioning strategy |
| **D: Compensation** | Salary-range research |
| **E: Resume + Cover Letter** | ATS-normalized DOCX (475–600 words, Calibri single-column), XYZ-formula bullets, achievement-first cover letter |
| **F: Story Mapping** | STAR+R stories mapped to JD requirements (Strong / Partial / None) |
| **G: Legitimacy** | Multi-signal ghost score → High Confidence / Proceed with Caution / Suspicious |

Gate-pass rules: Required Skills ≥ 50% and Experience Level ≥ 0.7 must both pass before resume generation. If either fails, Jobe shows the breakdown and asks before proceeding.

---

## 8-source discovery pipeline

Every source is a plugin under `collectors/sources/` implementing the same contract:

```js
module.exports = {
  id: 'source-id',
  name: 'Human-Readable Name',
  requires: ['ENV_VAR_NAME'],       // missing env vars → source returns []
  rateLimit: { rpm: 60 },
  async discover(ctx) { return [/* Posting[] */]; }
};
```

Sources ship in four categories:

- **Aggregators**: SerpAPI Google Jobs, SerpAPI site: search, HN Who-is-hiring
- **Company-specific**: Amazon public careers JSON, Apple SSR scrape
- **ATS directories**: Ashby customer boards
- **ATS direct**: Greenhouse by slug, Lever by slug

`pipeline.js` fans out all sources in parallel (rate-limited), normalizes into a canonical `Posting` schema, dedups three passes (URL exact → dedupKey sha1 → MinHash LSH fuzzy), updates the emergent `data/companies/index.json`, filters for recency / location / role, quick-ranks, lazily enriches the top-K (default 60) with JD text + compensation extraction + 30-day cache, full-ranks with JD-aware scoring + ghost detection + archetype detection, then persists per-run outputs under `signals/discovered/{date}/`.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full component diagram.

---

## Empirical backing (citations in code)

Every numerical claim traces to a paper or documented source. The core citations are embedded as code comments in the modules that use them:

| Module | Citation |
|---|---|
| `lib/minhash.js`, `lib/dedup.js` | [LSHBloom arXiv 2411.04257 (2024)](https://arxiv.org/abs/2411.04257); datasketch library defaults |
| `lib/rrf.js`, `lib/rank.js` | [Bruch et al ACM TOIS 2024](https://dl.acm.org/doi/10.1145/3654207): +1.4% nDCG over dense, +18% over BM25 on BEIR/MS MARCO |
| `lib/ghost-score.js` | [Clarify Capital 2024 n=1,200](https://www.clarifycapital.com/job-listings-survey); [Revelio Labs 2024](https://www.revelio.com/); [Hunter Ng arXiv 2410.21771](https://arxiv.org/abs/2410.21771) |
| `lib/calibration.js` | [arXiv 2506.13639 (2025)](https://arxiv.org/abs/2506.13639) — LLM-as-judge calibration |
| `lib/bias-audit.js` | [Bertrand & Mullainathan AER 2004](https://www.aeaweb.org/articles?id=10.1257/0002828042002561); [Brookings 2024](https://www.brookings.edu/articles/rethinking-the-impact-of-ai-on-hiring/) |
| `pipeline.js` (seniority recency) | Review of Accounting Studies 2023 on high-skill vacancy duration |
| `modes/find.md` (referral priority) | [Burks et al QJE 2015](https://academic.oup.com/qje/article/130/2/805/2330903); [Friebel et al NBER 2019](https://www.nber.org/papers/w26395) |
| `lib/tailoring.js` | Resume2Vec MDPI 2024 (+15.85% nDCG) as the strongest available anchor for tailoring-depth impact |

---

## Configuration

### `configs/default.json`
Template with candidate placeholder, scoring weights, match thresholds, and company tiers. Copy to `configs/local.json` (gitignored) for your own values.

### `.claude/skills/jobe/modes/_profile.md`
Your identity: name, contact, target roles, authorization status, portfolio domains. A template lives at `_profile.template.md`.

### `.claude/skills/jobe/reference.md`
Your portfolio evidence. Organize by domain (A1–A12 by default, or your own). Every resume bullet Jobe generates must trace back to a concrete entry here — that's the anti-fabrication guarantee.

### `data/queries/seeds.json`
Discovery seed queries. Each is a `{query, location, archetype}` tuple.

### `data/companies/negative-list.json`
Company slugs to exclude from discovery results.

### `.env`
API keys (SERPAPI_KEY optional, enables broader discovery).

---

## Anti-fabrication guarantees

1. **No bullet without evidence.** Every resume bullet must trace to a concrete entry in `reference.md`. If evidence is thin, the scorer returns weak-adjacency, not exact-match.
2. **No internal project names in output.** Describe by function ("autonomous ML operations platform"), not by your internal codename.
3. **ATS normalization.** `lib/normalize.js` strips em-dashes, smart quotes, and non-ASCII Unicode before every DOCX render, both for resumes and cover letters.
4. **Content differentiation.** Cover letter, "Why company X?", and custom application questions must use different evidence and framing. Enforced by the apply modes.
5. **Gate-pass before generation.** Required-skills coverage ≥ 50% and experience ≥ 0.7 before a resume is produced.

---

## Data contract (what stays private)

Two layers:

| Layer | Files | Install behavior |
|---|---|---|
| **User layer** (never overwritten) | `tracker.md`, `story-bank.md`, `followups.md`, `apply-queue.json`, `contacts.json`, `_profile.md`, `configs/local.json`, `.env`, `data/companies/index.json` (emergent), `reference.md` | Preserved on upgrade; install guarded with if-not-exists |
| **System layer** (replaced on upgrade) | `SKILL.md`, `reference.md` (template only), `modes/*.md`, `lib/*.js`, `collectors/`, `scripts/`, `agents/`, `configs/default.json` | Overwritten; treat as code |

The included `.gitignore` keeps the user-layer files out of any git operation.

See [`DATA_CONTRACT.md`](DATA_CONTRACT.md) for the full list.

---

## License

MIT — see [`LICENSE`](LICENSE).

## Contributing

Issues and PRs welcome. Source plugins are a natural extension point: add a new file under `collectors/sources/<category>/` implementing the `{id, name, requires, rateLimit, discover}` contract.
