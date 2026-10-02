export const meta = {
  name: 'jobe-generate-batch',
  description: 'Generate a tailored resume + cover letter JSON for each posting from its candidate pool, then adversarially verify and fix attribution, role posture, method depth, forbidden terms, ATS characters, and cover letter quality',
  phases: [
    { title: 'Generate', detail: 'one agent per posting: JD-grounded reframe -> resume JSON, self-audit' },
    { title: 'Verify', detail: 'adversarial check of attribution, tailoring depth, role posture, method depth, forbidden terms, cover letter bar, ATS characters; fix in place' },
  ],
}

// RUNTIME: this is a script for the Claude Code Workflow tool, not a Node
// module. It relies on the injected globals args, agent(), pipeline(), log()
// and on a top level await and return, so `node` cannot run or --check it.
// On a host without the Workflow tool, follow the sequential path in
// modes/batch.md instead.
//
// It cannot read files. Every fact about the candidate reaches the agents
// through files they are told to read in the user's workspace; nothing about
// any person is written in this script.
//
// args (one object; a JSON string of it is accepted):
//   root       absolute path of the jobe install (JOBE_HOME). Required.
//   workspace  absolute path of the active user workspace
//              (node scripts/user.js current --path). Required.
//   user       optional workspace slug; when set every node command is run as
//              JOBE_USER=<slug> node ... so each agent resolves that workspace.
//   date       YYYY-MM-DD used in the output file name and the resume date
//              field. Required (a workflow has no clock).
//   ledger     optional evidence file path relative to the workspace
//              (evidence.ledger in data/profile.json; default reference.md).
//   items      [{ slug, company, role, score, archetype, dir, url }] where dir
//              is the ABSOLUTE report folder that already holds _genctx.json,
//              jd.txt, and the candidate pool. scripts/bulk-resume-from-list.js
//              --json prints exactly this array.

let input = args
if (typeof input === 'string') { try { input = JSON.parse(input) } catch (e) { input = null } }
if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('args must be an object: { root, workspace, date, items: [...] }')
const { root, workspace, user, date } = input
const items = input.items
for (const [k, v] of Object.entries({ root, workspace, date })) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`args.${k} is required (root and workspace are absolute paths, date is YYYY-MM-DD)`)
}
if (!Array.isArray(items)) throw new Error('args.items must be an array')
const bad = items.filter((it) => !it || !it.slug || !it.dir)
if (bad.length) throw new Error(`${bad.length} item(s) lack slug or dir (dir is the absolute report folder)`)
log(`Generating ${items.length} resume packages`)

const NODE = user ? `JOBE_USER=${user} node` : 'node'
const LEDGER = input.ledger
  ? `${workspace}/${input.ledger}`
  : `the evidence file named by evidence.ledger in ${workspace}/data/profile.json (default ${workspace}/reference.md)`
const jsonOf = (it) => `${it.dir}/resume-${date}-${it.slug}.json`
const auditCmd = (it) => `${NODE} -e "const {auditResume}=require('./lib/tailor'); const fs=require('fs'); const a=auditResume(JSON.parse(fs.readFileSync('${jsonOf(it)}','utf8')), fs.readFileSync('${it.dir}/jd.txt','utf8')); console.log(JSON.stringify(a)); process.exit(a.ok?0:1)"`
const depthCmd = (it) => `${NODE} scripts/check-evidence-depth.js --resume "${jsonOf(it)}"`

const GEN_SCHEMA = {
  type: 'object',
  required: ['slug', 'jsonWritten', 'auditOk', 'metricDensity'],
  properties: {
    slug: { type: 'string' },
    jsonWritten: { type: 'boolean' },
    auditOk: { type: 'boolean' },
    metricDensity: { type: 'number' },
    summaryLine: { type: 'string', description: 'one-line summary of how this resume leads for the role' },
    notes: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['slug', 'verdict', 'finalAuditOk', 'attributionOk', 'postureOk', 'depthOk', 'noForbiddenTerms', 'coverLetterOk', 'atsClean', 'keywordCoverage'],
  properties: {
    slug: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'pass-with-fixes', 'fail'] },
    finalAuditOk: { type: 'boolean' },
    attributionOk: { type: 'boolean', description: 'experience entries, order, employers, titles, and dates equal the resume baseline; the first entry leads with real work from that role; every bullet sits under the employer or project its evidence belongs to; project work appears only under selectedProjects' },
    postureOk: { type: 'boolean', description: 'summary + first two bullets match the role posture the title and JD signal (people leader / senior specialist or technical lead / individual contributor); not defaulted to individual contributor voice when the role signals leadership' },
    depthOk: { type: 'boolean', description: 'scripts/check-evidence-depth.js --resume <path> exits 0: every major body of work the resume names states HOW it was done (method, technique, protocol), not scale or outcome only; and where the candidate built both a platform and the applications on it, the layer the JD asks about leads' },
    noForbiddenTerms: { type: 'boolean', description: 'no term from output.forbiddenTerms or from the What not to use in output section in any rendered field; both strict renders exit 0' },
    coverLetterOk: { type: 'boolean', description: 'has a measurable outcome + a leadership/scope signal + a decision-grade outcome, in the required form' },
    atsClean: { type: 'boolean', description: 'no < > [ ] { } backslash double-quote, no em-dash, en-dash, smart quote or other typographic punctuation (letters of the document language are kept)' },
    keywordCoverage: { type: 'number', description: 'fraction 0-1 of the top JD keywords present across summary+bullets' },
    metricDensity: { type: 'number' },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    topDifferentiator: { type: 'string' },
    gaps: { type: 'string' },
  },
}

const CONTEXT = `
WORKING DIRECTORY: ${root} (cd there first; every node command below runs from it).
THE CANDIDATE'S WORKSPACE: ${workspace}

READ THE CANDIDATE'S OWN FILES FIRST. They are the only source of facts about the candidate, and their rules override any habit of yours:
- ${workspace}/_profile.md : who the candidate is, target roles, and the sections "Standing rules", "Attribution rules", "Role posture leads", "Verified figures", "Known corrections", "What not to use in output". A section that is absent adds no rule.
- ${workspace}/data/profile.json : output.forbiddenTerms (names that must never appear in output), evidence.attribution (which role or project each body of work belongs to), evidence.narrative (the optional cover letter spine).
- ${workspace}/data/resume-baseline.json : the exact resume JSON schema, plus the experience entries, their order, employers, titles, dates, education, and stated skills.
- ${LEDGER} : the candidate's detailed evidence and real figures.
- ${workspace}/data/bullet-library.json : the tagged bullet pool and its companyKeyMap (employer -> role key).
`

const RULES = `
HARD RULES (the resume JSON must obey ALL of them):

ATTRIBUTION (most important):
- The experience entries, their order, employer names, titles, and dates must equal the resume baseline. experience[0] is the baseline's first entry, and its FIRST bullet describes real work done in that role.
- Every bullet stays under the employer or project its evidence belongs to. The sources of truth are companyKeyMap in the bullet library, evidence.attribution in profile.json, and the "Attribution rules" section of _profile.md. Never move a body of work to a different employer to make an entry look stronger: that mislabeling is the worst failure this workflow can produce.
- Work the baseline lists under selectedProjects stays a project. A project never becomes an experience entry, and a job never becomes a project.

FORBIDDEN TERMS (scan every rendered field): no term from output.forbiddenTerms in profile.json and nothing listed under "What not to use in output" in _profile.md may appear anywhere in the output. Describe that work by FUNCTION (what it does, for whom, at what scale). The evidence file may contain such names: never copy them out of it.

ATS-CLEAN (the text is typed raw into forms, so zero tolerance): no < > [ ] { } backslash or double-quote characters; no em-dashes, en-dashes, smart quotes, or other typographic punctuation; letters of the language the document is written in are kept. Use "(64, 8)" not a bracket pair; "at least 3" and "at most 25 percent" not a comparison sign.

ROLE POSTURE (REQUIRED, do NOT default to individual-contributor voice): classify the target from title + JD, then frame the summary + lead bullets to match.
- People leader (Manager / Director / Head of / "manage a team" / "hire" / "mentor" / "grow the team"): summary line 1 and the first bullets carry team size, scope, and outcomes delivered through others.
- Senior specialist or technical lead (Lead, Principal, "set direction" / "influence without direct authority" / "set the standard across teams"): lead with authority and breadth of scope WITHOUT people-management framing: standards set, work adopted by others, reviews owned, direction given.
- Individual contributor (no leadership language): lead with hands-on depth and delivery; keep leadership as a secondary signal.
Use the candidate's evidence for that posture as listed under "Role posture leads" in _profile.md; if that section is absent, choose from the evidence file. This is emphasis, never fabrication: if the candidate has no evidence for the posture, name that under gaps instead of inventing it. Verify the summary + first two bullets match the posture before finishing.

METHOD DEPTH (hard, describe HOW and not only HOW MUCH): every major body of work the resume names must state its actual method (the technique, protocol, process, or design), never only its scale or outcome. "A scheduling system used by 12 clinics" is SCALE and fails; "constraint based shift assignment with a fairness cap" is METHOD and passes. When the library holds both a scale bullet and a method bullet for the same work, SELECT and reframe the method one. If you name a body of work, say how it works. Gate: the depth command below must exit 0.

PLATFORM vs APPLICATION (do not flatten one into the other): when the candidate built both an underlying platform, framework, or programme AND the applications or cases that run on it, those are different achievements. Lead with the layer the JD asks about and name it as such; keep the other as secondary proof.

TAILORING (not a keyword shuffle): REORDER entries' bullets to LEAD with the highest-relevance evidence for THIS JD, and REFRAME each bullet's lead, framing, and terminology into the JD's vocabulary (use _genctx.json briefKeywords) WHILE PRESERVING the real figures and methods. Reordering alone is NOT tailoring. REQUIREMENT MAPPING: the JD's top 5 requirements must EACH map to a specific bullet using the JD's own vocabulary where honest (translating real evidence into the JD's synonym is tailoring; a new claim is fabrication). EVIDENCE-SELECTION GUARD: the TOP entry's first two bullets plus summary line 1 must answer the JD's core mandate. BULLET STYLE: result-first, at most about 45 words (up to 2 method bullets near 65), varied openers, no line counts, no local addresses, no paper ids, no "about" hedges, and a number in the STRONGEST bullets only (over-quantification reads machine written). Write a role-specific summary that mirrors the JD's responsibilities. Pick up to 2 selectedProjects most relevant to the JD from the candidate's own projects (poolProjects and the library's selectedProjects); if there are none, write selectedProjects as an empty list. Name honest gaps from briefGaps: position the adjacency, never claim unsupported experience. Stated skills in the baseline are authoritative: reorder them for the JD, never strip one.

COVER LETTER (resume.coverLetter): if the narrative file named by evidence.narrative in profile.json (default ${workspace}/data/career-narrative.md) exists and holds real content, write the letter as that chronological first person career story, framed toward this role and closing on this company. Otherwise write 3 paragraphs, 250 to 350 words: P1 leads with one achievement of the candidate's, then the company connection, then the role. P2 goes deep on ONE story mapped to the top JD requirement and shows the REASONING (why this approach, what tradeoff, what failure it prevented), not only the outcome. P3 is value, specific enthusiasm for this team or product, and availability. Either form MUST contain: (1) one specific measurable outcome, (2) one leadership or scope signal, (3) one decision-grade outcome. No buzzwords (results-driven, passionate, leveraged). The reasoning frameworks used to plan positioning (barbell, antifragile, via negativa, skin in the game, and the like) must never appear as words. No typographic punctuation.

FIGURES (no invention, ever): money and scale figures come ONLY from the evidence file or the "Verified figures" section of _profile.md. Anything listed under "Known corrections" in _profile.md is banned in every wording. If you are not sure a figure is real, use a non-numeric outcome the evidence supports instead.

whyCompany (resume.whyCompany): 120 or more characters, role-specific, anchored to ONE specific company product, technology, metric, or regulation, named by its proper name or with a figure. It must use DIFFERENT evidence than the cover letter. Not a placeholder.

AUDIT GATE: the JSON must pass the audit command below: metric density band 0.8 to 2.5 per bullet, bullet length and opener checks, whyCompany present + anchored + 120 characters, JD vocabulary coverage of the top JD terms, baseline attribution. Fix and re-run until it prints ok true.
`

const results = await pipeline(
  items,
  // STAGE 1: generate
  (it) => agent(
    `You are generating ONE tailored resume + cover letter JSON for a job application.
${CONTEXT}
POSTING: ${it.company} - ${it.role} (match score ${it.score}, archetype "${it.archetype}").
Slug: ${it.slug}. Report dir: ${it.dir}.

THEN READ, FOR THIS POSTING:
1. ${it.dir}/_genctx.json  -> archetype, briefKeywords (the JD vocabulary to mirror), briefGaps (honest gaps), evidenceByRole (the candidate's evidence ranked against this JD), poolExperience + poolProjects (the candidate bullet POOL from the selector: a starting pool, NOT the final resume).
2. ${it.dir}/jd.txt  -> the real job description. Tailor to THIS.

TASK: Produce the final resume JSON at ${jsonOf(it)}, matching the baseline schema's keys exactly. Fill: name, contact, education from the baseline unchanged; company="${it.company}", role="${it.role}", date="${date}", location=the "location" value of _genctx.json when it has one (the posting's location as listed; it goes on the queue row), a role-specific summary, the reframed experience[] (the baseline's entries in the baseline's order, the first entry leading with real work from that role), up to 2 JD-relevant selectedProjects (an empty list when the candidate has none), skills (keep the baseline's or lightly reorder for the JD), coverLetter, whyCompany, postingUrl="${it.url || ''}", archetype="${it.archetype}", matchScore=${it.score == null ? 'null' : it.score}, compensation (the pay band the JD publishes, as {"min": number, "max": number, "currency": "<three letter code>", "period": "year" | "month" | "hour"}; "" when the JD publishes none).
${RULES}
AUDIT COMMAND:  ${auditCmd(it)}
DEPTH COMMAND:  ${depthCmd(it)}

Then SELF-AUDIT: run the audit command on your file; if it is not ok, fix the bullets or whyCompany and re-run until ok. Run the depth command; it must exit 0. Write valid JSON (confirm it parses). Return the structured result.`,
    { label: `gen:${it.slug}`, phase: 'Generate', schema: GEN_SCHEMA }
  ),
  // STAGE 2: adversarial verify + fix in place
  (gen, it) => agent(
    `You are the ADVERSARIAL VERIFIER for a generated job-application resume JSON. Default to finding problems; only pass a resume that genuinely obeys every rule. Fix issues IN PLACE (edit the JSON), then confirm again.
${CONTEXT}
FILE: ${jsonOf(it)}  (posting: ${it.company} - ${it.role}, archetype "${it.archetype}")
POSTING CONTEXT: read ${it.dir}/_genctx.json (briefKeywords, briefGaps) and ${it.dir}/jd.txt (the JD).

CHECK EVERY ITEM, FIX ANY FAILURE, THEN VERIFY AGAIN:
1. ATTRIBUTION: compare experience[] against the resume baseline: same entries, same order, same employers, titles, and dates. The first entry's first bullet is real work from that role. Every bullet sits under the employer or project its evidence belongs to (companyKeyMap, evidence.attribution, the "Attribution rules" section). A bullet under the wrong employer is a CRITICAL mis-attribution: rewrite it from that employer's real evidence. Project work appears only under selectedProjects.
2. FORBIDDEN TERMS + RENDER GATES: run  ${NODE} scripts/render-docx.js --strict "${jsonOf(it)}"  and  ${NODE} scripts/render-cover-letter.js --strict "${jsonOf(it)}" . A line marked FATAL names a forbidden term or a positioning-vocabulary word: replace it with a description by function and re-run. Also read "What not to use in output" in _profile.md and remove anything it lists that the gate cannot know about. Both commands must exit 0.
3. ATS-CLEAN: no < > [ ] { } backslash or double-quote inside any string value; no em-dash, en-dash, smart quote, or other typographic punctuation; letters of the language the document is written in are kept. Replace each with its plain equivalent.
4. TAILORING DEPTH: compute keyword coverage = the fraction of the _genctx briefKeywords (top 12 or so) that appear across summary + bullets. If the resume reads generic or not reframed to the JD vocabulary (a keyword shuffle that leads with evidence the JD did not ask for), rewrite the lead and framing of the relevant bullets and the summary to speak to THIS role. Preserve real figures.
5. COVER LETTER: the required form (the narrative form when the narrative file exists, else 3 paragraphs of 250 to 350 words); contains a specific measurable outcome AND a leadership or scope signal AND a decision-grade outcome; shows the REASONING; no buzzwords; no typographic punctuation. Fix whatever is missing. For a letter not written in English the cover letter bar checks only a figure, a length of at least 100 words, and that the employer is named; the leadership and decision elements are not checked mechanically, so verify them by hand.
6. whyCompany: 120 or more characters, anchored to a specific company product, technology, metric, or regulation named by its proper name or with a figure, role-specific, different evidence from the cover letter.
7. AUDIT GATE: run  ${auditCmd(it)}  . It must end ok true. If not, fix what each issue names (never by inventing a figure), then re-run until ok.
8. ROLE POSTURE: classify the target from title + JD (people leader / senior specialist or technical lead / individual contributor). Verify summary line 1 + the first two experience bullets MATCH that posture, not a default individual-contributor voice. If they do not, rewrite them using the candidate's real evidence for that posture ("Role posture leads" in _profile.md, else the evidence file). Emphasis, not fabrication.
9. METHOD DEPTH + PLATFORM: run  ${depthCmd(it)}  . It must exit 0. Anything it reports SHALLOW is named at scale or outcome only: select the library's method bullet for it and reframe to state how the work was done. Separately, if the candidate built both a platform and applications on it and the resume leads with the layer the JD did NOT ask about, rewrite the lead. Re-run until exit 0.
10. FIGURES: every money and scale figure traces to the evidence file or "Verified figures"; nothing under "Known corrections" appears in any wording. Remove or correct anything that does not trace.
11. JSON VALIDITY: confirm the file still parses as JSON after your edits.
${RULES}
The generator self-reported: auditOk=${gen ? gen.auditOk : 'n/a'}, density=${gen ? gen.metricDensity : 'n/a'}. Do not trust it; verify again. Return the structured verdict (verdict='pass' if no fixes were needed, 'pass-with-fixes' if you fixed and it now passes, 'fail' only if it cannot be made to pass).`,
    { label: `verify:${it.slug}`, phase: 'Verify', schema: VERIFY_SCHEMA }
  )
)

const clean = results.filter(Boolean)
const pass = clean.filter(r => r.verdict !== 'fail')
const fails = clean.filter(r => r.verdict === 'fail')
const fixed = clean.filter(r => r.verdict === 'pass-with-fixes')
log(`Generated+verified ${clean.length}/${items.length}: ${pass.length} pass (${fixed.length} needed fixes), ${fails.length} fail`)

return {
  total: items.length,
  verified: clean.length,
  pass: pass.length,
  passWithFixes: fixed.length,
  fail: fails.length,
  failedSlugs: fails.map(r => r.slug),
  lowCoverage: clean.filter(r => (r.keywordCoverage || 0) < 0.5).map(r => ({ slug: r.slug, cov: r.keywordCoverage })),
  results: clean,
}
