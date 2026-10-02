# Onboard Mode

A guided interview that produces every personal file Jobe needs to run, for any profession. The user does not have to know the schema. You ask questions, collect answers, and write the files for them.

Files it writes (all under the active workspace `${WORKSPACE}`):

| File | Step | Required |
|---|---|---|
| `_profile.md` (prose for the assistant) | 1, 6.9 | yes |
| `data/resume-baseline.json` | 2 | yes |
| `reference.md` (the evidence file) | 3 | yes |
| `data/archetypes.json` (your own emphasis buckets) | 3.5 | optional |
| `data/bullet-library.json` | 4 | yes |
| `data/evidence-anchors.json`, `data/evidence-depth.json` (evidence gates) | 4.5 | optional |
| `.env` (API keys) | 5 | optional |
| `data/profile.json` (the structured policy code reads) | 6 | yes |
| `data/companies/negative-list.json` | 6 | yes (may stay empty) |
| `data/queries/seeds.json` | 6.5 | yes |
| `data/companies/portals.json`, `data/companies/non-tech-seed.json` (your target employers) | 6.5 | optional |
| `data/apply-profile.json` | 6.7 | yes (every answer may stay blank) |
| `data/career-narrative.md` | 6.8 | optional |
| `data/evidence-index.json` (generated) | 3 | optional |

Total time target: 15 to 30 minutes for a thorough setup. Less if the user pastes an existing resume up front.

**Assume nothing about the user's field.** Every example below is a shape drawn from two unrelated professions. Never offer a default role, skill, work mode, country, or title level; ask, and write what the user said. A question the user skips leaves the matching key at its permissive default (no filter, no check).

## Workspace

Write every file into the ACTIVE user's workspace `${WORKSPACE}` (resolved by SKILL Step 0), not the install root, so multiple people on one machine stay isolated. If `$ARGUMENTS` included a name (`/jobe onboard <name>`), SKILL Step 0 has already created and activated that workspace via `node "${JOBE_HOME}/scripts/user.js" new <name>`; confirm `node "${JOBE_HOME}/scripts/user.js" current` shows it before writing. If no workspace exists yet and this is a shared machine, ask the user for a short workspace name (their first name, or their focus) and create it the same way first. All paths below (`_profile.md`, `reference.md`, `data/...`) are relative to `${WORKSPACE}`.

A workspace created by `user.js new` already holds a scaffold copy of every template and all the report stage folders. Each scaffold is inert (empty lists, blank answers, examples under note keys). In single user mode (no name given, so no scaffold ran) create the same layout first. This never overwrites a file that already exists:

```bash
node -e "require(process.argv[1] + '/scripts/user.js').scaffold(process.argv[2])" "${JOBE_HOME}" "${WORKSPACE}"
```

Never write a person's file into the shared modes dir or into `${JOBE_HOME}/configs/`. For anyone who develops inside a clone of the repository, suggest a named workspace (`/jobe onboard <name>`): in single user mode the workspace IS the clone, so personal files sit beside tracked ones.

## Input

`$ARGUMENTS` after `onboard`:
- empty: run the full interview
- `profile`: only the identity and preferences steps (1 and 6)
- `resume`: only the resume baseline + bullet library steps (2 and 4)
- `evidence`: only the evidence step (3, 3.5, 4.5)
- `keys`: only the API key step (5)
- `seeds`: only the discovery seeds step (6.5)
- `apply`: only the apply profile step (6.7)
- `narrative`: only the career narrative step (6.8)

## Resume the interview

Check which files are already populated. A file counts as NOT populated when it is missing, when it is byte equal to its template, when `data/resume-baseline.json` has an empty `name`, or when `data/bullet-library.json` has an empty `companyKeyMap`. If anything is populated, tell the user what is and ask whether to:
1. **Resume**: pick up at the next unfilled section.
2. **Restart**: back up the existing files to `_archive/onboard-{date}/` and start fresh.
3. **Edit a specific section**: jump to that step.

Default to resume.

---

## Step 1: Identity and preferences (writes `_profile.md`)

Open by introducing what the interview produces and roughly how long it takes. Then collect, in this order, in plain English (do not show JSON):

1. **Name** (full)
2. **Phone** (as the user writes it for their country)
3. **Email**
4. **City and region** (or "Remote")
5. **LinkedIn URL** (can be skipped)
6. **Website, portfolio, or code host URL** (skip if none). A portfolio or personal site is stored as `contact.website` and a code host profile as `contact.github`; both print in the contact line of the resume and cover letter.
7. **Current title and employer** (two unrelated examples of the shape: "Registered Nurse at Example Hospital", "Senior Tax Accountant at Example Tax Group")
8. **Years of experience** (a single number; "skip" leaves the years check off)
9. **Degrees, licenses, and certifications**, as written on the resume. Only if the user targets roles that ask for one: any security clearance held (a name), none held, or skip.
10. **Target role titles**: 3 to 5, in the words postings use. Tell the user: "If you include a level word such as senior, lead, junior, or entry in a title, postings at that level rank first. Otherwise no level is preferred." Also ask which abbreviations postings use for these titles (two unrelated examples: RN for Registered Nurse, CPA for Certified Public Accountant). A title that shows only the abbreviation is matched only when that abbreviation is a seed of its own.
11. **Where you can work.** Ask each part plainly and do not suggest an answer:
    a. "Which of these do you accept: remote, hybrid, onsite? Any combination is fine, and so is all three."
    b. Only if hybrid is accepted, or the user says something like "remote, but a few office days are fine": "What is the largest share of the week in an office you would accept?" Record it as a fraction (one day in five is 0.2).
    c. "Which country or countries can you work in? Skip for no country filter."
    d. Only if hybrid or onsite is accepted: "Which metros or regions can you work in on site?" Record the distinctive place names (a city, a state, a province, a county). A US state, a Canadian province or territory, an Australian state, or a UK nation may be given by name or by code, whichever the user says: both forms are matched. For a region in any other country, also ask for the code postings write after the city, and record both. Skip means every place is kept.
12. **Work eligibility** (each answer is Yes, No, or "ask me each time"; never assume one):
    a. May you legally work in the country or countries you are targeting?
    b. Will you need visa or work permit sponsorship, now or later?
    c. Are you a citizen of that country? Are you a citizen OR a permanent resident? (A permanent resident answers No to the first and Yes to the second.)
    d. Do you live in that country (forms say "domiciled")?
    e. Only if you target government roles: are you eligible for federal or government employment, and do you hold an active security clearance?
    f. Are you willing to relocate?
    g. Are you bound by a noncompetition agreement or a similar restrictive covenant?
13. **How recent.** "How old can a posting be before it is not worth showing? The default is 30 days." Optionally: extra days for senior titles (default 0).
14. **Titles to leave out.** "Are there title words or levels you never want to see (for example intern, director, travel, per diem)? Is there a longer phrase containing one of those words that you DO want (for example "travel coordinator" when "travel" is excluded)?" A keep phrase shields only its own words: a title is still dropped when an excluded word also appears outside the phrase. No exclusion is applied unless the user names one.
15. **Compensation.** The range the user is aiming for (a talking point), the currency, and then, separately: "Do you want a hard floor? If yes, a posting is hidden only when its PUBLISHED range tops out below it; a posting with no published pay is always kept and labeled." Ask which currency the floor is in (a three letter code such as USD, GBP, EUR, CAD). Say which bands can be compared: only a published YEARLY range whose stated currency is that same currency. Pay in another currency, pay with no stated currency (a bare dollar sign counts as US dollars only on a posting placed in the United States), and pay per hour, month, or pay period are treated as unknown, kept, and labeled, so the assistant checks those rows against the live listing when it presents them. State that a floor is a discovery filter only and never changes a score.
16. **Skills section headings.** Ask which 3 to 5 groupings the user wants on the resume, in their own words (two unrelated examples: "Clinical, Licenses and certifications, Systems" or "Tax, Credentials, Software"), then 4 to 10 entries per grouping. There is no default set.

Write to `${WORKSPACE}/_profile.md` using the `_profile.template.md` shape: replace every placeholder with the user's answer or delete the line. Leave the sections "Rare combinations", "Attribution rules", "Role posture leads", "Verified figures", "Known corrections", and "Standing rules" in place; Steps 3 and 6.9 fill them. Confirm the path and contents back to the user before moving on.

---

## Step 2: Resume baseline (writes `data/resume-baseline.json`)

Two paths. Ask the user which they prefer:

### Path A: paste an existing resume (faster)

"Paste your current resume below. Plain text, markdown, or copied from a PDF: any format is fine. I will parse it into the canonical structure."

When they paste, parse it into:
- `name`, `contact`: backfill from Step 1 if not present in the paste.
- `summary`: keep the user's existing summary if present. If not, draft a 2 or 3 sentence version from the paste; show it; offer to edit.
- `experience[]`, reverse chronological, current role first. For each role: `title`, `company`, `location`, `dates`, `subtitle` (optional one line of context), and `bullets[]` (the existing bullets verbatim; they are the fallback, per posting bullets come from the library).
- `education[]` (write each `degree` as it appears on the resume, because it is compared with degree requirements in postings), `skills{}` (the user's own groupings from Step 1.16): backfill from the paste; ask for what is missing.

Show the parsed structure to the user as a clean numbered list (no JSON), and ask: "Anything to add, remove, or correct?"

### Path B: interview without a resume

If the user has no existing resume to paste, walk through their work history one role at a time, oldest to newest. For each:
- Title, employer, dates ("Month YYYY to Month YYYY" or "Month YYYY to Present")
- City and region, or Remote
- One line subtitle (team, setting, scope), optional
- Quick prompt: "What did you do, run, or deliver in this role?" Capture verbatim; this seeds Step 4.

After both paths, write `data/resume-baseline.json` in the shape of `templates/resume-baseline.template.json`: the real values go at the TOP level. The template's `$examples` block shows two professions for shape only; never copy a value from it, and leave the `$examples` and `$comment` keys out of the written file. Set `defaultBulletCounts` (a map from library role key to bullet count) to a reasonable split for the number of roles (the current role gets about 4, the remaining roles share the remaining 5 or 6 slots). Optional keys the renderer understands: `contact.github`, `contact.website`, `awards` (a list of strings), `projectsHeading`, `layout` (`"standard"` or `"compact"`). A per posting resume JSON adds `coverLetter`, `whyCompany`, `postingUrl`, `company`, `role`, `location` (the posting's), `archetype`, `matchScore`, `compensation`.

Confirm the file path and show the user the experience list (titles + employers + dates only) for sign off.

---

## Step 3: Evidence (writes `reference.md`)

The evidence file is the single source of truth for what Jobe is allowed to put on a resume. Every bullet has to trace back here.

Tell the user: "We're going to document your strongest 5 to 10 pieces of work. For each one I need: what you did, the specifics (methods, tools, volumes, timelines, the numbers that make it concrete), the outcome, and one thing that could have gone wrong and how you prevented it. The more precise you are here, the stronger every resume and cover letter Jobe writes for you."

Then for each piece of work, ask in this order (the eight field block of `templates/reference.template.md`):

1. **Project**: a short label you will recognize
2. **Where the proof lives**: a document, a system, a repository, a published result, a review, or a person who can confirm it. "Internal" is a fine answer.
3. **Role held**: which employer and role this belongs to (it must match a `company` value from Step 2's `experience[]`), or "outside a job"
4. **What you did**, in one or two sentences, described by function with no internal names ("discharge teaching program for cardiac patients", not the nickname the team used)
5. **Specifics**: methods, tools, scale, volumes, timelines, anything quantifiable
6. **Outcome**: the result for the organization, the client, or the people served, ideally a number
7. **What could have gone wrong**: the risk, and the choice that prevented it
8. **Limits**: anything you did not do or cannot claim (shared credit, estimates, figures you may not disclose)

After 5, ask: "Any more, or should we move on?" Up to 10 or 12 is the useful cap.

Write `reference.md` with one block per piece of work, grouped by employer or by the user's own buckets. DELETE the "Example entries" section of the template from the written file.

While you are here, collect three things the evidence makes obvious:

- **Attribution.** For each piece of work, which role it belongs to, and anything that must never be listed under another role (a side business versus the main job is the common case). Write one line each under "Attribution rules" in `_profile.md`.
- **Verified figures.** Each money or scale figure the user gave, with its exact scope (what it measures, over what period, at whose level). Write them under "Verified figures" in `_profile.md`.
- **Names that must never appear.** "Are there names that must never appear in a resume or cover letter: internal project names, client names, product code names?" Write the list to "What not to use in output" in `_profile.md` and keep it for `output.forbiddenTerms` in Step 6. Say that a rendered document containing one is refused, and that the work is described by function instead.

### Step 3b: Evidence roots (optional; most professions skip this)

Ask: "Do you keep your own work product as plain text files on this machine: notes, plans, write ups, analyses, source code?" If no, skip; nothing else changes and the evidence file plus the bullet library are the evidence.

If yes:
- Record the absolute folder paths for `evidence.roots` (Step 6), and for each folder which role or project it belongs to for `evidence.attribution` (rows `{ "source": "<folder or project label>", "belongsTo": "<role key or selectedProjects>" }`).
- Optional extra tool or method names to look for, for `evidence.tools`: a plain name, or `{ "name": "...", "match": ["<regex source>"], "aliases": ["<another spelling>"] }` when presence is proven by something other than the name.
- If some of that work lives only on a code or document host, record the account names (never tokens) for `evidence.githubAccounts`.
- After Step 6 writes the profile, build the index: `node scripts/evidence-index.js build`. It writes `data/evidence-index.json`; a tool found there is treated as held and is never reported as a gap. Say the ceiling plainly: office documents, PDFs, and spreadsheets are not read, and loose files directly under a root that also has subfolders are not read (put them in a subfolder).

**Deep evidence extraction (optional, needs the Workflow tool).** When the user has project folders and wants a thorough evidence file, offer `scripts/wf-evidence-extract.js` with args `{ workspace: "${WORKSPACE}", items: [{ name, path, hint, outFile }] }` (absolute paths; `outFile` under `${WORKSPACE}/data/evidence/`). Merge the outputs into `reference.md`, then offer `scripts/wf-bullets-from-evidence.js` with args `{ root: "${JOBE_HOME}", workspace: "${WORKSPACE}", user, archetypes, items: [{ name, role, evidenceFile, fragmentFile }] }`. Merge rule for the fragments: append each bullet under its role key in `data/bullet-library.json`, dedup by `id`, then run the two evidence gates (Step 4.5). Without the Workflow tool, read each folder yourself and write the same eight field blocks.

---

## Step 3.5: Emphasis buckets (optional; writes `data/archetypes.json`)

Ask: "Do the roles you are targeting fall into clearly different kinds, where you would lead with different parts of your experience?" Give two unrelated illustrations of what "kinds" means, never as a menu: a nurse might separate acute care roles from care coordination roles; a tax accountant might separate compliance roles from advisory roles.

- If no (the common answer): leave the scaffolded file as is. It defines no bucket, every posting is labeled `General`, and evidence is ranked by overlap with the job description alone.
- If yes: derive the bucket NAMES and their KEYWORDS from the user's own field and their own target postings, in their words. Write `${WORKSPACE}/data/archetypes.json` in the shape shown in `templates/archetypes.template.json` (`{ "<Bucket name>": { "keywords": [...], "portfolioDomains": [...] } }`). Show the buckets back and let the user rename or drop any.

A bucket is only ever a small ranking bonus, never a filter. Jobe ships no buckets and no fixed list.

---

## Step 4: Bullet library (writes `data/bullet-library.json`)

This is the hardest step but Jobe does most of the work.

For each `experience[]` entry from Step 2, generate 4 to 8 candidate bullets from the evidence in Step 3. Each candidate must:
- Be 30 to 60 words, result first: lead with the outcome, then how it was done.
- State the METHOD (how the work was done), not only its size or its result.
- Use the specific methods, tools, volumes, and outcomes from the user's Step 3 inputs. Never a figure the user did not give.
- Vary the opening word across the set.
- Avoid every name from "What not to use in output".
- Carry no typographic punctuation (no em dashes, en dashes, or smart quotes) and none of the characters `< > [ ] { } " \`. Letters of the language the user writes in, accents included, are kept.
- Carry 5 to 10 `keywords`, in the words a job description would use (methods, tools, settings, credentials, domain terms). Keywords are how Jobe learns which skills the user can prove.
- Carry `archetypes` ONLY when the user defined buckets in Step 3.5, using those exact names. Otherwise `[]`.
- Carry the same `studyGroup` label as any other bullet describing the same piece of work, so only one of them lands on a resume.

Show each bullet to the user. Allow:
- Accept as is.
- Edit text in place.
- Regenerate with different framing.
- Discard.

Then build the `companyKeyMap`: each `experience[].company` value gets a role key (`current`, `prior1`, `prior2`, and so on in reverse chronological order are only a convention; a consultancy or side business gets its own descriptive key). Show the mapping to the user, allow override.

Then ask about work outside a job (personal projects, volunteer work, publications, research). For each, generate 1 or 2 bullets and add them under `selectedProjects`, each with a `name` (the display name). Project shaped work goes here, never into `experience[]`.

Write `data/bullet-library.json` in the shape of `templates/bullet-library.template.json`: the real role arrays and `companyKeyMap` at the top level, the template's `$examples` and `$comment` keys left out.

After saving, run a sanity check:

```bash
cd "${JOBE_HOME}"
node -e "
const fs = require('fs'), path = require('path');
const ws = process.argv[1];
const read = (f) => JSON.parse(fs.readFileSync(path.join(ws, 'data', f), 'utf8'));
const lib = read('bullet-library.json'), baseline = read('resume-baseline.json');
const map = lib.companyKeyMap || {};
const missing = [];
for (const exp of baseline.experience || []) {
  const key = map[exp.company];
  if (!key) missing.push(exp.company + ' (no companyKeyMap entry)');
  else if (!Array.isArray(lib[key]) || lib[key].length === 0) missing.push(exp.company + ' -> ' + key + ' (empty pool)');
}
console.log(missing.length ? 'ISSUES:\n  ' + missing.join('\n  ') : 'OK: every experience entry resolves to a bullet pool with entries');
" "${WORKSPACE}"
```

If any issues surface, tell the user what's missing and offer to fix.

---

## Step 4.5: Evidence gates (optional)

Offer once the bullet library exists. Both files are scaffolded empty, and both gates pass while they stay empty.

- `data/evidence-anchors.json`: one anchor per distinct capability written up in `reference.md` (`{ "id", "section", "terms": [...] }`). `node scripts/check-evidence-coverage.js` fails when a capability has no library bullet, which is how evidence gets "trapped" in the evidence file where the selector can never surface it. Rule to state: whenever a capability is added to the evidence file, add a bullet AND an anchor.
- `data/evidence-depth.json`: one entry per major body of work, with `match` terms that find its bullets and `mechanisms` terms that name its method. `node scripts/check-evidence-depth.js` fails when the bullets about a body of work state only its scale or outcome, never how it was done.

Run both after filling them and fix what they flag.

---

## Step 5: API keys (writes `.env`)

Tell the user: "API keys are optional. Without any key, Jobe runs the key free sources (job board feeds, the LinkedIn guest search, and the per company crawlers for employers already in your index). With a free Brave key, discovery searches every applicant tracking system for your role titles and grows your company index over time."

Ask one at a time:

1. **Brave Search API key (recommended)**: link them to https://api.search.brave.com. Free tier is 2,000 queries a month, no card. Wait for them to paste the key (or "skip"). Any non empty string is acceptable.
2. **SerpAPI key (optional)**: link to https://serpapi.com. The free tier is small. Skip is fine.
3. Mention that `.env.example` lists the other optional keys and the two opt in sources (off unless turned on), and move on unless the user asks.

Write to `${WORKSPACE}/.env` (start from `${JOBE_HOME}/.env.example` if it doesn't exist). Keys shared by everyone on this machine can live in `${JOBE_HOME}/.env` instead. Confirm `.env` is in `.gitignore` (it is by default). Never echo a key back.

---

## Step 6: Policy (writes `data/profile.json` and `data/companies/negative-list.json`)

`data/profile.json` is the ONE machine readable policy file. Code reads it through `lib/profile.js` and never reads `_profile.md`, so an answer from Step 1 filters nothing until it is written here. Start from `templates/profile.template.json` (already scaffolded in a named workspace), keep `"version": 1`, and write EVERY block from what the user actually said. A question the user skipped keeps the template's permissive value.

**`candidate`**
- `yearsExperience`: the number from Step 1.8, or `null` (no years check).
- `degrees`: the list from Step 1.9, written as on the resume. The level (associate, bachelor, master, doctorate) is read from common words and abbreviations; an unrecognized credential simply skips the degree checks.
- `clearance`: the name of a clearance the user holds; `false` (or `"none"`) when the user said they hold none, and only then does a posting that requires a clearance lose points; `null` when unknown or not relevant, so no check runs.

**`discovery`**
- `workModes`: the accepted modes from Step 1.11a, any of `"remote"`, `"hybrid"`, `"onsite"`. All three, or no stated preference: `[]` (keeps everything). Remote plus a low touch hybrid allowance: `["remote", "hybrid"]` together with the share below. Write exactly `["remote"]` only when the user accepts no office time at all; the code then drops every hybrid posting before anyone reads it.
- `hybridMaxOfficeShare`: the fraction from Step 1.11b, or `null`. The assistant applies it when it reads each hybrid posting (see `find.md`); the code has no office share extractor yet.
- `countries`: from Step 1.11c. The United States is written `"US"`. Any other country may be written as its two letter code, its name, or a common alias (`"UK"` is read as GB); code plus name, for example `["CA", "Canada"]`, works too and counts as one country. The search APIs that take a market get one only when the list resolves to exactly one country (`adzuna` takes the first country listed), and the LinkedIn guest search sends a name of more than two letters when the list holds one, else the name of the code when the list resolves to one country. A posting is dropped only when its location names a country outside the list (a three letter code after a comma, as in "Toronto, CAN", is read from its letters); a bare city in another country is unknown and kept, apart from the few dozen large cities the classifier knows by name. No answer: `[]`.
- `regions`: the place names from Step 1.11d, for example `["Denver", "Colorado"]` or `["Leeds", "Yorkshire"]`. The match is a whole phrase inside the posting location, with no distance model. A US state, a Canadian province or territory, an Australian state, or a UK nation matches by its name and by its code, whichever the user wrote (`["Denver", "Colorado"]` keeps "Aurora, CO", `["Toronto", "ON"]` keeps "Ottawa, Ontario"). A region in any other country matches only in the forms listed, so write both the name and the code postings use, the code in capitals (for example `["Munich", "Bavaria", "BY"]`). It applies only to hybrid and onsite postings; remote postings are never touched. The user named none, or accepts remote only: `[]` (keeps every place).
- `maxAgeDays`: from Step 1.13 (default 30; 0 turns the recency cut off, in the pipeline and in every source). `seniorityExtensionDays`: default 0; extra days for titles that carry senior, sr, principal, or lead.
- `titleExclude`, `titleKeep`: the words and phrases from Step 1.14. Empty unless the user named some. A title is dropped when an exclude phrase matches outside every keep phrase. Matching ignores case and accents, and a hyphen in a phrase also matches a space (`part-time` drops "Part Time"), so write each phrase the way postings do.
- `salaryFloor`: the hard floor from Step 1.15 as a yearly number, or `null`. `salaryCurrency`: the three letter currency code of the floor from Step 1.15 (the template default is `"USD"`; write the user's own). Only a published yearly band in this same currency is compared with the floor; every other band is unknown and kept.
- `excludeStaffing`: ask "Should staffing agencies and brokers be hidden? In some fields they are a normal way to get hired." Default `true`.
- `companySites`: ask "Are there specific employers whose own careers site you want searched directly?" An entry is a careers site domain, optionally with a path (`careers.example.org`, `example.org/jobs`), or `{ "site": "...", "company": "..." }` when the employer name cannot be read from the domain. Empty means no company site queries (none ship).
- `minScore`: ask whether results below a score should be hidden; `null` means no floor.
- `referralFirst`: ask "Before a cold application, should I check your contacts for someone at the company?" Default `false`.

**`skills`**
- `gaps`: ask "Are there skills, tools, or credentials that postings in your field often ask for and that you want treated as honest gaps?" Each entry is a plain string, or `{ "label": "...", "terms": ["...", "..."], "unlessAlso": ["..."] }` when one gap has several names or should not count when the posting offers an alternative the user holds. Two unrelated examples of the shape: `"dialysis"`, and `{ "label": "payroll tax", "terms": ["payroll tax", "form 941"], "unlessAlso": ["sales tax"] }`.
- `levels`: a number from 0 to 1 per skill. **Rate your skills, the weak ones too.** Build the list from what postings for the target roles ask for (the seed titles from Step 1.10 and two or three sample postings), not only from the keywords the bullet library from Step 4 uses most; aim for 20 to 40 terms. Rate only skills specific to the user's field and leave out words that postings in every field use (leadership, communication, training, mentoring, hiring, budget, compliance, coaching and the like), and leave out general tools and methods that other fields share (spreadsheets, SQL, reporting, data analysis, forecasting, process improvement, project management, automation) even when the sample postings ask for them: a rated term is also evidence that the user holds the skill, so a table that keeps such terms lifts a posting from another field that is built around them (six or more named in a short description) to 65 and above wherever no title gate runs, as in `/jobe [URL]`. The test for a term: would a posting in an unrelated field ask for it in the same words? Such a skill still counts through the bullets and the resume skills block. If the user wants one rated anyway, rate it at its honest level and tell them postings from neighbouring fields will score by it. Propose a level for each: up to `1.0` when at least one bullet proves it, `0.6` when the user holds it but it is only in the resume skills block or cannot be proven, `0.3` to `0.5` when it is held partly, `0` to `0.3` when postings commonly ask for it and the user does not hold it. Include every `gaps` entry at its honest low value: an entry in `gaps` is not a rated term, so a weakness must be in `levels` to count. Show the list and let the user raise or lower any value; one spelling per skill is enough. Ask: "Which skills do your target postings ask for that you hold weakly or not at all?" and write those in below 0.6. Also ask: "Which three to six skills set you apart from other applicants to these roles?" and keep only those at `0.9` or above (two unrelated examples of the shape: `{ "wound care": 1, "discharge planning": 0.6, "dialysis": 0.2 }`, `{ "multistate returns": 0.95, "sales tax": 0.6, "payroll tax": 0.3 }`); only skills rated 0.9 or above earn the small differentiator bonus. Why the low marks matter: a table of only top marks carries no information, and `lib/rank.js` treats it that way. A rated skill a posting names counts as rated, and differentiator points add to the title points, only as far as the table is trusted: trust is the mean distance of the levels below 0.9, in full at 0.12, so a table in which every level is 0.9 or above is not counted as a rating (its terms still count as evidence that the user holds the skill, at the level given, so a posting that names rated skills the bullets do not carry scores a point or two higher for each one, about twelve for a table of ten, and can cross the 55 floor) and any level of 0.6 or lower counts. How far the table replaces the vocabulary estimate (ratedness) is rated terms / 40, capped at 1, times the share of rated weaknesses / 0.2, capped at 1, where a term is a weakness in full at 0.5 or below and in proportion between 0.5 and 0.6: 40 terms with about one in five at 0.5 or below make the table stand alone, and postings are then scored by the rated skills they name, not by the vocabulary estimate. Limits of a table that stands alone: a role next to the user's field that names their strengths scores in the 65 to 79 band, and a posting from another field whose title shares a word with a target role is scored by the rated keywords it names; under any other title a posting from another field is scored by the table only as far as the user's material covers it (three rated skills named halve the coverage needed), which is why words every field uses stay out of the table; read the description before acting on such a row. With nothing rated the score only knows whether a posting is in the user's field and how much of it their material covers, not which skills are their strongest, and `find` then asks before generating any resume instead of doing it automatically for the top band. A user with a very large bullet library and no levels scores high across their whole field; rating skills, weak ones included, is the remedy. Skipped: `{}`.

**`evidence`**
- `ledger`: `"reference.md"`. `narrative`: `"data/career-narrative.md"`.
- `roots`, `githubAccounts`, `tools`, `attribution`: from Step 3b, or empty.

**`output`**
- `forbiddenTerms`: the names from Step 3 that must never render. A rendered document that contains one is refused.
- `targetPages`: ask "What resume length are you aiming for: one page, two pages, or no target?" Write `1`, `2`, or `null`. The page check, the resume audit, and the fill workflow all read it.
- `stripHyphens`: `false` unless the user asks for rendered documents with no hyphens.
- `asciiOnly`: ask only when the user's name, employers, or schools carry accents or a non Latin script. Default `false`: the letters of every script and their accents are kept in rendered documents and form answers. Set `true` only when a target ATS is known to reject non ASCII text; accented Latin letters then fold to their base letter, symbols that carry meaning are written out, and every other script is removed. It applies to every rendered field (name, contact line, employer, place, dates, school, skill labels, headings), with one exception: a name written wholly in a non Latin script has no ASCII form and is kept as written. Hyphens in names, phone numbers and date ranges are kept even when `stripHyphens` is true.
- `pageSize`: ask "Which paper size should your resume and cover letter use: Letter or A4?" Write `"letter"` or `"a4"`. Skipped: `null`, which picks Letter when the country list is empty or names a country that uses Letter paper (the US, Canada, Mexico, the Philippines and several countries in Latin America), and A4 otherwise.
- `dateLocale`: ask how dates should be written on a cover letter and write the matching locale tag, for example `"en-GB"` (12 March 2026) or `"en-US"` (March 12, 2026). Skipped: `null`, which means en-US.
- `sectionHeadings`: ask only when the user writes resumes in a language other than English. An object with the user's own words for the resume section headings, keys `summary`, `projects`, `experience`, `skills`, `education`, `awards`; an unset key keeps the English heading. The template names the key in its comment only: add it to the `output` block. Not asked: leave it out.

Then the negative list. Ask:

1. **Companies you would never want to see in discovery results** (a former employer, a place you would not work). Default to empty. Write `${WORKSPACE}/data/companies/negative-list.json` in the shape of `templates/negative-list.template.json` (`companySlugs` are lowercase and hyphenated). Do not put staffing agencies there; they are covered by the shared list and the `excludeStaffing` answer.
2. **Industries or kinds of employer to avoid**: capture as a line under "Targeting rules" in `_profile.md` (the assistant applies it when presenting; no code filter exists for it).

Read the result back in plain language, from what the code actually resolved:

```bash
cd "${JOBE_HOME}"
node -e "const {loadProfile,discoveryFilters}=require('./lib/profile');const p=loadProfile();console.log(JSON.stringify({filters:discoveryFilters(p),titleExclude:p.discovery.titleExclude,titleKeep:p.discovery.titleKeep,hybridMaxOfficeShare:p.discovery.hybridMaxOfficeShare,companySites:p.discovery.companySites,referralFirst:p.discovery.referralFirst,candidate:p.candidate,skillLevels:p.skills.levels,output:p.output,page:require('./lib/profile').pageSetup(p)},null,2))"
```

Tell the user, in one short paragraph, what discovery will keep and what it will drop (work modes, countries, `regions`, recency, title rules, the pay floor and its currency), and which page size and date format rendered documents will use. If a value printed there differs from what the user said, the file is malformed: fix it before moving on. Then make `_profile.md` say the same thing.

---

## Step 6.5: Discovery seeds (writes `data/queries/seeds.json`)

This is the step that makes discovery search for the user's OWN roles. Nothing ships in this file: with no rows, discovery keeps every title and the search driven sources are skipped. Take the **target role titles** (Step 1.10) and the **locations** (Step 1.11) and write one seed per (role x location) pair.

- For each target role title, emit one entry per location. A user who accepts remote work gets a `"location": "Remote"` entry; a user who accepts hybrid or onsite gets one entry per named metro or region. A user with no location preference gets one entry per role with `"location": ""`.
- Add each abbreviation from Step 1.10 as its own seed row per location, placed AFTER the spelled out titles. The title gate matches on the words of the seed titles, so with only "Registered Nurse" on file a posting titled "RN - Medical Surgical" is dropped. The order matters because several sources search only the first few distinct titles.
- Write each title the way postings write it, accents included: the title gate ignores case and accents, so a seed written with an accented letter matches the same title stored without it.
- Keep it to roughly 8 to 20 pairs. More roles widen recall but dilute relevance.

Write `${WORKSPACE}/data/queries/seeds.json` in the shape of `templates/seeds.template.json`: `{ "queries": [ { "query", "location" }, ... ] }`. Show the user the generated list and let them add or remove rows.

**Target employers (optional).** Several source types crawl one board per employer and need to be told which employers. Write these ONLY into the workspace files, never into the shared `${JOBE_HOME}/configs/portals.json`:

- Employers on Workday, SmartRecruiters, or iCIMS go in `${WORKSPACE}/data/companies/non-tech-seed.json` (shape and lookup instructions in `templates/non-tech-seed.template.json`, key `$howToFind`): a Workday entry needs `host` + `tenant` + `site`, SmartRecruiters needs `companyId`, iCIMS needs `host`. These systems have no search across companies, so this is how Jobe reaches large employers in fields such as healthcare, finance, education, retail, and government contracting.
- Employers on Greenhouse, Lever, Ashby, Workable, Recruitee, Breezy, BambooHR, or Personio go in `${WORKSPACE}/data/companies/portals.json`, under the key named after the system (the same keys as `configs/portals.json`). An entry is a slug string or `{ "slug": "<subdomain or account slug>", "name": "<company>" }`; pin the name for BambooHR and Personio, whose feeds carry no company name.

Both files start empty and both are optional. With a Brave key, the slug harvest and every run also grow `data/companies/index.json` on their own.

---

## Step 6.7: Apply profile (writes `data/apply-profile.json`)

The apply harness (`/jobe apply`) reads answers a resume does not carry from `data/apply-profile.json`. Build it from what you already collected, in the shape of `templates/apply-profile.template.json`:

- Eligibility gates, from Step 1.12, each written as `"Yes"`, `"No"`, or `""` (blank means the harness leaves that question unanswered and shows it at the glance; it never guesses): `workAuthorized`, `requireSponsorship`, `citizen`, `citizenOrPermanentResident`, `domiciled`, `federalEligible`, `clearance`, `relocation`, `nonCompete`. Write only what the user said. An answer the user did not give stays `""`.
- `nonCompete: "Yes"` only answers that question on a form. Tell the user that `/jobe apply` will warn before every submit and that deciding whether an employer is a restricted competitor stays with them.
- `salaryStrategy`: ask "When a posting publishes a pay range, which figure should go in a salary field: the midpoint, the top, or the bottom?" Write `midpoint` (default), `top`, or `bottom`.
- `salaryExpectation`: the yearly figure used when a posting publishes no range (optional; blank lets the assistant confirm per application).
- `country`: the country name as forms list it. Always ask for it and write it. `state` and `stateName`: the region code and its full name. A blank `state` is read off a location written as "City, ST" only when `country` is the United States (or the location ends with it); for a user anywhere else, and for a US user whose `country` is blank, write `state` (and `stateName`) or the field is left for the glance. `postalCode`.
- `linkedin`, `github`, `website`: fallbacks used only when the resume JSON lacks them.
- `howHeard`: optional; blank means "Company careers page".
- Optional: `degreeLevel` (the level a degree dropdown should pick, for example "Associate", "Bachelor", "Master", "Doctorate"; blank derives it from the degree), `locale` (the browser locale tag the harness presents, such as "en-GB"; blank means en-US).

**EEO / demographic self identification is OPT IN and entirely the user's own choice.** Ask once, plainly: "Applications often include optional questions about gender, race, veteran status, disability and similar. Want the harness to fill in your own answers to those, or decline them all?"
- If they decline (the default): leave `eeoSelfIdentify: false` and `eeoValues: {}`. The harness then declines every demographic question and transmits nothing.
- If they want to self identify: set `eeoSelfIdentify: true` and fill `eeoValues` with THEIR stated answers. Recognized keys: `gender`, `race`, `veteran`, `disability`, `hispanic`, `transgender`, `orientation`, `pronouns`. Write each value in the words forms use for that choice. A value may be a list of acceptable wordings of the same choice, for example `"gender": ["Woman", "Female"]`. The harness selects an option only when it is, or contains, one of those wordings as a whole phrase; otherwise it declines. Never put a value here the user did not give you.

This file is gitignored and never leaves the user's machine.

---

## Step 6.8: Career narrative (optional; writes `data/career-narrative.md`)

Offer: "Cover letters can be written two ways. The standard form is three paragraphs built around one achievement. The other form tells your career as a short chronological story with one throughline, framed toward each role. The story form needs a spine from you once. Want to set that up?"

- If no: leave the file as scaffolded (or absent). Cover letters use the three paragraph form.
- If yes: fill in `${WORKSPACE}/data/career-narrative.md` (the scaffold copy of `templates/career-narrative.template.md`) from the user's answers, real facts only: the origin (what first pulled them toward this work), one numbered item per era or role in order (what they did, what it taught them, how it led to the next step, one concrete result), and the throughline (the single idea that connects every step). Every employer, date, and figure must also appear in the resume baseline or `reference.md`. Delete the bracketed prompts as each part is filled; a file that still holds only placeholders counts as absent.

---

## Step 6.9: Standing rules and role posture (finishes `_profile.md`)

Three short questions, then write the answers into the matching sections of `_profile.md`:

1. **Role posture leads.** "If you applied to a role that manages people, which of your experience should lead? And for a senior specialist role with no direct reports? And for a hands on individual role?" Write one line each under "Role posture leads". If the user has no evidence for a posture, write "none"; the assistant will then name it as an honest gap instead of inventing it.
2. **Standing rules.** "Is there anything you already know you always or never want: in how results are shown, how your resume is written, or what gets applied to?" Write one line per rule under "Standing rules". Tell the user these are copied into every helper agent's instructions, and that any lasting correction they give later ("from now on", "always", "never") is appended there. A rule that maps to a key in `data/profile.json` is written there too.
3. **Rare combinations.** "Which two or three combinations of skills or experience in your background are uncommon among people who apply to your target roles?" Write one numbered line each under "Rare combinations (resume spine)", replacing the placeholder lines. If the user skips, delete the placeholder lines and write "- (none yet)"; nothing is invented, and tailoring falls back to fit with the job description alone.

---

## Step 7: Smoke test

First show the user exactly what a run would do, with no network call:

```bash
cd "${JOBE_HOME}"
node collectors/pipeline.js --dry-run 2>&1 | tail -30
```

It prints the sources, the seed roles, and the merged filters. Check them against what the user asked for. Then run a small discovery so the user sees something real:

```bash
node collectors/pipeline.js --no-harvest --max-enrich 20 2>&1 | tail -10
```

Show the result. If it is empty, say why in plain terms (no search key and no employers in the index yet is the usual reason) and offer the fix (a free Brave key, or a few target employers in Step 6.5). Then offer: "Want me to evaluate the top match end to end so you see a tailored resume + cover letter come out?" If yes, run `/jobe <top-url>` against the highest scoring posting and show the resulting `reports/queue/{slug}/` files.

---

## Step 8: Wrap up

Print a summary:

```
Onboarding complete.

Files written (all under the workspace ${WORKSPACE}):
  ${WORKSPACE}/_profile.md                        ({Steps 1, 6.9: identity, preferences, standing rules})
  ${WORKSPACE}/data/resume-baseline.json          ({Step 2: K roles})
  ${WORKSPACE}/reference.md                       ({Step 3: N pieces of work})
  ${WORKSPACE}/data/archetypes.json               ({Step 3.5: your buckets, or none})
  ${WORKSPACE}/data/bullet-library.json           ({Step 4: B bullets across K role keys})
  ${WORKSPACE}/.env                               ({Step 5: which keys are set})
  ${WORKSPACE}/data/profile.json                  ({Step 6: work modes, countries, regions, recency, title rules, salary floor and currency, differentiator skills, forbidden terms, page target, page size, date locale})
  ${WORKSPACE}/data/companies/negative-list.json  ({Step 6})
  ${WORKSPACE}/data/queries/seeds.json            ({Step 6.5: Q (role x location) pairs in your field})
  ${WORKSPACE}/data/apply-profile.json            ({Step 6.7: eligibility answers, salary strategy, EEO opt in})
  ${WORKSPACE}/data/career-narrative.md           ({Step 6.8: written, or skipped})

Next steps:
  /jobe find                # discovery, filtered by your policy; evaluates the strongest matches
  /jobe <posting-url>       # evaluate a specific posting
  /jobe apply-all           # apply to your queue (the first run downloads the Camoufox browser once, a few hundred MB)
  /jobe tracker             # see the funnel after a few applications

To run any step again:
  /jobe onboard profile     # identity, preferences, policy
  /jobe onboard resume      # resume baseline + bullet library
  /jobe onboard evidence    # evidence file, buckets, evidence gates
  /jobe onboard keys        # API keys
  /jobe onboard seeds       # discovery seeds (roles x locations) and target employers
  /jobe onboard apply       # application form answers
  /jobe onboard narrative   # career narrative for cover letters
```

---

## Behaviors throughout the interview

- **One question at a time.** Don't list 5 questions in one prompt; the user fatigues.
- **Show your work.** After every step, summarize what you wrote and where, in plain language.
- **Allow back tracking.** If the user says "wait, the previous answer was wrong", undo and redo.
- **Be patient with copy and paste.** Long pastes from existing resumes, profiles, or project write ups are the ideal input; do not require the user to retype.
- **Never invent specifics.** If the user gives a vague answer ("we improved the intake process"), ask for one concrete detail (what changed? how many? what result?). If they can't answer, mark the bullet weak and move on. Do NOT hallucinate.
- **Never fill a preference the user did not state.** A skipped question means the permissive default, not your guess.
- **Clean punctuation, keep the letters.** Strip em dashes, en dashes, smart quotes, and the characters `< > [ ] { } " \` from any text the user pastes before writing it to a resume, library, or evidence file. `lib/normalize.js` will catch what slips through at render, but be defensive at write time. Never strip or fold the letters of a name, employer, or school (accents, other scripts); only `output.asciiOnly: true` does that, at render.

## What NOT to do

- Don't ask the user to look at JSON or write JSON.
- Don't present a list of emphasis buckets to choose from. Buckets come from the user's own field or do not exist.
- Don't ask for evidence the user clearly doesn't have. Shorten the evidence step for someone early in their career.
- Don't push for API keys. They're optional. Make the path with no key obviously workable.
- Don't answer an eligibility or demographic question on the user's behalf.
