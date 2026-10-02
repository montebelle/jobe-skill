export const meta = {
  name: 'jobe-compress-batch',
  description: 'Bring each resume to the dense word-band standard (short summary, most bullets on the most recent entry, up to 3 projects, a total word band), apply the known corrections, pass the deterministic gates, then recruiter-lens verify. Superseded by jobe-fill-batch, which gates on the rendered page.',
  phases: [
    { title: 'Compress', detail: 'one agent per resume: reshape + correct to the standard, run all gates, re-render' },
    { title: 'Verify', detail: 'recruiter-lens read + re-run gates, fix in place' },
  ],
}

// RUNTIME: this is a script for the Claude Code Workflow tool, not a Node
// module. It relies on the injected globals args, agent(), pipeline(), log()
// and on a top level await and return, so `node` cannot run or --check it.
//
// SUPERSEDED: scripts/wf-fill-batch.js does the same job with the rendered page
// as the authority (page count AND last-page fill). This one steers by a word
// band and checks only the page ceiling. Prefer the fill workflow; this script
// is kept for a host where the page-fill measurement (pdftotext) is missing.
//
// It cannot read files. Every fact about the candidate reaches the agents
// through files they are told to read in the user's workspace.
//
// args (one object; a JSON string of it is accepted):
//   root       absolute path of the jobe install (JOBE_HOME). Required.
//   workspace  absolute path of the active user workspace. Required.
//   user       optional workspace slug; node commands become JOBE_USER=<slug> node ...
//   maxPages   page ceiling; pass output.targetPages from data/profile.json. Default 2.
//   wordBand   optional { min, max } total words as counted by auditResume.
//              Default { min: 640, max: 870 }, which fills two pages; scale it
//              down for a one page target.
//   exemplar   optional ABSOLUTE path of a resume JSON the user already accepted.
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
const band = input.wordBand && Number(input.wordBand.min) > 0 && Number(input.wordBand.max) > Number(input.wordBand.min)
  ? { min: Number(input.wordBand.min), max: Number(input.wordBand.max) }
  : { min: 640, max: 870 }
const pagesWord = `${maxPages} page${maxPages === 1 ? '' : 's'}`
log(`Bringing ${items.length} resumes to the ${band.min}-${band.max} word, ${pagesWord} standard`)

const NODE = user ? `JOBE_USER=${user} node` : 'node'
const LEDGER = input.ledger
  ? `${workspace}/${input.ledger}`
  : `the evidence file named by evidence.ledger in ${workspace}/data/profile.json (default ${workspace}/reference.md)`
const docxOf = (it) => it.jsonPath.replace(/\.json$/, '.docx')

const COMPRESS_SCHEMA = {
  type: 'object',
  required: ['slug', 'words', 'summaryWords', 'pages', 'auditOk', 'centeringPreserved'],
  properties: {
    slug: { type: 'string' },
    words: { type: 'number' },
    summaryWords: { type: 'number' },
    pages: { type: 'number' },
    auditOk: { type: 'boolean' },
    centeringPreserved: { type: 'boolean', description: 'the JD-specific lead evidence survived the reshaping' },
    factsCorrected: { type: 'array', items: { type: 'string' } },
    cut: { type: 'string', description: 'one line: what was cut or added' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['slug', 'verdict', 'sellsIn7Seconds', 'gatesPass'],
  properties: {
    slug: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'pass-with-fixes', 'fail'] },
    sellsIn7Seconds: { type: 'boolean', description: 'summary line 1 + top two bullets convince a recruiter scanning for 7 seconds' },
    gatesPass: { type: 'boolean' },
    remainingConcern: { type: 'string' },
  },
}

const standard = (it) => `
WORKING DIRECTORY: ${root} (cd there first; every node command below runs from it).
THE CANDIDATE'S WORKSPACE: ${workspace}

THE CANDIDATE'S OWN FILES are the only source of facts, and their rules override any habit of yours:
- ${workspace}/_profile.md : who the candidate is, and the sections "Standing rules", "Attribution rules", "Verified figures", "Known corrections", "What not to use in output". A section that is absent adds no rule.
- ${workspace}/data/profile.json : output.forbiddenTerms, evidence.attribution.
- ${workspace}/data/resume-baseline.json : the resume JSON schema, the experience entries and their order, defaultBulletCounts, stated skills.
- ${LEDGER} : the candidate's detailed evidence and real figures.
- ${workspace}/data/bullet-library.json : the tagged bullet pool to draw additional evidence from.

THE STANDARD:${input.exemplar ? ` (the shape to match is a resume the candidate already accepted: ${input.exemplar} ; read it first)` : ''}
- GOAL: a DENSE resume that fills ${pagesWord} and never exceeds them. A resume that leaves large gaps of dead space is as wrong as one that spills over: FILL it by adding the candidate's JD-relevant, evidence-backed experience, or trim the least relevant content, until it fits.
- SUMMARY: 45 to 65 words. Plain claims only. A span of years may be attached only to something that really covers the whole span, and no claim the evidence does not support.
- EXPERIENCE SHAPE: the most recent entry carries the most bullets (5 to 6), then fewer for each older entry (about 3, 2, 1); follow defaultBulletCounts in the baseline when it is set. KEEP THE EXISTING JD-SPECIFIC CENTERING: the current top bullets were chosen for THIS role; keep them leading and add or remove evidence below them, do not re-center. Pull additional bullets from the bullet library and the evidence file that fit THIS JD. Every bullet outcome-first: what changed in the world, then the measure, then the method. At most 45 words (at most 2 method bullets near 60). Varied openers.
- PROJECTS: up to 3 of the candidate's real selectedProjects, each 45 to 60 words, the most JD-relevant; none when the candidate has none. No line counts, no literature citations, no inventories of parts.
- SKILLS: 3 to 4 compact categories, JD-relevant ordering, ZERO duplicate tokens (one skill appears at most once anywhere). Stated skills in the baseline are authoritative: do not strip real skills, only leave out the low-relevance ones for THIS role.
- TOTAL: ${band.min} to ${band.max} words as counted by auditResume. The page check is the hard ceiling: never exceed ${pagesWord} rendered.
- NEVER set pageBreakBefore on any experience entry (it creates a mid-page gap); delete it if present.
- COVER LETTER: keep it, but trim it to 250 to 350 words if it runs over (the narrative form may run longer when the candidate's narrative file exists).

CORRECTIONS AND FORBIDDEN TERMS (hard): apply every item under "Known corrections" in _profile.md to any occurrence, in whatever wording. Money and scale figures come only from the evidence file or "Verified figures"; never invent one. No term from output.forbiddenTerms and nothing under "What not to use in output" in any rendered field: describe that work by function. ATS-clean: no < > [ ] { } backslash double-quote, no em-dash, en-dash, smart quote, or other typographic punctuation; letters of the language the document is written in are kept.

DETERMINISTIC GATES (run ALL; ALL must pass before you finish):
a) ${NODE} -e "const {auditResume}=require('./lib/tailor');const fs=require('fs');const a=auditResume(JSON.parse(fs.readFileSync('${it.jsonPath}','utf8')),fs.readFileSync('${it.dir}/jd.txt','utf8'));console.log(JSON.stringify(a));process.exit(a.ok?0:1)"
b) ${NODE} scripts/render-docx.js "${it.jsonPath}"  AND  ${NODE} scripts/render-cover-letter.js "${it.jsonPath}"
c) ${NODE} scripts/check-docx-pages.js "${docxOf(it)}" --max ${maxPages}
A render line marked FATAL names a forbidden term or positioning word to replace. If any gate fails, fix and re-run until all three pass.`

const results = await pipeline(
  items,
  (it) => agent(
    `You are bringing one tailored resume to the candidate's standard shape.

POSTING: ${it.company} - ${it.role}. FILE: ${it.jsonPath} (dir ${it.dir}).
READ FIRST: the candidate's files listed in the standard below, then ${it.jsonPath}, then ${it.dir}/jd.txt.

Measure the resume first (run gate a for the word count, then gates b and c for the pages). If it is under the word band or leaves large empty gaps, FILL it WITHOUT losing the JD-specific centering: keep the existing lead bullets and ADD more of the candidate's JD-relevant, evidence-backed experience from the bullet library and the evidence file. If it is over the band or spills past ${pagesWord}, cut the least relevant content. Apply every known correction, remove any pageBreakBefore, and pass every gate.
${standard(it)}

Edit ${it.jsonPath} in place. Return the structured result with real measured numbers (words from the audit output, pages from the page checker).`,
    { label: `compress:${it.slug}`, phase: 'Compress', schema: COMPRESS_SCHEMA }
  ),
  (c, it) => agent(
    `You are a RECRUITER doing a 7-second scan, then a skeptical full read, of a resume for ${it.company} - ${it.role}. Read ${it.dir}/jd.txt, then ${it.jsonPath}.

TEST 1 (7 seconds): summary line 1 + the top entry's first two bullets. Would you keep reading for THIS role? If they read generic, a pile of method names with no outcome, or off-role, FIX in place.
TEST 2 (skeptical read): any claim that overstates (an unsupported responsibility, an inflated count, a figure attached to the wrong body of work per the known corrections), any bullet that is an inventory rather than an achievement, dense project paragraphs, duplicate skills, a summary over 65 words. FIX in place.
${standard(it)}
After ANY edit re-run all gates (audit, render both documents, page check). The first agent reported: words=${c ? c.words : '?'} summary=${c ? c.summaryWords : '?'} pages=${c ? c.pages : '?'}. Do not trust it; verify again. Return the structured verdict.`,
    { label: `verify:${it.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA }
  )
)

const clean = results.filter(Boolean)
const pass = clean.filter(r => r.verdict !== 'fail')
const notSell = clean.filter(r => r.sellsIn7Seconds === false)
log(`Compressed+verified ${clean.length}/${items.length}: ${pass.length} pass, ${notSell.length} still-not-selling`)
return {
  total: items.length, verified: clean.length, pass: pass.length,
  fail: clean.filter(r => r.verdict === 'fail').map(r => ({ slug: r.slug, concern: r.remainingConcern })),
  stillNotSelling: notSell.map(r => r.slug),
}
