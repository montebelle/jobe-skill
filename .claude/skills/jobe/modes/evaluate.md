# Evaluate Mode

Generate a tailored resume + cover letter for a specific job posting using A-G block evaluation.

## Input
The user provided: `$ARGUMENTS` (a URL, company+role, or pasted JD text)

## Step 0: Parse Input
- **URL**: Fetch the job posting. Proceed to Block A.
- **Company + role**: WebSearch for the posting. If found, use URL. Otherwise, proceed with what you have.
- **Pasted text**: Parse directly.
- **Empty**: Ask what role to evaluate.

Detect install location:
```bash
if [ -f collectors/pipeline.js ]; then JOBE_HOME=".";
elif [ -f "${HOME}/.jobe/collectors/pipeline.js" ]; then JOBE_HOME="${HOME}/.jobe";
else JOBE_HOME=""; fi
```

---

## Block A: Role Summary

1. **Detect archetype** from JD keywords (see _shared.md Archetype Detection table)
2. Output:
   - Archetype: [AI Platform / Agentic / Applied ML / Causal / ML Infra / Forward Deployed]
   - Domain: [adtech, fintech, healthcare, CPG, etc.]
   - Seniority: [junior / mid / senior / staff / principal]
   - Remote: [remote / hybrid / onsite]
   - Estimated team size: [from JD clues]
   - Compensation band: [from JD or estimate]

---

## Block B: Portfolio Match

Launch up to 3 agents IN PARALLEL:
- **jobe-jd-analyzer**: Extract full requirements taxonomy, ATS keywords, priority classification
- **jobe-company-intel**: Research company tech stack, culture, news, team. **Cache check first**: if `reports/{company-slug}/company-intel-{date}.json` exists and is < 14 days old, reuse it instead of spawning the agent. Save fresh intel to that path when the agent finishes.
- **jobe-competitor**: Profile competitor pool for this role at this company tier

**Partial-result handling**: run agents via Promise.allSettled semantics. If any agent fails or rejects, flag the corresponding subsection of Block C with `⚠ {agent-id} failed; block incomplete` rather than silently proceeding. Do NOT fabricate content for missing sections.

Company research is handled by `jobe-company-intel` agent (above) and cached.
See `reports/{slug}/company-intel-{date}.json`; reuse entries under 14 days old.
Salary data is fetched per-URL via `lib/enrich.js` compensation extractor.

Read `reference.md` for portfolio evidence. For EVERY JD requirement:
1. Search portfolio evidence by domain keywords
2. Classify: Exact / Strong Adjacency / Weak Adjacency / Gap
3. Cite specific repo paths for exact matches
4. Compute weighted scores per category
5. Compute overall match percentage
6. List gaps with mitigation strategies

---

## Block C: Level Detection + Positioning

1. Apply **gate-pass check** (Required Skills >= 50%, Experience >= 0.7). If either fails, present breakdown and ask user whether to proceed or skip.
2. Apply all 6 **Talebian lenses** to determine positioning strategy:
   - Which bullets are antifragile vs fragile?
   - Which skills are antifragile (gain value as field shifts)?
   - What asymmetric bet to include?
   - What would make them NOT hire the candidate? Pre-empt.
   - What's the barbell split (70% safe, 30% bold)?
   - What's the emergence narrative for the Summary?
3. Identify top 3 differentiators from competitor framework

---

## Block D: Compensation Research

Use salary collector data + jobe-company-intel findings + WebSearch if needed.
Report: estimated base, total comp, equity, level calibration, negotiation leverage.

---

## Block E: Resume + Cover Letter Generation

**Step 0 (REQUIRED — Build experience + selectedProjects via bullet-select):**

Use `lib/bullet-select.js` `buildExperience()` and `pickProjects()` to select per-JD bullets and projects from `data/bullet-library.json`. Do NOT hand-author bullets and do NOT reorder a fixed pool — that produces resumes interchangeable in body content.

```js
const { buildExperience, pickProjects } = require('./lib/bullet-select');
const baseline = require('./data/resume-baseline.json');
const spec = {
  archetype: '<from Block A archetype detection>',
  jdText: '<raw JD text from this posting>',
  bulletCounts: { current: 4, prior1: 2, prior2: 2, prior3: 1 }, // keys must match your bullet-library role-keys
  pinBullets: [],     // optional must-include bullet IDs
  excludeBullets: []  // optional skip IDs
};
resume.experience = buildExperience(baseline, spec);
resume.selectedProjects = pickProjects(spec, 2);
```

If the bullet library lacks evidence for a JD-specific archetype need, ADD a new entry to `data/bullet-library.json` (with `id`, `archetypes[]`, `keywords[]`, `text`) before generating the resume. Never invent evidence at resume-generation time.

**Then apply the rest of the Block E rules:**

**CRITICAL RULES**:
- NEVER use your internal project names in generated output. Describe by function: "autonomous ML operations platform", "competitive intelligence system", "outfit recommendation platform". (The bullet library should already enforce this in its text content.)
- Every bullet must go DEEP into what was technically built, not just name-drop. The bullet library should be pre-written to this depth; do not paraphrase it down.
- Use the DEEP technical details from your portfolio evidence. Specific algorithms, parameter values, architectural decisions — use them.
- No "Talebian", "barbell", "antifragile", "emergence", or "inversion" in any output.
- **Attribution check before rendering**: every bullet under an `experience[i]` entry must trace to a real artifact under that employer. Side-project / consultancy work belongs in its own experience entry or in `selectedProjects`, NEVER mixed into a different employer's bullets. See `_shared.md` Bullet Selection > Attribution Rules.
- **Cover letter must include**: (1) one specific dollar amount or measurable business outcome, (2) one leadership/scope signal, (3) one decision-grade outcome. See `_shared.md` Cover Letter Quality Bar.

Generate the tailored resume following ALL rules from _shared.md:
- ATS format rules (single column, Calibri, 475-600 words, 70%+ keyword match)
- Content rules (XYZ formula, quantified impact, JD exact phrasing, no buzzwords)
- Talebian lens decisions from Block C (what to lead with, what to cut, how to frame gaps)
- Archetype from Block A drives which portfolio domains to emphasize
- No em-dashes, en-dashes, smart quotes, or Unicode

Generate the cover letter following cover letter rules, Reasoning-First rules from _shared.md, AND Content Differentiation Rules:
- Cover letter, "Why Company?", and custom question answers must use GENUINELY DIFFERENT evidence
- If cover letter discusses safety enforcement, "Why X?" must NOT also discuss it
- "Why X?" should reference specific company details, not rehash the resume
- Custom questions go deep on ONE narrow topic not covered elsewhere
- Check what was already written for other fields before generating each one

Follow cover letter rules from _shared.md:
- 3 paragraphs, 250-350 words
- P1: Achievement first, company connection second, role third
- P2: 1-2 achievements mapped to top JD requirements -- but show the REASONING behind design decisions, not just the outcome. Why was it designed this way? What tradeoff was navigated? What failure mode was prevented?
- P3: Value + enthusiasm for specific team + availability
- Every technical claim must answer: "Why this design, not the obvious alternative?"

---

## Block F: STAR+R Story Mapping

Read `data/story-bank.md`. For each JD requirement, find matching stories.

Output a mapping matrix:
| JD Requirement | Best Story | Fit | Metric to Cite |
|---|---|---|---|
| Production ML systems | 13-Model Forecasting | Strong | 700+ paths, 24h turnaround |
| Safety / guardrails | Output Gate | Strong | Zero incidents across 28 pipelines |
| Causal inference | GeoLift 5-Gate | Strong | MDE 7.5% at 80% power |

For requirements with no Strong match, suggest talking points from portfolio evidence.
Append any new STAR+R stories discovered during this evaluation to `data/story-bank.md`.

---

## Block G: Posting Legitimacy Check

Check:
- Posting age (from JD metadata, ATS updated_at field)
- Apply button status (if URL accessible)
- Reposting patterns (same role posted multiple times)
- Recent layoff news at the company (WebSearch)

Classify: **High Confidence** / **Proceed with Caution** / **Suspicious**
NEVER default to Suspicious without specific evidence.

---

## Output: Save and Deliver

Determine output directory:
```bash
JOBE_HOME="${HOME}/.jobe"; [ -d reports ] && JOBE_HOME="."
REPORT_DIR="${JOBE_HOME}/reports/{company-slug}-{role-slug}"
mkdir -p "${REPORT_DIR}"
```

Save files:
1. Resume markdown: `{REPORT_DIR}/resume-{date}-{slug}.md`
2. Resume JSON (for DOCX renderer): `{REPORT_DIR}/resume-{date}-{slug}.json`
3. Cover letter (in JSON's coverLetter field)
4. Companion analysis: `{REPORT_DIR}/analysis-{date}-{slug}.md` (scores, gaps, keyword gap report, STAR mapping, comp intel, legitimacy)

Generate DOCX:
```bash
JOBE_HOME="${HOME}/.jobe"; [ -f scripts/render-docx.js ] && JOBE_HOME="."
cd "${JOBE_HOME}"
node scripts/render-docx.js "{REPORT_DIR}/resume-{date}-{slug}.json"
node scripts/render-cover-letter.js "{REPORT_DIR}/resume-{date}-{slug}.json"
```

Update tracker via unified writer:

```bash
node -e "
const { appendTrackerRow, pushQueueEntry } = require('./lib/tracker-writer');
const { saveBaseline, assessTailoring } = require('./lib/tailoring');
const resumeJson = require('./{REPORT_DIR}/resume-{date}-{slug}.json');

// First successful generation becomes the baseline against which tailoring depth is measured.
const fs = require('fs');
if (!fs.existsSync('data/resume-baseline.json')) saveBaseline(resumeJson);

const assessment = assessTailoring(resumeJson);
appendTrackerRow({
  date: '{date}',
  company: resumeJson.company,
  role: resumeJson.role,
  score: resumeJson.matchScore,
  status: 'Evaluated',
  reportDir: '{REPORT_DIR}/',
  notes: resumeJson.archetype + ' - tailoring=' + assessment.depth + ' (summary=' + assessment.summaryChanged + ', bullets=' + assessment.bulletDiffCount + ')',
});
pushQueueEntry({
  slug: '{slug}',
  company: resumeJson.company,
  role: resumeJson.role,
  archetype: resumeJson.archetype,
  score: resumeJson.matchScore,
  primaryUrl: resumeJson.postingUrl,
  resumeDocx: '{REPORT_DIR}/resume-{date}-{slug}.docx',
  coverLetterDocx: '{REPORT_DIR}/cover-letter-{date}-{slug}.docx',
  alternativeUrls: [],
  applied: false,
  tailoringDepth: assessment.depth,
});
"
```

Tell user: resume content, file locations, match score, keyword match rate, top 3 differentiators, legitimacy assessment, critical gaps + mitigation.

### Orphan Detection

After saving files, scan for orphaned reports:
```bash
ls ${JOBE_HOME}/reports/ 2>/dev/null
```

Compare report slugs against tracker entries. If any reports exist that are NOT in the tracker, warn the user:
```
WARNING: Found {n} orphaned report(s) not in tracker:
  - {slug-1}
  - {slug-2}
Add to tracker? (yes/no)
```
If yes, add entries with status "Evaluated" and score from the report JSON.
