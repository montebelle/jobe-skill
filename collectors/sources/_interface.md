# Source Plugin Contract

Every source under `collectors/sources/` must export a single `discover`
function matching this signature:

```js
/**
 * @param {object} ctx - Discovery context
 * @param {string[]} ctx.queries     - Seed queries (role + location strings)
 * @param {object}   ctx.filters     - { usOnly, maxAgeDays, locations, negativeList }
 * @param {object}   ctx.profile     - the candidate's profile (target roles, locations)
 * @param {object}   ctx.auth        - { serpApiKey, ... }
 * @param {object}   ctx.logger      - { info(msg), warn(msg), error(msg) }
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
   and can derive the direct Greenhouse/Lever/Ashby URL, use that as
   `canonicalUrl` and put the aggregator URL in `alternateUrls`.
5. **Attach provenance.** Fill `sourceUrl` with the URL the posting was
   found AT (not the posting URL) so we can audit recall later.
6. **Gate on required env.** If `requires` lists an env var that is absent,
   return `[]` immediately; the pipeline handles missing-source gracefully.
7. **Deduplicate within-source.** A single source may return the same
   posting twice (different queries hit it); dedup before returning.

## Naming

- `aggregators/` — sources that search across many companies (SerpAPI, HN, etc.)
- `company-specific/` — direct integrations against a single employer's careers API
- `ats-directories/` — sources that enumerate a platform's customer list
- `ats-direct/` — thin callers for a known ATS board slug (tactical, not discovery)
