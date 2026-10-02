# Mode: linkedin-tab (Human in the Loop LinkedIn Jobs Ingest)

Pull job postings from the user's **own, already open LinkedIn Jobs search tab** into the discovery flow. The user's logged in session is never automated headlessly: the human opens the search, the agent only **reads** the visible page through the Chrome extension. This is the account safe alternative to scraping LinkedIn (see `collectors/sources/aggregators/linkedin-guest.js` for the public endpoint source that needs no login and runs inside `/jobe find`).

## Why this design
- LinkedIn bans accounts for unattended automation. Your account is a career asset; it is never driven by a bot.
- Easy Apply only and member only listings are not visible to the logged out guest endpoint, but they ARE visible in the user's own browser tab. Reading what the user already sees captures that slice with zero added account behavior.
- The same dedup and rank flow as `/jobe find` applies downstream, so manual captures merge cleanly with pipeline output.

## Steps

1. **Check the Chrome connection.** Load the Claude in Chrome tools via ToolSearch if deferred (`mcp__Claude_in_Chrome__*`). If no browser is connected, ask the user to open Chrome with the extension and log into LinkedIn.

2. **Ask the user to open their search.** They should open `linkedin.com/jobs` with their own filters applied: keywords, plus whatever their location policy calls for (the work mode facet, the country or city) and a Date Posted preset. Suggest the largest preset that does not exceed their recency window (`discovery.maxAgeDays` in `${WORKSPACE}/data/profile.json`), so no card is older than the window: LinkedIn offers past 24 hours, past week, and past month, with nothing between a week and a month. Their saved searches and alerts work too. Wait for confirmation, then use the tab context tools to find the LinkedIn tab.

3. **Read the page.** Use `get_page_text` (or `read_page`) on the LinkedIn tab. The left rail lists job cards: title, company, location, posted age ("3 days ago"), and links of the form `linkedin.com/jobs/view/...`. If the user scrolls and says "next page", read again and append. Repeat for as many pages as the user wants to capture.

4. **Extract to JSON.** Build an array of raw postings:
   ```json
   [{ "title": "<title exactly as shown on the card>", "company": "<company>",
      "location": "<location exactly as shown>", "url": "https://www.linkedin.com/jobs/view/...",
      "postedDate": "3 days ago", "jdText": "" }]
   ```
   Rules: one entry per visible card; keep the posted age string verbatim (`lib/posting.js parseDate` understands relative ages); do NOT invent fields that are not on the page; if the user opened a specific job's detail pane, include its description text as `jdText`.

5. **Ingest.** Write the array to a temp file (for example `/tmp/linkedin-tab-postings.json`), then from `${JOBE_HOME}` run:
   ```bash
   node collectors/ingest-manual.js /tmp/linkedin-tab-postings.json --source linkedin-tab
   ```
   This normalizes, dedups (against itself; one employer's same title in several cities stays one row per city unless the work mode policy is exactly `["remote"]`), drops the user's negative list companies and the shared staffing list (unless `discovery.excludeStaffing` is false), applies the user's title policy and target role match, quick scores, and writes `${WORKSPACE}/signals/discovered/{date}/manual-linkedin-tab.json`. A second run with the same `--source` on the same day merges into that file (deduplicated), so later pages can be ingested one at a time.

6. **Present results.** Show the ranked list (score, company, title, work mode and location as classified, URL). The ingest script applies no work mode, country, region, or recency gate, so apply the user's policy from `${WORKSPACE}/data/profile.json` here: DROP postings outside it (`discovery.workModes`, `discovery.countries`, `discovery.regions` for every posting that is not remote, `discovery.maxAgeDays`) from the presented list. If useful, list them separately as excluded, never inside the main list. With no policy on file, present everything. A card's location label is an assertion, not a verified fact: say so for any posting whose JD you have not read.

7. **Offer next steps.** For any posting the user wants to pursue: run the standard evaluate flow (`modes/evaluate.md`) on its URL: the A to G blocks, gate pass scoring, then resume and cover letter through Block E of `evaluate.md` (read the JD first, then the user's evidence). Easy Apply postings: the application happens in the user's browser per `modes/apply.md` (human in the loop, the user reviews before submit).

## Hard rules
- NEVER navigate, click, type, or otherwise act on linkedin.com. Read only on the user's open tab. (Applying through `modes/apply.md` is the separate exception, supervised by the user, on the employer's apply page.)
- NEVER store LinkedIn session data, cookies, or anything beyond the extracted posting fields.
- All extracted postings go through `collectors/ingest-manual.js`. No side lists kept by hand that bypass dedup and the tracker.
