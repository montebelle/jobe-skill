# Mode: linkedin-tab — Human-in-the-Loop LinkedIn Jobs Ingest

Pull job postings from the user's **own, already-open LinkedIn Jobs search tab** into the discovery pipeline. The user's logged-in session is never automated headlessly: the human opens the search, the agent only **reads** the visible page via the Chrome extension. This is the account-safe alternative to scraping LinkedIn (see `collectors/sources/aggregators/linkedin-guest.js` for the no-login public-endpoint source that runs inside `/jobe find`).

## Why this design
- LinkedIn bans accounts for unattended automation. your account is a career asset; it is never driven by a bot.
- Easy Apply-only and member-only listings are not visible to the logged-out guest endpoint — but they ARE visible in the user's own browser tab. Reading what the user already sees captures that slice with zero added account behavior.
- The same dedup -> rank flow as `/jobe find` applies downstream, so manual captures merge cleanly with pipeline output.

## Steps

1. **Check Chrome connection.** Load the Claude-in-Chrome tools via ToolSearch if deferred (`mcp__Claude_in_Chrome__*`). If no browser is connected, ask the user to open Chrome with the extension and log into LinkedIn.

2. **Ask the user to open their search.** They should open `linkedin.com/jobs` with their preferred filters applied (keywords, Remote, Date Posted = Past Week/Month, US). Their saved searches/alerts work too. Wait for confirmation, then use the tab context tools to find the LinkedIn tab.

3. **Read the page.** Use `get_page_text` (or `read_page`) on the LinkedIn tab. The left rail lists job cards: title, company, location, posted-age ("3 days ago"), and links of the form `linkedin.com/jobs/view/...`. If the user scrolls and says "next page", read again and append — repeat for as many pages as the user wants to capture.

4. **Extract to JSON.** Build an array of raw postings:
   ```json
   [{ "title": "Senior Machine Learning Engineer", "company": "Acme",
      "location": "United States (Remote)", "url": "https://www.linkedin.com/jobs/view/...",
      "postedDate": "3 days ago", "jdText": "" }]
   ```
   Rules: one entry per visible card; keep the posted-age string verbatim (`lib/posting.js parseDate` understands relative ages); do NOT invent fields that are not on the page; if the user opened a specific job's detail pane, include its description text as `jdText`.

5. **Ingest.** Write the array to `/tmp/linkedin-tab-postings.json`, then run:
   ```bash
   node collectors/ingest-manual.js /tmp/linkedin-tab-postings.json --source linkedin-tab
   ```
   This normalizes, dedups (against itself), quick-scores, filters to role matches, and writes `signals/discovered/{date}/manual-linkedin-tab.json`.

6. **Present results.** Show the ranked list (score, company, title, remote/US classification, URL). Apply the standard remote-only rule from `_profile.md`: flag any posting whose classification is `hybrid`/`onsite` rather than silently keeping it.

7. **Offer next steps.** For any posting the user wants to pursue: run the standard evaluate flow (`modes/evaluate.md`) on its URL — A–G blocks, gate-pass scoring, then resume + cover letter via `lib/bullet-select.js`. Easy Apply postings: note that application happens in the user's browser per `modes/apply.md` (human-in-the-loop, user reviews before submit).

## Hard rules
- NEVER navigate, click, type, or otherwise act on linkedin.com — read-only on the user's open tab. (Applying via `modes/apply.md` is the separate, user-supervised exception on the employer's apply page.)
- NEVER store LinkedIn session data, cookies, or anything beyond the extracted posting fields.
- All extracted postings go through `collectors/ingest-manual.js` — no hand-maintained side lists that bypass dedup and the tracker.
