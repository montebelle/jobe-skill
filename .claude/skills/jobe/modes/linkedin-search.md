# Mode: linkedin-search — Agent-Driven LinkedIn Logged-In Search Sweep

Drive the user's **logged-in** LinkedIn Jobs search across their profile-fit queries
and paginate, reading each page and ingesting into the same pipeline as `/jobe find`.
This is the powered-up sibling of `linkedin-tab`: where `linkedin-tab` is read-only
on a page the human navigated, this mode navigates and paginates itself.

## Why this mode exists (and why it is not a pipeline source)

The logged-out guest endpoint (`collectors/sources/aggregators/linkedin-guest.js`,
which runs inside `/jobe find`) returns mostly onsite, thin-metadata listings —
near-zero survive the remote-only filter. The **logged-in** search returns the
personalized + promoted inventory from real companies in the user's field that the
guest endpoint never surfaces. Reaching it requires driving the authenticated
browser tab via the Chrome extension, which a headless Node source plugin cannot
do. So the drive is agent-orchestrated here; the codifiable parts live in
`lib/linkedin.js`.

## ACCOUNT-SAFETY (hard rules)

- **Opt-in and user-present only.** Run this only when the user explicitly invokes
  it and is watching. NEVER unattended / headless / cron. The default LinkedIn
  path remains the read-only `linkedin-tab` mode.
- **Human-paced and bounded.** Navigate, wait, scroll, read — do not hammer. The
  logged-in session feeds a bot-risk score; page reads generate far less signal
  than rapid navigation, so keep waits between actions.
- **Never solve or bypass a CAPTCHA.** LinkedIn embeds an invisible reCAPTCHA in
  the search-page DOM at all times (it shows up in the accessibility tree but does
  not block) — that is normal, ignore it. But if a **visible** security challenge
  renders, STOP and tell the user to clear it themselves.
- **Read-only on the data.** Only navigate/scroll/read. Never click Apply, Save,
  message, or any write action on linkedin.com.

## Steps

1. **Check Chrome connection.** Load `mcp__Claude_in_Chrome__*` via ToolSearch if
   deferred. `list_connected_browsers` -> `select_browser`. If none connected, ask
   the user to open Chrome with the extension and log into LinkedIn, then
   `tabs_context_mcp{createIfEmpty:true}` and have them drag their LinkedIn tab into
   the MCP window (or open `linkedin.com/jobs` in the MCP tab themselves).

2. **Build the query set.** Default queries come from `lib/linkedin.profileQueries()`,
   which reads the user's target roles from `data/queries/seeds.json` (written by
   `/jobe onboard` — no hardcoded field vocabulary). If the user has no seeds yet,
   `profileQueries()` returns `[]`; fall back to the free-form `$ARGUMENTS` the user
   typed. Honor any `$ARGUMENTS` as an extra/override query in all cases.

3. **Per query, per page** (start = 0, 25, 50, ...):
   ```
   url = lib/linkedin.buildSearchUrl({ keywords, start })   // Remote + Past week + US baked in
   navigate(tabId, url)
   // load all ~25 cards: scroll the results rail to the bottom and back
   browser_batch: wait, scroll down x2 (amount ~16), wait, scroll up
   read_page(tabId, filter:"all", max_chars:200000)         // saves to a tool-result file when large
   node collectors/ingest-manual.js "<read_page-file>" --from-accessibility --source linkedin-search
   ```
   `--from-accessibility` parses the raw read_page dump via `lib/linkedin.parseSearchCards`,
   normalizes, dedups, **drops staffing agencies** (`data/companies/staffing-list.json`)
   and negative-list companies, role-matches against the profile, and writes/merges
   `signals/discovered/{date}/manual-linkedin-search.json`.

4. **Depth.** Pages 1-3 are highest yield; deep pages (4+) are ~80% staffing/promoted
   noise but still surface a few real employers per page. The staffing filter removes
   most of the noise automatically. Default to ~3 pages/query; go deeper only if the
   user asks. `read_page` output is large — expect each page to cost a heavy read.

5. **Recency.** The `Past week` (f_TPR=r604800) filter guarantees <=7 days even on
   "Promoted" cards that hide their date, satisfying the 14-day rule (`_profile.md`).
   LinkedIn has no 2-week preset; week is the safe choice.

6. **Present + offer next.** Show the ranked, deduped, staffing-filtered companies.
   These carry title-only quickScores (no JD). For the strong shortlist, fetch each
   JD via the public endpoint `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}`
   (account-safe, no session) to verify remote/recency and full-rank, then run
   `modes/evaluate.md` to build tailored resumes. Easy Apply / login-walled forms:
   per `modes/apply.md` (Camoufox uses a fresh session; never automate the LinkedIn account).

## Relation to /jobe find

`/jobe find --linkedin` should run the normal pipeline first, then this sweep, and
merge `manual-linkedin-search.json` into the ranked list (same as `lib/agent-import.js`
merges the WebSearch agent path). The slugs discovered here also grow
`data/companies/index.json` for future direct-ATS runs.
