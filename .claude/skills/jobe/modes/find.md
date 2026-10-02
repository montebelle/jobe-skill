# Find Mode

Discover recent, relevant jobs in the user's field via the unified pipeline, filter them by the user's own policy, resolve and verify what a source could only assert, and present only what qualifies.

## Architecture

The discovery pipeline is source plugin based. It runs every source in
parallel, merges into a canonical `Posting` schema, deduplicates, filters,
quick ranks on title/URL, enriches the top K with JD text, scores them, and
produces a fully ranked list.

**Sources** (in `collectors/sources/`; every `.js` file there registers itself). Search terms and title gates come ONLY from the user's seed roles (`${WORKSPACE}/data/queries/seeds.json`), so the same code searches nursing titles for a nurse and accounting titles for an accountant. A source with no seed roles, no key, or no tenants logs one line and returns nothing; the pipeline continues with the rest.

Keyword driven search across platforms (search every job by keyword without naming companies):
- `aggregators/brave-search.js`: **recommended free path**. Brave Search API site scoped queries across the ATS domains, plus the user's own `discovery.companySites`. 2,000 queries/month free (no card). Set `BRAVE_API_KEY` in `.env`.
- `aggregators/serpapi-google-jobs.js`: Google Jobs via SerpAPI (paid beyond a small free tier). Set `SERPAPI_KEY`.
- `aggregators/serpapi-site-search.js`: SerpAPI site: search across ATS domains and `discovery.companySites` (same key). No employer or startup site list ships.
- `aggregators/adzuna.js` (`ADZUNA_APP_ID` + `ADZUNA_APP_KEY`), `aggregators/jsearch.js` (`JSEARCH_API_KEY`), `aggregators/jooble.js` (`JOOBLE_API_KEY`), `aggregators/findwork.js` (`FINDWORK_API_KEY`; a board of software and technology roles), `aggregators/usajobs.js` (`USAJOBS_API_KEY` + `USAJOBS_EMAIL`; US federal jobs in every profession). Each stays dark until its key is set. Only under a policy that accepts no remote work do `adzuna`, `jsearch` and `usajobs` search in the seed row's own place.
- `aggregators/hn-who-is-hiring.js`: the monthly Hacker News hiring thread, filtered by the seed roles.

Job boards read as feeds (key free, always on, filtered by the seed roles):
- `aggregators/remotive.js`, `remoteok.js`, `weworkremotely.js`, `himalayas.js`, `jobicy.js`, `working-nomads.js` (remote boards), `arbeitnow.js` (mostly European employers), `themuse.js` (no category by default; set `THEMUSE_CATEGORIES` to narrow it to your field).

LinkedIn, logged out:
- `aggregators/linkedin-guest.js`: runs by default (key free, no login, no account involved). It queries LinkedIn's public logged out search. The work mode facet, the country, and the recency window come from the user's policy; with no policy the search carries no work type facet and no location. The location sent is the country, except that an onsite or hybrid search runs in the seed row's own place (the first two places per role), else in the user's first region written as a name. Guest cards show the company's displayed city, kept as `hqLocation`, and `remoteVerified` is always false: a remote label from this source is an ASSERTION until Step 2.8 confirms it. (The richer logged in sweep is opt in via `--linkedin`; see Step 2.7.)

Opt in sources, OFF unless the user sets the flag in `.env`:
- `aggregators/hiring-cafe.js` (`HIRING_CAFE_OPT_IN=1`): off by default because the site's robots file disallows the search URL pattern it reads.
- `aggregators/indeed-camoufox.js` (`INDEED_CAMOUFOX_ENABLED=1`): drives logged out public search pages in a stealth browser, never signs in, and stops on any verification page. Tuning: `INDEED_CAMOUFOX_MAX_QUERIES`, `_PAGES`, `_DETAILS`, `_DELAY_MS`, `_HEADLESS`.

Per company ATS crawlers (always run; they grow the emergent company index):
- `ats-direct/greenhouse.js`, `ats-direct/lever.js`, `ats-directories/ashby-directory.js`: one board per company slug.
- `ats-direct/workable.js`, `recruitee.js`, `breezy.js`, `bamboohr.js`, `personio.js`: one board per tenant.
- `ats-direct/workday.js`, `smartrecruiters.js`, `icims.js`: employers listed explicitly in `${WORKSPACE}/data/companies/non-tech-seed.json` (these systems have no search across companies).
- `company-specific/amazon-jobs.js`, `company-specific/apple-jobs.js`: two fixed large employers, query driven, so they return nothing for roles those employers do not post.

No tenant or employer list ships. Tenants come from the workspace company index (`${WORKSPACE}/data/companies/index.json`, grown by every run), the user's own seeds (`${WORKSPACE}/data/companies/portals.json` and `${WORKSPACE}/data/companies/non-tech-seed.json`), and the shared `configs/portals.json` (which ships empty).

**Recommended setup**: add `BRAVE_API_KEY` to `.env` (free) for keyword driven discovery across all customers of every ATS, not just the seeded ones. Without any search key, recall is limited to the feeds, the guest search, and the companies already in the index.

## The user's policy decides what is kept

Every filter below reads `${WORKSPACE}/data/profile.json` through `lib/profile.js` (SKILL Step 2.3 prints the merged values). Precedence: a command line flag, then the profile, then the permissive default. With no policy on file NOTHING is dropped by work mode, country, title level, or pay. Never state or assume a work mode, a country, or a day count as a default; when in doubt run `node collectors/pipeline.js --dry-run`, which prints the seeds and the merged filters and reaches no network.

- **Work modes** (`discovery.workModes`: any of remote, hybrid, onsite; empty keeps all). Two stages: before enrichment only a posting already known to be in an excluded mode is dropped; after enrichment the mode read from the real JD must be one the user accepts, and a posting that states no mode is kept only when the user accepts onsite. A title that names a hybrid or onsite arrangement overrides a remote location field. Under any policy other than remote only, a listing that shows only a city is kept for enrichment (the JD decides), and the LinkedIn guest source runs one search per accepted work type so each card carries the facet it came from.
- **Low touch hybrid** (`discovery.hybridMaxOfficeShare`, for example 0.25). This one is a rule YOU apply; the code has no office share extractor yet. When `workModes` is exactly `["remote"]` the code drops every hybrid posting before you see it, so a user who accepts low touch hybrid must have `"workModes": ["remote", "hybrid"]` plus the share. Then, for each hybrid row, read the JD: keep it when the stated time in an office is at or under the share (occasional travel or a few days a quarter counts as under); drop it when it requires more (for example 2 or 3 days a week against a 0.25 share), is fully onsite, or requires living near a named hub. With the share unset, every hybrid row the code kept stays.
- **Countries** (`discovery.countries`; empty keeps every country). Exactly `["US"]` uses the built in United States classifier. Under any other list a posting is dropped only when its location names a country outside the list (or is recognizably in the United States); a city alone, a city plus region, or a location that names no place is kept as unknown, so check the country of such rows yourself when you read the JD. The same holds for a list that mixes the US with other countries: only a named other country drops (plus the few dozen large foreign cities the classifier knows by name), and a city or city plus region it cannot place is kept. A country may be listed by name or two letter code.
- **Regions** (`discovery.regions`; empty keeps every place). Applies only to work that needs the user on site: a hybrid or onsite posting (after enrichment, also one that states no work mode) must name one of the regions in its location as a whole phrase. A US state, a Canadian province or territory, an Australian state, or a UK nation matches by its name and by its code, whichever the user wrote (`["Denver", "Colorado"]` keeps "Aurora, CO"); a region in any other country matches only in the forms the user listed. A remote posting is never touched, and a location that names no place is kept. No flag lifts this gate.
- **Recency** (`discovery.maxAgeDays`, default 30; 0 turns the cut off in the pipeline and in every source; `discovery.seniorityExtensionDays`, default 0, adds headroom for senior titles). Recency keys on the ORIGINAL publish date where the ATS gives one, not a refresh or repost date. A posting with no detectable date is kept; label it "date unknown".
- **Title rules** (`discovery.titleExclude`, `discovery.titleKeep`). A title is dropped when an exclude phrase matches outside every keep phrase; a keep phrase shields only its own words. A discovery filter only, never a score input. No level is excluded unless the user listed it.
- **Salary floor** (`discovery.salaryFloor` in `discovery.salaryCurrency`). A posting is dropped only when a PUBLISHED yearly band in that same currency tops out below the floor (`postEnrichRejected.salary` counts them). Free text is parsed for the codes USD, GBP, EUR, CAD, AUD, NZD, SGD, CHF and the dollar, pound, and euro signs; a bare `$` is read as USD only for a posting placed in the United States. Unknown pay (none, another or an unstated currency, per hour or month) is kept, and every surviving row carries `salaryCheck`: `published` or `unknown`. An estimate never counts as meeting the floor.
- **Excluded companies**: the user's negative list plus the shared staffing list (the latter only while `discovery.excludeStaffing` is true, the default), through `lib/exclusions.js`.
- **History**: a requisition already applied to or skipped is never shown again (matched by company and role, not URL; when the policy is not remote only and the queue row carries a `location`, also by city). `--include-applied` lifts it.

## Input

Parse `$ARGUMENTS` after "find":
- **Role filter** (optional, default: from `${WORKSPACE}/data/queries/seeds.json`)
- **Location filter** (optional)
- **Company filter** (optional)

## Step 1: Prune the queue, then run the pipeline

Prune stale apply queue rows first, so the queue cleans itself on every run. A row is added for each generated resume and nothing else ever removes one. `scripts/prune-queue.js` removes only rows that are not history and are dead: an orphan (no report folder anywhere), an archived row (the folder exists only under an archive), or a row whose role matches the user's own `discovery.titleExclude` outside every `discovery.titleKeep` phrase. With no title policy that last rule never fires. It keeps every applied and skipped row (the pipeline reads them so a job already handled is not shown again) and every row whose folder is still in `queue`, `manual`, `verify` or `evaluate`. It never deletes a report folder, and it writes the prior queue to `data/apply-queue.json.bak` before removing anything. Add `--dry` to preview.

```bash
cd "${JOBE_HOME}"
node scripts/prune-queue.js 2>&1 | head -20
node collectors/pipeline.js 2>&1 | tail -40
```

Pipeline options (a flag always wins over `data/profile.json`; a flag the script does not know prints the usage and exits 2 without starting a run):
- `--dry-run`: print sources, seeds, and the merged filters only, no network calls
- `--no-enrich`: skip JD fetching (discovery only, fast)
- `--source X`: run a single source (e.g. `--source greenhouse-direct`)
- `--max-enrich N`: cap enrichment to the N top scored postings (default 300)
- `--max-age N`: recency window in days for this run (default: the user's `discovery.maxAgeDays`; 0 turns the cut off)
- `--senior-extension N`: extra days for senior titles for this run
- `--remote-only` / `--allow-onsite`: force the work mode gate to remote, or lift it, for this run
- `--us-only` / `--no-us-only`: force the country gate to the United States, or lift it, for this run
- `--include-applied`: also show requisitions already applied to or skipped
- `--show-ghosts`: include postings flagged Suspicious
- `--no-harvest`: skip the slug harvest (saves search calls on a metered key)
- `--query "<role>"` with optional `--location "<place>"`: replace the seeds for this run. `--query` assumes no location.
- `--help`: print the usage and exit

Mode level option (NEVER pass it to `collectors/pipeline.js`, which rejects any flag it does not know):
- `--linkedin`: after the pipeline, also run the agent driven **logged in LinkedIn search sweep** (`modes/linkedin-search.md`) and present its captures with the ranked list. It surfaces the personalized inventory the logged out guest source misses. **Opt in + user present only** (it drives the user's authenticated session; account risk). Not part of the default `find`.

Pipeline output (in `${WORKSPACE}/signals/discovered/{date}/`; the folder name is the UTC date):
- `raw-{source}.json` per source
- `merged.json`: deduped, before filters
- `filter-report.json`: the merged filters (profile plus flags) and the rejection counts
- `ranked-all.json`: filtered + quick scored
- `ranked-enriched.json`: top K with JD + full score
- `discovery-summary.json`: counts per source, `postEnrichRejected`, `payUnknown`, `withUnmetMinimums`, `needsAgentFallback`

## Step 2: Load and present

```bash
TODAY=$(date -u +%Y-%m-%d)
LIST="${WORKSPACE}/signals/discovered/${TODAY}/ranked-enriched.json"
node -e "
const fs=require('fs');
const top=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
for (const p of top.slice(0,30)) {
  console.log([p.matchScore || p.quickScore, p.archetype, p.company, p.title, p.location, p.remote, p.salaryCheck, (p.minimumsUnmet||[]).join('; ')].join(' | '));
  console.log('  '+p.canonicalUrl);
}
" "${LIST}"
```

Run Steps 2.6 to 2.9 that apply BEFORE you show the final table; a row is not presentable until it is resolved and verified.

**Presentation rules (on for everyone):**
- **Only qualifying rows, and every qualifying row.** Show only postings that clear every gate the user actually set: work mode verified (Step 2.8), country, region (`discovery.regions`, for every row that is not remote), recency window, title rules, salary floor, not a ghost, a direct employer, not already applied to or skipped. Do NOT pad the table with flagged or non qualifying rows for completeness, and do NOT silently drop a row that qualifies. A user with no policy has no gates beyond ghost, staffing, and history, so everything else is shown.
- **Unverified is its own list.** A posting whose work mode could not be confirmed (`verifyStatus` of `inconclusive` or `unreachable`) is listed apart as "unverified", never inside results the user's work modes are meant to guarantee.
- **Compensation on EVERY row, never blank.** Use the posting's `compensation` when the pipeline extracted one (`salaryCheck: published`). Otherwise fetch the band from the live listing (the ATS salary range fields, or `baseSalary` in the page's JSON-LD). Otherwise show a clearly labeled estimate ("est."). An estimate never counts as meeting the salary floor; when a floor is set, say which rows meet it on a published band and which are unknown.
- **Stated minimums are shown.** When `minimumsUnmet` is non empty, print it next to the score so the choice is made with open eyes.
- **The score is fit only.** `matchScore` is computed from the user's own skills on file against the JD (`34 + coverage * 44` plus small title bonuses, minus stated blockers; the full formula and `gatePass` are in `_shared.md` Scoring Model). No preference enters it: location, level, pay, and company type are filters above, never score inputs. Do not adjust a score by hand.
- **A staffing agency or aggregator that slipped through** is the one legitimate drop at presentation time (while `discovery.excludeStaffing` is true). Record its slug so it stays out: in a named workspace, in `${WORKSPACE}/data/companies/staffing-list.json` (`{ "companySlugs": [...] }`, read in addition to the shared list); in single user mode, in the negative list instead, because there that path IS the shared list and an install replaces it.

Present the ranked table with columns:
- Match score (full if enriched, else quick), with any unmet stated minimums
- Archetype (omit the column when the user defined none)
- Company
- Role
- Location and verified work mode
- Posted date (or "date unknown")
- **Compensation (REQUIRED on every row: published band, else fetched from the live listing, else a labeled estimate)**
- URL (the employer's own listing where one was resolved)

## Step 2.5: Free form filter passthrough

If `$ARGUMENTS` beyond "find" contains a role or a location (two unrelated examples: `/jobe find Staff Nurse Denver`, `/jobe find Tax Accountant Remote`), invoke the pipeline with those filters:

```bash
node collectors/pipeline.js --query "<the role as typed>" --location "<the location as typed>" --max-enrich 50
```

`--query` / `--location` replace the seeds for this run only. Leave `--location` out when the user named none. A location word is a search term, not a policy: it does not change the user's work mode or country gates (use the flags in Step 1 for that).

## Step 2.6: WebSearch agent fallback (triggered when recall is low)

After the pipeline writes `discovery-summary.json`, read it and decide whether to launch the `jobe-job-discovery` agent. The summary's `needsAgentFallback` boolean is the canonical trigger:

```bash
SUMMARY="${WORKSPACE}/signals/discovered/${TODAY}/discovery-summary.json"
node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log(JSON.stringify({needs:s.needsAgentFallback, reason:s.fallbackReason, brave:s.perSource['brave-search']||0, dedup:s.afterDedup, payUnknown:s.payUnknown, withUnmetMinimums:s.withUnmetMinimums}))" "${SUMMARY}"
```

**Launch conditions** (any one is sufficient):
- `summary.needsAgentFallback === true` (Brave returned under 100 OR the merged set is under 300). These thresholds were tuned on one large search, so a narrow field will usually trip them; that is expected.
- Both `BRAVE_API_KEY` and `SERPAPI_KEY` are unset.
- All HTTP sources returned 0.
- The user explicitly asks for a broader sweep.

**Skip the agent** when Brave alone returned 200 or more postings and the merged set is 500 or more: the marginal recall isn't worth the WebSearch cost.

### Launch

Use the Agent tool with subagent_type `jobe-job-discovery`. A subagent inherits nothing, so write the user's REAL values into the prompt. Every `{...}` below is a substitution you perform from the files named; none of them has a default you may assume:

```
workspace: {the absolute ${WORKSPACE} path}
targetRoles: {the role titles in ${WORKSPACE}/data/queries/seeds.json; if empty, the target roles in _profile.md}
targetLocations: {the locations in the seeds; write "none given" when there are none}
workModes: {discovery.workModes; write "any" when the list is empty}
hybridMaxOfficeShare: {the value; write "not set" when null}
countries: {discovery.countries; write "any" when the list is empty}
regions: {discovery.regions; write "any" when the list is empty}
maxAgeDays: {the merged maxAgeDays; write "no limit" when 0}
titleExclude: {discovery.titleExclude; "none" when empty}    titleKeep: {discovery.titleKeep; "none" when empty}
salaryFloor: {discovery.salaryFloor with discovery.salaryCurrency; "none" when null. Label only: never drop a posting whose pay is unknown}
excludeCompanies: {the negative list slugs; plus "staffing agencies and job aggregators" while discovery.excludeStaffing is true}
targetCompanies: {optional: discovery.companySites; leave the line out when empty}
skillsOrKeywords: {optional: a few of the most distinctive keywords of the user's bullet library, used only for extra queries; leave the line out when there is no library}
standingRules: {every relevant line of "Standing rules" and "Known corrections" from _profile.md, verbatim; "none" when absent}
TODAY: {the same YYYY-MM-DD folder name the pipeline wrote}
outputPath: {the absolute ${WORKSPACE} path}/signals/discovered/{TODAY}/agent-discovered.json
```

The agent requires `targetRoles` and an absolute `outputPath` and stops without them. It reads "any", "none", "none given", "not set", and "no limit" as no constraint, so write exactly those words for an unset value and never a guess.

The output path MUST be absolute and inside the ACTIVE user's workspace: that is where `node lib/agent-import.js` reads it back from. A relative path would land in the install root and the import would find nothing.

The agent writes `agent-discovered.json` itself (per its instructions). Do not parse markdown; read the JSON file.

### Merge agent output into the ranked list

After the agent finishes:

```bash
node lib/agent-import.js
```

This script:
- extracts ATS slugs from each agent URL and merges them into `${WORKSPACE}/data/companies/index.json` (so the next run iterates them via the direct ATS plugins).
- normalizes postings via `lib/posting.createPosting`.
- applies the same filters as the pipeline: title rules and target roles, excluded companies, and the user's work mode (the strict gate: a posting that states no mode is kept only when the user accepts onsite), country, region, and recency policy (no policy means nothing is dropped).
- dedups against today's existing `ranked-enriched.json` (URL exact).
- appends survivors to `ranked-enriched.json`, sorted by score.

It prints a JSON summary with `added`, `newSlugs`, `indexSize`. Read `ranked-enriched.json` again after the import and present the combined list.

**Why this design**: the agent path is a one shot recall booster; once it discovers a slug, that slug lives in `index.json` permanently and the direct ATS plugins iterate it on every future run. Over time the dependency on any seed list disappears: the index becomes the source of truth.

## Step 2.7: LinkedIn logged in sweep (only when `--linkedin`)

If `$ARGUMENTS` includes `--linkedin`, after the pipeline + agent fallback, execute
`modes/linkedin-search.md`: it drives the user's logged in LinkedIn search across
`lib/linkedin.profileQueries()`, paginates, and ingests each page through
`collectors/ingest-manual.js --from-accessibility`. Its captures land in
`${WORKSPACE}/signals/discovered/{date}/` as `manual-linkedin-search*.json` (that mode
states the exact file naming). No script merges a manual capture into
`ranked-enriched.json`: present the captures together with the ranked list after the
Step 2.8 checks, and dedup them against it by company and title. This is the stronger
alternative to the always on logged out `linkedin-guest` source. **Account safety is
hard**: opt in, user present, human paced, never unattended, never solve a visible
CAPTCHA. See `modes/linkedin-search.md` for the full rules. Do NOT run this unless
`--linkedin` was explicitly passed.

## Step 2.8: Resolve LinkedIn leads to the employer's own listing, then verify (never skip)

**Discovery is not verification.** A LinkedIn guest result (and any source whose page cannot be enriched) only ASSERTS a work mode: the search facet is a prior, the card may show the company's head office instead of the work location, and the link is login walled with the real apply target behind a redirect. A source may assert; only the employer's own listing may confirm. Every LinkedIn posting must end up with a real apply URL on the employer's ATS and a location read from that listing, or stay flagged as unresolved. This holds for every policy: when the user accepts all work modes the step still gives the real apply URL and the real location, and the check becomes "does it match the user's location policy". In testing, a large share of LinkedIn remote labels turned out to be wrong.

Three passes, in order:

```bash
cd "${JOBE_HOME}"
# Pass 1. Deterministic: company name -> ATS board -> match the title on that board
#         -> rewrite canonicalUrl to the ATS URL and take location, work mode and country from it.
node scripts/resolve-linkedin-to-ats.js "${LIST}" --write
# Pass 2. Residue agents (below) for every posting still atsResolved !== true, then the merge snippet.
# Pass 3. Fallback verification for whatever is still a LinkedIn link.
node scripts/verify-remote.js "${LIST}" --only-linkedin --write
```

**Pass 1** accepts a title match only when the word overlap is at least 0.5 AND clearly ahead of the next best title on the board (or at least 0.75), so it cannot link a different requisition. It probes Greenhouse, Lever and Ashby only, which is why pass 2 exists. It keeps the LinkedIn link in `alternateUrls` and `linkedinUrl`.

**Pass 2, residue agents.** List the postings whose `canonicalUrl` is still a LinkedIn link and whose `atsResolved` is not `true`. Fan them out to general purpose agents (WebSearch + WebFetch) in batches of about 8 leads, in parallel. Give each agent this brief, with every `{...}` substituted:

```
You are resolving job leads to the employer's own listing. Use WebSearch and WebFetch only.
Never log in anywhere and never open a LinkedIn page; you do not need LinkedIn for this task.

WORKSPACE: {the absolute ${WORKSPACE} path}
OUTPUT FILE: {the absolute ${WORKSPACE} path}/signals/discovered/{TODAY}/residue-batch-{n}.json
USER POLICY (for labeling only, do not filter on it): work modes {workModes or "any"};
  hybrid office share at most {hybridMaxOfficeShare or "not set"}; countries {countries or "any"}.
STANDING RULES: {the relevant lines from the user's profile, verbatim, or "none"}

LEADS: {a JSON array of { company, title, linkedinUrl, hqLocation }}

For each lead:
1. Find the SAME requisition on the employer's own careers site or its applicant tracking
   system (Workday, iCIMS, SmartRecruiters, BambooHR, Workable, Recruitee, Breezy, Personio,
   Gem, Jobvite, or a careers page on the employer's own domain). Search for the employer name
   with the exact title, then open the result.
2. "Same requisition" means: the same employer, the same title or a clear variant of it, and a
   description that agrees with the lead. If two listings fit and you cannot tell which, or
   nothing fits, return resolved: false with a one line reason. Never pick the nearest title
   just to have an answer.
3. Read the location and the work mode ONLY from the employer's page: its location field, its
   workplace type field, and the description text (days in an office, a residency or hub
   requirement, travel). Ignore whatever the lead's source claimed. When the page gives a
   number of office days, convert it to a share of a five day week (officeShare).
4. If the listing belongs to a different employer than the lead named (a staffing firm, an
   investor, a parent brand posting for a subsidiary), put the real employer in
   employerCorrection.
5. Record the original publish date and a published pay band when the page shows them.
   Never estimate pay.

Write OUTPUT FILE as JSON:
{ "results": [ { "linkedinUrl": "...", "resolved": true, "reason": null,
    "canonicalUrl": "<the employer listing URL>", "employerCorrection": null,
    "title": "...", "location": "<as the page states it>",
    "remote": "remote | hybrid | onsite | unknown", "officeShare": null,
    "postedDate": "YYYY-MM-DD or null", "compensation": "<published band or null>",
    "evidence": "<the sentence on the page that states the work mode>" } ] }
Return one line: how many resolved, how many not.
```

Then merge the batch files onto the list (agents never edit the ranked list themselves, so parallel batches cannot collide):

```bash
cd "${JOBE_HOME}"
node -e "
const fs = require('fs'), path = require('path');
const [list, dir] = process.argv.slice(1);
const { atomicWrite } = require('./lib/tracker-writer');
const postings = JSON.parse(fs.readFileSync(list, 'utf8'));
// ponytail: stamps the same fields scripts/resolve-linkedin-to-ats.js stamps, but
// does not recompute the country flag or dedup against a row an ATS source
// already found. Upgrade path: a script that reuses stampResolved and lib/dedup.
const byLink = new Map(postings.map((p) => [p.canonicalUrl || p.url, p]));
let merged = 0, unresolved = 0;
for (const f of fs.readdirSync(dir).filter((n) => /^residue-batch-.*\.json$/.test(n))) {
  let results = [];
  try { results = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).results || []; } catch { continue; }
  for (const r of results) {
    const p = byLink.get(r.linkedinUrl);
    if (!p || p.atsResolved === true) continue;
    if (!r.resolved || !r.canonicalUrl) { p.atsResolved = false; p.atsResolveReason = r.reason || 'residue-unresolved'; unresolved++; continue; }
    const mode = ['remote', 'hybrid', 'onsite'].includes(r.remote) ? r.remote : 'unknown';
    p.linkedinUrl = r.linkedinUrl;
    p.alternateUrls = [...new Set([...(p.alternateUrls || []), r.linkedinUrl])];
    p.canonicalUrl = r.canonicalUrl;
    p.atsResolved = true; p.atsBoard = 'employer listing';
    if (r.employerCorrection) p.employerCorrection = r.employerCorrection;
    if (r.location) p.location = r.location;
    p.remote = mode;
    p.remoteVerified = mode === 'remote';
    p.verifyStatus = mode === 'remote' ? 'remote' : (mode === 'unknown' ? 'inconclusive' : 'not-remote');
    p.verifiedLocation = r.location || null;
    p.verifiedWorkplace = mode;
    if (typeof r.officeShare === 'number') p.officeShare = r.officeShare;
    if (r.postedDate) p.postedDate = r.postedDate;
    if (r.compensation && !p.compensation) p.compensation = r.compensation;
    merged++;
  }
}
atomicWrite(list, JSON.stringify(postings, null, 1));
console.log(JSON.stringify({ merged, unresolved }));
" "${LIST}" "${WORKSPACE}/signals/discovered/${TODAY}"
```

The snippet does not recompute the country flag and does not dedup; `scripts/final-list.js` and the presentation step read the country from the new `location`, and a requisition that now appears twice (once from an ATS source, once resolved here) is shown once.

**Pass 3** reads each remaining LinkedIn posting through the public logged out guest endpoint only, never the user's session, and stamps `remoteVerified`, `verifyStatus` (`remote`, `not-remote`, `unreachable`, `inconclusive`), `verifiedLocation`, `verifiedWorkplace`. It never drops a posting.

**Presentation rule (hard):** a posting is shown as remote when, and only when, `verifyStatus` is `remote` or its location came from the employer's own listing. `inconclusive` and `unreachable` are NOT remote: list them apart as unverified. A posting that resolved to hybrid or onsite is then judged by the user's work modes and the low touch hybrid rule like any other row. When the real employer differs from the name the source showed (`employerCorrection`), present the real employer and check it against the exclusion lists.

## Step 2.9: Refresh the evidence index before scoring (only when the user has evidence roots)

Scoring and resume generation should reflect the user's current work. If `evidence.roots[]` in `data/profile.json` is non empty and the work under those folders changed since the last run, rebuild the fact index before the auto evaluate below (and before any resume generation):

```bash
node scripts/evidence-index.js build
```

- With no roots the script says so and exits 0; skip this step. Most professions have no such folders, and nothing is lost.
- `evidence.githubAccounts[]` (account names only, never tokens) is optional: when the user keeps work on a code host that is not on this machine, list each account's recently pushed repositories (`gh repo list "<account>" --limit 100 --json name,pushedAt`, switching account first when there are several) and clone or pull the changed ones into `${WORKSPACE}/data/.evidence-corpus/` (scanned automatically) before the build. Empty list: skip.
- A tool the index proves is treated as held and can never be reported as a gap. The index only CREDITS evidence. A skill the user stated stays authoritative even when no folder shows it.
- When the refresh surfaces a capability that is new, check it against the existing bullet library before calling it new (never trust a count of "novel" items from a subagent), then score through `lib/tailor.tailorBrief` against the JD, never by title keywords.

This is a periodic refresh: skip it when the index was rebuilt within the last few days.

### Optional helpers before generating resumes

```bash
node scripts/verify-listing.js "${LIST}" --write   # is each listing still open, what does the employer's ATS say
node scripts/classify-gate.js "${LIST}"            # which listings the apply harness can complete
node scripts/final-list.js "${LIST}"               # the presentation gate
```

`verify-listing.js` attaches a `verify` object to each posting (`status`, `stillOpen`, `titleSim`, `location`, `remote`, `postedDate`, `comp`). A status of `needs-agent` means the script could not reach or confirm the listing (a page rendered by script, a careers host whose board could not be confirmed, a timeout, a rate limit (429), or a server error): `stillOpen` is null, so open it yourself and do not treat it as closed. Only a 404 or 410 from the listing's own API or page, or an Ashby board that no longer lists the job, is reported `gone`. For the work mode, a remote location or workplace field and the ATS remote flag both yield to a hybrid statement in the title or JD (the same phrase patterns as the pipeline label). A low `titleSim` means the link may point at a different requisition. `remoteGuess: true` beside `remote` marks a coarse verdict (a location offering both modes, a bare "hybrid" word, a loose remote phrase, a country only location, or a location with no remote word and no stated mode). `final-list.js` takes the work mode from the employer record first, then the pipeline's own label, and uses a guessed verdict only when the pipeline has no label; a guessed remote never stands for a LinkedIn row the page check did not confirm. If you write a `verify` object by hand, leave `remoteGuess` out when you read the mode from the listing itself.

`classify-gate.js` splits the list into not gated (Greenhouse, Lever, Ashby, and an employer domain fronting Greenhouse) and gated (account walls, unsupported systems, job board links, unknown sites). Record `gated` and `gateType` on the queue row; gated rows end in the `manual` bucket.

`final-list.js` applies the user's policy from `${WORKSPACE}/data/profile.json` (work modes, countries, regions, `minScore`, title rules) plus the negative list and the staffing list, leaves out listings verified closed, keeps a listing the check could not reach with the line `listing not confirmed open (...): check the page`, and prints compensation on every row. `salary: fetch band` on a row means no published band was found: read it from the live listing, and if there is none give a clearly labeled estimate. It also prints any stated minimum the candidate does not meet. The work mode gate is the pipeline's strict one on the VERIFIED mode: a listing that states no mode counts as onsite, so it is kept only when the user accepts onsite and is then shown as `work mode unverified`. `discovery.regions` applies to every listing whose verified mode is not remote; an excluded row shows `outside region (<location>)`. The title rule is the pipeline's (an exclude phrase outside every keep phrase). `--allow-onsite` and `--no-us-only` lift the work mode and country gates for one run; no flag lifts the region gate; a second argument sets the score floor.

Maintenance helpers, safe to run any time: `node scripts/linkedin-guest-sweep.js` (searches the seed roles on the public guest endpoint, resolves new company names to ATS boards and adds them to the company index) and `node scripts/resolve-index-backlog.js` (resolves index entries that have no ATS yet).

## Step 3: Referral first (only when `discovery.referralFirst` is true)

Skip this step entirely unless the user's profile sets `discovery.referralFirst: true` (default false). It is an ordering preference, never a score input, and `/jobe contacto` stays available on request either way.

When it is on, surface referral opportunities for the top 10 postings before offering auto evaluate.

Empirical basis: Burks et al (QJE 2015) and Friebel et al (NBER 2019 field experiment) show referred candidates are hired at roughly 10x the rate of cold applications, turn over 12 to 20% less often, and are hired 55% faster. No resume formatting change in the empirical literature delivers an effect of that magnitude.

Run the real network lookup via `lib/network.js`:

```bash
node -e "
const { referralCheck, ensureContactsFileExists } = require('./lib/network');
const top = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).slice(0, 10);
const created = ensureContactsFileExists();
if (created) console.log('Created an empty data/contacts.json. Populate it from your LinkedIn connections export for this step to surface real contacts.');
const companies = [...new Set(top.map(p => p.employerCorrection || p.company))];
const checks = referralCheck(companies);
for (const c of checks) {
  if (c.status === 'strong-tie')   console.log('  STRONG:', c.company, '(' + c.strongTieCount + '/' + c.totalCount + ')');
  else if (c.status === 'weak-tie') console.log('  WEAK:  ', c.company, '(' + c.totalCount + ' contacts)');
  else                              console.log('  COLD:  ', c.company);
}
" "${LIST}"
```

If any are strong tie or weak tie, ask: "Run `/jobe contacto {company}` on any of these before the cold apply path?"

If all are cold and `${WORKSPACE}/data/contacts.json` has zero entries, say once: "No referral contacts on file. Add them to `data/contacts.json` to use this step."

## Step 4: Auto Evaluate Top Matches

Every generated resume runs through `evaluate.md` Block E, which REQUIRES reading the JD, then the user's evidence (the evidence roots when the profile lists any, the evidence file, and the bullet library as a candidate pool), then reframing to the role and leading with what genuinely fits it. Resumes must speak to each JD, never reuse a generic bullet set.

Work only from rows that passed the presentation rules above. If `discovery.minScore` is set, rows below it are not listed at all.

1. **Score >= 80 (Strong)**: Automatically run evaluate mode. No ask.
2. **Score 65 to 79 (Good)**: List and ask "Generate resumes for the matches scored 65 and up?"
3. **Score 55 to 64 (Stretch)**: List only.
4. **Score < 55 (Reach)**: Collapsed into a summary count, list on request.

A user with no skills on file has a neutral fit part of 56; only the title bonuses move it (target role words up to 8, a seed seniority word 3, so at most 67). Nothing reaches the automatic band, and a row at 65 or above reflects the title only: list the rows and ask.

When `skills.levels` in `${WORKSPACE}/data/profile.json` is empty, do NOT auto evaluate the 80 band (the same holds for a table that holds only levels of 0.9 and above: a table of strengths alone is not counted as a rating; its terms still count as evidence that the user holds the skill, at the level given, so a posting that names rated skills the bullets do not carry scores a point or two higher for each one, about twelve for a table of ten, and can cross the 55 floor): list those rows with the Good band and ask. Until the table is filled in, the score tells you whether a posting is in the user's field and how much of it their material covers; it does not know which of their skills are the strongest, so treat the order inside a band as approximate and read `gatePass.gate1` as "clears the 55 floor". Offer once to rate skills, the weak ones included (`onboard.md` Step 6, `skills.levels`). A listing with only a snippet for a description (under about 60 content words) is pulled toward the neutral score and cannot reach the automatic band; fetch the full description before judging it.

Each evaluated posting gets its own report slug from `lib/dedup.js reportSlug` (`evaluate.md` Block E): under any policy other than remote only, the same title in two cities is two rows, two folders, and two queue entries.

Ghost flag postings (score >= 0.30 from `lib/ghost-score.js`) show with a warning marker in the table. `Suspicious` postings (ghost >= 0.60) are hidden by default; use `--show-ghosts` to include.

For each auto evaluated posting, report:
- Company, role, match score, archetype
- Files generated (resume DOCX, cover letter DOCX, analysis)
- Top differentiator from the rank reasons, and any unmet stated minimum

After all evaluations complete, ask:
"Want me to apply to any of these? Type `/jobe apply {company-slug}` for any role."

## Emergent Company Index

Every run updates `${WORKSPACE}/data/companies/index.json` with newly discovered companies
and their detected ATS (eleven systems are recognized from a posting URL). Over time the
index grows to cover every company that has posted a role in the user's field that a run surfaced.

## Negative List

`${WORKSPACE}/data/companies/negative-list.json` contains slugs the user does not want to see.
The pipeline filters them out before presenting results. Staffing agencies and aggregators
are handled by the shared staffing list and do not belong there.

## Failure Modes

- **No search key** (`BRAVE_API_KEY`, `SERPAPI_KEY` unset): those sources return `[]`. The
  pipeline still works through the feeds, the guest search, and the per company crawlers,
  with lower recall; the agent fallback then runs.
- **No seeds**: search driven sources skip and every title is kept. Run `/jobe onboard seeds`.
- **A source throws**: caught at pipeline level; other sources continue.
- **All sources fail**: pipeline writes an empty `ranked-enriched.json` and
  reports the source error summary.
- **Today's list does not exist yet**: the helper scripts print a one line hint and exit 0.
