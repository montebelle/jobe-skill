# Onboard Mode

A guided interview that produces every personal file Jobe needs to run: `_profile.md`, `reference.md`, `data/resume-baseline.json`, `data/bullet-library.json`, and (optionally) `.env`. The user does not have to know the schema. You ask questions, collect answers, and write the files for them.

Total time target: 15–30 minutes for a thorough setup. Less if the user pastes an existing resume up front.

## Input

`$ARGUMENTS` after `onboard`:
- empty → run the full interview
- `resume` → only re-run the resume-baseline + bullet-library steps
- `profile` → only re-run the identity + preferences step
- `evidence` → only re-run the portfolio evidence step
- `keys` → only re-run the API-key step

## Resume the interview

If any of `_profile.md` / `reference.md` / `data/resume-baseline.json` / `data/bullet-library.json` already exist (and aren't the templates), tell the user what's already populated and ask whether to:
1. **Resume** — pick up at the next unfilled section.
2. **Restart** — back up the existing files to `_archive/onboard-{date}/` and start fresh.
3. **Edit a specific section** — jump to that step.

Default to resume.

---

## Step 1: Identity (writes `_profile.md`)

Open by introducing what the interview produces and roughly how long it takes. Then collect, in this order, in plain English (do not show JSON):

1. **Name** (full)
2. **Phone** (formatted as +1 (xxx) xxx-xxxx if US)
3. **Email**
4. **City, State** (or "Remote — anywhere")
5. **LinkedIn URL** (slug only is fine)
6. **GitHub URL** (slug only is fine; can be skipped)
7. **Personal site / portfolio URL** (skip if none)
8. **Current title and employer** (e.g., "Senior ML Engineer at Acme Corp")
9. **Years of experience** (a single number)
10. **Target role titles** — list 3–5 (e.g., "Senior Machine Learning Engineer, Staff Machine Learning Engineer, AI Engineer, Senior Data Scientist")
11. **Target locations** — ask the literal question: "Are you remote-only, hybrid OK, or fully open?" + which metros if hybrid/onsite. (Jobe defaults to remote-only US; this is a hard filter, so be explicit with the user about what they're choosing.)
12. **Work authorization** — US citizen / permanent resident / requires sponsorship / EU / other
13. **Salary floor** (optional) — base or total comp; mention this is used to deprioritize, not exclude
14. **Education** — degree, school, graduation year (one entry; multiples optional)
15. **Skills bucket headings** — ask for 3–5 categories the user wants on their resume (default: Languages, ML, Infra, Data). Then ask for 4–10 entries per bucket.

Write to `.claude/skills/jobe/modes/_profile.md` using the `_profile.template.md` shape. Confirm the path and contents back to the user before moving on.

---

## Step 2: Resume baseline (writes `data/resume-baseline.json`)

Two paths. Ask the user which they prefer:

### Path A — paste an existing resume (faster)

"Paste your current resume below. Plain text, markdown, or copy-paste from a PDF — any format is fine. I will parse it into the canonical structure."

When they paste, parse it into:
- `name`, `contact` — backfill from Step 1 if not present in the paste.
- `summary` — keep the user's existing summary if present. If not, draft a 2–3 sentence version from the paste; show it; offer to edit.
- `experience[]` — for each role: `title`, `company`, `location`, `dates`, `subtitle` (optional one-line context), and `bullets[]` (the existing bullets verbatim, will be replaced by bullet-select per posting).
- `education[]`, `skills{}` — backfill from the paste; ask for missing.

Show the parsed structure to the user as a clean numbered list (no JSON), and ask: "Anything to add, remove, or correct?"

### Path B — interview without a resume

If the user has no existing resume to paste, walk through their work history one role at a time, oldest to newest. For each:
- Title, company, dates (YYYY-MM-DD format internally; "Month YYYY to Month YYYY" or "Month YYYY to Present" displayed)
- City / State or Remote
- One-line subtitle (team, products, scope) — optional
- Quick prompt: "What did you build / lead / ship in this role?" — capture verbatim, this seeds Step 4.

After both paths, write `data/resume-baseline.json` using `templates/resume-baseline.template.json` as the shape. Set `defaultBulletCounts` to a reasonable split based on the number of roles (current = 4, remaining roles divide the remaining 5–6 slots).

Confirm the file path and show the user the experience list (titles + companies + dates only) for sign-off.

---

## Step 3: Portfolio evidence (writes `reference.md`)

The portfolio file is the single source of truth for what Jobe is allowed to put on a resume. Every bullet has to trace back here.

Tell the user: "We're going to document your strongest 5–10 projects. For each one I need: what you built, the specifics (algorithms, parameters, sample sizes, latency or throughput numbers), the outcome, and one failure mode you prevented. The deeper your detail here, the stronger every cover letter Jobe writes for you."

Then for each project, ask in this order:

1. **Project name / identifier** (your own short label)
2. **Repo or artifact path** (skip if proprietary — say "internal" and Jobe will use that)
3. **Which employer / consultancy / personal-project bucket does this belong to?** (must match a `company` value from Step 2's `experience[]`, OR be tagged "personal" / "side-project")
4. **What it is in one sentence** (function-described — no internal codenames; "agent orchestration platform" not "Project Hummingbird")
5. **The technical specifics** — algorithms, parameter values, dataset shape, scale, latency, throughput, anything quantifiable
6. **The outcome** — business or research impact, ideally a number
7. **What could have gone wrong / failure mode addressed** — what was the design choice that prevented it?

After 5 projects, ask: "Any more, or should we move on?" Up to 10–12 is the useful cap.

Group the projects into archetype buckets as you go. The 6 archetypes are:
- AI Platform / LLMOps
- Agentic / Automation
- Applied ML
- Causal / Experimentation
- ML Infrastructure
- Forward Deployed / Customer-Facing

Tell the user which archetype each project lands in and let them override.

Write `reference.md` with one section per project, organized under the 6 archetype headings (skip empty ones). Use the shape from `templates/reference.template.md`.

---

## Step 4: Bullet library (writes `data/bullet-library.json`)

This is the hardest step but Jobe does most of the work.

For each `experience[]` entry from Step 2, generate 4–8 candidate bullets pulled from the project descriptions in Step 3. Each candidate must:
- Be 30–60 words.
- Lead with the verb / action ("Built", "Shipped", "Architected", "Led", "Engineered").
- Use specific algorithms / parameter values / scale numbers from the user's Step 3 inputs.
- Quantify outcome where possible.
- Avoid internal codenames.
- Be plain ASCII (no em-dashes, smart quotes, brackets `< > [ ] { } " \`).
- Be tagged with 1–3 archetypes from the 6-archetype list.
- Be tagged with 5–10 keywords (extract from the bullet text — algorithm names, framework names, scale words, domain terms).

Show each bullet to the user. Allow:
- Accept as-is.
- Edit text in place.
- Regenerate with different framing.
- Discard.

Then build the `companyKeyMap`: each `experience[].company` value gets a role-key (`current`, `prior1`, `prior2`, `prior3`, etc., in reverse-chronological order; consultancies / side-projects get descriptive keys like `consultancy` or `sideproject`). Show the mapping to the user, allow override.

Then ask about projects without an employer (personal projects, open-source, research). For each, generate 1–2 bullets and add them under `selectedProjects`.

Write `data/bullet-library.json` using `templates/bullet-library.template.json` as the shape, with the `companyKeyMap` you confirmed and one array per role-key plus the `selectedProjects` array.

After saving, run a sanity check:

```bash
node -e "
const lib = require('./data/bullet-library.json');
const baseline = require('./data/resume-baseline.json');
const map = lib.companyKeyMap || {};
const missing = [];
for (const exp of baseline.experience) {
  const key = map[exp.company];
  if (!key) missing.push(exp.company + ' (no companyKeyMap entry)');
  else if (!Array.isArray(lib[key]) || lib[key].length === 0) missing.push(exp.company + ' -> ' + key + ' (empty pool)');
}
console.log(missing.length ? 'ISSUES:\n  ' + missing.join('\n  ') : 'OK: every experience entry resolves to a non-empty bullet pool');
"
```

If any issues surface, tell the user what's missing and offer to fix.

---

## Step 5: API keys (writes `.env`)

Tell the user: "API keys are optional. Without any key, Jobe runs the public-API and HTML sources (Greenhouse, Lever, Ashby, Amazon, Apple, HN) and surfaces a few hundred postings per run. With a free Brave key, recall jumps roughly 5x and Jobe automatically grows the company index over time."

Ask one at a time:

1. **Brave Search API key (recommended)** — link them to https://api.search.brave.com. Free tier is 2,000 queries / month, no card. Wait for them to paste the key (or "skip"). Validate it looks like a Brave key (starts with `BSA` typically, but any non-empty string is acceptable).
2. **SerpAPI key (optional)** — link to https://serpapi.com. Free tier is 100 queries / month, paid starts at $50. Skip is fine.
3. **GitHub token (optional)** — only matters for `/jobe deep` company-research. Skip is fine.

Write to `.env` (copy from `.env.example` first if it doesn't exist). Confirm `.env` is in `.gitignore` (it should be by default).

---

## Step 6: Preferences (writes `data/companies/negative-list.json`)

Quick step. Ask:

1. **Companies you would never want to see in discovery results** — comma-separated slugs or names. (Examples the user might give: ex-employer, competitor, blacklisted vendor.) Default to empty.
2. **Industries to deprioritize** — e.g., "no defense", "no gambling", "no crypto". Capture as a note in `_profile.md` for now; future work can wire them as filter rules.
3. **Salary floor for filtering** — confirm or update from Step 1.

Write `data/companies/negative-list.json` with the `companySlugs[]` array.

---

## Step 7: Smoke test

Run a small discovery + evaluate cycle so the user sees something real:

```bash
node collectors/pipeline.js --no-harvest --max-enrich 20 2>&1 | tail -10
```

Show the result. Then offer: "Want me to evaluate the top match end-to-end so you see a tailored resume + cover letter come out?" If yes, run `/jobe <top-url>` against the highest-scoring posting and show the resulting `reports/{slug}/` files.

---

## Step 8: Wrap-up

Print a summary:

```
Onboarding complete.

Files written:
  .claude/skills/jobe/modes/_profile.md         ({Step 1})
  reference.md                                   ({Step 3 — N projects across M archetypes})
  data/resume-baseline.json                      ({Step 2 — K roles})
  data/bullet-library.json                       ({Step 4 — total B bullets across K role-keys})
  .env                                           ({Step 5 — keys: brave/serpapi/github})
  data/companies/negative-list.json              ({Step 6})

Next steps:
  /jobe find                # full discovery + auto-evaluate top matches
  /jobe <posting-url>       # evaluate a specific posting
  /jobe tracker             # see the funnel after a few applications

To re-run any step:
  /jobe onboard profile     # identity only
  /jobe onboard resume      # resume + bullet-library
  /jobe onboard evidence    # portfolio reference
  /jobe onboard keys        # API keys
```

---

## Behaviors throughout the interview

- **One question at a time.** Don't list 5 questions in one prompt; the user fatigues.
- **Show your work.** After every step, summarize what you wrote and where, in plain language.
- **Allow back-tracking.** If the user says "wait, the previous answer was wrong" — undo, redo.
- **Be patient with copy-paste.** Long pastes from existing resumes / LinkedIn / project READMEs are the ideal input; do not require the user to retype.
- **Never invent specifics.** If the user gives a vague answer ("we built a recommendation system"), ask for one concrete detail (algorithm? scale? outcome metric?). If they can't answer, mark the bullet weak and move on — do NOT hallucinate.
- **Plain ASCII enforcement.** Strip em-dashes, smart quotes, and the bracket characters `< > [ ] { } " \` from any text the user pastes before writing it to a file. `lib/normalize.js` will catch what slips through, but be defensive at write time.

## What NOT to do

- Don't ask the user to look at JSON or write JSON.
- Don't ask the user to memorize the 6 archetypes — present them as multiple choice when needed.
- Don't ask for portfolio evidence the user clearly doesn't have. Skip the section if they're early-career.
- Don't push for API keys. They're optional. Make the no-key path obviously workable.
