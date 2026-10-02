export const meta = {
  name: 'jobe-bullets-from-evidence',
  description: 'Convert each project evidence file into resume-ready, function-described, tagged bullets (no forbidden terms) for the right role key. Feeds the bullet library so resumes can draw on the full, distinct depth of the evidence.',
  phases: [
    { title: 'Bullets', detail: 'one agent per evidence file: read it, write 4-8 function-described tagged bullets to a JSON fragment' },
  ],
}

// RUNTIME: this is a script for the Claude Code Workflow tool, not a Node
// module. It relies on the injected globals args, agent(), pipeline(), log()
// and on a top level await and return, so `node` cannot run or --check it.
// On a host without the Workflow tool, write the bullets by hand with the same
// rules (modes/onboard.md).
//
// It cannot read files. Every fact about the candidate reaches the agents
// through files they are told to read in the user's workspace.
//
// AFTER IT RETURNS the caller merges the fragments into
// <workspace>/data/bullet-library.json: append each bullet under its role key,
// dedup by id, then run scripts/check-evidence-coverage.js and
// scripts/check-evidence-depth.js. This script does not touch the library.
//
// args (one object; a JSON string of it is accepted):
//   root        absolute path of the jobe install (JOBE_HOME). Required.
//   workspace   absolute path of the active user workspace. Required.
//   user        optional workspace slug; node commands become JOBE_USER=<slug> node ...
//   archetypes  optional list of the user's archetype names (the keys of their
//               archetype taxonomy). Empty or absent: bullets get archetypes [].
//   items       [{ name, role, evidenceFile, fragmentFile }] with ABSOLUTE
//               evidenceFile and fragmentFile. role is a role key of the
//               user's bullet library (a value of its companyKeyMap) or
//               "selectedProjects" for a personal project.

let input = args
if (typeof input === 'string') { try { input = JSON.parse(input) } catch (e) { input = null } }
if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('args must be an object: { root, workspace, items: [...] }')
const { root, workspace, user } = input
const items = input.items
for (const [k, v] of Object.entries({ root, workspace })) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`args.${k} is required (an absolute path)`)
}
if (!Array.isArray(items)) throw new Error('args.items must be an array')
const bad = items.filter((it) => !it || !it.name || !it.role || !it.evidenceFile || !it.fragmentFile)
if (bad.length) throw new Error(`${bad.length} item(s) lack name, role, evidenceFile, or fragmentFile (absolute paths)`)
log(`Generating bullets from ${items.length} evidence files`)

const NODE = user ? `JOBE_USER=${user} node` : 'node'
const archetypes = (Array.isArray(input.archetypes) ? input.archetypes : []).filter((a) => typeof a === 'string' && a.trim())
const ARCHETYPE_RULE = archetypes.length
  ? `a subset of: ${archetypes.join(', ')}`
  : 'always an empty list (the candidate has no archetype taxonomy)'

const SCHEMA = {
  type: 'object',
  required: ['name', 'bulletsWritten', 'fragmentFile'],
  properties: {
    name: { type: 'string' },
    bulletsWritten: { type: 'number' },
    fragmentFile: { type: 'string' },
    sampleBullet: { type: 'string' },
    forbiddenTermLeaked: { type: 'boolean', description: 'true if a forbidden term remains in the fragment (should always be false)' },
  },
}

const results = await pipeline(
  items,
  (it) => agent(
    `Convert ONE project's deep-evidence file into resume-ready bullets. cd ${root} first; every node command below runs from it.

EVIDENCE FILE: ${it.evidenceFile}
PROJECT: ${it.name}  |  ROLE KEY: ${it.role}  (a role key of ${workspace}/data/bullet-library.json: its companyKeyMap maps each employer to one; "selectedProjects" means a personal project, not a job)

READ FIRST: ${workspace}/_profile.md (who the candidate is, target roles, and the sections "What not to use in output", "Attribution rules", "Verified figures", "Known corrections"), ${workspace}/data/profile.json (output.forbiddenTerms), and a few existing entries of ${workspace}/data/bullet-library.json for the bullet shape. Then read the evidence file fully.

Write 4 to 8 DISTINCT, resume-ready bullets capturing THIS project's strongest, most specific achievements. They feed a bullet library that is selected and reframed per job, so make them concrete and reusable.

HARD RULES:
1. DESCRIBE BY FUNCTION: no term from output.forbiddenTerms and nothing listed under "What not to use in output" may appear in the bullet text or keywords. Say what the thing does, for whom, at what scale. Such names live ONLY in the evidence file, never in a rendered resume.
2. REAL FIGURES ONLY: use the specific numbers, methods, parameters, and scale from the evidence file. Never invent one. If the evidence marks a number as inferred or unverified, do not state it as fact. Respect every item under "Known corrections".
3. RESULT-FIRST: lead with the outcome or what was built, then the measure, then the method. At most 45 words each (up to 2 method bullets near 65). Varied openers. A number only in the strongest bullets (over-quantification reads machine written).
4. ATS-CLEAN: no < > [ ] { } backslash or double-quote; no em-dash, en-dash, smart quote, or other typographic punctuation; letters of the language the document is written in are kept. Hyphens inside compound words are fine.
5. Each bullet is DISTINCT from the others (this project's unique contributions) and distinct from the generic bullets anyone in the field could write.
6. At least one bullet names HOW the work was done (the method, technique, protocol, or process), not only its size or outcome.

For EACH bullet output an object:
  { "id": "<short-project-slug>-<n>", "text": "<bullet>", "role": "${it.role}", "archetypes": [${ARCHETYPE_RULE}], "keywords": [8 to 15 lowercase terms a job description in the candidate's field would use and this bullet genuinely supports], "studyGroup": "<optional: one shared tag when two bullets describe the same underlying work, so the selector never picks both>" }

WRITE a JSON array of these objects to: ${it.fragmentFile}

THEN CHECK the fragment against the forbidden list:
  ${NODE} -e "const {scanCodenames}=require('./lib/tailor');const hits=scanCodenames(require('fs').readFileSync('${it.fragmentFile}','utf8'));console.log(JSON.stringify(hits));process.exit(hits.length?1:0)"
Any term it prints must be rewritten by function; re-run until it prints []. Confirm the file parses as JSON.

Return the count + one sample bullet. forbiddenTermLeaked must be false.`,
    { label: `bullets:${it.name}`, phase: 'Bullets', schema: SCHEMA }
  )
)

const clean = results.filter(Boolean)
const total = clean.reduce((n, r) => n + (r.bulletsWritten || 0), 0)
const leaked = clean.filter(r => r.forbiddenTermLeaked)
log(`Wrote ${total} bullets across ${clean.length} projects; ${leaked.length} reported forbidden-term leaks`)
return {
  projects: clean.length,
  totalBullets: total,
  leaks: leaked.map(r => r.name),
  perProject: clean.map(r => ({ name: r.name, n: r.bulletsWritten, file: r.fragmentFile })),
}
