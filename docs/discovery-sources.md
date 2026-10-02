# Discovery sources: coverage map

This page answers "which sites does `/jobe find` read, and why only these?" at a glance.

`/jobe find` runs every plugin under `collectors/sources/`. Any `.js` file in one of the four folders below that exports `{ id, name, requires, rateLimit, discover }` is loaded by `collectors/pipeline.js loadSources()`. There are 33 plugins today: 20 aggregators, 2 company specific, 1 ATS directory, 10 ATS direct. The contract every plugin follows is in [`collectors/sources/_interface.md`](../collectors/sources/_interface.md).

To see the exact list on your machine, with your seed roles and your merged filters, and without any network call:

```bash
node collectors/pipeline.js --dry-run
```

## What every source has in common

* **Your roles are the queries.** Search terms come from your own seed roles in `data/queries/seeds.json` through `lib/role-queries.js`. No plugin carries a role list or a title pattern. A registered nurse's run searches nursing titles and a tax accountant's run searches accounting titles. A search based source with no seed roles logs `no seed roles; skipping` and returns nothing.
* **Your policy is the filter.** Work mode, country, recency, pay floor, title rules, and the staffing filter come from `data/profile.json` through `lib/profile.js`. With no policy on file a source sends no work mode facet and no country, and the pipeline drops nothing by work mode, country, or pay. A command line flag wins over the profile, and the profile wins over the permissive default.
* **No employer list ships.** `configs/portals.json` ships empty, and the employer seed `data/companies/non-tech-seed.json` exists only in your workspace (created from `templates/non-tech-seed.template.json`). Company career sites searched by `brave-search` and `serpapi-site-search` come only from `discovery.companySites` in your profile.
* **A source that cannot run stays quiet.** A missing key, an unset opt in flag, no seed roles, or no tenants: the plugin logs one line and returns `[]`. The pipeline continues with the rest.
* **Discovery is not verification.** A source may assert a work mode it cannot confirm (a search facet is not evidence). Such a posting carries `remoteVerified: false` and the location the source displayed in `hqLocation` until a verification step confirms it. See "After discovery" below.
* **Recency keys on the original publish date.** Where an API offers both a first published date and an updated date, the first published one is used (`first_published` on Greenhouse, `publishedAt` on Ashby). An updated date moves on every repost and would defeat the recency window. A window of `0` (`discovery.maxAgeDays` or `--max-age 0`) turns the cut off in the pipeline and in every source: a source then omits its own recency parameter.
* **Neutral request headers.** Requests identify as `jobe-discovery/1.0 (personal job search)` or a plain browser agent. No person, email, or account name is sent. The one exception is `usajobs`, whose API requires the email you registered your own key with.

## Aggregators (search across many employers)

| Source id | Needs | What it reads | Notes |
|---|---|---|---|
| `brave-search` | `BRAVE_API_KEY` | Brave Search, one `site:` query per ATS domain and seed role | Recommended free path (2,000 queries per month, no card). Up to 8 seed roles. Also searches your `discovery.companySites`. |
| `serpapi-google-jobs` | `SERPAPI_KEY` | Google for Jobs through SerpAPI | Up to about 50 results per seed query. Retries a 429 or 5xx up to four times with back off and honors `Retry-After`. Takes its market from the single country your country list names. |
| `serpapi-site-search` | `SERPAPI_KEY` | Google `site:` search across ATS domains | Up to 4 seed roles. Same retry rule. Also searches your `discovery.companySites`. Takes its market from the single country your country list names. |
| `adzuna` | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | Adzuna Jobs API | Needs exactly one market. Uses the first country in `discovery.countries` (a code, a name, or an alias: "UK" is gb), and skips when the list names no country. Under a policy that accepts no remote work it searches in the seed row's first place. A predicted salary is left out. Up to 4 seed roles. |
| `jsearch` | `JSEARCH_API_KEY` (or `RAPIDAPI_KEY`) | Google for Jobs through RapidAPI | Up to 4 seed roles. Takes its market from the single country your country list names. Under a policy that accepts no remote work the query names the seed row's first place instead of the country. |
| `findwork` | `FINDWORK_API_KEY` | findwork.dev | The board lists software and technology roles, so it returns little for other fields. Up to 4 seed roles. |
| `jooble` | `JOOBLE_API_KEY` | Jooble Jobs API | The free plan is 500 requests for the life of the key, so at most 4 requests per run. A role seeded in several locations is searched in the first location only. |
| `usajobs` | `USAJOBS_API_KEY` and `USAJOBS_EMAIL` | data.usajobs.gov | US federal jobs in every profession. Up to 3 seed roles. Under a policy that accepts no remote work the search is limited to the seed row's places. |
| `hiring-cafe` | `HIRING_CAFE_OPT_IN=1` | hiring.cafe public data route | Off by default because the site's robots file disallows the search address pattern. Turn it on only for personal, low volume use. Up to 3 seed roles, 2 pages each. |
| `indeed-camoufox` | `INDEED_CAMOUFOX_ENABLED=1` | Indeed public search pages in a stealth browser | Off by default. Signed out only: it never signs in, never clicks Apply, and stops the whole source on any verification page. Targets indeed.com (the US site). Tuning: `INDEED_CAMOUFOX_MAX_QUERIES`, `_PAGES`, `_DETAILS`, `_DELAY_MS`, `_HEADLESS`. |
| `linkedin-guest` | none | LinkedIn public signed out job search | No account, no sign in. Up to 9 seed roles, 2 pages each (`LINKEDIN_GUEST_PAGES` raises it). The location sent is the country, except that an onsite or hybrid search runs in the seed row's own place (the first two places per role), else in your first region written as a name. Discovery only: see "After discovery". |
| `hn-who-is-hiring` | none | The monthly Hacker News hiring thread | Mostly early stage technology employers. Comments are matched against your seed roles. |
| `remotive` | none | Remotive API | Remote board. Up to 5 seed roles. |
| `remoteok` | none | RemoteOK feed | Remote board. One feed request, titles matched locally. |
| `weworkremotely` | none (`WWR_CATEGORIES` optional) | We Work Remotely RSS | Remote board. Reads the catch all feed, which covers every category. `WWR_CATEGORIES` adds category feeds for your own field. |
| `himalayas` | none | Himalayas API | Remote board. The 300 newest postings, titles matched locally. |
| `jobicy` | none | Jobicy API | Remote board. Up to 3 seed roles. The US scope parameter is sent only for a country policy of exactly `["US"]`. |
| `working-nomads` | none | Working Nomads feed | Remote board. One feed request. |
| `arbeitnow` | none | Arbeitnow job board API | Paged feed, up to 10 pages. Mostly European employers. |
| `themuse` | none (`THEMUSE_CATEGORIES` optional) | The Muse public API | No keyword search exists, so titles are matched locally. With no category it reads the five newest pages, a thin slice of a large feed. Set `THEMUSE_CATEGORIES` to the site's own category names for your field. |

The remote boards are remote by construction. They return little for a profession that is rarely remote, which is expected and harmless.

## Company specific

| Source id | Needs | Notes |
|---|---|---|
| `amazon-jobs` | none | One fixed employer, always on. Query driven, so it returns nothing for roles that employer does not post. Server side scope is the United States only. |
| `apple-jobs` | none | Same as above. |

## ATS directory

| Source id | Needs | Notes |
|---|---|---|
| `ashby-directory` | tenants | Reads each known Ashby board. Tenants come from your portals seed and the company index. |

## ATS direct (one employer board at a time)

| Source id | Needs | Notes |
|---|---|---|
| `greenhouse-direct` | tenants | Public board API. Recency on `first_published`. |
| `lever-direct` | tenants | Public postings API. |
| `workable` | tenants | Public account feed. A Workable posting address names no tenant, so tenants reach the index through the slug harvest or your portals seed, not through postings. |
| `recruitee` | tenants | Public offers API per company. |
| `breezy` | tenants | Per company subdomain. The job description is filled by enrichment. |
| `bamboohr` | tenants | Per company subdomain. The feed carries no employer name, so pin `{ "slug": "...", "name": "..." }`. |
| `personio` | tenants | Per company subdomain, XML feed. The feed carries no employer name, so pin the name. Mostly European employers, so under a country policy of exactly `["US"]` most rows are dropped downstream. |
| `workday` | employer seed | One entry per employer in `non-tech-seed.json`. Up to 3 seed roles as search text. |
| `smartrecruiters` | employer seed | One entry per employer. Up to 4 seed roles. |
| `icims` | employer seed | Best effort page reading, less reliable than the other two. Up to 3 seed roles. |

**Tenants** means the union of: `ctx.filters.atsSlugs.<ats>` for one run, your workspace `data/companies/portals.json`, the shared `configs/portals.json` (ships empty), and entries in your workspace `data/companies/index.json` tagged with that ATS. No tenant list ships.

**Employer seed** means your workspace `data/companies/non-tech-seed.json` (no shared copy ships; the list is empty until you add an employer). Workday, SmartRecruiters, and iCIMS have no search across companies, so each employer is listed explicitly. `templates/non-tech-seed.template.json` shows the entry shapes and, under `$howToFind`, how to read the values off an employer's careers address and test them.

## How the company index grows

Nothing has to be listed by hand for the Greenhouse, Lever, Ashby, Workable, Recruitee, Breezy, BambooHR, and Personio sources. `data/companies/index.json` in your workspace grows on every run:

* **Slug harvest** (`lib/slug-harvest.js`, needs `BRAVE_API_KEY`). Before the sources run, twelve `site:` patterns across eleven ATS hosts are searched with up to three of your seed roles each (at most 36 queries, 12 when you have no seeds). New tenants land in the index and are scanned in the same run.
* **Postings.** Every posting whose address is on a known ATS host tags its employer with that ATS (`lib/slug-harvest.js atsFromUrl`).
* **Name resolution.** Employers found by name only (from the LinkedIn guest and Google for Jobs sources) are filed as `ats: "other"`. `node scripts/resolve-index-backlog.js` and `node scripts/linkedin-guest-sweep.js` probe the public Greenhouse, Lever, and Ashby board APIs and promote the names that resolve.

## After discovery

The pipeline applies your policy twice: a permissive pass before enrichment (a posting is dropped only when it is already known to be outside your work modes or countries) and a strict pass after enrichment, when the job description has been read. Postings the pipeline cannot enrich need the scripts below.

| Script | Purpose |
|---|---|
| `scripts/prune-queue.js [--dry]` | Removes dead rows from the apply queue (no report folder, archived, or a title your policy excludes). Keeps all applied and skipped history. Never deletes a folder. |
| `scripts/resolve-linkedin-to-ats.js [list] [--write] [--limit N]` | Resolves each LinkedIn lead to the employer's own Greenhouse, Lever, or Ashby listing by company name and a decisive title match, then takes location and work mode from that listing. |
| `scripts/verify-remote.js [list] [--only-linkedin] [--limit N] [--write]` | Confirms the work mode from the posting page (LinkedIn through the signed out guest endpoint only) and stamps `remoteVerified`, `verifyStatus`, `verifiedLocation`, `verifiedWorkplace`. |
| `scripts/verify-listing.js <list> [--write]` | Optional. Checks each listing against the employer's ATS: still open, title, location, work mode, original publish date, published pay. |
| `scripts/classify-gate.js [list] [minScore]` | Optional. Splits the list into listings the apply harness can complete and listings a person must finish. |
| `scripts/final-list.js [list] [minScore] [outFile] [--allow-onsite] [--no-us-only]` | Optional. The presentation gate driven by your profile and the exclusion lists, with compensation on every row. It applies the strict work mode gate to the verified mode (a listing that states none counts as onsite), `discovery.regions` to every listing that is not remote, and the title rule. |
| `scripts/linkedin-guest-sweep.js` | Optional. Widens the company index from your seed roles through the public guest search (`LINKEDIN_SWEEP_MAX_QUERIES`, default 20). |
| `scripts/resolve-index-backlog.js` | Resolves index entries that have no ATS yet (`RESOLVE_LIMIT`, default 700). |

A posting may be presented as remote when, and only when, `verifyStatus` is `remote` or its location came from the employer's own listing. `inconclusive` and `unreachable` are not remote.

## Known limits

* Only the United States maps to a server side country scope in `amazon-jobs`, `apple-jobs`, `jobicy`, `hiring-cafe`, and the LinkedIn geo id used by the signed in search helper. Any other country policy searches unscoped and relies on the pipeline's country gate, which drops a posting only when its location names a country outside your list (or is recognizably in the United States) and keeps a city alone, a city and region, or a location that names no place as unknown. `brave-search`, `serpapi-google-jobs`, `serpapi-site-search`, `jsearch` and the slug harvest take their market from the single country your list names (a code, a name, or an alias: "UK" is gb; code plus name for one country counts once); with several countries they search with no market.
* `hiring-cafe` sends its US country object without coordinates and only for a country policy of exactly `["US"]`. That request shape has not been checked against the live site. If the site ignores it, results are simply broader and the pipeline's country gate still applies.
* `linkedin-guest` sends the country as free text: a name of more than two letters from your list when it holds one, else the name of the code when the list resolves to one country (`["GB"]` sends "United Kingdom"). A list of several bare codes sends no location and relies on the pipeline's country gate. For onsite and hybrid work it searches at most the first two seed places per role.
* Every deliberate ceiling in the code, with its file and upgrade path, is listed in [`known-limitations.md`](known-limitations.md).
* Hybrid office share (`discovery.hybridMaxOfficeShare`) is not enforced in code. It is a rule the find mode applies when it reads the job description.
* The pay floor compares only a published YEARLY band whose stated currency equals `discovery.salaryCurrency`. Free text is parsed for the codes USD, GBP, EUR, CAD, AUD, NZD, SGD, CHF and for the dollar, pound, and euro signs; a bare `$` is read as USD only for a posting placed in the United States. Everything else (another currency, an unstated currency, pay per hour, month, or pay period, text that does not parse) is unknown, which is kept and labeled, never treated as below your floor.
* `discovery.regions` is a whole phrase match on the posting location, applied to hybrid and onsite postings only, so list the distinctive place names (a city, a state or province). A US state, a Canadian province or territory, an Australian state, or a UK nation matches by its name and by its code, whichever you write (`["Denver", "Colorado"]` keeps "Aurora, CO"). For a region in any other country, list both the name and the code postings use, the code in capitals (for example `["Munich", "Bavaria", "BY"]`). There is no distance or commute model.
* `needsAgentFallback` in `discovery-summary.json` fires when Brave returned fewer than 100 results or fewer than 300 postings survived dedup. Those thresholds were tuned on one large search, so a narrow field will usually ask for the agent fallback.
* `resolve-linkedin-to-ats.js`, `resolve-index-backlog.js`, and `linkedin-guest-sweep.js` probe Greenhouse, Lever, and Ashby only. Employers on other systems stay unresolved until an agent finds their listing.

## Excluded boards, and why

The large consumer boards retired their public read interfaces. Much of their inventory still arrives indirectly through Google for Jobs (`serpapi-google-jobs`, `jsearch`). None of the boards below can be read through an official interface without a partner contract, a sign in, or a terms violation.

| Board | Status | Path used here, if any |
|---|---|---|
| Indeed | Public API retired. Partner only job sync. | No official path. The opt in `indeed-camoufox` source reads the public signed out search pages and stops on any verification page. |
| ZipRecruiter | Partner only, approval gated. | None built. The publisher partner API is the one real path that is not built. |
| Glassdoor | Public API retired, enterprise only. | None. |
| Dice | API shut down. | Some listings arrive through Google for Jobs. |
| Monster | API deprecated. | Covered indirectly through Google for Jobs. |
| SimplyHired | Feeds shut down. | Covered indirectly through Google for Jobs. |
| Wellfound | No API, terms forbid scraping, sign in wall. | None. |
| Y Combinator Work at a Startup | Sign in wall. | None. Those employers' own ATS boards are already read. |
| Otta, Welcome to the Jungle | No public API, sign in wall. | None. |
| Built In | No API. It fronts Greenhouse and Lever boards that are already read. | None unique. |
| Teal | No API. It is itself an aggregator over other boards. | None unique. |
| LinkedIn (signed in) | Excluded from the automated pipeline as an account safety rule. | Only the signed out guest endpoint runs unattended. The signed in search is a separate, opt in, user present mode (`/jobe linkedin-search`). |
| Google Jobs (direct) | Official API shut down. | Covered through `serpapi-google-jobs` and `jsearch`. |

## To widen further (your action)

* Set the keys for the sources that are built and dark until keyed: `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`, `JSEARCH_API_KEY`, `USAJOBS_API_KEY` and `USAJOBS_EMAIL`, `FINDWORK_API_KEY`, `JOOBLE_API_KEY`. All have free tiers. See `.env.example`.
* Set `BRAVE_API_KEY`. It powers both the widest keyword source and the slug harvest that feeds the eight per company crawlers.
* Add your target employers: career site domains in `discovery.companySites`, board identifiers in `data/companies/portals.json`, and Workday, SmartRecruiters, or iCIMS employers in `data/companies/non-tech-seed.json`.
* Set `THEMUSE_CATEGORIES` and `WWR_CATEGORIES` to the categories of your own field.
* Set `HIRING_CAFE_OPT_IN=1` or `INDEED_CAMOUFOX_ENABLED=1` if you accept what each one does.
* Run `/jobe linkedin-search` while you are present to reach the inventory only a signed in search shows.
