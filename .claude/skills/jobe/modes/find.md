# Find Mode

Discover ML/AI/DS jobs via the unified pipeline.

## Architecture

The discovery pipeline is source-plugin based. It runs every source in
parallel, merges into a canonical `Posting` schema, deduplicates, filters,
quick-ranks on title/URL, enriches top-K with JD text, and produces a
fully ranked list.

**Sources** (in `collectors/sources/`):

Keyword-driven cross-platform aggregators (preferred — search every job by keyword without naming companies):
- `aggregators/brave-search.js` - **Recommended free path**: Brave Search API site-scoped queries across all ATS domains. 2,000 queries/month free (no card). Set `BRAVE_API_KEY` in `.env`.
- `aggregators/serpapi-google-jobs.js` - Google Jobs via SerpAPI (paid: 100/mo free, $50/mo for 5K). Set `SERPAPI_KEY` in `.env`.
- `aggregators/serpapi-site-search.js` - SerpAPI site: search across ATS + company + startup domains (same key).
- `aggregators/hn-who-is-hiring.js` - HN monthly "Who is hiring" thread.

ATS-direct slug iteration (always runs; grows the emergent company index):
- `company-specific/amazon-jobs.js` - Amazon public search.
- `company-specific/apple-jobs.js` - Apple SSR scrape.
- `ats-directories/ashby-directory.js` - Ashby customer boards.
- `ats-direct/greenhouse.js` - Greenhouse slug-based.
- `ats-direct/lever.js` - Lever slug-based.
- `ats-direct/workday.js` - Workday multi-tenant (per `data/companies/non-tech-seed.json`).
- `ats-direct/smartrecruiters.js` - SmartRecruiters multi-company.
- `ats-direct/icims.js` - iCIMS best-effort HTML scrape.

Sources gate themselves on `requires` env vars (e.g. `BRAVE_API_KEY`, `SERPAPI_KEY`). Missing env means the source returns `[]`; the pipeline continues with remaining sources.

**Recommended setup**: add `BRAVE_API_KEY` to `.env` (free, 2K queries/month) for keyword-driven discovery across all customers of every ATS, not just the seeded ones. Without any aggregator key, recall is limited to the slug seed lists.

## Input

Parse `$ARGUMENTS` after "find":
- **Role filter** (optional, default: from `data/queries/seeds.json`)
- **Location filter** (optional)
- **Company filter** (optional)

## Step 1: Run pipeline

```bash
JOBE_HOME="${HOME}/.jobe"; [ -f collectors/pipeline.js ] && JOBE_HOME="."
cd "${JOBE_HOME}"
node collectors/pipeline.js 2>&1 | tail -40
```

Options:
- `--dry-run` - print sources and queries only, no network calls
- `--no-enrich` - skip JD fetching (discovery only, fast)
- `--source X` - run a single source (e.g. `--source amazon-jobs`)
- `--max-enrich N` - cap enrichment to N top-scored postings (default 300)
- `--max-age N` - override recency window (default 30 days)
- `--no-us-only` - allow non-US roles
- `--allow-onsite` - **disable the default remote-only filter** (per `_profile.md`, hybrid + onsite are excluded by default; this flag opens the gate)

Pipeline output (in `signals/discovered/{date}/`):
- `raw-{source}.json` per source
- `merged.json` - deduped, pre-filter
- `filter-report.json` - rejection counts
- `ranked-all.json` - filtered + quick-scored
- `ranked-enriched.json` - top-K with JD + full score

## Step 2: Load and present

```bash
node -e "
const fs=require('fs');
const top=JSON.parse(fs.readFileSync('signals/discovered/${TODAY}/ranked-enriched.json'));
for (const p of top.slice(0,30)) {
  console.log([p.matchScore || p.quickScore, p.archetype, p.company, p.title, p.location].join(' | '));
  console.log('  '+p.canonicalUrl);
}
"
```

Present ranked table with columns:
- Match score (full if enriched, else quick)
- Archetype
- Company
- Role
- Location
- Posted date
- Compensation (if extracted)
- URL

## Step 2.5: Free-form filter passthrough

If `$ARGUMENTS` beyond "find" contains a role or location (e.g. `/jobe find Senior MLE Remote`), invoke pipeline with those filters:

```bash
node collectors/pipeline.js --query "Senior MLE" --location "Remote" --max-enrich 50
```

Currently pipeline reads seed queries from `data/queries/seeds.json`; `--query` / `--location` overrides override the seeds for this run only.

## Step 2.6: WebSearch agent fallback (auto-triggered when recall is low)

After the pipeline writes `discovery-summary.json`, read it and decide whether to launch the `jobe-job-discovery` agent. The summary's `needsAgentFallback` boolean is the canonical trigger:

```bash
TODAY=$(date +%Y-%m-%d)
SUMMARY="signals/discovered/${TODAY}/discovery-summary.json"
node -e "const s=require('./${SUMMARY}'); console.log(JSON.stringify({needs:s.needsAgentFallback, reason:s.fallbackReason, brave:s.perSource['brave-search']||0, dedup:s.afterDedup}))"
```

**Auto-launch conditions** (any one is sufficient):
- `summary.needsAgentFallback === true` (Brave returned <100 OR merged set <300).
- Both `BRAVE_API_KEY` and `SERPAPI_KEY` are unset.
- All HTTP sources returned 0.
- User explicitly asks for broader sweep.

**Skip the agent** when Brave alone returned >= 200 postings and merged set >= 500 — the marginal recall isn't worth the WebSearch cost.

### Launch

Use the Agent tool with subagent_type `jobe-job-discovery`. The agent prompt should include:

```
targetRoles: {from _profile.md target roles list}
targetLocations: Remote (US) only — hard filter from _profile.md
remoteOnly: true
maxAgeDays: 30
TODAY: {today's date YYYY-MM-DD}
outputPath: signals/discovered/{TODAY}/agent-discovered.json
```

The agent writes `agent-discovered.json` itself (per its instructions). Do not parse markdown — read the JSON file.

### Merge agent output into the ranked list

After the agent finishes:

```bash
node lib/agent-import.js
```

This script:
- extracts ATS slugs from each agent URL and merges them into `data/companies/index.json` (so the next run iterates them via direct ATS plugins).
- normalizes postings via `lib/posting.createPosting`.
- applies the same role / remote / US filters as the pipeline.
- dedups against today's existing `ranked-enriched.json` (URL exact).
- appends survivors to `ranked-enriched.json`, sorted by score.

It prints a JSON summary with `added`, `newSlugs`, `indexSize`. Re-read `ranked-enriched.json` after import and present the combined list.

**Why this design**: the agent path is a one-shot recall booster; once it discovers a slug, that slug lives in `index.json` permanently and the direct-ATS plugins (Greenhouse / Lever / Ashby / Workday) iterate it on every future run. Over time the seed-list dependency disappears entirely — the index becomes the source of truth.

## Step 3: Referral-First Suggestion (empirical priority)

Before offering auto-evaluate, surface referral opportunities for the top 10 postings.

Empirical basis: Burks et al (QJE 2015) and Friebel et al (NBER 2019 field experiment) show referred candidates are hired at roughly 10x the rate of cold applications, turn over 12-20% less often, and are hired 55% faster. No resume-formatting change in the empirical literature delivers an effect of that magnitude.

Run the real network lookup via `lib/network.js`:

```bash
node -e "
const { referralCheck, ensureContactsFileExists } = require('./lib/network');
const top = require('./signals/discovered/${TODAY}/ranked-enriched.json').slice(0, 10);
const created = ensureContactsFileExists();
if (created) console.log('Created empty data/contacts.json — populate from LinkedIn export for this feature to surface real contacts.');
const companies = [...new Set(top.map(p => p.company))];
const checks = referralCheck(companies);
for (const c of checks) {
  if (c.status === 'strong-tie')   console.log('  STRONG:', c.company, '(' + c.strongTieCount + '/' + c.totalCount + ')');
  else if (c.status === 'weak-tie') console.log('  WEAK:  ', c.company, '(' + c.totalCount + ' contacts)');
  else                              console.log('  COLD:  ', c.company);
}
"
```

If any are strong-tie or weak-tie, ask: "Run `/jobe contacto {company}` on any of these before the cold apply path?"

If all are cold and `data/contacts.json` has zero entries, surface: "No referral contacts populated. Add them to `data/contacts.json` to unlock the highest-impact empirical lever in this skill."

## Step 4: Auto-Evaluate Top Matches

Every generated resume runs through `evaluate.md` Block E, which REQUIRES the JD-grounded reframe (the `scripts/tailor-brief.js` brief, then reorder + reframe each bullet to the role). Resumes must speak to each JD, never reuse a generic bullet set.

After referral check:

1. **Score >= 80 (Strong)**: Automatically run evaluate mode. No ask.
2. **Score 65-79 (Good)**: List and ask "Generate resumes for the Score 65+ matches?"
3. **Score 55-64 (Stretch)**: List only.
4. **Score < 55 (Reach)**: Collapsed into a summary count, list on request.

Ghost-flag postings (score >= 0.30 from `lib/ghost-score.js`) show with a warning marker in the table. `Suspicious` postings (ghost >= 0.60) are hidden by default; use `--show-ghosts` to include.

For each auto-evaluated posting, report:
- Company, role, match score, archetype
- Files generated (resume DOCX, cover letter DOCX, analysis)
- Top differentiator from rank reasons

After all evaluations complete, ask:
"Want me to apply to any of these? Type `/jobe apply {company-slug}` for any role."

## Emergent Company Index

Every run updates `data/companies/index.json` with newly discovered companies
and their detected ATS. Over time the index grows from the initial portals.json
seed to cover every company that has posted an ML role we surfaced.

## Negative List

`data/companies/negative-list.json` contains slugs the user does not want to see.
The pipeline filters them out before presenting results.

## Failure Modes

- **No `SERPAPI_KEY`**: SerpAPI sources return `[]`. Pipeline still works via
  Amazon + Apple + Ashby + Greenhouse + Lever + HN. Recall drops ~60%.
- **A source throws**: caught at pipeline level; other sources continue.
- **All sources fail**: pipeline writes an empty `ranked-enriched.json` and
  reports the source error summary.
