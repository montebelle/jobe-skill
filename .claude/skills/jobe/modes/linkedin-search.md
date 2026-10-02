# Mode: linkedin-search (Agent Driven LinkedIn Logged In Search Sweep)

Drive the user's **logged in** LinkedIn Jobs search across their own target role
queries and paginate, reading each page and ingesting into the same normalize,
dedup, and rank flow as `/jobe find`. This is the powered up sibling of
`linkedin-tab`: where `linkedin-tab` is read only on a page the human navigated,
this mode navigates and paginates itself.

## Why this mode exists (and why it is not a pipeline source)

The logged out guest endpoint (`collectors/sources/aggregators/linkedin-guest.js`,
which runs inside `/jobe find`) returns thin listings: title, company, and a link,
with no description, and its location label cannot be checked from the card. The
**logged in** search returns the personalized and promoted inventory from real
employers in the user's field that the guest endpoint never surfaces. Reaching it
requires driving the authenticated browser tab through the Chrome extension, which
a headless Node source plugin cannot do. So the drive is orchestrated by the agent
here; the parts that can be code live in `lib/linkedin.js`.

## ACCOUNT SAFETY (hard rules)

- **Opt in and user present only.** Run this only when the user explicitly invokes
  it and is watching. NEVER unattended, headless, or on a schedule. The default
  LinkedIn path remains the read only `linkedin-tab` mode.
- **Human paced and bounded.** Navigate, wait, scroll, read. Do not hammer. The
  logged in session feeds a bot risk score; page reads generate far less signal
  than rapid navigation, so keep waits between actions.
- **Never solve or bypass a CAPTCHA.** LinkedIn embeds an invisible reCAPTCHA in
  the search page DOM at all times (it shows up in the accessibility tree but does
  not block). That is normal, ignore it. But if a **visible** security challenge
  renders, STOP and tell the user to clear it themselves.
- **Read only on the data.** Only navigate, scroll, and read. Never click Apply,
  Save, message, or any write action on linkedin.com.

## Steps

1. **Check the Chrome connection.** Load `mcp__Claude_in_Chrome__*` via ToolSearch if
   deferred. `list_connected_browsers` then `select_browser`. If none is connected,
   ask the user to open Chrome with the extension and log into LinkedIn, then
   `tabs_context_mcp{createIfEmpty:true}` and have them drag their LinkedIn tab into
   the MCP window (or open `linkedin.com/jobs` in the MCP tab themselves).

2. **Build the query set.** Default queries come from `lib/linkedin.profileQueries()`,
   which reads the user's target roles from `${WORKSPACE}/data/queries/seeds.json`
   (written by `/jobe onboard`; there is no built in role vocabulary). It already
   skips any seed title where a `discovery.titleExclude` phrase matches outside
   every `discovery.titleKeep` phrase (the pipeline's title rule): a query the title filter would drop only
   wastes page reads. With no seeds yet it returns `[]`; fall back to the free form
   `$ARGUMENTS` the user typed. Honor any `$ARGUMENTS` as an extra or override query
   in all cases. Keep the list short: heavily overlapping queries waste reads.
   ```bash
   node -e "console.log(require('./lib/linkedin').profileQueries())"
   ```

3. **Per query, per page** (start = 0, 25, 50, ...):
   ```
   url = lib/linkedin.buildSearchUrl({ keywords, start })
   navigate(tabId, url)
   // load all ~25 cards: scroll the results rail to the bottom and back
   browser_batch: wait, scroll down x2 (amount ~16), wait, scroll up
   read_page(tabId, filter:"all", max_chars:200000)         // saves to a tool result file when large
   node collectors/ingest-manual.js "<read_page-file>" --from-accessibility --source linkedin-search-q{n}-p{page}
   ```
   `buildSearchUrl` takes the work mode facet, the geo restriction, and the date
   preset from the user's policy in `${WORKSPACE}/data/profile.json`
   (`discovery.workModes`, `discovery.countries`, `discovery.maxAgeDays`). With no
   policy on file there is no work mode facet and no geo restriction. Known limit:
   only the United States has a geo id in code (`countries` exactly `["US"]`); any
   other country list searches without a geo restriction and relies on the location
   check in step 6. To build the URL:
   ```bash
   node -e "console.log(require('./lib/linkedin').buildSearchUrl({ keywords: process.argv[1], start: Number(process.argv[2]) || 0 }))" "<query>" 25
   ```
   `--from-accessibility` parses the raw read_page dump via `lib/linkedin.parseSearchCards`,
   normalizes, dedups, **drops staffing agencies** (the shared
   `data/companies/staffing-list.json`, unless `discovery.excludeStaffing` is false)
   and the user's negative list companies, applies the user's title policy and target
   role match, and writes `${WORKSPACE}/signals/discovered/{date}/manual-{source}.json`.
   A later run with the same `--source` on the same day MERGES into that file
   (deduplicated), so one label per sweep also works; a label per query and page
   (as above) keeps each page inspectable. The capture set is every
   `manual-linkedin-search-*.json` written today.

4. **Depth.** Pages 1 to 3 have the highest yield; deep pages (4 and beyond) are
   mostly staffing and promoted noise but still surface a few real employers per
   page. The staffing filter removes most of the noise automatically. Default to
   about 3 pages per query; go deeper only if the user asks. `read_page` output is
   large, so expect each page to cost a heavy read.

5. **Recency.** `buildSearchUrl` picks the LinkedIn date preset closest to the
   user's recency window (`discovery.maxAgeDays`): past 24 hours, past week, or past
   month; a window wider than a month leaves the facet off. LinkedIn has no preset
   between a week and a month, so a window between the two snaps to the nearer one
   (10 days searches the past week, 20 days the past month). The preset also bounds
   "Promoted" cards that hide their date. When the preset is wider than
   the window, drop the older cards yourself in step 6 using each card's posted age.

6. **Verify, then present.** Discovery is not verification: a search facet only
   ASSERTS a work mode or location, and these captures carry scores from the title
   alone (no JD). For the strong shortlist, fetch each JD through the public
   endpoint `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}` (account
   safe, no session) to confirm the work mode, the location, and the posted date
   against the user's policy (including `discovery.regions` for every posting
   that is not remote), then rank on the full text. Present ONLY postings
   that pass the user's policy; list any that could not be confirmed separately as
   unverified, never inside the main list. Then run `modes/evaluate.md` to build
   tailored resumes. Easy Apply and forms behind a login: per `modes/apply.md`
   (Camoufox uses a fresh session; never automate the LinkedIn account).

   The same two scripts `/jobe find` uses can do this in bulk. They stamp what the
   employer's own listing says (`verifiedLocation`, `verifiedWorkplace`,
   `verifyStatus`); compare that to the user's policy. Both accept a capture file as
   it is (they read its `postings` list and write the file back in the same shape):
   ```bash
   node scripts/resolve-linkedin-to-ats.js "<capture file>" --write   # real employer listing URL plus its location
   node scripts/verify-remote.js "<capture file>" --only-linkedin --write
   ```

## Relation to /jobe find

`/jobe find --linkedin` runs the normal pipeline first, then this sweep, and
presents the verified captures together with the ranked list. No script merges the
`manual-*.json` files into `ranked-enriched.json`; dedup them against it by company
and title when you present. A LinkedIn link carries no ATS board slug, so these
captures do not grow `${WORKSPACE}/data/companies/index.json` by themselves.
