# Source Plugin Contract

Every source under `collectors/sources/` must export a single `discover`
function matching this signature:

```js
/**
 * @param {object}   ctx          - Discovery context
 * @param {object[]} ctx.queries  - The user's seed queries: [{ query, location }]
 *                                  (data/queries/seeds.json, or --query on the command line)
 * @param {object}   ctx.filters  - The user's discovery policy merged with command line flags:
 *                                  { remoteOnly, usOnly, workModes, countries, regions, maxAgeDays,
 *                                    seniorityExtensionDays, salaryFloor, salaryCurrency,
 *                                    excludeStaffing, minScore, companySites, atsSlugs? }
 * @param {object}   ctx.auth     - { serpApiKey, braveApiKey }; other keys are read from env
 * @param {object}   ctx.logger   - { info(msg), warn(msg), error(msg) }
 * @param {object}   ctx.limiter  - rate limiter built from `rateLimit`; `await ctx.limiter.wait()`
 * @param {Function} ctx.reportSourceStatus - report `degraded|failed|skipped` plus a stable reason
 * @returns {Promise<Posting[]>}
 */
async function discover(ctx) { ... }

module.exports = {
  id: 'unique-source-id',          // used in Posting.discoveredVia
  name: 'Human Readable Name',
  requires: ['SERPAPI_KEY'],       // env vars required to run (optional)
  rateLimit: { rpm: 60 },          // rough requests-per-minute budget
  discover,
};
```

## Rules

1. **Return canonical `Posting[]`.** Use `createPosting(raw, sourceId)` from `lib/posting.js`.
2. **Never throw.** Catch all errors, log via `ctx.logger`, return `[]` or partial results.
3. **Respect rate limits.** Self-throttle; the pipeline does not police you.
4. **Prefer direct ATS URLs.** If you discover a posting via an aggregator
   and can derive the direct ATS URL, use that as `canonicalUrl` and put the
   aggregator URL in `alternateUrls`.
5. **Attach provenance.** Fill `sourceUrl` with the URL the posting was
   found AT (not the posting URL) so we can audit recall later.
6. **Gate on required env.** `requires` is declarative metadata; the plugin
   still gates itself inside `discover()`. If a listed env var is absent,
   return `[]` immediately; the pipeline handles a missing source gracefully.
   An opt in flag (a source that is off unless the user sets an env var, such
   as `HIRING_CAFE_OPT_IN` or `INDEED_CAMOUFOX_ENABLED`) is listed in
   `requires` like a key and gated the same way.
7. **Deduplicate within-source.** A single source may return the same
   posting twice (different queries hit it); dedup before returning.
8. **No role vocabulary in a plugin.** Search terms come from
   `roleStrings(ctx, { max })` and title gates from `makeTitleMatcher(ctx)`
   (both in `lib/role-queries.js`). They are derived from the user's own
   seeds, so a nurse's run searches nursing titles and an accountant's run
   searches accounting titles. A search based plugin with no seed roles logs
   `no seed roles; skipping` and returns `[]`. Never call
   `rank.isRoleMatch(title)` with one argument: with no profile it keeps
   every title. `sourceQuery` values must not name a field either.
9. **No curated employer or tenant list in plugin code.** Tenants come from
   `ctx.filters.atsSlugs`, the workspace company index
   (`data/companies/index.json`, grown by every run), and the seed files (the
   user's workspace copy first, then the shared copy, which ships empty). A
   plugin that crawls one board per company gets all three from
   `lib/ats-tenants.js loadTenants(ctx, '<ats>')`, which returns
   `[{ slug, name|null }]`; the older plugins read the seed files through
   `collectors/seed-files.js`. Career sites to search come from
   `ctx.filters.companySites` (the user's `discovery.companySites`).
10. **Honour the user's policy instead of hardcoding one.**
    `ctx.filters.remoteOnly` and `ctx.filters.usOnly` are booleans that are
    true only when the user's policy says so. Send a remote facet only when
    `remoteOnly` is true (or map `ctx.filters.workModes`), and a country only
    when `usOnly` is true or `ctx.filters.countries` names one. With no policy
    a plugin must not narrow its search by work mode or country. Never assume
    a market either: a plugin whose API needs one country and finds none in
    the policy returns `[]` and logs. For recency read the window through
    `recencyDays(ctx.filters)` from `lib/profile.js`, never `maxAgeDays`
    directly: it returns the day count, or `null` when the user turned the
    cut off (`maxAgeDays` 0). On `null` send no recency parameter and keep
    every row; a feed plugin tests a row with `withinAge(date, days)` from
    the same module.
11. **Discovery is not verification.** A plugin may only ASSERT a work mode
    it cannot confirm (a search facet is not evidence). Pass the location the
    source displayed as `hqLocation` and leave `remoteVerified` false; only a
    verification step that fetched the real posting may set it true.
12. **Posted date is the ORIGINAL publish date.** When an API offers both a
    first published date and an updated date, pass the first published one;
    an updated date moves on every repost and defeats the recency gate.
13. **Neutral User-Agent.** No person, email, or account handle in any
    request header. The house string is `jobe-discovery/1.0 (personal job search)`;
    an endpoint that only answers a browser style agent gets the same product
    token inside a `Mozilla/5.0 (compatible; ...)` envelope, or a plain
    browser agent, never an identity.
14. **Stop on quota exhaustion.** A provider-wide quota response is not a
    per-query transient. Stop that source after the first quota response,
    report `degraded` with a stable reason, and allow independent sources to
    continue. Never fan a known quota failure across the remaining query set.

## Naming

- `aggregators/` — sources that search across many companies (SerpAPI, HN, etc.)
- `company-specific/` — direct integrations against a single employer's careers API
- `ats-directories/` — sources that enumerate a platform's customer list
- `ats-direct/` — thin callers for a known ATS board slug (tactical, not discovery)

Every `.js` file inside those four folders is loaded as a plugin, so a helper
shared by several plugins lives outside them: in `lib/` (for example
`lib/ats-tenants.js`, `lib/role-queries.js`) or next to the pipeline
(`collectors/seed-files.js`).
