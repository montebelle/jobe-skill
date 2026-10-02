# Evaluate Mode

Generate a tailored resume + cover letter for a specific job posting using the A to G block evaluation.

## Input
The user provided: `$ARGUMENTS` (a URL, company+role, or pasted JD text)

## Step 0: Parse Input
- **URL**: Fetch the job posting. Proceed to Block A.
- **Company + role**: WebSearch for the posting. If found, use URL. Otherwise, proceed with what you have.
- **Pasted text**: Parse directly.
- **Empty**: Ask what role to evaluate.

`${JOBE_HOME}` (code) and `${WORKSPACE}` (the active user's files) come from SKILL Step 0. Run every `node ...` command from `${JOBE_HOME}`.

---

## Block A: Role Summary

1. **Detect archetype** (optional; see _shared.md Archetype Detection). With no `${WORKSPACE}/data/archetypes.json`, treat as `General`.
2. Output:
   - Archetype: [your configured bucket, or General]
   - Domain: [the employer's sector, as the JD describes it]
   - Seniority: [entry / mid / senior / lead / manager / director, as the title and JD state it]
   - Work mode: [remote / hybrid / onsite, and the stated office share if hybrid]
   - Estimated team size: [from JD clues]
   - Compensation band: [published in the JD, or a clearly labeled estimate]
3. A posting evaluated directly never passed the discovery filters. If it falls outside the user's own policy (work modes, countries, an excluded title, a published band below the salary floor), say so in one line and continue; the user asked for this posting.

---

## Block B: Portfolio Match

Launch up to 3 agents IN PARALLEL. Each prompt carries the absolute `${WORKSPACE}` path, the absolute path of the evidence file, and the relevant standing rules (SKILL "Subagent propagation"):
- **jobe-jd-analyzer**: Extract the full requirements taxonomy, ATS keywords, and priority classification. Inputs: the URL or raw JD text, company, role title, standing rules. Its output also carries three parts later blocks read directly: "Top Five Requirements" in the JD's own words (Block E Step 0a), "Licenses, Certifications, and Clearances" (the stated minimums), and "Role posture the language signals" (Block C.4).
- **jobe-company-intel**: Research the company (what it does, the team and function the role sits in, tools and systems, culture, news). Inputs: Company name, Role title, Function (the function the role sits in), Industry, Output path, Standing rules. **Cache check first**: if `${WORKSPACE}/signals/company-intel/{company-slug}/company-intel-{date}.json` exists and is under 14 days old, reuse it instead of spawning the agent. Otherwise pass that absolute path as Output path so the agent saves fresh intel there. (It is kept out of `reports/` so the bucket lifecycle and the orphan scan never see it.)
- **jobe-competitor**: Profile the competitor pool for this role at this kind of employer. Inputs: Role level, Employer type (in your own words, from the JD and the company intel; there is no fixed tier list), Company name, Location, Key requirements, Ledger path (the absolute path of the evidence file), Standing rules and the names that must never render.

**Partial result handling**: run agents with Promise.allSettled semantics. If any agent fails or rejects, flag the corresponding subsection of Block C with `WARNING: {agent-id} failed; block incomplete` rather than silently proceeding. Do NOT fabricate content for missing sections.

Salary data is fetched per URL via the `lib/enrich.js` compensation extractor.

Read the evidence file (`evidence.ledger` in `data/profile.json`, default `${WORKSPACE}/reference.md`) and, when the profile lists evidence roots (`evidence.roots[]`), the sources themselves. For EVERY JD requirement:
1. Search the evidence by the requirement's own terms
2. Classify: Exact / Strong Adjacency / Weak Adjacency / Gap
3. Cite the source for every exact match (a document, a system, a repository path, or the evidence file entry)
4. Compute weighted scores per category
5. Compute overall match percentage
6. List gaps with mitigation strategies

---

## Block C: Level Detection + Positioning

1. Apply **gate pass check** (Required Skills >= 50%, Experience >= 0.7). If either fails, present breakdown and ask user whether to proceed or skip. If the posting came from discovery, also show `minimumsUnmet` (the JD's own stated minimums the candidate does not meet, from `lib/rank.js`).
2. Apply all 6 positioning lenses from _shared.md (internal only) to determine positioning strategy:
   - Which claims hold up under questioning, and which are thin?
   - Which capabilities gain value as the field shifts?
   - What asymmetric bet to include?
   - What would make them NOT hire the candidate? Answer each objection in advance.
   - What is the safe versus bold split (70% exact matches, 30% differentiators)?
   - What does the sequence of roles add up to, for the Summary?
3. Identify top 3 differentiators from the competitor framework
4. **Role posture (REQUIRED, do not default to an individual contributor voice)**: classify the target from title + JD, then frame the summary and lead bullets to match.
   - **People leader** (Manager / Director / Head of / Supervisor / "manage a team" / "hire" / "mentor" / "grow the team"): LEAD with the candidate's people leadership evidence: team size, scope, and outcomes for the organization. Summary line 1 and the first bullets carry them.
   - **Senior specialist or technical lead** ("set direction" / "influence without direct authority" / "raise the bar across teams" / "subject matter expert"): LEAD with authority in the craft and scope across the organization, WITHOUT people management framing.
   - **Individual contributor** (no leadership language): LEAD with hands on depth and work delivered; keep leadership as a secondary signal.
   Use the evidence the profile names for that posture under "Role posture leads"; if that section is absent, choose from the evidence file. This is emphasis, never fabrication: if the candidate has no evidence for the posture the JD signals, name the honest gap. Verify the summary and the first two bullets match the posture before rendering.

---

## Block D: Compensation Research

Use salary collector data + jobe-company-intel findings + WebSearch if needed.
Report: estimated base, total compensation, any equity or bonus, level calibration, negotiation leverage. Label every estimate as an estimate.

---

## Block E: Resume + Cover Letter Generation

**Set the report folder first.** The audit and both renderers read `jd.txt` from beside the resume JSON, so the folder and that file must exist before anything else. New evaluations land in the `queue` bucket; a slug that already has a folder in another bucket (see _shared.md Report folder lifecycle) keeps it.

**The slug.** It is `{company-slug}-{role-slug}` when the user's work mode policy is exactly `["remote"]` or the posting has no city. Under any other policy a posting with a city gets `{company-slug}-{role-slug}-{city-slug}` (for example `example-health-registered-nurse-denver`), so two cities of one title never share a report folder, a queue row, or a tracker row; a hybrid posting with no city gets the suffix `hybrid`. Do not build it by hand: take the exact value from `lib/dedup.js reportSlug`, and pass the run's merged filters instead when a flag lifted the policy:

```bash
cd "${JOBE_HOME}" && node -e "const {reportSlug}=require('./lib/dedup');const {loadProfile,discoveryFilters}=require('./lib/profile');const [company,title,location]=process.argv.slice(1);console.log(reportSlug({company,title,location},discoveryFilters(loadProfile())))" "<company>" "<role title>" "<posting location, or empty>"
```

A folder made before this rule keeps its old city free slug and is still found. Put the printed value in `SLUG`, and write the posting's location as `location` in the resume JSON so the queue row carries it:

```bash
SLUG="<the value the reportSlug command above printed>"
cd "${JOBE_HOME}"
REPORT_DIR="$(node -e "const path=require('path');const {locateReportDir}=require('./lib/tracker-writer');const r=require('./lib/config').getProjectRoot();console.log(locateReportDir(r,process.argv[1])||path.join(r,'reports','queue',process.argv[1]))" "${SLUG}")"
mkdir -p "${REPORT_DIR}"
```

Write the raw JD text to `${REPORT_DIR}/jd.txt` now. Without it the JD coverage checks are skipped (the render prints that it skipped them).

**Step 0 (REQUIRED: read the JD, then the candidate's evidence, then write from that):**

Tailoring is NOT emitting stored bullets, and it is NOT ranking the bullet library by keyword. It is: read what THIS role asks for, find the candidate's real evidence that answers it, LEAD with the highest relevance evidence, and reframe it in the JD's own language. A keyword funnel over a fixed library returns the same lead bullets for every JD and buries the best fit evidence whose vocabulary differs from the JD's. Do NOT skip the reframe.

**(a) Read the JD.** Extract its top 5 real requirements in the JD's own words. Then get the deterministic brief as a HINT (never as the evidence source):
```bash
node scripts/tailor-brief.js --url "<canonicalUrl>"      # preferred: the posting record carries the company
node scripts/tailor-brief.js "${REPORT_DIR}/jd.txt"      # a pasted JD with no posting record (a posting.json with company and jdText also works)
```
JD keywords are counted over the responsibilities and qualifications sections only (the whole text unless both sections are found); they exclude English function words, and the scoped text ends where a bulleted section returns to prose. The hiring company's name is kept out of them only when the input is a posting record, so with a bare `jd.txt` ignore any keyword or gap that is just the employer's name. The `| seniority: X` label prints only when the JD's first line carries a level word (principal, staff, senior, lead); it is never inferred from body text and there is no default level.

It prints the JD archetype, ranked keywords, responsibilities + qualifications to mirror, the library evidence ranked by JD fit (per role, with matched terms), honest gaps, and a generator checklist. A gap listed there already excludes any term found in the baseline skills or in the evidence index. (Programmatic: `require('./lib/tailor').tailorBrief(jdText, baseline, { exclude: [company] })`.)

**(b) Read the candidate's evidence that matches this JD.** This is the evidence source.
- If `evidence.roots[]` is set in `data/profile.json`, open the work product under those folders that matches the JD's requirements (documents, notes, plans, reports, analyses, source code: whatever the user keeps there) and pull real mechanisms: methods, steps, parameters, structure, who it served. Respect `evidence.attribution[]` and the "Attribution rules" section: each source belongs to one role or to `selectedProjects`.
- Read the evidence file (`evidence.ledger`, default `${WORKSPACE}/reference.md`) for outcomes and figures the sources do not contain (money, scale, adoption, team size). Pair real mechanisms with real figures; NEVER invent a number.
- If an evidence index exists, confirm tool presence with it so a proven tool is never reported as a gap: `node scripts/evidence-index.js has "<tool>"` (exit 1 means not found; no index means skip this check). A skill the user stated stays authoritative whatever the index says.
- With no evidence roots (most professions), the evidence file plus the bullet library ARE the evidence. That path is fully supported.

**(c) Build the candidate pool (`lib/bullet-select.js`).** Use `buildExperience()` and `pickProjects()` to select per JD bullets and projects from `${WORKSPACE}/data/bullet-library.json`. With evidence roots it is a phrasing aid for evidence you already located; without them it is the evidence. Either way the output is a CANDIDATE pool, not the final resume. Do NOT reorder a fixed pool and call it tailored.

```js
const { buildExperience, pickProjects } = require('./lib/bullet-select');
const baseline = require('${WORKSPACE}/data/resume-baseline.json');
const spec = {
  archetype: '<from Block A archetype detection, or General>',
  jdText: '<raw JD text from this posting>',
  bulletCounts: { current: 4, prior1: 2, prior2: 2, prior3: 1 }, // keys must match your bullet-library role keys; omit to use baseline.defaultBulletCounts
  pinBullets: [],     // optional must include bullet IDs
  excludeBullets: []  // optional skip IDs
};
resume.experience = buildExperience(baseline, spec);
resume.selectedProjects = pickProjects(spec, 2);
```

**(d) REFRAME to the JD (REQUIRED LLM step).** Rewrite the resume so it speaks to THIS role:
1. **Reorder** entries and bullets so each leads with the highest relevance evidence for this JD, not the default order, and not whatever shares the most tokens.
2. **Reframe every bullet** into the JD's vocabulary (brief keywords + responsibilities) WITHOUT inventing. Reword real evidence only; PRESERVE the specific figures and methods. Change the lead, framing, and terminology to match what the role asks for.
3. **Write a role specific summary** that mirrors the JD responsibilities and leads with the strongest matching evidence.
4. **Pick relevant projects** (the ones whose focus matches the JD), not the default two.
5. **Name the honest gaps** (from the brief): position the adjacency; never claim experience the evidence does not support.
6. **Requirement mapping**: EACH of the JD's top 5 requirements must map to a specific BULLET (not just a summary line or a skills token), stated in the JD's own vocabulary where honest. Translating real evidence into the JD's words is tailoring; inventing a new claim is fabrication. The most common tailoring failure is a tailored summary over an untailored body: a summary claim with no backing bullet reads as unsubstantiated, and `auditResume` flags it.
7. **Center of gravity**: the top role's FIRST TWO bullets plus the first line of the summary must together carry the JD's top requirements. A reader sees these first and infers fit in seconds. Do NOT open every resume with the same favorite story regardless of role; let the JD decide what leads. If the highest relevance evidence currently sits in the cover letter or a later role, move it up into the top role's opening bullets. `auditResume(resume, jdText)` enforces this (the center of gravity gate and the unbacked skills gate); fix every flag before rendering.
8. **Respect stated minimums**: if the JD declares a hard minimum the evidence does not meet (a required degree, license, or certification, a years of experience count, a specific named tool), do NOT paper over it with keyword stuffing or an inflated summary. Name the honest adjacency and move on. `lib/rank.js` records unmet stated minimums as `posting.minimumsUnmet`; a role with several is a reach, not a strong match, no matter how well the resume reads.

When the evidence shows something a JD needs that has no library phrasing, write the bullet fresh from the source you read, then add a `${WORKSPACE}/data/bullet-library.json` entry (`id`, `keywords[]`, `text`, optional `archetypes[]`) afterward so it is reusable. Never invent evidence at generation time; if neither a source nor the evidence file supports a claim, name the honest gap instead.

**Worked example (the standard), two unrelated fields:**
- A "Care Coordination" JD, candidate a hospital nurse. WRONG (keyword shuffle): the current role leads with "Administered medications for a 28 bed unit" because both texts say "patients". RIGHT (reframed): it leads with the discharge teaching redesign, worded as "coordinated transition planning across nursing, pharmacy, and case management", with the same real figure it always had.
- A "Tax Process and Controls" JD, candidate a tax accountant. WRONG: leads with "Prepared 140 returns per season". RIGHT: leads with the standard workpaper index and review checklist the team adopted, worded as "designed the review control that raised first pass acceptance". Same true facts, reframed to the role.

**Before rendering, verify JD vocabulary coverage:** the role's top keywords (from the brief) should appear across the summary + bullets. If they do not, the resume is not tailored. Reframe again.

**Resume quality gate (REQUIRED before render, always WITH the JD).** Run the audit and fix every issue, then run it again until it is clean:
```bash
node -e "const fs=require('fs');const {auditResume}=require('./lib/tailor');const [json,jd]=process.argv.slice(1);const a=auditResume(JSON.parse(fs.readFileSync(json,'utf8')),fs.readFileSync(jd,'utf8'));console.log(JSON.stringify(a,null,2));process.exit(a.ok?0:1)" "${REPORT_DIR}/resume-{date}-${SLUG}.json" "${REPORT_DIR}/jd.txt"
```
It checks field agnostic signals: (a) **required sections present** (education, experience, contact; a hand edited JSON can silently drop one and the render skips it without complaint); (b) **attribution**: `experience[0].company` is the first entry of the user's baseline, the order is reverse chronological, and the baseline degree is present and unaltered; (c) **metric density is a BAND (0.8 to 2.5 numbers per bullet)**: too thin reads unsubstantiated, but a number in every clause is a documented machine written tell, so prefer fewer numbers, each attached to a method, and leave at least one bullet with no number (a resume of 8 or more bullets in which every bullet carries one is flagged); (d) **bullet style**: result first, at most 45 words (at most 2 deep method bullets to about 65), varied openers (never more than 40% starting with the same word), no line counts, local addresses, paper ids, or "about X" hedges; (e) a **`whyCompany`** that is present, 120+ characters, not a placeholder, and anchored to something concrete about the company: it must name, by its proper name, a program, unit, service, regulation, product, publication, or award of the employer, or give a figure, or quote a phrase in double quotes. The employer's name alone and lowercase generic nouns (product, platform, mission) do not count, and the resume fails the audit under `--strict`; (f) **summary length** (35 to 80 words), at most 4 selected projects, and no duplicate skills. With the JD it also gates **JD fit mechanically** (all from JD extracted terms, no field vocabulary in code): **coverage** (the JD's top terms appear across summary + bullets + skills), **requirement to bullet mapping** (each top term is carried by a real bullet or project, not just the summary), **center of gravity** (summary line 1 + the top role's first two bullets carry at least 2 of the JD's top 4 terms), and **unbacked skills** (a JD term living only in the skills block, with no bullet evidence, is flagged). The library function itself never blocks; this instruction and the `--strict` render are what make fixing every flag mandatory.

**Depth gate (REQUIRED before render).** Every major body of work the resume names must state its MECHANISM or method (how it was done), not only its scale or its outcome. And lead with what the candidate built or ran at the deepest layer the JD asks about (the method, the program, the system itself), not only the applications on top of it. Run it and fix until it exits 0:
```bash
node scripts/check-evidence-depth.js --resume "${REPORT_DIR}/resume-{date}-${SLUG}.json"
```
It is driven by the user's `${WORKSPACE}/data/evidence-depth.json`; with that file absent or empty it has nothing to check and exits 0 (note that it was skipped).

**Then apply the rest of the Block E rules:**

**CRITICAL RULES**:
- NEVER put an internal name in any rendered field: no term from `output.forbiddenTerms` in `data/profile.json`, nothing under "What not to use in output" in the profile (internal project names, client names tied to a method, anything under NDA). Describe the work by function: "discharge teaching program for cardiac patients", not the nickname the team used. When you write a bullet FRESH from a source, check it against that list before rendering; the library was cleaned once, freshly written bullets were not. The render refuses a document that contains a forbidden term.
- Every bullet must go DEEP into what was actually done, not just name the work. Reframe library evidence into the JD's language while PRESERVING its depth and its specific figures; do not flatten it into generic phrasing, and do not leave it in its default framing either.
- Bullets are result first and readable: lead with the outcome, keep most bullets concise, and vary the opening word across the resume. Go deep on method where it differentiates, but do NOT put a number in every clause. Over quantification and uniform sentence openers are documented machine generated tells.
- Use the specific details from the evidence you read: methods, parameters, volumes, decisions. Read the source; do not approximate from a bullet.
- No positioning vocabulary ("Talebian", "barbell", "antifragile", "emergence", "inversion", and the rest of the list in _shared.md) in any output. The render refuses the unambiguous ones.
- **Attribution check before rendering**: experience is reverse chronological; `experience[0].company` equals the first entry of the user's baseline; every bullet under an `experience[i]` entry traces to real work for that employer. Side project or consultancy work belongs in its own experience entry or in `selectedProjects`, NEVER mixed into a different employer's bullets. See `_shared.md` Evidence Sourcing, Attribution Rules.
- **Cover letter must include**: (1) one measurable outcome, (2) one leadership or scope signal, (3) one decision the work drove. See `_shared.md` Cover Letter Quality Bar.
- Never set `pageBreakBefore` on an experience entry unless the user asks for it.

Generate the tailored resume following ALL rules from _shared.md:
- ATS format rules (single column, Calibri, no more than two rendered pages or the user's page target, 70%+ keyword match)
- Content rules (XYZ formula, quantified impact where real, JD exact phrasing, no buzzwords)
- Positioning decisions from Block C (what to lead with, what to cut, how to frame gaps) and the role posture from Block C.4
- Archetype from Block A (if configured) is a hint about where to look first; under General, lead with the evidence that best answers the JD
- Narrative Alignment Standard from _shared.md: the summary, lead bullets, projects, and cover letter must tell one coherent JD specific story from supported evidence
- No em dashes, en dashes, smart quotes or other typographic punctuation; letters of the language the document is written in are kept (_shared.md ATS Format Rules, rule 10)

Generate the cover letter following the Cover Letter Rules in _shared.md (the narrative form when the user has a career narrative, the achievement form otherwise; that section is the single source of truth for length and structure), the Reasoning First rules, AND these Content Differentiation Rules:
- Cover letter, "Why Company?", and custom question answers must use GENUINELY DIFFERENT evidence
- If the cover letter discusses one body of work, "Why X?" must NOT also discuss it
- "Why X?" should reference specific company details, not rehash the resume
- Custom questions go deep on ONE narrow topic not covered elsewhere
- Check what was already written for other fields before generating each one
- Every substantive claim must answer: "Why this approach, not the obvious alternative?"

---

## Block F: STAR+R Story Mapping

Read `${WORKSPACE}/data/story-bank.md`. For each JD requirement, find matching stories.

Output a mapping matrix:
| JD Requirement | Best Story | Fit | Metric to Cite |
|---|---|---|---|
| (core requirement from the JD) | (your strongest matching story) | Strong | (the number that proves it) |
| (secondary requirement) | (supporting story) | Partial | (metric or scope) |

For requirements with no Strong match, suggest talking points from the evidence file.
Append any new STAR+R stories discovered during this evaluation to `${WORKSPACE}/data/story-bank.md`.

---

## Block G: Posting Legitimacy Check

Check:
- Posting age (from JD metadata; on an ATS use the ORIGINAL publish date, not a refresh or repost date)
- Apply button status (if URL accessible)
- Reposting patterns (same role posted multiple times)
- Recent layoff news at the company (WebSearch)

Classify: **High Confidence** / **Proceed with Caution** / **Suspicious**
NEVER default to Suspicious without specific evidence.

---

## Output: Save and Deliver

`REPORT_DIR` and `SLUG` were set at the top of Block E (`${WORKSPACE}/reports/queue/{slug}/` for a new evaluation; lifecycle order: verify, evaluate, queue, manual, applied or skipped, archive).

Save files:
1. JD text: `${REPORT_DIR}/jd.txt` (already written in Block E)
2. Resume markdown: `${REPORT_DIR}/resume-{date}-${SLUG}.md`
3. Resume JSON (for the DOCX renderer): `${REPORT_DIR}/resume-{date}-${SLUG}.json`. Its top level carries `company` (the audit keeps the employer's name out of the JD keywords it checks), `role`, `postingUrl`, and `location` (the posting's location as listed; it goes on the queue row).
4. Cover letter (in the JSON's `coverLetter` field)
5. Companion analysis: `${REPORT_DIR}/analysis-{date}-${SLUG}.md` (scores, gaps, keyword gap report, STAR mapping, comp intel, legitimacy)

Generate DOCX with the gates blocking:
```bash
cd "${JOBE_HOME}"
node scripts/render-docx.js --strict "${REPORT_DIR}/resume-{date}-${SLUG}.json"
node scripts/render-cover-letter.js --strict "${REPORT_DIR}/resume-{date}-${SLUG}.json"
```
A line marked FATAL names a forbidden term or a positioning word: rewrite that passage by function and render again. Any other failure is the audit, the depth gate, or the cover letter bar: fix the content, never drop `--strict` to get a file. For a letter not written in English the cover letter bar checks only a figure, a length of at least 100 words, and that the employer is named; the leadership and decision elements are not checked mechanically, so verify them by hand.

Verify the rendered pages (the rendered page is authoritative, not a word count). Requires LibreOffice + poppler; degrades to a warning if absent:
```bash
node scripts/check-docx-pages.js "${REPORT_DIR}/resume-{date}-${SLUG}.docx" --min-fill 0.85
```
The page ceiling comes from `output.targetPages` in `data/profile.json` (pass `--max N` to override). When the user has no page target, drop `--min-fill` so only the two page ceiling applies. Feed its `{ pages, lastPageFill }` back into `auditResume(resume, jdText, { pageMetrics })`, which reads the same target, to gate the half empty last page defect. If it flags too few pages or a short last page, add role relevant, evidence backed content and render again. A render that spills by a few lines can set `"layout": "compact"` in the JSON instead of cutting content.

Optional PDF (renders the exact DOCX you reviewed and checks that its text is selectable):
```bash
node scripts/docx-to-pdf.js "${REPORT_DIR}/resume-{date}-${SLUG}.docx" --name Firstname_Lastname_Company_Role
```

Update tracker and queue through the unified writer (safe to run twice for the same slug):

```bash
cd "${JOBE_HOME}"
node -e "
const fs = require('fs'), path = require('path');
const [reportDir, slug, date] = process.argv.slice(1);
const { upsertTrackerRow, pushQueueEntry } = require('./lib/tracker-writer');
const { loadBaseline, saveBaseline, assessTailoring } = require('./lib/tailoring');
const root = require('./lib/config').getProjectRoot();
const rel = path.relative(root, reportDir).split(path.sep).join('/');   // e.g. reports/queue/<slug>
const resumeJson = JSON.parse(fs.readFileSync(path.join(reportDir, 'resume-' + date + '-' + slug + '.json'), 'utf8'));

// With no baseline on file, the first successful generation becomes the
// baseline against which tailoring depth is measured.
if (!loadBaseline()) saveBaseline(resumeJson);

const assessment = assessTailoring(resumeJson);
upsertTrackerRow({
  date,
  company: resumeJson.company,
  role: resumeJson.role,
  score: resumeJson.matchScore,
  status: 'Evaluated',
  reportDir: rel + '/',
  notes: resumeJson.archetype + ' - tailoring=' + assessment.depth + ' (summary=' + assessment.summaryChanged + ', bullets=' + assessment.bulletDiffCount + ')',
}, slug);
pushQueueEntry({
  slug,
  company: resumeJson.company,
  role: resumeJson.role,
  archetype: resumeJson.archetype,
  score: resumeJson.matchScore,
  primaryUrl: resumeJson.postingUrl,
  location: resumeJson.location || '',   // the posting's location: lets history tell two cities apart
  reportDir: rel + '/',
  resumeDocx: rel + '/resume-' + date + '-' + slug + '.docx',
  coverLetterDocx: rel + '/cover-letter-' + date + '-' + slug + '.docx',
  alternativeUrls: [],
  applied: false,
  tailoringDepth: assessment.depth,
});
" "${REPORT_DIR}" "${SLUG}" "{date}"
```

Paths in the tracker and the queue are stored relative to the workspace, which is what `moveReportFolder` rewrites when the folder later changes bucket.

Tell user: resume content, file locations, match score, keyword match rate, top 3 differentiators, legitimacy assessment, critical gaps + mitigation, and any stated minimum the candidate does not meet.

### Orphan Detection

After saving files, scan for orphaned reports. `reports/` is bucketed (`reports/{queue,manual,verify,evaluate,applied,skipped}/{slug}/`), so list the slug folders one level down and skip the buckets that hold no job folders (`audit`, `archive`, `sample`):
```bash
ls -d "${WORKSPACE}"/reports/*/*/ 2>/dev/null | grep -Ev '/reports/(audit|archive|sample)/|/archive/$' | xargs -n1 basename | sort -u
```

Compare report slugs against tracker entries. If any reports exist that are NOT in the tracker, warn the user:
```
WARNING: Found {n} orphaned report(s) not in tracker:
  - {slug-1}
  - {slug-2}
Add to tracker? (yes/no)
```
If yes, add entries with status "Evaluated" and score from the report JSON.
