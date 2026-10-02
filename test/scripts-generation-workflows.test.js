'use strict';
// The six scripts/wf-*.js files are scripts for the Claude Code Workflow tool,
// not Node modules: `export const meta` first, then a body with a top level
// await and return that uses the injected globals args / agent / pipeline /
// log. `node --check` cannot parse them, so this test compiles each one the
// way the runtime does (meta stripped of its export, body in an async
// function) and runs it against stub globals with synthetic arguments.
//
// It proves three things: each script is valid for that runtime, each takes
// every user specific value from its arguments (workspace paths, page target,
// archetype names) and none from its own text, and each refuses to run without
// the paths it needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const GLOBALS = ['args', 'agent', 'pipeline', 'parallel', 'log', 'phase', 'budget', 'workflow'];

const ROOT = '/opt/jobe-install';
const WS = '/srv/workspaces/synthetic-user';
const DIR = `${WS}/reports/queue/mercy-valley-clinic-charge-nurse`;
const JSON_PATH = `${DIR}/resume-2031-03-04-mercy-valley-clinic-charge-nurse.json`;
const posting = { slug: 'mercy-valley-clinic-charge-nurse', company: 'Mercy Valley Clinic', role: 'Charge Nurse', score: 81, archetype: 'General', dir: DIR, url: 'https://careers.example.org/jobs/1' };

const CASES = {
  'wf-generate-batch.js': {
    args: { root: ROOT, workspace: WS, user: 'synthetic-user', date: '2031-03-04', ledger: 'notes/evidence.md', items: [posting] },
    stages: 2,
    expect: [JSON_PATH, `${WS}/notes/evidence.md`, `${WS}/data/profile.json`, 'JOBE_USER=synthetic-user node scripts/render-docx.js --strict', `${DIR}/jd.txt`],
    required: ['root', 'workspace', 'date'],
  },
  'wf-recenter-batch.js': {
    args: { root: ROOT, workspace: WS, items: [{ ...posting, jsonPath: JSON_PATH }] },
    stages: 2,
    expect: [JSON_PATH, `${WS}/_profile.md`, `node scripts/render-cover-letter.js "${JSON_PATH}"`],
    required: ['root', 'workspace'],
  },
  'wf-fill-batch.js': {
    args: { root: ROOT, workspace: WS, maxPages: 1, minFill: 0.9, exemplar: `${WS}/reports/applied/x/resume.json`, items: [{ ...posting, jsonPath: JSON_PATH }] },
    stages: 2,
    expect: ['--max 1 --min-fill 0.9', 'targetPages:1', 'export P=$(', `${WS}/reports/applied/x/resume.json`, JSON_PATH.replace(/\.json$/, '.docx')],
    required: ['root', 'workspace'],
  },
  'wf-compress-batch.js': {
    args: { root: ROOT, workspace: WS, maxPages: 1, wordBand: { min: 380, max: 520 }, items: [{ ...posting, jsonPath: JSON_PATH }] },
    stages: 2,
    expect: ['380 to 520 words', '--max 1', JSON_PATH],
    required: ['root', 'workspace'],
  },
  'wf-evidence-extract.js': {
    args: { workspace: WS, items: [{ name: 'close-process', path: '/srv/work/close-process', hint: 'month end close', outFile: `${WS}/data/evidence/close-process.md` }] },
    stages: 1,
    expect: ['/srv/work/close-process', `${WS}/data/evidence/close-process.md`, `${WS}/_profile.md`],
    required: ['workspace'],
  },
  'wf-bullets-from-evidence.js': {
    args: { root: ROOT, workspace: WS, archetypes: ['Audit', 'Advisory'], items: [{ name: 'close-process', role: 'prior1', evidenceFile: `${WS}/data/evidence/close-process.md`, fragmentFile: `${WS}/data/evidence/close-process.bullets.json` }] },
    stages: 1,
    expect: ['"role": "prior1"', 'a subset of: Audit, Advisory', `cd ${ROOT}`, `${WS}/data/evidence/close-process.bullets.json`],
    required: ['root', 'workspace'],
  },
};

function compile(file) {
  const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
  assert.ok(src.startsWith('export const meta = {'), `${file} must begin with the meta literal`);
  return { src, fn: new AsyncFunction(...GLOBALS, src.replace(/^export const meta/, 'const meta')) };
}

async function execute(fn, args) {
  const prompts = [];
  const logs = [];
  // Stub agent: records the prompt and answers with every required key of the
  // stage schema (verdict "pass", everything else a neutral value).
  const agent = async (prompt, opts = {}) => {
    prompts.push({ prompt, opts });
    const out = {};
    for (const key of (opts.schema && opts.schema.required) || []) {
      const prop = opts.schema.properties[key] || {};
      out[key] = prop.enum ? prop.enum[0] : prop.type === 'boolean' ? true : prop.type === 'number' ? 1 : 'x';
    }
    return out;
  };
  const pipeline = async (items, ...stages) => {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      let prev = items[i];
      for (const stage of stages) prev = await stage(prev, items[i], i);
      results.push(prev);
    }
    return results;
  };
  const never = () => { throw new Error('not expected in these scripts'); };
  const result = await fn(args, agent, pipeline, never, (m) => logs.push(m), () => {}, { total: null }, never);
  return { result, prompts, logs };
}

test('every wf-*.js under scripts/ is covered here', () => {
  const found = fs.readdirSync(SCRIPTS).filter((f) => /^wf-.*\.js$/.test(f)).sort();
  assert.deepEqual(found, Object.keys(CASES).sort());
});

for (const [file, c] of Object.entries(CASES)) {
  test(`${file}: valid for the Workflow runtime and driven only by its arguments`, async () => {
    const { src, fn } = compile(file);
    assert.match(src, /Workflow tool, not a Node\s*\n?\/\/ module/, 'the header must say which runtime it needs');
    // Unavailable in the Workflow runtime (they would break resume).
    assert.ok(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(src));
    // No machine path and no fixed date in the script text itself.
    assert.ok(!/\/Users\/|\/home\/[a-z]/.test(src));
    assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(src));

    const { result, prompts } = await execute(fn, c.args);
    assert.equal(prompts.length, c.stages * c.args.items.length);
    const all = prompts.map((p) => p.prompt).join('\n');
    for (const needle of c.expect) assert.ok(all.includes(needle), `${file}: prompt lacks ${JSON.stringify(needle)}`);
    assert.ok(!all.includes('undefined'), `${file}: an argument was interpolated as undefined`);
    for (const p of prompts) assert.ok(p.opts.schema && p.opts.label && p.opts.phase, 'every agent call carries schema, label, phase');
    assert.ok(result && typeof result === 'object');
    assert.equal(result.total ?? result.projects, c.args.items.length);

    // A JSON string of the same object is accepted.
    const viaString = await execute(fn, JSON.stringify(c.args));
    assert.equal(viaString.prompts.length, prompts.length);

    for (const key of c.required) {
      const missing = { ...c.args };
      delete missing[key];
      await assert.rejects(execute(fn, missing), new RegExp(`args\\.${key} is required`));
    }
    await assert.rejects(execute(fn, { ...c.args, items: 'nope' }), /args\.items must be an array/);
    await assert.rejects(execute(fn, [posting]), /args must be an object/);
  });
}

// selectedProjects is optional (work outside a job). A prompt that demands a
// fixed number pushes an agent to invent projects or loop on a failing check.
test('no batch workflow demands a fixed number of selected projects', async () => {
  for (const file of ['wf-generate-batch.js', 'wf-fill-batch.js', 'wf-compress-batch.js']) {
    const { src, fn } = compile(file);
    const { prompts } = await execute(fn, CASES[file].args);
    const all = prompts.map((p) => p.prompt).join('\n');
    for (const text of [src, all]) {
      assert.ok(!/\b\d to \d (?:real |specific )?projects\b|(?<!up to )\b\d (?:JD-relevant )?selectedProjects\b/.test(text), `${file}: fixed project count`);
    }
    assert.match(all, /(?:when|if) the candidate has no(?:ne| selectedProjects)|if (?:there are )?none/, `${file}: says what to do with no projects`);
  }
});
