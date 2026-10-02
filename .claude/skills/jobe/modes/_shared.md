# Shared Context

Loaded for every mode. Contains the workspace rules, the profile and standing rules contract, the report folder lifecycle, scoring, positioning, ATS rules, render gates, evidence sourcing, and the anti fabrication guardrails. Nothing here assumes a profession: every example is a shape, and every preference comes from the active user's own files.

---

## Workspaces (multiple users on one machine)

Jobe supports many people on the same computer, each targeting a different field (nursing, accounting, film, operations, ...). Each person has an isolated **workspace**; the code and shared seeds are common.

- **Resolve the active workspace at the start of every run.** `node "${JOBE_HOME}/scripts/user.js" current --path` prints the absolute workspace directory. It prints the install root when no user is configured (single user, back compatible).
- **All USER layer paths resolve under that workspace directory**, never under the install root: `_profile.md`, `reference.md`, and everything under `data/` (profile.json, resume-baseline, bullet-library, apply-profile, archetypes.json, career-narrative.md, evidence-index.json, evidence-anchors.json, evidence-depth.json, tracker.md, story-bank.md, followups.md, apply-queue.json, contacts.json, queries/seeds.json, companies/index.json, companies/negative-list.json, companies/portals.json, companies/non-tech-seed.json, and the optional evidence/ folder), plus `reports/` and `signals/`.
- **SHARED (never per user):** the code (`lib/`, `collectors/`, `scripts/`), `configs/`, `templates/`, and the field neutral system file `data/companies/staffing-list.json`. These stay at the install root. The workspace `data/companies/portals.json` is read first and combined with the shared `configs/portals.json`; `data/companies/non-tech-seed.json` exists only in the workspace.
- The collectors and scripts resolve the active workspace on their own (from the `users/.active` pointer, or the `JOBE_USER` env var which wins over it, or `JOBE_USER_ROOT`, an absolute path that wins over both and exists for tests and smoke runs), so you never pass a workspace path into `node collectors/...` or `node scripts/...` to select the user. A LIST FILE argument is different: scripts resolve it against the current directory, so pass an absolute `${WORKSPACE}/...` path or no argument at all.
- **Isolation is hard:** never read or write one person's workspace while acting as another. If you are unsure who is active, run `node "${JOBE_HOME}/scripts/user.js" current` and confirm before touching personal files.
- **Override legacy path idioms.** Any concrete path a mode names for a USER file (`reports/...`, `data/...`, `signals/...`, `reference.md`, `_profile.md`), whether written bare relative or through an older `JOBE_HOME="${HOME}/.jobe"` / `JOBE_HOME="."` data root idiom, MUST be taken as relative to `${WORKSPACE}`. Prepend `${WORKSPACE}/` and ignore the legacy data root idiom. This applies to direct `Read`/`Write`/`Edit` and to `node -e` `require('./...')`/`readFileSync`/`writeFileSync`. Only `node collectors/...` / `node scripts/...` / `node lib/...` invocations resolve the workspace themselves; run those from `${JOBE_HOME}` and do not prefix them.

---

## Profile, policy, and standing rules

Each user has two profile files, with different readers:

| File | Reader | Holds |
|---|---|---|
| `${WORKSPACE}/_profile.md` | the model only | identity, target roles, prose preferences, and the optional sections below |
| `${WORKSPACE}/data/profile.json` | code only, through `lib/profile.js` | the structured policy: `candidate` (years, degrees, clearance), `discovery` (work modes, hybrid office share, countries, recency, title exclude and keep lists, salary floor, staffing filter, company sites, score floor, referral first), `skills` (levels, gaps), `evidence` (ledger, narrative, roots, accounts, tools, attribution), `output` (forbidden terms, page target, hyphen style) |

Rules that follow from this split:

1. **A preference only filters when it is in `data/profile.json`.** Prose in `_profile.md` changes what you write, never what the pipeline keeps. When a mode says "the user's work modes" or "the user's recency window", it means the JSON value (SKILL Step 2.3 prints it). Keep the two files in agreement whenever you edit either one.
2. **Absent means permissive.** A key the user never set applies no filter and no check: every work mode, every country, every title level, no salary floor, the shipped recency default. Never fill a gap with a preference of your own, and never present one person's taste as the product default.
3. **A command line flag beats the profile, which beats the permissive default.**
4. **The match score measures fit only**: how well the role's stated requirements map to the candidate's real experience, including honest reshaping through adjacency. Preferences (location, level, pay, company type, a referral) are FILTERS or ordering steps. They never add to or subtract from the score.

### Optional prose sections of `_profile.md`

Each is optional; an absent section adds no rule. The workflow scripts and the modes look for these headings by name:

- **Standing rules**: the user's own durable corrections, one per line. Hard constraints on every run (SKILL Step 2.4), appended whenever the user states a new one (SKILL Step 2.5).
- **Attribution rules**: which employer or project each body of work belongs to, and what must never be listed under another.
- **Role posture leads**: which evidence leads for a people leader role, for a senior specialist or technical lead role, and for an individual contributor role.
- **Verified figures**: the money and scale figures that may be used, each with its exact scope.
- **Known corrections**: claims that were wrong in an earlier draft and must not reappear, in any wording.
- **What not to use in output**: names and topics that must never render. The machine checked list is `output.forbiddenTerms` in `data/profile.json`; keep both in step.

### Subagents inherit nothing

Every subagent prompt must carry, as literal text: the absolute `${WORKSPACE}` path; the policy values the task touches (title exclude and keep lists, work modes, countries, regions, recency window, salary floor); the names that must never render; when it lists or ranks postings, the presentation rule (only rows that clear every gate the user set, a compensation figure on every row); when it writes resume, cover letter or application answer text, the evidence sourcing rule (read the JD, then the user's real evidence, then write), the "Attribution rules", "Role posture leads" and "Verified figures" sections, the ATS character rule and the method depth rule; and every relevant line of "Standing rules" and "Known corrections". See SKILL "Subagent propagation". A subagent given a bare task will default, and a default is exactly what the user's standing rules exist to prevent.

---

## Report folder lifecycle

A report folder lives at `${WORKSPACE}/reports/{bucket}/{slug}/` and moves through the buckets in this order:

`verify` (generated, verification pending or failed), `evaluate` (scored, decision pending), `queue` (generated, verified, in `data/apply-queue.json`, ready to apply), `manual` (a person must finish it), then `applied` or `skipped`, then `archive` (aged out or done). `audit` holds audit reports and is not a job bucket.

- New evaluations land directly in `reports/queue/{slug}/`.
- `manual` is an ACTIVE parking bucket for anything the harness cannot complete (a knockout or eligibility gate it cannot register, an account wall, an ATS that blocks an automated submit). It is not an archive. Folders there are filed flat: `reports/manual/{slug}/`.
- **Never assume where a folder sits.** Resolve it: `require('./lib/tracker-writer').locateReportDir(root, slug)` returns the absolute folder in whichever bucket holds it (it also finds an older flat `reports/{slug}/` folder and dated archive folders), or `null`.
- **Never move a folder by hand.** `moveReportFolder(slug, bucket)` finds the folder wherever it sits, moves it, and rewrites the queue entry (`resumeDocx`, `coverLetterDocx`, `reportDir`) and every tracker reference in one step.
- Company level research that is not one job's report (the company intel cache, deep research notes) lives under `${WORKSPACE}/signals/company-intel/{company-slug}/`, outside `reports/`, so the lifecycle and the orphan scan never see it.

---

## Scoring Model

### Category Weights
| Category | Weight |
|---|---|
| Required Skills | 3x |
| Preferred Skills | 1x |
| Tools and Systems | 2x |
| Domain Knowledge | 2x |
| Experience Level | 2x |
| Education and Credentials | 1x |
| Soft / Cultural | 0.5x |

### Match Classifications
| Classification | Score | Definition |
|---|---|---|
| Exact Match | 1.0 | Done this exact thing with measurable proof. Cite the source (a document, a system, a repository path, or an evidence file entry). |
| Strong Adjacency | 0.7 | Closely related, transferable. Explain connection. |
| Weak Adjacency | 0.4 | Some exposure, not at full scale. Be honest. |
| Gap | 0.0 | No evidence. Provide mitigation strategy. |

### Match Thresholds
| Threshold | Score | Strategy |
|---|---|---|
| Strong Match | 80 to 100 | Lead with confidence |
| Good Match | 65 to 79 | Lead with differentiators |
| Stretch Match | 55 to 64 | Lead with unique value |
| Reach | Below 55 | Recommend against unless extreme differentiators |

These bands match `configs/default.json` `match_thresholds` and the auto evaluate steps in `find.md`.

### Gate Pass Rules
- **Gate 1**: Required Skills >= 50%
- **Gate 2**: Experience Level >= 0.7
If either fails, present breakdown and ask before generating resume.

### How the pipeline computes `matchScore` (`lib/rank.js fullScore`)

The discovery score is deterministic and built only from the user's own files:

- `score = 34 + coverage * 44`. `coverage` blends two estimates by how far the user's own skill table in `skills.levels` stands alone (ratedness = rated terms / 40, capped at 1, times the share of rated weaknesses / 0.2, capped at 1; a rated term is a weakness in full at 0.5 or below and in proportion between 0.5 and 0.6). Rated: of the rated skills the JD names, the mean level (neutral 0.5 when it names none). Derived: the share of the JD's own content words found in the user's evidence (bullet text and keywords count up to 1.0, the resume skills block or the evidence index 0.6, a declared gap in `skills.gaps` 0.2; in a library of hundreds of bullets a word is full evidence only when several bullets carry it), stretched so that covering 82 percent of the words is full coverage and 16 percent is none. Pay, benefits, equal opportunity, how to apply and working condition text, sentences in the employer's own voice that state no ask, and closing side sections are not counted, and a description of under about 60 content words is pulled toward neutral in proportion. The blend is a count, not a plain weighting: `coverage = (trust * sum of the levels of the rated skills the JD names + weight * prior) / (trust * number of those skills + weight)`, with `weight = 8 * (1 - ratedness)` and `prior = (1 - ratedness) * derived + ratedness * 0.5`, so the more rated skills a JD names the more the rated estimate counts. `trust = min(1, mean over rated terms of max(0, 0.9 - level) / 0.12)`: a table of strengths alone (every level 0.9 or above) has trust 0 and is not counted as a rating (its terms still count as evidence that the user holds the skill, at the level given, so a posting that names rated skills the bullets do not carry scores a point or two higher for each one, about twelve for a table of ten, and can cross the 55 floor); any level of 0.6 or lower counts. Field check: on a posting whose title names no target role word, ratedness and trust are both multiplied by `min(1, max(derived / 0.5, min(1, (rated skills named - 1) / 2) * min(1, derived / 0.25)))`, so a posting outside the user's field is scored by the derived estimate, not by the rated keywords it happens to name: three rated skills named (two count half) halve the coverage the posting needs and never open the table by themselves. A rated term is also evidence, so the table should hold only skills specific to the user's field, neither words every field uses nor general tools and methods that other fields share (spreadsheets, SQL, reporting, data analysis, forecasting, process improvement, project management, automation); a table that keeps them lifts a posting from another field that is built around them (six or more named in a short description) to 65 and above (`onboard.md` Step 6). With nothing rated, coverage is the derived estimate; with a full table that also rates weaknesses it is the rated mean. It is 0.5 when the user has nothing on file.
- Plus up to 8 in total for differentiators and target role words in the title together. Differentiators: `1.2 * n ** 0.75` for the n skills the user rated 0.9 or above in `skills.levels` that the JD names (one adds 1.2, four 3.4, eight 5.7; none rated, no bonus). Role words: 3 per target role word in the title, scaled by 1 - ratedness, so this part is zero when the table stands alone. Differentiator points are added in full only as far as the table is trusted (trust above); for the untrusted share they take the place of title role points instead of adding to them, so a table of strengths alone earns the bonus the same user with nothing rated does. Plus 3 when the title carries a seniority word the user's OWN seed titles carry (no level is preferred otherwise).
- Minus 15 when a doctorate is required and the known degree is below it, minus 18 when a clearance is required and `candidate.clearance` says the user holds none, minus 5 for a 10 to 15 plus years ask above `candidate.yearsExperience`, minus 6 per unmet stated minimum.
- A user with no skills on file has a neutral fit part of 56 on every posting; only the title bonuses above move it (at most 67), so ordering falls to title words and freshness.
- Until `skills.levels` is filled in, the score says whether a posting is in the user's field and how much of it their material covers; it does not know which skills are their strongest, so the order inside a band is approximate. About 40 rated terms, one in five of them at 0.5 or below, make the user's own table the whole score; a table that rates no weakness is not counted as a rating, so ask for the weak skills too (`onboard.md` Step 6).
- `gatePass = { gate1: score >= 55, the JD left enough to judge, and coverage >= 0.5 * ratedness (ratedness after the field check; so with nothing rated the gate is the score floor alone), gate2: the largest years ask is at most yearsExperience (unknown years passes), minimums: none unmet }`. `posting.minimumsUnmet` lists the JD's own stated minimums the candidate does not meet; show them next to the score. Skill terms in `rankReason` are shown in matching form (lowercase, accents folded); gap labels keep the user's spelling.

Nothing about a preference enters this number (rule 4 above).

---

## Archetype Detection (optional)

Archetypes are optional emphasis buckets that bias which evidence a resume leads with for a given JD. NONE ship by default: with no archetype file, every JD is treated as `General` and evidence is ranked purely by overlap with the JD, which is the right default for most users and every field.

To use them, define your own in `${WORKSPACE}/data/archetypes.json` (shape and two field examples in `templates/archetypes.template.json`) and tag your `data/bullet-library.json` bullets with matching `archetypes[]`:

```json
{
  "Your Bucket Name": { "keywords": ["a term", "another term"], "portfolioDomains": ["a heading in your reference.md"] }
}
```

`lib/archetypes.js` reads `${WORKSPACE}/data/archetypes.json` first, then an older `${WORKSPACE}/configs/archetypes.json`, then `${JOBE_HOME}/configs/archetypes.json`. It classifies each JD into your best matching bucket (or `General` if none match), and bullet-select gives archetype matched bullets a small ranking bonus. The buckets, their keywords, and their emphasis are entirely yours: define them around your own field, or skip them.

**An archetype is orientation only.** When archetypes are configured they are a hint about where to look first. They never decide the evidence. The evidence is whatever best answers THIS JD once you have read it against the candidate's real work (see Evidence Sourcing). A JD tagged with one bucket whose real ask belongs to another still leads with the evidence that answers the real ask.

---

## Positioning Reasoning (INTERNAL ONLY)

These are reasoning frameworks for deciding WHAT to include and HOW to frame it. They must NEVER appear as words in any resume, cover letter, or output the user sees. No "Talebian", no "barbell", no "antifragile" or "antifragility", no "via negativa", no "skin in the game", no "WYSIATI", no "fat tails", no "emergence", no "inversion". The renderers refuse a document that contains the unambiguous ones (see Render Gates). The user sees the result of this reasoning, not the reasoning itself.

However, the REASONING these frameworks produce MUST come through in the output, especially cover letters. The reader should see cost asymmetry thinking, tradeoff analysis, failure mode reasoning, and working backward from what could go wrong. They just should not see the labels. Example: don't write "I used a barbell approach." DO write the thinking in the words of the candidate's own field, for instance "A two minute bedside check catches most missed doses at no added cost; pharmacist review is kept for the few high risk drugs where a miss is expensive" or "A rule based match clears the routine entries; senior review time goes to the handful of accounts where an error would be material." The thinking is visible; the vocabulary is not.

**1. Fragility**: A claim backed by deep, documented evidence (a detailed entry in the evidence file, work product you can open, a named outcome with its scope) holds up under questioning. A claim backed by a single thin mention does not. Lead with the claims that hold up. Never bluff.

**2. Antifragility**: Deep, hard to commoditize capabilities, the ones backed by the candidate's strongest evidence, gain value as the field shifts. Make those the resume's spine; lead with what stays valuable, not with the most common keyword.

**3. Asymmetric Opportunities**: Include 1 or 2 pieces of work the JD doesn't ask for but the team would value. Small risk (one wasted bullet), large upside (memorable candidate).

**4. Inversion**: What would make them NOT hire the candidate? Read the objections off the JD and the candidate's own history (a required credential the candidate lacks, a different setting or sector, a shorter tenure, a change of field) and answer each one with a resume bullet that shows the closest real evidence. Never answer an objection with a claim the evidence does not support.

**5. Barbell**: 70% safe (exact JD matches, boring and precise) + 30% bold (unique differentiators no other candidate has). Kill the generic middle.

**6. Emergence**: Read the candidate's roles in order and name what the sequence adds up to that no single role shows (for example, someone who has done the work, then taught it, then run it). The Summary must capture that progression in the candidate's own terms.

**Source Framework**: The six lenses above (fragility, antifragility, asymmetry, inversion, barbell, emergence) are drawn from Taleb's *Antifragile* and *Fooled by Randomness*, augmented with Kahneman's WYSIATI / System 1 and 2 bias awareness. Use them to generate reasoning rich output where the thinking is visible but the terminology is absent.

---

## ATS Format Rules

Evidence weighted. Rules with empirical backing are cited; rules without rigorous sources are kept as directional priors and labeled accordingly.

1. **Single column** (supported: Enhancv 2024 template testing found single column parses more reliably than multi column; directional, not peer reviewed)
2. **No tables, graphics, text boxes, icons** (supported: multiple ATS vendor parsers degrade on non text structural elements; exact failure rate is vendor specific)
3. **Standard headers**: SUMMARY, EXPERIENCE, SKILLS, EDUCATION (plus SELECTED PROJECTS and AWARDS when the resume has them)
4. **Calibri or Arial font** (no specific empirical backing; common convention)
5. **At most two pages** (supported: ResumeGo 2018, n=482 recruiters, controlled simulation, 2.3x preference for two pages over one for mid and senior roles; industry survey, not peer reviewed). The user's own target is `output.targetPages` in `data/profile.json`: 1 for a short history, 2 for a long one, `null` for no page fill check (only the two page ceiling is then reported).
6. **No resume word count target.** Use the available space according to the role and the evidence. Judge length by the RENDERED document (`scripts/check-docx-pages.js`), clarity, and relevance rather than a fixed word range.
7. **Quantified results where the numbers are real** (directional; the XYZ formula is a teaching framework, not an RCT validated tactic). The audit holds metric density to a band: too few numbers reads unsubstantiated, a number in every clause reads machine written.
8. **70%+ JD keyword match** (directional; ATS keyword matching is empirically how most ATS rank. Tailoring per JD is supported by Resumly industry data and Resume2Vec MDPI 2024 (+15.85% nDCG), both of moderate strength)
9. **Bold job titles, bulleted accomplishments** (common convention; F pattern reading is from Nielsen Norman eye tracking, which studied web pages, not resumes)
10. **No em dash, en dash, smart quote or other typographic punctuation; letters of the language the document is written in are kept.** (operational: ATS parsers have documented failures on typographic punctuation; defensive). `lib/normalize.js` always folds dashes, bullet glyphs and smart quotes to ASCII at render and removes invisible characters and emoji; letters of every script, accents included, stay as written. Two opt in keys in `data/profile.json`: `output.stripHyphens` removes plain hyphens (a style choice), and `output.asciiOnly` folds accented letters to their base letter, writes out symbols that carry meaning (micro, degree, plus or minus, currency signs) and removes every other script (only for a target ATS known to reject non ASCII text).
11. **No ATS illegal ASCII characters: `< > [ ] { } " \`** (operational: Workday / Greenhouse / Lever / Ashby upload validators reject these as XML or markup control tokens inside the DOCX XML. `lib/normalize.js` strips them at render and both `scripts/render-docx.js` and `scripts/render-cover-letter.js` call `normalize()` on every field as a safety net, but write your `data/bullet-library.json` and `data/resume-baseline.json` clean too: use "at least 3" not the `>=` symbol, "at most 25 percent" not `<=25%`, "(64, 8)" not square brackets.) Free text typed into an application form passes through the same normalizer, so write those answers ATS clean as well.
12. **XYZ formula: "Accomplished X as measured by Y by doing Z"** (Google origin teaching framework, no RCT validation, but aligns with quantification as a prior)

### Render Gates

Both renderers check the document before writing anything. Stated once here; every mode that renders inherits it.

- **Always fatal**: a term from `output.forbiddenTerms` (`data/profile.json`) in any rendered field, and positioning vocabulary (the framework words listed above). The render exits 1 and writes nothing. Rewrite the passage by function and render again.
- **Warn by default, block under `--strict`** (or env `JOBE_STRICT_AUDIT=1`): the resume audit (`auditResume`, JD aware when `jd.txt` sits beside the resume JSON), the method depth gate (`data/evidence-depth.json`; it checks nothing when that file is absent or empty), and the cover letter substance bar (`auditCoverLetter`). For a letter not written in English the cover letter bar checks only a figure, a length of at least 100 words, and that the employer is named; the leadership and decision elements are not checked mechanically, so verify them by hand (the renderer prints them as `[cover-letter-audit] not checked for a letter not in English, verify by hand: ...`). The resume audit also flags a resume of 8 or more bullets in which every bullet carries a number: leave at least one bullet without one.
- Modes render with `--strict`. A warning is a prompt to fix the content, never something to route around.

## Narrative Alignment Standard

Claim support is the floor, not the finished application. Every resume and cover letter must also make a coherent, JD specific argument from the candidate's real experience.

For each role:
1. Identify the employer's central problem, not just its keyword list.
2. Choose the strongest supported career story that answers that problem.
3. Make summary line 1 and the first two bullets of the current role establish that story immediately.
4. Use the remaining experience to show a coherent progression across the candidate's own roles (what each step added to the one before), not a list of unrelated jobs.
5. Select projects only when they advance the same argument or supply one memorable, relevant differentiator.
6. Use the cover letter to deepen the story with reasoning, tradeoffs, and decisions. Do not repeat the resume in paragraph form.
7. Treat an honest gap as part of the positioning. Demonstrate the closest adjacency without writing as though the missing experience exists.

The package should answer, in order: What does this employer need? Which proven part of the candidate's experience best answers it? Why does the rest of the candidate's career make that evidence more credible and distinctive?

### What the empirical literature DOES strongly support (use these as priorities)

- **Referrals dominate cold apply** (Burks et al QJE 2015; Friebel et al NBER 2019). Effect size >>> any formatting change. See `/jobe contacto` mode.
- **Name based discrimination in screening exists** (Bertrand & Mullainathan AER 2004, mixed replication). Implication: if the candidate's name or background invites bias, referrals matter even more.
- **LLM based screening has measurable demographic variance** (Brookings 2024). Implication: don't assume a single model's score is neutral; run bias audits.

---

## Cover Letter Rules

A cover letter is never the resume in prose. There are two forms; the user's files decide which one applies.

**Which form.** Look for the career narrative: the path in `evidence.narrative` (default `${WORKSPACE}/data/career-narrative.md`). If the file exists AND holds real content (not only the bracketed placeholders of `templates/career-narrative.template.md`), use the **narrative form**. Otherwise use the **achievement form**. Both forms carry the three required elements of the Cover Letter Quality Bar, and both follow the Reasoning First rules below.

### Narrative form (when the user has a career narrative)

A first person, CHRONOLOGICAL career story with one throughline: an origin, a walk forward through each role, what the candidate learned at each step and how it built on the last, the growth and the impact, ending pointed at THIS role.

- **Source (required):** read the narrative file and build the letter FROM that spine. Then frame and weight the arc toward the target role: the same history reads as a journey toward whatever this JD cares about most. Keep the recent part consistent with the resume baseline timeline.
- About 450 to 650 words, one page. Several short paragraphs, one per era or role, in chronological order.
- **Open on the origin** from the spine, reframed toward the role's domain.
- **Progress role by role**: each paragraph names what the candidate did AND the lesson or growth it gave, and how it set up the next step. The transitions carry the arc.
- **Weight the paragraphs** toward the roles and skills the target JD cares about; compress the rest. Real figures appear woven into the story as beats, never as a list of metrics.
- **Land the thesis**: the throughline paragraph of the narrative file, in words that fit this role.
- **Close looking forward**, naming THIS company, team, or product and what the candidate wants to do there. Never "I look forward to hearing from you."
- No generic flattery; every specific is tied to the candidate's real arc or to THIS role. Every employer, date, and figure also appears in the resume baseline or the evidence file.

### Achievement form (default, no career narrative)

- 250 to 350 words, 3 paragraphs, one page
- **P1 (Hook)**: Lead with the candidate's achievement, not company flattery. Achievement first, company connection second, role name third.
- **P2 (Proof)**: 1 or 2 achievements mapped to top JD requirements. Go deep on one story. Specific methods, tools, and figures. XYZ formula.
- **P3 (Close)**: Value restatement + genuine enthusiasm for the specific team or product + availability. Not "I look forward to hearing from you."

### Both forms

- No generic content. Every sentence specific to THIS company and THIS role.
- No em dashes, en dashes, smart quotes or other typographic punctuation, and none of the characters `< > [ ] { } " \`. Letters of the language the letter is written in are kept.
- Greeting and sign off: the renderer uses the greeting and the sign off the letter itself carries, as written. It adds "Dear {company} Hiring Team," and "Sincerely," only to an English letter that has none. A letter in another language must carry its own greeting and sign off (a short final line, then the name); otherwise it renders with the name alone.
- No term from `output.forbiddenTerms`, nothing under "What not to use in output".

### Reasoning First Cover Letters

The cover letter must demonstrate HOW the candidate thinks, not just WHAT was done. Every achievement mentioned should include the reasoning behind the decision.

- BAD (outcome only): "I redesigned discharge teaching and readmissions fell 18 percent."
- GOOD (reasoning visible): "Readmissions were coming from patients who nodded through a single long teaching session on the day they left. I split it into three short bedside sessions with a teach back check, because a ten minute session a nurse can fit into rounds is one that actually happens."
- BAD: "I shortened month end close from nine days to five."
- GOOD: "Most of the nine days went to matching entries nobody doubted. A rule based match now clears those, and reviewer time goes to the few accounts where an error would be material."

The Positioning Reasoning lenses should come through as REASONING in the letter text. The vocabulary never appears, but the THINKING does. The reader should see cost and benefit tradeoffs, asymmetric reasoning, and working backward from failure without ever seeing the labels.

For every substantive claim in the cover letter, answer at least one of:
- Why was it done this way instead of the obvious alternative?
- What tradeoff was being navigated?
- What failure mode was being prevented?
- What would have happened if this decision were wrong?

Reference: If the user maintains their own reasoning notes, load them here and use them to internalize the reasoning style when generating cover letters.

### Cover Letter Quality Bar

Every cover letter, in either form, MUST contain at minimum the three elements `auditCoverLetter` (`lib/tailor.js`) checks:

1. **One measurable outcome**: money, a percent, or a count with its unit (for example "readmissions down 18 percent over two quarters", "210,000 dollars lower state tax in the first year").
2. **One leadership or scope signal**: a team led, people trained or supervised, something founded or owned (for example "trained 22 nurses through the rollout", "owned the filing calendar for 140 client returns").
3. **One decision the work drove**: a recommendation, a priority, an adoption, an approval, or a change in how the organization allocates effort (for example "the unit adopted the three session format as its standard", "the client approved moving where inventory is held").

In the narrative form these are story beats, not a checklist paragraph. If a draft fails any of the three, it is incomplete. Regenerate with business impact and leadership content taken from the user's evidence file and evidence sources, not from canned library phrasing. Figures come only from the evidence file or the "Verified figures" section of the profile.

---

## Anti Fabrication Rules

- Every claim must trace to the candidate's own evidence: an entry in the evidence file (`evidence.ledger`, default `${WORKSPACE}/reference.md`), a bullet in the library, or work product under the user's evidence roots. If it is not there, it does not go on the resume.
- NEVER inflate scores. If evidence is thin, score as weak adjacency or gap.
- NEVER add skills the user doesn't have. Only reformulate real experience with JD vocabulary.
- Every exact match MUST cite its source: a document, a system, a repository path, or the evidence file entry. Repositories are one kind of evidence, never assumed.
- **A stated skill is authoritative.** A scan of the user's work folders (the evidence index) may CREDIT evidence; it never removes or downgrades a skill the user stated. Much of a person's real output lives in an employer's systems and cannot be seen from their own machine.
- **Authorship metadata is not negative evidence.** Do not use version control author names, file owners, or a missing byline as proof that the user did not do work they listed. Keep third party tools, libraries, and upstream baselines attributed to their authors, and do not claim sole authorship unless the user confirmed it.
- **Figures come from the user.** Money and scale figures come only from the evidence file or the "Verified figures" section of the profile. Never infer a figure, and never treat a missing record as proof that something did not happen.
- Nothing under "Known corrections" in the profile may reappear, in any wording.
- No skills on the resume that can't be defended in an interview.
- No buzzwords: "results-driven", "passionate", "leveraged"

---

## Ghost Job Detection (Block G)

Multi signal scoring via `lib/ghost-score.js`. Each signal returns a value in [0,1]; the final ghost score is the max of all signals (any one strong signal is enough to flag).

Signals:
1. **Age signal**: posting age against the larger of 30 days and your recency window (off when the window is 0), plus the user's `discovery.seniorityExtensionDays` (default 0) for senior titles. The optional headroom has empirical support (Review of Accounting Studies 2023 on high skill vacancy duration); it is the same value the recency gate uses, so a posting the gate keeps is not then flagged for its age.
2. **Repost signal**: same requisition posted 3+ times
3. **Company ratio signal**: hires per posting ratio (Revelio Labs 2024 baseline ~0.5; <0.25 is a strong ghost signal)
4. **Layoff signal**: company announced layoffs in last 30/90/180 days
5. **Title fuzz signal**: "talent network", "future openings", "general application" titles

Labels:
- **High Confidence** (score < 0.30): show normally
- **Proceed with Caution** (0.30 to 0.60): show with flag
- **Suspicious** (>= 0.60): hide by default, accessible with `--show-ghosts`

Empirical backing: Clarify Capital 2024 (n=1,200: 1 in 3 postings older than 30 days, 1 in 5 intentionally unfilled), Hunter Ng arXiv 2410.21771 (2024), Revelio Labs 2024. Government and academic roles have longer legitimate timelines (age signal alone should not gate them). Recruiter sourced is a positive signal.

---

## Competitor Framework

Who else applies depends on the kind of employer, in every field. Use the shape below and fill the "who applies" column from the user's own field (the `jobe-competitor` agent researches the specific role).

| Employer tier | What defines it | Typical applicant |
|---|---|---|
| Most sought after | The names every candidate in the field applies to | Top credentials, prior experience at a peer employer, a long record of visible results |
| Established large employer | Structured hiring, formal requirements, many applicants per opening | Meets every listed requirement, steady tenure, recognized credentials |
| Growing or small organization | Fewer applicants, broader roles | Generalists with range who have built or run things end to end |
| Public sector, non profit, or regulated institution | Formal eligibility rules, fixed pay bands | Meets the stated eligibility criteria exactly; mission fit matters |

### Your Rare Combinations (populate in `_profile.md`)
Document the combinations of skills in your own profile that are uncommon at the tiers you target. Jobe uses this list to decide which bullets to lead with in a tailored resume. Two shapes, from unrelated fields, to show what a combination looks like:
1. Deep hands on practice + the system behind it (a nurse who also configured the charting workflow the unit uses)
2. Technical depth + client facing judgment (a tax accountant who both researches the position and explains it to the client)

---

## Evidence Sourcing (REQUIRED for Resume Generation)

For every resume generated (a single posting via `/jobe [url]`, several via `/jobe batch`, or auto evaluate from `/jobe find`), evidence is sourced in this order. Full procedure: `modes/evaluate.md` Block E Step 0.

1. **Read the JD.** List its top 5 real requirements in the JD's own words.
2. **Read the user's primary sources**, when the profile lists any (`evidence.roots[]` in `data/profile.json`: folders of the user's own work product such as documents, notes, plans, reports, analyses, or source code). Open the ones that match the JD's requirements and pull real mechanisms: methods, steps, parameters, structure, who it served. Repositories are one kind of evidence root, never assumed; most professions have none, and that is fine.
3. **Read the evidence file** (`evidence.ledger`, default `${WORKSPACE}/reference.md`) for everything the sources do not contain: outcomes, figures, scope, team size, adoption. Never invent a number.
4. **Use `data/bullet-library.json` through `lib/bullet-select.js` as a CANDIDATE POOL and a phrasing aid.** It supplies ATS clean wording for evidence you already located.

If the user has no primary sources, steps 3 and 4 ARE the evidence, and the selection procedure below applies as written. In every case the final bullets are written per JD and led by what genuinely fits THIS role. Keyword overlap alone is not tailoring.

### Why
Ranking a fixed library by keyword overlap returns the same few lead bullets for every JD (the ones that share generic words with most postings) and buries the best fit evidence whose vocabulary differs from the JD's. The result is resumes that are interchangeable in body content, with only the summary and cover letter unique. Reading the JD and then the real evidence fixes both problems, and it also catches errors a library can carry forward (work described as finished that was only designed, a result attributed to the wrong role).

### How (candidate pool)

```js
const { buildExperience, pickProjects } = require('./lib/bullet-select');
const baseline = require('${WORKSPACE}/data/resume-baseline.json');
const spec = {
  archetype: '<from Block A archetype detection, or General>',
  jdText: '<raw JD text from posting>',
  // bulletCounts keys must match role keys in your bullet-library.json.
  // Omit it to use baseline.defaultBulletCounts.
  bulletCounts: { current: 4, prior1: 2, prior2: 2, prior3: 1 },
  pinBullets: [],     // optional must include bullet IDs
  excludeBullets: [], // optional skip IDs
};
resume.experience = buildExperience(baseline, spec);
resume.selectedProjects = pickProjects(spec, 2);
```

`buildExperience` walks each baseline experience entry, resolves `company` to a library role key (through `spec.companyKeyMap`, then `library.companyKeyMap` declared in your `bullet-library.json`, then the slug of the company), scores that role's bullet pool by overlap with the JD (an archetype match is a small bonus), keeps one bullet per `studyGroup`, and returns the top N. `pickProjects` does the same against the library's `selectedProjects` array.

The output of `buildExperience` / `pickProjects` is a CANDIDATE pool, not the final resume. `evaluate.md` Block E then runs the required JD grounded reframe: get the per JD brief (`scripts/tailor-brief.js` / `lib/tailor.js`), reorder and reframe each bullet into the JD's vocabulary (preserving real figures, never inventing), write a role specific summary, and verify keyword coverage before rendering. When the sources show evidence for a JD need that has no library phrasing, write the bullet fresh from the source and add a library entry afterward so it is reusable.

### Bullet library structure

Your `data/bullet-library.json` must have this shape (role keys are yours to choose; the example is one profession, for shape only):

```json
{
  "companyKeyMap": {
    "Example Hospital": "current",
    "Example Clinic": "prior1"
  },
  "current": [
    {
      "id": "current-1",
      "archetypes": [],
      "keywords": ["patient education", "discharge planning", "readmission"],
      "studyGroup": "discharge-teaching",
      "text": "Cut 30 day readmissions on a 28 bed unit by 18 percent by redesigning discharge teaching into three bedside sessions with a teach back check."
    }
  ],
  "prior1": [],
  "selectedProjects": []
}
```

`keywords` are how Jobe learns which skills the user can prove, so use the words a job description would use. `archetypes` is optional and uses only bucket names the user defined. `studyGroup` is optional: bullets that share one describe the same work, and the selector keeps one per group. A `selectedProjects` entry also takes `name` (the display name, and the dedup key). Each bullet should be written at the depth you want it to appear in the resume.

### Attribution Rules (define in your own profile and bullet library)

For every employer in your `data/resume-baseline.json` `experience[]`, the bullet library must contain only claims that trace to real work done for that employer. Do not let bullets from one role surface under another role's section. The sources of truth, in order: `companyKeyMap` in the bullet library (the gate the selector uses), `evidence.attribution[]` in `data/profile.json` (rows `{ "source": "<folder or project label>", "belongsTo": "<role key or selectedProjects>" }`, for anything read from an evidence root), and the "Attribution rules" section of `_profile.md` (the prose rationale).

If you have a side business or parallel project that overlaps with your main job, declare each separately AND keep the bullet pools strictly disjoint. The single biggest failure mode for tailored resumes is attributing side project work to the main job.

Distinguish the two shapes. A side consultancy or venture with its own client relationships over a defined period can be its own `experience[]` entry (keep its bullet pool disjoint from the main job). But an effort that is project shaped, a single product or service you built rather than a role with an employer relationship, belongs in `selectedProjects`, alongside your other projects, NOT in `experience[]`. Listing a personal project as a job overstates employment history; keep it in the projects section and let its bullets live in the library's `selectedProjects` pool.

`auditResume` checks the mechanical part before render: `experience[0].company` must be the first entry of the user's baseline, the order must be reverse chronological, and the baseline degree must be present and unaltered.

### Selected Projects Rendering

`scripts/render-docx.js` `buildSelectedProjects(projects, heading)` renders the Selected Projects section between Summary and Experience when `resume.selectedProjects` is a non empty array (section order: Summary, Selected Projects, Experience, Skills, Education, Awards). The optional `projectsHeading` key renames the section. Resume JSONs without a `selectedProjects` field render unchanged.
