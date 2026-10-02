'use strict';
/**
 * The root files that tie the tree together: install-local.sh, .gitignore,
 * .env.example, package.json and its lock file.
 *
 * The installer runs for real, into a temporary HOME, with
 * JOBE_INSTALL_SKIP_DEPS=1 (no network, no browser download). The installed
 * copy of scripts/user.js is then driven as a command, so `new` and `migrate`
 * are exercised without touching this checkout or any real workspace.
 * Fixtures are synthetic (a registered nurse and a tax accountant).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { builtinModules } = require('module');
const { spawnSync } = require('child_process');

// Isolate BEFORE any lib module loads.
const roots = [];
const freshRoot = () => { roots.push(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'root-integration-')))); return roots[roots.length - 1]; };
process.env.JOBE_USER_ROOT = freshRoot();
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const SYS = path.join(__dirname, '..');
const { TEMPLATE_DESTS } = require('../scripts/user');
const { LIFECYCLE_BUCKETS } = require('../lib/tracker-writer');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const readJson = (...p) => JSON.parse(read(...p));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
// Every file under a folder of this checkout, as paths relative to the repo root.
function walk(rel) {
  return fs.readdirSync(path.join(SYS, rel), { withFileTypes: true }).flatMap((d) => {
    if (d.name === '.DS_Store' || d.name === 'node_modules') return [];
    const child = path.join(rel, d.name);
    return d.isDirectory() ? walk(child) : [child];
  });
}
const CODE_FILES = ['lib', 'collectors', 'scripts'].flatMap(walk).filter((f) => /\.(js|sh)$/.test(f));

// -- install-local.sh --------------------------------------------------------

const HOME = freshRoot();
const JOBE = path.join(HOME, '.jobe');
const MODES = path.join(HOME, '.claude', 'skills', 'jobe', 'modes');
// A clean environment: no workspace override leaks into the installed copy.
const childEnv = { PATH: process.env.PATH, HOME };
const install = () => spawnSync('bash', [path.join(SYS, 'install-local.sh')], {
  encoding: 'utf8', env: { ...childEnv, JOBE_INSTALL_SKIP_DEPS: '1' },
});
const userJs = (...args) => spawnSync(process.execPath, [path.join(JOBE, 'scripts', 'user.js'), ...args], { encoding: 'utf8', env: childEnv });
const skipInstall = process.platform === 'win32' ? 'the installer is a bash script' : false;
const GLOBAL_NOTES = '# my own global instructions\n';

test('install: copies everything the tree ships and writes nothing personal', { skip: skipInstall }, () => {
  write(path.join(HOME, '.claude', 'CLAUDE.md'), GLOBAL_NOTES);
  const r = install();
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // A person's own global instructions file is never written.
  assert.equal(read(HOME, '.claude', 'CLAUDE.md'), GLOBAL_NOTES);
  assert.equal(read(JOBE, 'CLAUDE.md'), read(SYS, '.claude', 'CLAUDE.md'));

  // Every module, source plugin, script, helper and template arrives.
  for (const rel of [...['lib', 'collectors', 'scripts', 'templates'].flatMap(walk), 'package.json', '.env.example']) {
    assert.ok(fs.existsSync(path.join(JOBE, rel)), `${rel} was not installed`);
  }
  for (const f of fs.readdirSync(path.join(SYS, 'configs')).filter((n) => n.endsWith('.json'))) {
    if (['local.json', 'archetypes.json', 'apply-profile.json'].includes(f)) continue; // personal, older layout
    assert.ok(fs.existsSync(path.join(JOBE, 'configs', f)), `configs/${f} was not installed`);
  }
  if (fs.existsSync(path.join(SYS, 'package-lock.json'))) assert.ok(fs.existsSync(path.join(JOBE, 'package-lock.json')));
  assert.equal(read(JOBE, 'data/companies/staffing-list.json'), read(SYS, 'data/companies/staffing-list.json'));

  // Every mode and agent arrives (a personal profile in the modes folder is not a mode).
  assert.ok(fs.existsSync(path.join(HOME, '.claude', 'skills', 'jobe', 'SKILL.md')));
  for (const f of fs.readdirSync(path.join(SYS, '.claude', 'skills', 'jobe', 'modes'))) {
    if (f.endsWith('.md') && f !== '_profile.md') assert.ok(fs.existsSync(path.join(MODES, f)), `mode ${f} was not installed`);
  }
  for (const f of fs.readdirSync(path.join(SYS, '.claude', 'agents'))) {
    if (/^jobe-.*\.md$/.test(f)) assert.ok(fs.existsSync(path.join(HOME, '.claude', 'agents', f)), `agent ${f} was not installed`);
  }

  // Nothing personal is seeded: onboarding creates these, the installer never does.
  for (const dest of Object.values(TEMPLATE_DESTS)) {
    assert.ok(!fs.existsSync(path.join(JOBE, dest)), `the installer seeded ${dest}`);
  }
  for (const rel of ['data/tracker.md', 'data/apply-queue.json', 'data/story-bank.md', 'node_modules']) {
    assert.ok(!fs.existsSync(path.join(JOBE, rel)), `the installer created ${rel}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(JOBE, 'users')), []);
  // The new .env is the blank example, never a copy of the checkout's own keys.
  assert.equal(read(JOBE, '.env'), read(SYS, '.env.example'));
});

test('install: an update replaces shared files and keeps what the person changed', { skip: skipInstall }, () => {
  const seedFile = path.join(JOBE, 'data/companies/non-tech-seed.json');
  const seed = readJson(SYS, 'templates/non-tech-seed.template.json'); // what single user onboarding starts from
  seed.smartrecruiters = [{ companyId: 'ExampleHospitalTrust', company: 'Example Hospital Trust', industry: 'healthcare' }];
  const kept = {
    [seedFile]: JSON.stringify(seed, null, 2) + '\n',
    [path.join(JOBE, '.env')]: 'BRAVE_API_KEY=not-a-real-key\n',
    [path.join(JOBE, 'configs', 'apply-wrappers.json')]: '{ "careers.example.org": "exampleboard" }\n',
    [path.join(MODES, '_profile.md')]: '# Profile of a registered nurse (older location)\n',
    [path.join(HOME, '.claude', 'CLAUDE.md')]: GLOBAL_NOTES,
  };
  for (const [file, text] of Object.entries(kept)) write(file, text);
  write(path.join(JOBE, 'data/companies/staffing-list.json'), '{ "companySlugs": [] }\n'); // a stale shared list
  write(path.join(JOBE, 'configs', 'default.json'), '{ "stale": true }\n');

  const r = install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const [file, text] of Object.entries(kept)) assert.equal(read(file), text, `${path.relative(HOME, file)} was overwritten`);
  assert.equal(read(JOBE, 'data/companies/staffing-list.json'), read(SYS, 'data/companies/staffing-list.json'));
  assert.equal(read(JOBE, 'configs', 'default.json'), read(SYS, 'configs', 'default.json'));
});

test('installed user.js: migrate moves one person out of the shared root without leaving them behind for the next', { skip: skipInstall }, () => {
  assert.equal(userJs('current', '--path').stdout.trim(), JOBE, 'no workspace yet: the install root is the workspace');

  // Single user data, including two personal files in older shared locations.
  write(path.join(JOBE, 'data/profile.json'), JSON.stringify({ discovery: { workModes: ['onsite'] } }));
  write(path.join(JOBE, 'data/queries/seeds.json'), JSON.stringify({ queries: [{ query: 'Registered Nurse', location: 'Leeds' }] }));
  write(path.join(JOBE, 'configs/apply-profile.json'), JSON.stringify({ workAuthorized: 'Yes' }));
  write(path.join(JOBE, 'configs/archetypes.json'), JSON.stringify({ 'Acute Care': { keywords: ['icu'], portfolioDomains: [] } }));

  const r = userJs('migrate', 'nurse');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ws = path.join(JOBE, 'users', 'nurse');
  assert.equal(userJs('current', '--path').stdout.trim(), ws);

  // Carried: everything under data/, plus the personal files from the older shared locations.
  assert.deepEqual(readJson(ws, 'data/profile.json').discovery.workModes, ['onsite']);
  assert.equal(readJson(ws, 'data/queries/seeds.json').queries[0].query, 'Registered Nurse');
  assert.equal(readJson(ws, 'data/apply-profile.json').workAuthorized, 'Yes');
  assert.ok(readJson(ws, 'data/archetypes.json')['Acute Care']);
  assert.match(read(ws, '_profile.md'), /registered nurse/);
  assert.equal(read(ws, '.env'), 'BRAVE_API_KEY=not-a-real-key\n');
  for (const gone of [path.join(JOBE, 'configs/apply-profile.json'), path.join(JOBE, 'configs/archetypes.json'), path.join(MODES, '_profile.md'), path.join(JOBE, 'data/profile.json')]) {
    assert.ok(!fs.existsSync(gone), `${path.relative(HOME, gone)} was left in a shared place`);
  }

  // Shared again: the broker list moved back and machine keys copied. The
  // employer seed is personal: it leaves with this person and nothing stays behind.
  assert.equal(read(JOBE, 'data/companies/staffing-list.json'), read(SYS, 'data/companies/staffing-list.json'));
  assert.ok(!fs.existsSync(path.join(ws, 'data/companies/staffing-list.json')));
  assert.ok(fs.existsSync(path.join(JOBE, '.env')));
  assert.equal(readJson(ws, 'data/companies/non-tech-seed.json').smartrecruiters[0].company, 'Example Hospital Trust');
  assert.ok(!fs.existsSync(path.join(JOBE, 'data/companies/non-tech-seed.json')), 'the employer seed was left in the shared root');

  // A second migrate into the same name refuses rather than overwrite.
  assert.notEqual(userJs('migrate', 'nurse').status, 0);
});

test('installed user.js: a new workspace is scaffolded from the installed templates, isolated from the first', { skip: skipInstall }, () => {
  const r = userJs('new', 'Tax Accountant');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ws = path.join(JOBE, 'users', 'tax-accountant');
  assert.equal(userJs('current').stdout.trim(), 'tax-accountant');

  for (const bucket of LIFECYCLE_BUCKETS) assert.ok(fs.existsSync(path.join(ws, 'reports', bucket)), `reports/${bucket}/`);
  for (const [name, dest] of Object.entries(TEMPLATE_DESTS)) {
    // In an installed layout the profile template lives with the modes.
    const src = [path.join(JOBE, 'templates', name), path.join(MODES, name)].find((p) => fs.existsSync(p));
    if (src) assert.deepEqual(fs.readFileSync(path.join(ws, dest)), fs.readFileSync(src), `${dest} did not come from ${name}`);
  }
  assert.ok(fs.existsSync(path.join(ws, '_profile.md')), 'the profile template was not found in the installed modes folder');
  // Nothing of the nurse reaches the accountant.
  assert.deepEqual(readJson(ws, 'data/queries/seeds.json').queries, []);
  assert.deepEqual(readJson(ws, 'data/companies/non-tech-seed.json').smartrecruiters, []);
  assert.deepEqual(userJs('list').stdout.match(/^ {2}[* ] \S+$/gm), ['    nurse', '  * tax-accountant']);
});

// -- .gitignore --------------------------------------------------------------

test('.gitignore covers every personal path of single user mode and none of the shipped files', (t) => {
  const personal = [
    ...Object.values(TEMPLATE_DESTS),
    'data/tracker.md', 'data/story-bank.md', 'data/followups.md', 'data/contacts.json', 'data/calibration.jsonl',
    'data/apply-queue.json', 'data/apply-queue.json.bak', 'data/apply-wrappers.json', 'data/companies/index.json',
    'data/evidence-index.json', 'data/.evidence-corpus/project/notes.txt',
    'data/evidence/project/notes.md', 'data/evidence/project.bullets.json', 'data/apply-queue.json.tmp.1.2',
    'configs/archetypes.json', 'configs/apply-profile.json', '_archive/old/_profile.md',
    'signals/discovered/x.json', 'reports/queue/example/resume.json', 'users/nurse/_profile.md',
    '.env', '.claude/settings.local.json', '.codesearch.db', '.playwright-mcp/page.yml', 'node_modules/x/index.js',
  ];
  const shipped = [
    'package.json', 'package-lock.json', '.env.example', '.gitignore', 'install-local.sh',
    'data/companies/staffing-list.json', 'configs/default.json', 'configs/portals.json',
    'web/package-lock.json', 'web/src/app/reports/[slug]/page.tsx',
    ...walk('templates'), ...CODE_FILES, ...walk('test'),
  ];
  const r = spawnSync('git', ['check-ignore', '--no-index', '-v', '-n', '--stdin'], { cwd: SYS, encoding: 'utf8', input: [...personal, ...shipped].join('\n') });
  if (r.error || r.status > 1) return t.skip('not a git checkout');
  // One line per path: "<source>:<line>:<pattern>\t<path>". The fields are empty
  // when nothing matches, and a "!" pattern means the path is explicitly kept.
  const ignored = new Set(r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'))
    .filter(([rule]) => { const pattern = rule.split(':').slice(2).join(':'); return pattern && !pattern.startsWith('!'); })
    .map(([, file]) => file));
  for (const p of personal) assert.ok(ignored.has(p), `${p} is personal and is not ignored`);
  for (const p of shipped) assert.ok(!ignored.has(p), `${p} ships and must not be ignored`);
});

// -- .env.example ------------------------------------------------------------

test('.env.example documents every environment variable the code reads, with no value filled in', () => {
  const example = read(SYS, '.env.example');
  const read_ = new Set();
  for (const rel of CODE_FILES) {
    const text = read(SYS, rel);
    for (const m of text.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]{2,})\b/g)) read_.add(m[1]);
    for (const m of text.matchAll(/requires:\s*\[([^\]]*)\]/g)) for (const k of m[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)) read_.add(k[1]);
  }
  for (const k of Object.values(readJson(SYS, 'configs/default.json').api_keys || {})) read_.add(k.env_var);
  read_.add('JOBE_INSTALL_SKIP_DEPS'); // read by install-local.sh
  for (const os_ of ['HOME', 'USERPROFILE', 'PATH']) read_.delete(os_); // set by the system, not by the user
  assert.ok(read_.size >= 20, 'the scan should find the variables the sources read');
  for (const name of read_) assert.match(example, new RegExp(`\\b${name}\\b`), `${name} is read by the code and missing from .env.example`);

  // A copied .env must start blank: no key, no personal default.
  for (const line of example.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) assert.equal(m[2], '', `${m[1]} ships with a value`);
  }
});

// -- package.json and its lock -----------------------------------------------

test('package.json declares exactly the packages the code loads, and the lock file matches', () => {
  const pkg = readJson(SYS, 'package.json');
  const used = new Set();
  for (const rel of [...CODE_FILES, ...walk('test')].filter((f) => f.endsWith('.js'))) {
    for (const m of read(SYS, rel).matchAll(/\b(?:require|import)\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g)) {
      const name = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
      if (!name.startsWith('node:') && !builtinModules.includes(name)) used.add(name);
    }
  }
  assert.deepEqual([...used].sort(), Object.keys(pkg.dependencies).sort(), 'every dependency needs a consumer and every consumer a dependency');

  assert.equal(pkg.scripts.test, 'node --test test/*.test.js');
  for (const cmd of Object.values(pkg.scripts)) {
    const script = cmd.match(/^node ((?:scripts|collectors)\/\S+\.js)/);
    if (script) assert.ok(fs.existsSync(path.join(SYS, script[1])), `npm script points at a missing file: ${script[1]}`);
  }
  assert.match(pkg.repository.url, /^https:\/\/github\.com\/[^/]+\/jobe-skill$/, 'the repository address stays');

  const lock = readJson(SYS, 'package-lock.json');
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'package-lock.json is stale: run npm install');
  for (const name of Object.keys(pkg.dependencies)) assert.ok(lock.packages[`node_modules/${name}`], `${name} is not locked`);
});
