# Jobe — Dashboard

A self-hosted Next.js dashboard for the [Jobe](../) career-intelligence skill.
Reads directly from the parent repo's filesystem (`data/`, `reports/`,
`signals/`). Runs locally on `http://localhost:3000`. No data leaves the
machine.

## What you see

| Route | Page | Purpose |
|---|---|---|
| `/` | Pipeline overview | The signature typographic funnel — discovered → evaluated → queued → applied → responded → interviewing → offer — with conversion rates, recent activity, archetype distribution, and the top of queue. |
| `/queue` | Apply queue | Filterable table. Score / archetype / role search + sort. Per-row actions: download resume DOCX, cover letter DOCX, open posting, mark applied, mark skipped (with reason). Keyboard shortcuts: `j`/`k` navigate, `a` apply, `s` skip, `↵` open report, `/` focus filter. |
| `/applied` | Applied list | Combined view of `apply-queue.json` + `tracker.md`. Status, applied date, days-since, response state, links to original posting + the resume/cover used. |
| `/skipped` | Skipped list | Skipped entries with reasons. Useful for spotting patterns. |
| `/reports/[slug]` | Posting detail | Side-by-side resume preview (rendered from JSON) + cover letter (rendered as serif paragraphs). Score, archetype, status. Download buttons for the canonical DOCX artifacts. |
| `/stats` | Analytics | Score histogram, archetype pie, applications-per-day timeline, source attribution, per-archetype apply rate. |
| `/discovery` | Latest run | Per-source counts, raw → dedup → filter → enrich funnel, ghost-flag count, agent-fallback signal, top 30 ranked postings from the most-recent run. |

## Run

Prerequisites: Node.js ≥ 20.

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:3000`.

For production-style local hosting:

```bash
npm run build
npm run start
```

## Architecture

- Next.js 16 App Router, React 19, Tailwind 4 with `@theme` tokens.
- All file I/O happens in server components / route handlers. No
  filesystem reads on the client.
- Mutations (`/api/queue/[slug]/apply`, `/api/queue/[slug]/skip`) delegate
  to `lib/tracker-writer.js` in the parent repo (the canonical mutation
  module — atomic writes, contract-stable). The dashboard never edits
  `apply-queue.json` directly.
- Path-traversal-safe file serving: `/api/docx/[...path]` only serves
  files under `reports/`, `data/`, and `signals/`. Anything else is 403.
- Mammoth ships in dependencies for any future in-browser DOCX preview;
  current implementation downloads DOCX as binary.

## Visual system

- **Typography**: Fraunces (variable serif) for display monuments and
  italic labels; Geist Sans for UI; Geist Mono for data.
- **Palette**: dark-only, oklch-based. Steel-blue atmosphere with warm
  amber as the "action / signal" accent.
- **The signature**: numbers as monuments. The home funnel renders each
  pipeline stage's count as a variable-weight serif numeral whose
  font-size scales with its share of the previous stage. Conversion
  percentages are whispered in monospace on the right.
- **Motion**: restrained. Staggered rise-in for top-level sections, a
  slow glint on the live indicator, hover state polish on rows.
  No decorative animation.
- **Grain + radial gradient**: subtle SVG noise overlay + corner gradients
  for depth without busy-ness.

## File contracts

The dashboard is read-mostly. It expects these shapes from the parent
repo (defined in `src/lib/types.ts`):

- `data/apply-queue.json` — array of `QueueEntry`.
- `data/tracker.md` — markdown table parsed server-side.
- `reports/{slug}/resume-{date}-{slug}.json` — the tailored resume +
  `coverLetter` field.
- `signals/discovered/{date}/ranked-enriched.json` — discovery output.
- `signals/discovered/{date}/discovery-summary.json` — funnel summary.

If a file is missing the dashboard degrades gracefully (shows empty
states with a hint to run the appropriate `/jobe` command).
