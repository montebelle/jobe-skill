export const meta = {
  name: 'jobe-evidence-extract',
  description: 'Deep-read EVERY one of the candidate\'s projects or work folders (one agent per project) and extract complete, distinct evidence (what it is, how it works, methods, parameters, scale, results) to an evidence file each. No lumping, no shortcutting.',
  phases: [
    { title: 'Extract', detail: 'one agent per project: deep-read the whole project, write a complete evidence markdown, return a structured summary' },
  ],
}

// RUNTIME: this is a script for the Claude Code Workflow tool, not a Node
// module. It relies on the injected globals args, agent(), pipeline(), log()
// and on a top level await and return, so `node` cannot run or --check it.
// On a host without the Workflow tool, read each project by hand and write the
// same six headings into the evidence file (modes/onboard.md).
//
// It cannot read files. This is the engine that builds a strong evidence file
// (reference.md): the per project outputs are merged into it by the caller.
//
// args (one object; a JSON string of it is accepted):
//   workspace  absolute path of the active user workspace. Required (the
//              agents read _profile.md there to learn who the candidate is).
//   items      [{ name, path, hint, outFile }] with ABSOLUTE path (the project
//              or work folder to read) and ABSOLUTE outFile (the evidence
//              markdown to write, for example under
//              <workspace>/data/evidence/). hint is free text context, may be
//              empty. The folders usually come from evidence.roots in
//              data/profile.json.

let input = args
if (typeof input === 'string') { try { input = JSON.parse(input) } catch (e) { input = null } }
if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('args must be an object: { workspace, items: [...] }')
const { workspace } = input
const items = input.items
if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('args.workspace is required (an absolute path)')
if (!Array.isArray(items)) throw new Error('args.items must be an array')
const bad = items.filter((it) => !it || !it.name || !it.path || !it.outFile)
if (bad.length) throw new Error(`${bad.length} item(s) lack name, path, or outFile (absolute paths)`)
log(`Deep-reading ${items.length} projects`)

const SCHEMA = {
  type: 'object',
  required: ['name', 'oneLiner', 'readDepth', 'evidenceFile'],
  properties: {
    name: { type: 'string' },
    oneLiner: { type: 'string', description: 'what this project IS, specific and distinct' },
    skillsDemonstrated: { type: 'array', items: { type: 'string' }, description: 'concrete resume-relevant skills this project proves, named specifically (the actual method, system, or practice, not a broad category)' },
    keySpecifics: { type: 'array', items: { type: 'string' }, description: '8-20 concrete, verifiable facts: methods, parameter values, structure, scale, results' },
    candidateRole: { type: 'string', description: 'what the candidate did themselves versus reviewed, managed, or inherited' },
    distinctFrom: { type: 'string', description: 'what makes this DIFFERENT from sibling projects (so it never gets lumped)' },
    resumeRoles: { type: 'array', items: { type: 'string' }, description: 'which kinds of roles this evidence is strongest for' },
    readDepth: { type: 'string', enum: ['thorough', 'partial', 'shallow'], description: 'how completely you read it' },
    filesRead: { type: 'number' },
    evidenceFile: { type: 'string' },
  },
}

const results = await pipeline(
  items,
  (it) => agent(
    `You are doing a DEEP, EXHAUSTIVE read of ONE of the candidate's projects or bodies of work to extract complete resume evidence. Read ${workspace}/_profile.md first to learn who the candidate is and what roles they target.

PROJECT: ${it.name}
PATH: ${it.path}
CONTEXT/HINT: ${it.hint || '(none given)'}

DO NOT SHORTCUT. Do not read only the summary page. Walk the folder structure, then READ the actual source material: code, documents, decks, spreadsheets, protocols, plans, notes, whatever the folder holds, and enough of it to describe HOW THE WORK ACTUALLY WORKS. This project is DISTINCT from the candidate's other projects: capture what makes it unique and never lump it with its siblings.

Extract, with specifics grounded in the material (cite the file, and the line or page where useful):
1. WHAT IT IS: one precise sentence.
2. HOW IT WORKS: the real mechanics. Its structure, the flow of work or data through it, who or what does each step, the clever parts. If it is a framework, a programme, or a process that other work runs on, explain its parts and how they fit.
3. SPECIFIC TECHNIQUES: the named methods, standards, protocols, models, formulas, parameter values, thresholds, and safeguards actually used. Be concrete: write the actual name and the actual value, never a category.
4. QUANTIFIED SCALE / RESULTS: counts, sizes, volumes, durations, error or accuracy figures, money. Only what you can verify from the material.
5. THE CANDIDATE'S ROLE: what they did themselves versus reviewed, managed, or inherited.
6. RESUME MAPPING: which kinds of roles this is the strongest evidence for, and the 2 to 3 sharpest bullet-worthy facts.

WRITE a thorough evidence markdown (as long as it needs to be; there is no length limit) to: ${it.outFile}
Structure it with clear headers. This file becomes canonical resume evidence, so be complete and precise, and mark every statement you INFER as inferred, separately from what you VERIFIED in the material. Internal names may appear in this evidence file (it is private); they are removed later, when bullets are written.

Then return the structured summary (skillsDemonstrated + keySpecifics must be specific and distinct, not generic).`,
    { label: `read:${it.name}`, phase: 'Extract', schema: SCHEMA }
  )
)

const clean = results.filter(Boolean)
const thorough = clean.filter(r => r.readDepth === 'thorough')
log(`Deep-read ${clean.length}/${items.length} projects (${thorough.length} thorough)`)
return {
  total: items.length,
  read: clean.length,
  thorough: thorough.length,
  projects: clean.map(r => ({ name: r.name, oneLiner: r.oneLiner, skills: r.skillsDemonstrated, specifics: (r.keySpecifics || []).length, depth: r.readDepth, file: r.evidenceFile })),
}
