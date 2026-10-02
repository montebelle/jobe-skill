'use strict';
// The README "Upgrading from an older clone" steps, run for real. An older
// version tracked four files that are now personal; a person who onboarded in
// single user mode has edited them, and a plain `git pull` across the change
// stops. This test builds that situation in temporary git repositories and
// runs the documented commands, so the instructions cannot drift from what
// git actually does.
//
// Hermetic: temp directories only, a blank git config, no network. Nothing is
// read from the real install root except README.md and .gitignore.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const README = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
// Files an older version tracked and this one leaves to the person.
const ONCE_TRACKED = [
  'data/queries/seeds.json',
  'data/companies/negative-list.json',
  'data/companies/non-tech-seed.json',
  '.claude/settings.local.json',
];
const hasGit = !spawnSync('git', ['--version']).error && process.platform !== 'win32';

const section = README.split('### Upgrading from an older clone')[1].split('\n### ')[0];
const steps = section.match(/```bash\n([\s\S]*?)```/)[1];

function git(cwd, env, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function scene() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-upgrade-'));
  const blank = path.join(tmp, 'gitconfig');
  fs.writeFileSync(blank, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: blank, GIT_CONFIG_NOSYSTEM: '1', HOME: tmp };
  const up = path.join(tmp, 'upstream');
  fs.mkdirSync(up);
  git(up, env, 'init', '-q', '-b', 'main');
  const commit = (msg) => { git(up, env, 'add', '-A'); git(up, env, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', msg); };
  // The older version: the four files are tracked, with shipped content.
  for (const f of ONCE_TRACKED) {
    fs.mkdirSync(path.join(up, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(up, f), '{}\n');
  }
  fs.writeFileSync(path.join(up, 'package.json'), '{}\n');
  commit('older version');
  const clone = path.join(tmp, 'jobe-skill');
  git(tmp, env, 'clone', '-q', up, clone);
  // This version: the files are gone from git and ignored.
  for (const f of ONCE_TRACKED) fs.rmSync(path.join(up, f));
  fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(up, '.gitignore'));
  commit('this version');
  // The person onboarded in single user mode in between (two unrelated fields).
  const mine = {
    'data/queries/seeds.json': '{"queries":[{"role":"Registered Nurse"},{"role":"Tax Accountant"}]}\n',
    'data/companies/negative-list.json': '{"companySlugs":["a-former-employer"]}\n',
    '.claude/settings.local.json': '{"permissions":{"allow":["Bash(node:*)"]}}\n',
  };
  for (const [f, body] of Object.entries(mine)) fs.writeFileSync(path.join(clone, f), body);
  fs.writeFileSync(path.join(clone, '_profile.md'), 'mine\n');
  return { tmp, env, clone, mine };
}

test('the upgrade steps name every file an older version tracked, and .gitignore covers each', { skip: !hasGit }, () => {
  for (const f of ONCE_TRACKED) assert.ok(steps.includes(f), `README upgrade steps do not move ${f}`);
  const { tmp, env, clone } = scene();
  try {
    fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(clone, '.gitignore'));
    git(clone, env, 'rm', '-q', '--cached', ...ONCE_TRACKED);
    const ignored = git(clone, env, 'check-ignore', ...ONCE_TRACKED).trim().split('\n');
    assert.deepStrictEqual(ignored.sort(), [...ONCE_TRACKED].sort());
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a plain pull stops on the edited files, which is why the steps exist', { skip: !hasGit }, () => {
  const { tmp, env, clone, mine } = scene();
  try {
    const r = spawnSync('git', ['pull', '-q'], { cwd: clone, env, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /would be overwritten by merge/);
    for (const [f, body] of Object.entries(mine)) assert.strictEqual(fs.readFileSync(path.join(clone, f), 'utf8'), body);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the documented steps update the clone and keep every personal file as the person left it', { skip: !hasGit }, () => {
  const { tmp, env, clone, mine } = scene();
  try {
    // The steps as printed, minus the dependency install (no network here).
    const script = steps.split('\n').filter((l) => !/^npm install\b/.test(l)).join('\n');
    execFileSync('bash', ['-c', `set -e\n${script}`], { cwd: clone, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.strictEqual(git(clone, env, 'status', '--short').trim(), '', 'git status --short must print nothing after the upgrade');
    for (const [f, body] of Object.entries(mine)) assert.strictEqual(fs.readFileSync(path.join(clone, f), 'utf8'), body, f);
    // The file the person never edited is kept too (the old shipped employer seed).
    assert.ok(fs.existsSync(path.join(clone, 'data/companies/non-tech-seed.json')));
    assert.strictEqual(fs.readFileSync(path.join(clone, '_profile.md'), 'utf8'), 'mine\n');
    assert.strictEqual(git(clone, env, 'log', '-1', '--format=%s').trim(), 'this version');
    assert.strictEqual(git(clone, env, 'ls-files', '--', ...ONCE_TRACKED).trim(), '', 'none of the four is tracked any more');
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'jobe-backup', 'data/queries/seeds.json'), 'utf8'), mine['data/queries/seeds.json']);
    assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'jobe-keep')).filter((n) => fs.statSync(path.join(tmp, 'jobe-keep', n)).isFile()), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the documented recovery after a stash and pull leaves the files in place and untracked', { skip: !hasGit }, () => {
  const { tmp, env, clone, mine } = scene();
  try {
    const recovery = section.match(/`(git reset -q -- [^`]+)`/)[1];
    for (const f of ONCE_TRACKED) assert.ok(recovery.includes(f), `recovery command omits ${f}`);
    git(clone, env, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'stash', '-q');
    git(clone, env, 'pull', '-q');
    spawnSync('git', ['stash', 'pop'], { cwd: clone, env });   // ends in "deleted by us" conflicts
    assert.match(git(clone, env, 'status', '--short'), /^DU /m);
    execFileSync('bash', ['-c', recovery], { cwd: clone, env });
    assert.strictEqual(git(clone, env, 'status', '--short').trim(), '');
    for (const [f, body] of Object.entries(mine)) assert.strictEqual(fs.readFileSync(path.join(clone, f), 'utf8'), body, f);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('no document promises that an update never touches personal files without naming the exception', () => {
  for (const rel of ['README.md', 'DATA_CONTRACT.md']) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.ok(!/personal files are never touched\./i.test(text), `${rel} still says personal files are never touched`);
    assert.match(text, /Upgrading from an older clone/, rel);
  }
});
