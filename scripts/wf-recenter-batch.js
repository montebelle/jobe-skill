export const meta = {
  name: 'jobe-recenter-batch',
  description: 'Re-center each already-generated resume so it SELLS the candidate to THAT specific role: lead with the evidence the role asks for, outcome-measure-method bullets, demote off-target lead evidence, then adversarially verify on the sells-to-role dimension (not just keywords)',
  phases: [
    { title: 'Recenter', detail: 'one agent per resume: judge center of gravity + sells-to-role, rewrite lead + bullets, demote off-target evidence, render, self-audit' },
    { title: 'Verify', detail: 'adversarial hiring-manager check: does the top third convince me the candidate can do THIS job? fix in place' },
  ],
}

// RUNTIME: this is a script for the Claude Code Workflow tool, not a Node
// module. It relies on the injected globals args, agent(), pipeline(), log()
// and on a top level await and return, so `node` cannot run or --check it.
// On a host without the Workflow tool, apply the same checks by hand through
// modes/evaluate.md Block E.
//
// It cannot read files. Every fact about the candidate reaches the agents
// through files they are told to read in the user's workspace.
//
// Why it exists: a resume can pass every keyword gate and still lead with
// evidence from the wrong domain for the role.
//
// args (one object; a JSON string of it is accepted):
//   root       absolute path of the jobe install (JOBE_HOME). Required.
//   workspace  absolute path of the active user workspace. Required.
//   user       optional workspace slug; node commands become JOBE_USER=<slug> node ...
//   date       YYYY-MM-DD; needed only for items that carry no jsonPath
//              (the file is then <dir>/resume-<date>-<slug>.json).
//   ledger     optional evidence file path relative to the workspace
//              (evidence.ledger in data/profile.json; default reference.md).
//   items      [{ slug, company, role, archetype, dir, jsonPath? }] with
//              ABSOLUTE dir (the report folder, holding jd.txt and
//              _genctx.json) and, when given, ABSOLUTE jsonPath.

let input = args
if (typeof input === 'string') { try { input = JSON.parse(input) } catch (e) { input = null } }
if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('args must be an object: { root, workspace, items: [...] }')
const { root, workspace, user, date } = input
const items = input.items
for (const [k, v] of Object.entries({ root, workspace })) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`args.${k} is required (an absolute path)`)
}
if (!Array.isArray(items)) throw new Error('args.items must be an array')
const jsonOf = (it) => it.jsonPath || `${it.dir}/resume-${date}-${it.slug}.json`
const bad = items.filter((it) => !it || !it.slug || !it.dir || (!it.jsonPath && !date))
if (bad.length) throw new Error(`${bad.length} item(s) lack slug, dir, or a resume path (give jsonPath per item, or args.date)`)
log(`Re-centering ${items.length} resumes`)

const NODE = user ? `JOBE_USER=${user} node` : 'node'
const LEDGER = input.ledger
  ? `${workspace}/${input.ledger}`
  : `the evidence file named by evidence.ledger in ${workspace}/data/profile.json (default ${workspace}/reference.md)`
const auditCmd = (it) => `${NODE} -e "const {auditResume}=require('./lib/tailor'); const fs=require('fs'); const a=auditResume(JSON.parse(fs.readFileSync('${jsonOf(it)}','utf8')), fs.readFileSync('${it.dir}/jd.txt','utf8')); console.log(JSON.stringify(a)); process.exit(a.ok?0:1)"`
const renderCmds = (it) => `${NODE} scripts/render-docx.js "${jsonOf(it)}"  and  ${NODE} scripts/render-cover-letter.js "${jsonOf(it)}"`

const RECENTER_SCHEMA = {
  type: 'object',
  required: ['slug', 'wasMiscentered', 'centeredOk', 'auditOk', 'leadEvidence'],
  properties: {
    slug: { type: 'string' },
    wasMiscentered: { type: 'boolean', description: 'true if the resume as received led with off-target evidence (framing from a different domain than the role) or did not convey the candidate\'s experience to THIS role' },
    centeredOk: { type: 'boolean', description: 'true if after your edits the summary + the top entry\'s first two bullets lead with the evidence THIS JD asks for' },
    auditOk: { type: 'boolean' },
    leadEvidence: { type: 'string', description: 'one line: what the resume now LEADS with for this role' },
    cutOrDemoted: { type: 'string', description: 'what off-target evidence you cut or demoted from the lead (or "none")' },
    metricDensity: { type: 'number' },
    keywordCoverage: { type: 'number' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['slug', 'verdict', 'sellsToRole', 'centerOfGravityOk', 'xyzStructure', 'atsClean', 'attributionOk', 'auditOk'],
  properties: {
    slug: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'pass-with-fixes', 'fail'] },
    sellsToRole: { type: 'boolean', description: 'as the hiring manager for THIS role, does the top third convince you the candidate can do THIS job' },
    centerOfGravityOk: { type: 'boolean' },
    xyzStructure: { type: 'boolean', description: 'bullets are achievement-first: outcome + measure + method' },
    atsClean: { type: 'boolean' },
    attributionOk: { type: 'boolean' },
    auditOk: { type: 'boolean' },
    remainingConcern: { type: 'string' },
  },
}

const CORE = `
WORKING DIRECTORY: ${root} (cd there first; every node command below runs from it).
THE CANDIDATE'S WORKSPACE: ${workspace}

THE CANDIDATE'S OWN FILES are the only source of facts, and their rules override any habit of yours:
- ${workspace}/_profile.md : who the candidate is, target roles, and the sections "Standing rules", "Attribution rules", "Role posture leads", "Verified figures", "Known corrections", "What not to use in output". A section that is absent adds no rule.
- ${workspace}/data/profile.json : output.forbiddenTerms, evidence.attribution, evidence.narrative.
- ${workspace}/data/resume-baseline.json : the resume JSON schema, the experience entries and their order, stated skills.
- ${LEDGER} : the candidate's detailed evidence and real figures.

THE ONE THING THAT MATTERS: the resume must SELL the candidate's experience to THIS specific role. A hiring manager reading the summary + the top entry's first two bullets must immediately see "this person can do THIS job", not "this is someone from another domain whose evidence I have to squint at to map onto my role." Passing keyword gates is NOT the bar; conveying fit is.

CENTER OF GRAVITY (hard): infer the role's CORE mandate from jd.txt (not just its keywords), then make the summary's first sentence and the TOP experience entry's first two bullets LEAD with the candidate's evidence that answers that mandate, reframed into the role's own context and vocabulary. Two examples of correct centering, from unrelated fields:
- a role whose mandate is patient safety and audit -> LEAD with incident review, audit design, and protocol change evidence, not with general ward throughput.
- a role whose mandate is resolving disputed filings -> LEAD with notices resolved, positions defended, and the research method, not with routine return volume.
When the target role sits outside the candidate's home domain, describe the work by FUNCTION (what was built, run, measured, or decided) rather than by its home-domain subject matter.

CUT OR DEMOTE off-target lead evidence: if a lead bullet is a pure home-domain outcome and the role is not in that domain, move it out of the top position or drop it for a bullet that answers the JD. Keep it only if it is genuinely the best evidence for THIS role.

OUTCOME / MEASURE / METHOD BULLET STRUCTURE (every bullet): the achievement first, then the measure, then how it was done ("Accomplished X, as measured by Y, by doing Z"). Result-first, at most about 45 words (up to 2 method bullets near 65), varied openers, a number only in the strongest bullets (over-quantification reads machine written). Preserve REAL figures from the existing resume and the evidence file; never invent one. Money and scale figures come only from the evidence file or "Verified figures"; anything under "Known corrections" is banned.

COVER LETTER (resume.coverLetter): if the narrative file named by evidence.narrative (default ${workspace}/data/career-narrative.md) exists and holds real content, keep the chronological career story form, framed toward this role. Otherwise 3 paragraphs, 250 to 350 words: P1 an achievement that maps to the role + why this company and role. P2 ONE story mapped to the JD's top requirement showing the REASONING (why this approach, what tradeoff, what failure it prevented). P3 value + specific enthusiasm + availability. Either form MUST contain a specific measurable outcome, a leadership or scope signal, and a decision-grade outcome. No buzzwords; the reasoning frameworks used to plan positioning never appear as words; no typographic punctuation.

whyCompany: 120 or more characters, anchored to ONE specific company product, technology, metric, or regulation, named by its proper name or with a figure, role-specific, DIFFERENT evidence than the cover letter.

HARD RULES: ATS-clean (no < > [ ] { } backslash double-quote; no em-dash, en-dash, smart quote, or other typographic punctuation; letters of the language the document is written in are kept). No term from output.forbiddenTerms and nothing listed under "What not to use in output" in any rendered field: describe that work by function. Attribution: the experience entries, order, employers, titles, and dates equal the resume baseline; the first entry leads with real work from that role; every bullet stays under the employer or project its evidence belongs to; project work appears only under selectedProjects. Honest gaps are positioned as adjacency, never as fabricated experience.
`

const gates = (it) => `
AUDIT: run  ${auditCmd(it)}  and fix until it prints ok true (it enforces lead evidence against the JD's top terms, requirement to bullet mapping, the metric density band 0.8 to 2.5, and coverage). Then RENDER both documents:  ${renderCmds(it)}  . A line marked FATAL names a forbidden term or positioning word to replace.`

const results = await pipeline(
  items,
  (it) => agent(
    `You are RE-CENTERING one already-generated resume so it genuinely sells the candidate's experience to THIS role. It currently passes keyword gates but may lead with off-target framing.

POSTING: ${it.company} - ${it.role} (archetype "${it.archetype}"). Slug: ${it.slug}. Dir: ${it.dir}.
JSON: ${jsonOf(it)}

READ: ${it.dir}/jd.txt (the role: infer its CORE mandate), the current resume JSON (what it leads with now), ${it.dir}/_genctx.json when present (briefKeywords, evidenceByRole, pools), and the candidate's files listed below.

DO: judge whether the resume as written LEADS with the evidence THIS role needs. If it leads with off-target framing (home-domain outcomes for a role outside that domain, the wrong kind of evidence up top, a generic summary), RE-CENTER it: rewrite the summary's first sentence to lead with the role's core, reorder + reframe the experience so the top entry's first two bullets answer the JD's core mandate in outcome / measure / method form, cut or demote off-target lead bullets, rewrite the cover letter and whyCompany. Preserve real figures; keep the baseline schema keys exactly.
${CORE}${gates(it)}

Then self-audit, fix until ok, render both documents, and return the structured result (wasMiscentered honestly reflects what you found).`,
    { label: `recenter:${it.slug}`, phase: 'Recenter', schema: RECENTER_SCHEMA }
  ),
  (rc, it) => agent(
    `You are the ADVERSARIAL HIRING-MANAGER VERIFIER for ${it.company} - ${it.role}. You ARE the hiring manager for THIS role. Read ${it.dir}/jd.txt, then ${jsonOf(it)}. Default to skeptical.

THE TEST: reading ONLY the summary + the top experience entry's first two bullets, are you convinced this person can do THIS job? If it reads as someone from a different domain whose evidence you must work to map onto your role, that is a FAIL: fix it in place.

CHECK + FIX IN PLACE (edit the JSON), then verify again:
1. SELLS TO ROLE / CENTER OF GRAVITY: the summary's first sentence + the top entry's first two bullets lead with the evidence THIS JD asks for, in the role's vocabulary. If not, re-center (rules below).
2. STRUCTURE: every bullet is achievement-first (outcome + measure + method), at most about 45 words (at most 2 method bullets near 65), varied openers, no over-quantification.
3. No off-target lead bullet (a home-domain outcome leading a role outside that domain) unless it is genuinely the best evidence.
4. ATTRIBUTION: experience entries, order, employers, titles, and dates equal the resume baseline; the first entry leads with real work from that role; project work only under selectedProjects.
5. NO forbidden term anywhere (output.forbiddenTerms, "What not to use in output"). ATS-clean (no < > [ ] { } backslash double-quote, no em-dash, en-dash, smart quote, or other typographic punctuation; letters of the language the document is written in are kept).
6. COVER LETTER in the required form with a measurable outcome + a leadership or scope signal + a decision-grade outcome; whyCompany anchored + 120 or more characters + different evidence.
7. AUDIT GATE: the audit command below must print ok true.
${CORE}${gates(it)}
If you fixed anything, RENDER both documents again. The recenter agent reported wasMiscentered=${rc ? rc.wasMiscentered : 'n/a'}, centeredOk=${rc ? rc.centeredOk : 'n/a'}. Do not trust it; verify again. Return the verdict ('pass' if no fix was needed, 'pass-with-fixes' if you fixed and it now sells, 'fail' only if it cannot be made to convey fit honestly, for example a genuine deep gap).`,
    { label: `verify:${it.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA }
  )
)

const clean = results.filter(Boolean)
const pass = clean.filter(r => r.verdict !== 'fail')
const fails = clean.filter(r => r.verdict === 'fail')
const notSell = clean.filter(r => r.sellsToRole === false)
log(`Re-centered ${clean.length}/${items.length}: ${pass.length} pass, ${fails.length} fail, ${notSell.length} still-not-selling`)
return {
  total: items.length,
  verified: clean.length,
  pass: pass.length,
  fail: fails.length,
  failedSlugs: fails.map(r => ({ slug: r.slug, concern: r.remainingConcern })),
  stillNotSelling: notSell.map(r => r.slug),
  results: clean.map(r => ({ slug: r.slug, verdict: r.verdict, sellsToRole: r.sellsToRole, concern: r.remainingConcern })),
}
