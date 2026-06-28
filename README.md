# Jobe

**A career-intelligence skill for [Claude Code](https://claude.com/claude-code).** Jobe searches the open job market for you, ranks postings against your portfolio, and writes ATS-clean resumes and cover letters whose every claim traces to evidence you control. It runs as a set of slash commands inside Claude Code: `/jobe find`, `/jobe <url>`, `/jobe apply-all`, `/jobe tracker`.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-skill-orange)](https://claude.com/claude-code)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)

```bash
/jobe find                 # discover, dedup, rank, ghost-score; auto-evaluate top matches
/jobe <posting-url>        # one-shot evaluation: A-G analysis + resume + cover letter
/jobe batch url1 url2 ...  # evaluate many postings; per-JD bullet selection per resume
/jobe apply-all            # auto-apply the queue via Camoufox stealth automation (--paste for paste-ready fallback)
/jobe tracker              # discovered -> evaluated -> applied -> responded -> offer
/jobe interview-prep <co>  # STAR+R story mapping + likely questions
```

## Table of contents

1. [What Jobe does](#what-jobe-does)
2. [Quick start](#quick-start)
3. [How it works](#how-it-works)
4. [All 15 commands](#all-15-commands)
5. [Configuration](#configuration)
6. [Why Jobe (defensibility)](#why-jobe-defensibility)
7. [Empirical backing](#empirical-backing)
8. [FAQ](#faq)
9. [Privacy and the data contract](#privacy-and-the-data-contract)
10. [Contributing](#contributing)
11. [License](#license)

---

## What Jobe does

Jobe runs four loops over your job search:

- **Discover.** Scans 12 job sources in parallel (ATS APIs + web search + HN) every time you run `/jobe find`. Dedupes with MinHash LSH, ranks with Reciprocal Rank Fusion, scores ghost-job risk with a multi-signal model, filters to remote-US (or whatever your `_profile.md` says).
- **Evaluate.** For each posting that passes a gate-pass check, Jobe writes a tailored resume and cover letter. Bullet selection is per-JD: `lib/bullet-select.js` filters your bullet library by the posting's archetype, scores each remaining bullet against the JD's keywords, and picks the top N per role. No two resumes share identical body text.
- **Apply.** Auto-fills and submits real ATS forms (Greenhouse / Lever / Ashby) via **Camoufox** — a stealth Firefox that does not leak the automation fingerprints a CDP-driven Chrome does, so it avoids the CAPTCHA / email-confirm walls. Each application: auto-fill, a quick glance (screenshot + field summary) for your review, submit, then close the email-confirmation loop. Free-text questions are written from your own evidence, never invented. `--paste` falls back to paste-ready blocks for login-walled forms. EEO/demographic questions decline by default (opt in via `data/apply-profile.json`).
- **Track.** A simple markdown tracker plus an apply queue, with conversion rates, follow-up cadences, and orphan detection.

Jobe is **not** an auto-apply spambot and not a generic ChatGPT resume rewriter. Every claim it puts on a resume traces to a specific entry in your portfolio reference file. Every score traces to a documented method with a citation.

### Optional: a self-hosted dashboard (`web/`)

A Next.js dashboard ships in `web/` for visualizing the pipeline locally. Pipeline overview with a typographic funnel, queue management with keyboard shortcuts (`j`/`k` navigate, `a` apply, `s` skip), per-posting detail pages with resume + cover letter previews, analytics, and the latest discovery run. Reads from your local filesystem; nothing leaves the machine.

```bash
npm run web:install   # one-time
npm run dev           # http://localhost:3000
```

See [`web/README.md`](web/README.md) for the full feature tour.

---

## Quick start

### Prerequisites

- [Claude Code](https://claude.com/claude-code) installed and signed in.
- [Node.js](https://nodejs.org/) 20 or newer.
- Git.
- Optional but recommended: a free [Brave Search API key](https://api.search.brave.com) (2,000 queries / month, no card). Without it, discovery falls back to public ATS APIs and HN, which surfaces a few hundred postings per run instead of a few thousand.

### Install

```bash
# 1. Clone and install dependencies
git clone https://github.com/montebelle/jobe-skill.git
cd jobe-skill
npm install

# 2. Wire it into Claude Code as a skill
mkdir -p ~/.claude/skills/jobe ~/.claude/agents
cp -r .claude/skills/jobe/* ~/.claude/skills/jobe/
cp .claude/agents/jobe-*.md ~/.claude/agents/

# 3. (Optional, for auto-apply) fetch the Camoufox stealth browser, one-time ~311MB
npx camoufox-js fetch
```

> Prefer a global install? Run `./install-local.sh` from the clone instead of steps 2–3 — it copies the
> skill into `~/.claude/` and the code into `~/.jobe/`, runs `npm install`, and fetches Camoufox for you,
> so `/jobe` works from any directory.

### Onboard (15-30 minutes, guided)

In any Claude Code session inside the cloned repo:

```
/jobe onboard
```

This is a guided interview that produces every personal file Jobe needs — `_profile.md`, `reference.md`, `data/resume-baseline.json`, `data/bullet-library.json`, and `.env`. You answer questions in plain English (paste your existing resume up front to skip half the steps); Jobe writes the files for you.

The interview has 7 steps:

1. **Identity** — name, contact, target roles, target locations, work auth, salary floor.
2. **Resume baseline** — paste your current resume OR walk through your work history. Jobe parses into the canonical structure.
3. **Portfolio evidence** — 5-10 projects, with specifics (algorithms, parameter values, scale numbers, outcomes, failure modes addressed). This is the source-of-truth for everything Jobe puts on a resume.
4. **Bullet library** — Jobe drafts 4-8 candidate bullets per role from your project descriptions; you accept / edit / regenerate / discard each one. Keys auto-mapped from your work history.
5. **API keys** (optional) — Brave Search recommended (free, 2K queries / month, no card).
6. **Preferences** — companies to exclude, industries to deprioritize.
7. **Smoke test** — small discovery + one end-to-end evaluation so you see a tailored resume + cover letter come out before you trust the rest.

You can re-run any single step later with `/jobe onboard profile`, `/jobe onboard resume`, `/jobe onboard evidence`, or `/jobe onboard keys`.

### First real run

```
/jobe find
```

You'll see something like:

```
[19:00:05] sources loaded: brave-search, serpapi-google-jobs, ..., greenhouse-direct, lever-direct
[19:00:05] slug-harvest: +68 new slugs across 21 queries (index: 822)
[19:00:05] total raw: 2412
[19:00:05] after dedup: 2157
[19:00:05] after filter: 230 (rejected: role=528 recency=0 loc=275 non-remote=1042)
[19:00:05] enriching top 211
[19:00:05] done. wrote signals/discovered/2026-04-30
```

Jobe will then auto-evaluate the matches scoring above 80, list the 65-79 band for confirmation, and let you trigger evaluations on demand. Output for each posting goes to `reports/{slug}/`: a tailored resume DOCX, a cover-letter DOCX, and an analysis markdown. Each one is added to `data/apply-queue.json` for the next `/jobe apply-all` pass.

---

## How it works

The discovery pipeline runs in four phases:

### Phase 0: Slug harvest

Before any role-keyword query runs, `lib/slug-harvest.js` issues 21 role-less Brave queries against each ATS domain (`site:boards.greenhouse.io after:DATE`, `site:jobs.ashbyhq.com after:DATE`, etc.) to enumerate company slugs Jobe doesn't yet know about. New slugs land in `data/companies/index.json` immediately, and the direct-ATS plugins re-read the index at discover-time, so the same run reaps them. Over weeks of use the seed list becomes vestigial — the index *becomes* the source of truth.

### Phase 1: Discovery

`collectors/pipeline.js` fans out 19 source plugins in parallel, rate-limited per source:

| Category | Sources |
|---|---|
| Aggregators (keyword-driven, cross-platform) | Brave Search, SerpAPI Google Jobs, SerpAPI site: search, HN Who-is-hiring, Remotive, RemoteOK, WeWorkRemotely, Himalayas, LinkedIn (guest), Adzuna, JSearch |
| Company-specific | Amazon, Apple |
| ATS directories | Ashby customer boards |
| ATS direct (per-slug API) | Greenhouse, Lever, Workday, SmartRecruiters, iCIMS |

Brave and SerpAPI use a per-(domain x role) query fan-out (~80 queries / run). One single-role query against a single ATS domain returns 20 highly-relevant URLs; OR-megaqueries return 20 generic ones dominated by the most common term. The split surfaces specialty roles that the megaquery drowned.

Every source emits raw `Posting[]` in a canonical schema. `lib/dedup.js` then runs three passes:

1. URL exact match.
2. `dedupKey` sha1 over normalized (company-slug, role, location).
3. MinHash LSH fuzzy match (128 perms, 18x7 bands, Jaccard >= 0.70 on bigram shingles).

### Phase 2: Filter, enrich, score

Filters apply: recency window (30 days, +15 for senior / staff per *Review of Accounting Studies 2023*), location (remote / US / hybrid based on `_profile.md`), role gate (posting titles matched against your target-role tokens from `data/queries/seeds.json`; permissive when you have no seeds yet), queue, negative list.

Every gate-passing posting (default cap 300) gets enriched: JD text fetched, compensation extracted, 30-day cached. Then `fullScore` runs on JD content (50 baseline + signal-based deltas, clamped to [0, 100]). Pre-enrich `quickScore` only sets enrichment priority (seniority + freshness + ATS-canonical-URL boost); it does not gate.

### Phase 3: Agent fallback

The pipeline writes `signals/discovered/{date}/discovery-summary.json` with a `needsAgentFallback` flag (true when Brave returned <100 OR merged set <300). The find mode reads it. If true, it launches the `jobe-job-discovery` agent, which uses Claude Code's built-in `WebSearch` tool (no API quota) to targetedly hunt slugs the search APIs missed. The agent writes structured JSON; `lib/agent-import.js` extracts ATS slugs into the index, normalizes + filters + enriches + scores those discoveries, and merges them into `ranked-enriched.json`.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full component diagram.

---

## All commands

| Command | What it does |
|---|---|
| `/jobe onboard` | **Run this first.** Guided interview that produces every personal file Jobe needs (`_profile.md`, `reference.md`, `data/resume-baseline.json`, `data/bullet-library.json`, `data/apply-profile.json`, `.env`). 15-30 min. Re-runnable per-section. |
| `/jobe find [filter]` | Phase 0-3 discovery; auto-evaluate matches above the strong threshold. Optional free-form filter (role / location / company). |
| `/jobe <url>` | Evaluate one posting. Runs A-G blocks: role summary, portfolio match, positioning, comp, resume + cover letter, story mapping, legitimacy. |
| `/jobe <company> <role>` | Same, finds the canonical posting URL first via WebSearch. |
| `/jobe batch url1 url2 ...` | Evaluate many postings; cross-posting bullet differentiation enforced. |
| `/jobe apply <slug>` | Fill + submit one application via Camoufox stealth automation; glance before submit + email-confirm loop. `--paste` falls back to paste-ready. |
| `/jobe apply-all` | Auto-apply the entire queue via Camoufox (default). `--top N`, `--paste` fallback, `--headless`. |
| `/jobe apply-assisted` | Fallback: paste-ready blocks for login-walled forms. |
| `/jobe tracker` | Pipeline view, conversion rates, orphan check. |
| `/jobe interview-prep <co>` | STAR+R story mapping plus likely questions plus company-specific prep. |
| `/jobe followup` | Follow-up cadence (7d / 1d / same-day) and draft messages. |
| `/jobe patterns` | Analytics: conversion funnel, archetype performance, score thresholds. |
| `/jobe contacto <co>` | LinkedIn outreach drafts (recruiter / HM / peer / interviewer; 300 chars). |
| `/jobe deep <co>` | 6-axis company research (product, business, people, growth, risk, interview signals). |
| `/jobe project <path>` | Evaluate a portfolio project for archetype fit and interview defensibility. |
| `/jobe calibrate` | Weekly LLM-judge calibration loop (Cohen's kappa tracking, threshold >= 0.75). |
| `/jobe audit` | Demographic bias audit over the scorer (name x school perturbations). |

---

## Configuration

Five files drive Jobe's behavior. Two are templates, three are private to you.

| File | Purpose | Source |
|---|---|---|
| `.env` | API keys (Brave, SerpAPI, GitHub) | Copy from `.env.example` |
| `.claude/skills/jobe/modes/_profile.md` | Your name, contact, target roles, target locations | Copy from `_profile.template.md` |
| `reference.md` | Portfolio evidence (project by project) | Copy from `templates/reference.template.md` |
| `data/resume-baseline.json` | Your canonical resume structure (companies, dates) | Copy from `templates/resume-baseline.template.json` |
| `data/bullet-library.json` | Per-role bullet pool, archetype-tagged | Copy from `templates/bullet-library.template.json` |

The `companyKeyMap` in `bullet-library.json` is what bridges your `resume-baseline.json` `experience[].company` strings to the role-keys under which the bullet pools live. Get this mapping right and `lib/bullet-select.js` will never mix one role's bullets into another role's section.

Optional supporting files:

- `data/companies/non-tech-seed.json` — initial Workday / SmartRecruiters / iCIMS tenants. Slug-harvest grows this automatically over time.
- `data/queries/seeds.json` — seed queries (role + location pairs). Default covers tech + finance + healthcare + retail + energy + defense.
- `data/companies/negative-list.json` — slugs you never want surfaced.

---

## Why Jobe (defensibility)

Most job-search tools optimize for volume (auto-apply to 200 roles) or for opinion (ChatGPT rewrites your resume). Jobe optimizes for **defensibility**: every score, every dedup decision, every tailoring choice is grounded in a documented method with a citation. You can argue with the output because you can see the mechanism.

Three concrete consequences:

1. **No bullet without evidence.** Every resume bullet must trace to a concrete entry in your `reference.md`. Internal codenames are stripped at render. If evidence is thin, the scorer returns weak-adjacency, not exact-match.
2. **No invented numbers.** Earlier prompt libraries floated figures like "8.2% interview rate" and "2.5x callbacks" with no traceable methodology. Those have been removed. The empirical claims that remain are cited inline in the modules that use them — see the next section.
3. **Bias and calibration are observable.** `/jobe audit` perturbs candidate names and schools to surface scorer variance. `/jobe calibrate` enforces a Cohen's kappa >= 0.75 gate against your own human adjudication labels.

---

## Empirical backing

Every numerical claim Jobe relies on is anchored in a citation embedded as a comment in the module that uses it.

| Module | Method | Citation |
|---|---|---|
| `lib/minhash.js`, `lib/dedup.js` | MinHash LSH, 128 perms, 18x7 bands, Jaccard >= 0.70 on bigram shingles | [LSHBloom (arXiv 2411.04257, 2024)](https://arxiv.org/abs/2411.04257) + datasketch defaults |
| `lib/rrf.js`, `lib/rank.js` | Reciprocal Rank Fusion, k=60 | [Bruch et al, ACM TOIS 2024](https://dl.acm.org/doi/10.1145/3654207). +1.4% nDCG over dense, +18% over BM25 on BEIR / MS MARCO |
| `lib/ghost-score.js` | Multi-signal ghost-job model (max-pooled) | [Clarify Capital 2024 n=1,200](https://www.clarifycapital.com/job-listings-survey); [Revelio Labs 2024](https://www.revelio.com/); [Hunter Ng (arXiv 2410.21771)](https://arxiv.org/abs/2410.21771) |
| `pipeline.js` | Seniority-aware recency (+15 days for senior / staff IC) | *Review of Accounting Studies* 2023 on high-skill vacancy duration |
| `lib/calibration.js` | LLM-as-judge calibration vs human, Cohen's kappa >= 0.75 | [arXiv 2506.13639 (2025)](https://arxiv.org/abs/2506.13639) |
| `lib/bias-audit.js` | Name x school perturbation bias audit | [Bertrand & Mullainathan (AER 2004)](https://www.aeaweb.org/articles?id=10.1257/0002828042002561); [Brookings 2024](https://www.brookings.edu/articles/rethinking-the-impact-of-ai-on-hiring/) |
| `modes/find.md` | Referral-first ordering | [Burks et al (QJE 2015)](https://academic.oup.com/qje/article/130/2/805/2330903); [Friebel et al (NBER 2019)](https://www.nber.org/papers/w26395) |
| `lib/tailoring.js` | Per-JD tailoring depth | Resume2Vec MDPI 2024 (+15.85% nDCG) as the strongest available anchor |

---

## FAQ

### How do I get started?

Run `/jobe onboard` from inside the cloned repo. It walks you through everything in plain English — no JSON to write, no schema to learn. Paste your existing resume up front and most of the work is done. After the interview you'll have a working setup with at least one tailored resume + cover letter generated end-to-end so you know it works before you trust it on real applications.

### Do I need an API key?

No, but recall is much higher with one. Without any key, Jobe runs the public-API and HTML-scraping sources (Greenhouse, Lever, Ashby, Amazon, Apple, HN) and surfaces a few hundred postings per run. With a free Brave API key it surfaces a few thousand and harvests new ATS slugs into `data/companies/index.json` automatically.

### What if a posting I want isn't in any of the indexed ATS?

Two paths. (1) Run `/jobe <posting-url>` directly with the URL of the LinkedIn / Indeed / company-careers listing — Jobe will fetch, parse, and evaluate it without going through discovery. (2) The agent fallback layer (`jobe-job-discovery`) is exactly for this: it uses Claude's built-in WebSearch to targetedly find ATS URLs for companies the search APIs missed. It fires automatically when discovery recall is low.

### How does Jobe avoid hallucinating bullets?

Bullets are not LLM-generated at evaluate-time. They are pre-written by you in `data/bullet-library.json`, tagged with archetypes and keywords, and *selected* (not generated) per posting by `lib/bullet-select.js`. The selector filters by archetype intersection, scores by keyword overlap against the JD, and returns the top N. The cover letter *is* LLM-composed, but it draws only from the same library — the rules in `modes/_shared.md` enforce a quality bar (specific dollar amount + leadership signal + decision-grade outcome) so the LLM has no room to invent.

### Can I use Jobe for non-ML / non-AI roles?

Yes — Jobe assumes nothing about your field. Discovery, the title gate, and ranking all derive from YOUR profile, with no hardcoded role vocabulary anywhere:

- `/jobe onboard` writes your target roles into `data/queries/seeds.json`. Every source builds its queries from those seeds (`lib/role-queries.js`), and `lib/rank.js` matches + scores postings against your target-role tokens and your `data/bullet-library.json` keywords.
- Archetypes (emphasis buckets) are optional. None ship by default — postings classify as `General` and evidence is ranked purely by JD-keyword overlap. To add your own, drop a `configs/archetypes.json` (`{ "Bucket": { "keywords": [...], "portfolioDomains": [...] } }`) and tag your bullet library to match.

A nurse, accountant, or marketer gets nurse / accountant / marketing discovery with **no code edits**. (Before setup — empty seeds — discovery is permissive and thin; run `/jobe onboard` first.)

### How do I update Jobe?

```bash
cd jobe-skill
git pull
cp -r .claude/skills/jobe/* ~/.claude/skills/jobe/    # overwrites system-layer files
cp .claude/agents/jobe-*.md ~/.claude/agents/
npm install                                            # if dependencies changed
```

The user-layer files (`_profile.md`, `reference.md`, `tracker.md`, `data/bullet-library.json`, `.env`, etc.) are never touched. See [`DATA_CONTRACT.md`](DATA_CONTRACT.md).

### My run is slow / hitting rate limits.

The pipeline rate-limits each source (per `s.rateLimit.rpm`). The Brave free tier is 1 query / second, which adds ~80 seconds for the role fan-out plus ~25 seconds for slug-harvest. SerpAPI's free tier is 100 queries / month total — disable it with `--source` or remove the key if you're not on a paid plan. To skip enrichment for a fast triage run: `node collectors/pipeline.js --no-enrich`.

---

## Privacy and the data contract

Two layers, with strict separation:

| Layer | Files | Behavior |
|---|---|---|
| **User layer** (yours, never touched by upgrade) | `_profile.md`, `reference.md`, `tracker.md`, `story-bank.md`, `followups.md`, `apply-queue.json`, `contacts.json`, `.env`, `data/resume-baseline.json`, `data/bullet-library.json`, `data/companies/index.json`, `data/companies/negative-list.json`, `data/companies/non-tech-seed.json` | Preserved on every upgrade |
| **System layer** (replaced on upgrade) | `SKILL.md`, `modes/*.md` (except `_profile.md`), `lib/*.js`, `collectors/*`, `scripts/*`, `agents/*`, `configs/default.json`, `templates/*` | Treated as code, overwritten |

The included `.gitignore` keeps user-layer files out of any git operation, so accidental `git add -A` won't leak `.env` or your tracker.

See [`DATA_CONTRACT.md`](DATA_CONTRACT.md) for the full file-by-file list and rationale.

---

## Contributing

Issues and PRs welcome. The natural extension points:

- **A new source plugin.** Add `collectors/sources/<category>/<source>.js` exporting `{id, name, requires, rateLimit, discover(ctx)}`. Missing env vars in `requires` cause the source to return `[]` so the pipeline keeps working without your key.
- **A new mode.** Add `.claude/skills/jobe/modes/<mode>.md` and update the router table in `SKILL.md`.
- **A new archetype set** for non-ML fields (security engineering, design, product management). Touch `lib/archetypes.js`, the archetype detection heuristics in `modes/_shared.md`, and update `templates/bullet-library.template.json`.
- **A new agent.** Add `.claude/agents/jobe-<purpose>.md` defining its system prompt and allowed tools.

Run `npm test` before submitting. CI checks formatting (`prettier --check`) and lint (`eslint`).

---

## License

[MIT](LICENSE).
