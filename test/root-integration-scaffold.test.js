'use strict';
/**
 * scripts/user.js scaffold(): a new workspace gets every lifecycle folder and
 * every shipped template, and what lands asserts nothing about the person.
 *
 * Everything runs in temporary workspaces (JOBE_USER_ROOT). The real
 * workspaces on this machine are never read or written. Fixtures are synthetic
 * (a registered nurse and a tax accountant).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Isolate BEFORE any lib module loads: several capture the workspace at load.
const roots = [];
const freshRoot = () => { roots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'root-integration-'))); return roots[roots.length - 1]; };
process.env.JOBE_USER_ROOT = freshRoot();
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const SYS = path.join(__dirname, '..');
const USER_JS = path.join(SYS, 'scripts', 'user.js');
const { scaffold, TEMPLATE_DESTS } = require('../scripts/user');
const { LIFECYCLE_BUCKETS } = require('../lib/tracker-writer');

const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
// A "$..." or "_..." key is a note, never data.
const dataKeys = (obj) => Object.keys(obj).filter((k) => !/^[$_]/.test(k));
const isEmpty = (v) => v === '' || v === null || v === false
  || (Array.isArray(v) && v.length === 0)
  || (v && typeof v === 'object' && Object.values(v).every(isEmpty));

// Where the repo keeps a template (the same lookup scripts/user.js does).
function shippedTemplate(name) {
  return [
    path.join(SYS, 'templates', name),
    path.join(SYS, '.claude', 'skills', 'jobe', 'modes', name),
  ].find((p) => fs.existsSync(p)) || null;
}

test('requiring scripts/user.js runs no command and exports the scaffold', () => {
  assert.equal(typeof scaffold, 'function');
  assert.ok(Object.keys(TEMPLATE_DESTS).length >= 13);
});

test('every file in templates/ has a workspace destination that a migrate carries', () => {
  for (const name of fs.readdirSync(path.join(SYS, 'templates'))) {
    if (name.startsWith('.')) continue;
    assert.ok(TEMPLATE_DESTS[name], `templates/${name} has no row in TEMPLATE_DESTS (scripts/user.js): it would never reach a workspace`);
  }
  const dests = Object.values(TEMPLATE_DESTS);
  assert.equal(new Set(dests).size, dests.length, 'two templates share one destination');
  for (const dest of dests) {
    // `user.js migrate` moves data/ and these two root files; anything else would be left behind.
    assert.ok(dest.startsWith('data/') || ['_profile.md', 'reference.md'].includes(dest), `${dest} is outside what migrate moves`);
  }
});

test('scaffold creates every lifecycle bucket and copies every shipped template', () => {
  const root = process.env.JOBE_USER_ROOT;
  scaffold(root);

  for (const bucket of LIFECYCLE_BUCKETS) {
    assert.ok(fs.statSync(path.join(root, 'reports', bucket)).isDirectory(), `reports/${bucket}/ was not created`);
  }
  for (const dir of ['data/queries', 'data/companies', 'signals/snapshots', 'signals/cache/jd', 'signals/discovered', 'signals/apply']) {
    assert.ok(fs.statSync(path.join(root, dir)).isDirectory(), `${dir}/ was not created`);
  }

  let landed = 0;
  for (const [name, dest] of Object.entries(TEMPLATE_DESTS)) {
    const src = shippedTemplate(name);
    const at = path.join(root, dest);
    if (!src) { assert.ok(!fs.existsSync(at), `${dest} appeared with no template behind it`); continue; }
    assert.ok(fs.existsSync(at), `${name} did not land at ${dest}`);
    assert.deepEqual(fs.readFileSync(at), fs.readFileSync(src), `${dest} differs from ${name}`);
    landed++;
  }
  assert.ok(landed >= 13, `expected at least 13 templates to land, got ${landed}`);
});

test('a scaffolded workspace is permissive and empty: nothing is assumed about the person', () => {
  const root = process.env.JOBE_USER_ROOT; // scaffolded by the test above
  const { loadProfile, discoveryFilters, titlePolicy, DEFAULTS } = require('../lib/profile');
  const { buildProfile } = require('../lib/rank');
  const { loadTaxonomy } = require('../lib/archetypes');
  const { loadExclusions } = require('../lib/exclusions');

  // The structured profile equals the permissive defaults: no filter of any kind.
  const profile = loadProfile({ root });
  assert.deepEqual(profile, DEFAULTS);
  const filters = discoveryFilters(profile);
  assert.equal(filters.remoteOnly, false);
  assert.equal(filters.usOnly, false);
  assert.deepEqual(filters.workModes, []);
  assert.deepEqual(filters.countries, []);
  assert.equal(filters.salaryFloor, null);
  assert.equal(filters.minScore, null);
  assert.deepEqual(titlePolicy(profile), { exclude: null, keep: null });

  // No role, no skill, no degree, no bucket, no excluded employer.
  const fit = buildProfile({ root });
  assert.equal(fit.configured, false);
  assert.equal(fit.roleTokens.size, 0);
  assert.equal(fit.skills.length, 0);
  assert.equal(fit.candidate.degreeLevel, 0);
  assert.deepEqual(loadTaxonomy(root), {});
  assert.equal(loadExclusions({ root }).negative.size, 0);

  // Lists start empty.
  assert.deepEqual(readJson(root, 'data/queries/seeds.json').queries, []);
  const negative = readJson(root, 'data/companies/negative-list.json');
  assert.deepEqual([negative.companySlugs, negative.reasons], [[], {}]);
  const seed = readJson(root, 'data/companies/non-tech-seed.json');
  for (const k of dataKeys(seed)) assert.deepEqual(seed[k], [], `non-tech-seed ${k}`);
  if (fs.existsSync(path.join(root, 'data/companies/portals.json'))) {
    const portals = readJson(root, 'data/companies/portals.json');
    for (const k of dataKeys(portals)) assert.deepEqual(portals[k], [], `portals ${k}`);
  }
  assert.deepEqual(readJson(root, 'data/evidence-anchors.json').anchors, []);
  assert.deepEqual(readJson(root, 'data/evidence-depth.json').systems, []);

  // Resume baseline and bullet library carry no content outside the note keys.
  for (const rel of ['data/resume-baseline.json', 'data/bullet-library.json']) {
    const file = readJson(root, rel);
    for (const k of dataKeys(file)) assert.ok(isEmpty(file[k]), `${rel}: "${k}" ships with content`);
  }

  // Application answers: every one blank, demographic questions declined. The
  // only preset is the neutral way to pick one figure out of a published band.
  const apply = readJson(root, 'data/apply-profile.json');
  for (const k of dataKeys(apply)) {
    if (k === 'salaryStrategy') { assert.equal(apply[k], 'midpoint'); continue; }
    assert.ok(isEmpty(apply[k]), `apply-profile: "${k}" ships with an answer`);
  }
  assert.equal(apply.eeoSelfIdentify, false);

  // The narrative spine is all bracketed prompts, so it counts as absent.
  const narrative = fs.readFileSync(path.join(root, 'data/career-narrative.md'), 'utf8');
  const arc = narrative.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.ok(arc.length >= 3 && arc.every((l) => /^\d+\. \[/.test(l)), 'every arc item must still be a bracketed prompt');
});

test('scaffold never overwrites a file the person already has', () => {
  const root = freshRoot();
  const mine = {
    'data/queries/seeds.json': JSON.stringify({ queries: [{ query: 'Registered Nurse', location: 'Leeds' }, { query: 'Tax Accountant', location: 'Remote' }] }),
    '_profile.md': '# my own profile\n',
    'data/profile.json': JSON.stringify({ discovery: { workModes: ['onsite'] } }),
  };
  for (const [rel, text] of Object.entries(mine)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  scaffold(root);
  scaffold(root); // and it is safe to run twice
  for (const [rel, text] of Object.entries(mine)) {
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), text, `${rel} was overwritten`);
  }
  // The files the person did not have were still filled in.
  assert.ok(fs.existsSync(path.join(root, 'data/resume-baseline.json')));
});

test('`current --path` reports the workspace the Node code uses', () => {
  const root = freshRoot();
  const run = (override) => spawnSync(process.execPath, [USER_JS, 'current', '--path'], {
    encoding: 'utf8', env: { ...process.env, JOBE_USER_ROOT: override },
  });
  const ok = run(root);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), path.normalize(root));
  // A relative override is an error, never a silent fall back to a real workspace.
  assert.notEqual(run('relative/dir').status, 0);
});
