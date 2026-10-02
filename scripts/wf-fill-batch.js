export const meta = {
  name: 'jobe-fill-batch',
  description: 'Re-tailor each resume to a DENSE, SPECIFIC render that fills the page target: gate on rendered pages + last-page fill (NOT word count), de-vague every thin section, then recruiter-lens + fabrication verify',
  phases: [
    { title: 'Fill', detail: 'one agent per resume: de-vague + fill to the page target, iterate against the page-fill gate, re-render' },
    { title: 'Verify', detail: 'recruiter-lens read + fabrication/figure check + re-run the page-fill + audit gates, fix in place' },
  ],
}

// RUNTIME: this is a script for the Claude Code Workflow tool, not a Node
// module. It relies on the injected globals args, agent(), pipeline(), log()
// and on a top level await and return, so `node` cannot run or --check it.
// On a host without the Workflow tool, run the same gate chain by hand
// (modes/evaluate.md Block E).
//
// It cannot read files. Every fact about the candidate reaches the agents
// through files they are told to read in the user's workspace.
//
// The rendered page is authoritative, not the word count. The gate chain needs
// LibreOffice (soffice) and poppler (pdfinfo, pdftotext) on the machine.
//
// args (one object; a JSON string of it is accepted):
//   root       absolute path of the jobe install (JOBE_HOME). Required.
//   workspace  absolute path of the active user workspace. Required.
//   user       optional workspace slug; node commands become JOBE_USER=<slug> node ...
//   maxPages   page target; pass output.targetPages from data/profile.json.
//              Default 2 (filling to a page target is what this workflow is for).
//   minFill    least fraction of the last page that must be covered. Default 0.85.
//   exemplar   optional ABSOLUTE path of a resume JSON the user already accepted,
//              read by the agents as the shape to match.
//   ledger     optional evidence file path relative to the workspace
//              (evidence.ledger in data/profile.json; default reference.md).
//   items      [{ slug, company, role, jsonPath, dir }] with ABSOLUTE jsonPath
//              and dir (the report folder, holding jd.txt).

let input = args
if (typeof input === 'string') { try { input = JSON.parse(input) } catch (e) { input = null } }
if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('args must be an object: { root, workspace, items: [...] }')
const { root, workspace, user } = input
const items = input.items
for (const [k, v] of Object.entries({ root, workspace })) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`args.${k} is required (an absolute path)`)
}
if (!Array.isArray(items)) throw new Error('args.items must be an array')
const bad = items.filter((it) => !it || !it.slug || !it.dir || !it.jsonPath)
if (bad.length) throw new Error(`${bad.length} item(s) lack slug, dir, or jsonPath (absolute paths)`)
const maxPages = Number(input.maxPages) > 0 ? Math.round(Number(input.maxPages)) : 2
const minFill = Number(input.minFill) > 0 && Number(input.minFill) <= 1 ? Number(input.minFill) : 0.85
const pagesWord = `${maxPages} page${maxPages === 1 ? '' : 's'}`
log(`Filling ${items.length} resumes to a dense, specific, full ${pagesWord} render (page-authoritative)`)

const NODE = user ? `JOBE_USER=${user} node` : 'node'
const LEDGER = input.ledger
  ? `${workspace}/${input.ledger}`
  : `the evidence file named by evidence.ledger in ${workspace}/data/profile.json (default ${workspace}/reference.md)`
const docxOf = (it) => it.jsonPath.replace(/\.json$/, '.docx')

const FILL_SCHEMA = {
  type: 'object',
  required: ['slug', 'pages', 'lastPageFill', 'auditOk'],
  properties: {
    slug: { type: 'string' },
    pages: { type: 'number' },
    lastPageFill: { type: 'number', description: 'fraction of the last page filled with content (0-1), as measured by the page checker' },
    auditOk: { type: 'boolean' },
    devagued: { type: 'array', items: { type: 'string' }, description: 'thin/vague sections rewritten specific' },
    projectCount: { type: 'number' },
    remaining: { type: 'string', description: 'one line: any issue not resolved' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['slug', 'verdict', 'pages', 'lastPageFill', 'sellsIn7Seconds', 'gatesPass', 'noFabrication'],
  properties: {
    slug: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'pass-with-fixes', 'fail'] },
    pages: { type: 'number' },
    lastPageFill: { type: 'number' },
    sellsIn7Seconds: { type: 'boolean', description: 'summary line 1 + top two bullets convince a recruiter scanning for 7 seconds for THIS role' },
    gatesPass: { type: 'boolean' },
    noFabrication: { type: 'boolean', description: 'no invented client, employer outcome, money figure, or metric anywhere; every figure traces to the evidence file or the verified figures in _profile.md' },
    remainingConcern: { type: 'string' },
  },
}

const standard = (it) => `
WORKING DIRECTORY: ${root} (cd there first; every node command below runs from it).
THE CANDIDATE'S WORKSPACE: ${workspace}

THE CANDIDATE'S OWN FILES are the only source of facts, and their rules override any habit of yours:
- ${workspace}/_profile.md : who the candidate is, and the sections "Standing rules", "Attribution rules", "Verified figures", "Known corrections", "What not to use in output". A section that is absent adds no rule.
- ${workspace}/data/profile.json : output.forbiddenTerms, evidence.attribution.
- ${workspace}/data/resume-baseline.json : the resume JSON schema, the experience entries and their order, stated skills.
- ${LEDGER} : the candidate's detailed evidence and real figures.
- ${workspace}/data/bullet-library.json : the tagged bullet pool to draw additional evidence from.

THE TARGET IS A FULL ${pagesWord.toUpperCase()} RENDER, NOT A WORD COUNT. The two defects this pass removes are a half-empty last page and vague thin sections.${input.exemplar ? ` The shape to match is a resume the candidate already accepted: ${input.exemplar} . READ IT FIRST; render it and page-check it if unsure.` : ''}

WHAT "FULL AND SPECIFIC" MEANS (fix all that apply):
- PAGE FILL: exactly ${pagesWord} rendered, with the last page filled to at least ${minFill} (measured, below). A half-empty last page is THE defect. Fill it with the candidate's JD-relevant, evidence-backed experience: more bullets on the entries that have documented evidence, a second bullet on the thin entries, and, only when the candidate has them, up to 4 real projects from selectedProjects in the bullet library or baseline, all drawn from the bullet library and the evidence file. Never pad with fluff; fill with SPECIFIC evidence. If it spills past ${pagesWord}, trim the least relevant content (or set "layout": "compact" in the JSON when it spills by only a few lines).
- DE-VAGUE EVERY THIN SECTION. A bullet that is a bare list of tools or a hand-wave is vague. Every bullet is outcome-first: what changed in the world, then the measure, then the method. State what each PROJECT actually IS in plain terms before its substance. No phrase repeated three times, no first-person "I built" inside a project summary.
- THIN ENTRIES: for any experience entry whose outcomes are not documented in the evidence file, describe the real work concretely (what was done, what was owned, with what) and NEVER invent clients, money, or metrics for it. Two honest bullets each is the fill target.
- KEEP THE JD CENTERING. The current top bullets were chosen for THIS role; keep them leading and ADD more JD-relevant evidence below them. Do not re-center onto favorite bullets.
- SUMMARY: 45 to 80 words, plain claims only, using the JD's top vocabulary where honest.
- PROJECTS: only the candidate's real selectedProjects (bullet library and baseline). Use up to 4 of the most JD-relevant, each 45 to 65 words, each stating what it IS, then its substance. If the candidate has fewer, use what exists; if none, leave selectedProjects empty and fill the page with experience evidence. Never turn work done in a job into a project.
- SKILLS: 3 to 4 compact categories, JD-relevant ordering, ZERO duplicate tokens across categories. Stated skills in the baseline are authoritative: surface the JD-relevant ones, never strip one.
- LAYOUT: never set pageBreakBefore on an experience entry (it leaves a mid-page gap); delete it if present.
- COVER LETTER: keep it; trim it to its word range if it runs over.

CORRECTIONS AND FORBIDDEN TERMS (hard): apply every item under "Known corrections" in _profile.md to any occurrence, in whatever wording. Money and scale figures come only from the evidence file or "Verified figures". No term from output.forbiddenTerms and nothing under "What not to use in output" in any rendered field: describe that work by function. ATS-clean: no < > [ ] { } backslash double-quote; no em-dash, en-dash, smart quote, or other typographic punctuation; letters of the language the document is written in are kept.

DETERMINISTIC GATES (run ALL; ALL must pass before you finish; the PAGE CHECK IS AUTHORITATIVE):
  ${NODE} scripts/render-docx.js "${it.jsonPath}"
  ${NODE} scripts/render-cover-letter.js "${it.jsonPath}"
  export P=$(${NODE} scripts/check-docx-pages.js "${docxOf(it)}" --max ${maxPages} --min-fill ${minFill} --required); echo "$P"
  ${NODE} -e "const {auditResume}=require('./lib/tailor');const fs=require('fs');const pm=JSON.parse(process.env.P);const a=auditResume(JSON.parse(fs.readFileSync('${it.jsonPath}','utf8')),fs.readFileSync('${it.dir}/jd.txt','utf8'),{pageMetrics:pm,targetPages:${maxPages}});console.log(JSON.stringify({pageOk:pm.ok,pages:pm.pages,fill:pm.lastPageFill,auditOk:a.ok,issues:a.issues}));process.exit(pm.ok&&a.ok?0:1)" 2>&1
A render line marked FATAL names a forbidden term or positioning word to replace. Iterate (add or sharpen JD-relevant evidence, or trim if it spills) until pageOk (pages == ${maxPages} and fill >= ${minFill}) AND auditOk are both true.`

const results = await pipeline(
  items,
  (it) => agent(
    `You are re-tailoring one resume to a DENSE, SPECIFIC, FULL ${pagesWord} render.

POSTING: ${it.company} - ${it.role}. FILE: ${it.jsonPath} (dir ${it.dir}).
READ FIRST: the candidate's files listed in the standard below, then ${it.jsonPath}, then ${it.dir}/jd.txt.

The resume likely renders with a half-empty last page and vague thin sections (tool lists, generic projects). FIX both: fill the last page to at least ${minFill} with the candidate's JD-relevant, evidence-backed experience and de-vague every bullet, WITHOUT losing the JD centering and WITHOUT inventing any client, money figure, or metric.
${standard(it)}

Edit ${it.jsonPath} in place. Return the structured result with REAL measured numbers (pages + fill from the page checker, auditOk from the audit).`,
    { label: `fill:${it.slug}`, phase: 'Fill', schema: FILL_SCHEMA }
  ),
  (f, it) => agent(
    `You are a skeptical RECRUITER + fact-checker for a resume for ${it.company} - ${it.role}. Read ${it.dir}/jd.txt, then ${it.jsonPath}.

TEST 1 (7-second scan): summary line 1 + the top entry's first two bullets: would you keep reading for THIS role? If generic, a pile of method names with no outcome, or off-role, FIX in place.
TEST 2 (fabrication): confirm NO invented client names, money figures, or metrics anywhere (an entry with no documented outcomes must read as honest real work, with no fabricated results); confirm every figure traces to the evidence file or "Verified figures"; confirm every item under "Known corrections" is respected. Fix any violation.
TEST 3 (full + specific): render again and page-check: pages == ${maxPages} and last-page fill >= ${minFill}; no vague tool-list bullets; every project present is specific and states what it IS (at most 4; zero is correct when the candidate has no selectedProjects, never add one that is not in the library or baseline). Fix in place.
${standard(it)}
After ANY edit re-run ALL gates. The fill agent reported pages=${f ? f.pages : '?'} fill=${f ? f.lastPageFill : '?'}. Do not trust it; measure again. Return the structured verdict.`,
    { label: `verify:${it.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA }
  )
)

const clean = results.filter(Boolean)
const pass = clean.filter(r => r.verdict !== 'fail')
const thin = clean.filter(r => typeof r.lastPageFill === 'number' && r.lastPageFill < minFill)
const fab = clean.filter(r => r.noFabrication === false)
log(`Filled+verified ${clean.length}/${items.length}: ${pass.length} pass, ${thin.length} still-thin(<${minFill} fill), ${fab.length} fabrication-flag`)
return {
  total: items.length, verified: clean.length, pass: pass.length,
  stillThin: thin.map(r => ({ slug: r.slug, fill: r.lastPageFill })),
  fabricationFlags: fab.map(r => r.slug),
  fail: clean.filter(r => r.verdict === 'fail').map(r => ({ slug: r.slug, concern: r.remainingConcern })),
}
