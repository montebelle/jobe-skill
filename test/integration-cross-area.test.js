'use strict';
// Cross area checks added by the integration pass. Every fixture is synthetic
// and comes from two unrelated professions (a registered nurse and a tax
// accountant). Each test runs in a throwaway workspace through JOBE_USER_ROOT.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const mkRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `integration-${tag}-`));
const writeJson = (root, rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};
const run = (root, args) => spawnSync(process.execPath, args, {
  cwd: REPO, encoding: 'utf8', env: { ...process.env, JOBE_USER_ROOT: root, JOBE_USER: '' },
});

test('a pay range written with a hyphen or a dash survives the JD text cleanup', () => {
  const { extractCompFromText } = require('../lib/enrich');
  const { stripHtml } = require('../lib/posting');
  const band = (s) => extractCompFromText(stripHtml(s));
  for (const s of ['$70,000 - $85,000', '$70,000-$85,000', '$70,000 to $85,000', '<p>Pay: $70,000 – $85,000 per year</p>', '$70k-$85k']) {
    assert.deepEqual(band(s), { min: 70000, max: 85000, currency: null }, s);
  }
  // One figure followed by an unrelated one is not a range.
  assert.equal(band('$100,000 sign on budget, 401k match'), null);
  assert.equal(band('The fund raised $750,000,000 last year'), null);
  assert.equal(band('$70,000 and up to $5,000 in bonus'), null);
});

test('a state with a two word name is still a United States location', () => {
  const { parseLocation } = require('../lib/posting');
  for (const loc of ['Albany, New York', 'Charlotte, North Carolina', 'Santa Fe, New Mexico', 'Washington, District of Columbia', 'Austin, Texas']) {
    assert.equal(parseLocation(loc).us, true, loc);
  }
  for (const loc of ['Toronto, Ontario', 'Newcastle, New South Wales', 'Pune, Maharashtra']) {
    assert.equal(parseLocation(loc).us, false, loc);
  }
});

test('the tools a brief reports come from the user library, never from a shipped table', () => {
  const jd = 'You will go above and beyond, react quickly, and keep Java coffee stocked. Telemetry monitoring and wound care required. Multistate nexus research and partnership returns a plus.';
  const stackFor = (library) => {
    const root = mkRoot('stack');
    if (library) writeJson(root, 'data/bullet-library.json', library);
    const res = run(root, ['-e', `console.log(JSON.stringify(require('./lib/tailor').analyzeJD(${JSON.stringify(jd)}).stack))`]);
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout.trim().split('\n').pop()).sort();
  };
  assert.deepEqual(stackFor(null), [], 'no library: nothing is assumed');
  assert.deepEqual(
    stackFor({ companyKeyMap: { 'Example Hospital': 'hospital' }, hospital: [{ id: 'n1', keywords: ['telemetry monitoring', 'wound care', 'IV therapy'], text: 'x' }] }),
    ['telemetry monitoring', 'wound care']);
  assert.deepEqual(
    stackFor({ companyKeyMap: { 'Example Tax Group': 'firm' }, firm: [{ id: 't1', keywords: ['multistate nexus', 'partnership returns', 'tax research'], text: 'x' }] }),
    ['multistate nexus', 'partnership returns']);
});

test('the pipeline and the queue prune agree on what counts as history', () => {
  const root = mkRoot('history');
  writeJson(root, 'data/apply-queue.json', [
    { slug: 'a', company: 'Example Hospital', role: 'Registered Nurse', skipped: true },
    { slug: 'b', company: 'Example Clinic', role: 'Charge Nurse', status: 'applied' },
    { slug: 'c', company: 'Example Tax Group', role: 'Tax Manager', reportDir: 'reports/applied/c' },
    { slug: 'd', company: 'Example Manufacturing', role: 'Staff Accountant' },
  ]);
  writeJson(root, 'data/queries/seeds.json', { queries: [] });
  const postings = [
    ['Example Hospital', 'Registered Nurse'], ['Example Clinic', 'Charge Nurse'],
    ['Example Tax Group', 'Tax Manager'], ['Example Manufacturing', 'Staff Accountant'],
  ];
  const res = run(root, ['-e', `
    const { applyFilters } = require('./collectors/pipeline');
    const { createPosting } = require('./lib/posting');
    const list = ${JSON.stringify(postings)}.map(([company, title], i) => createPosting({ company, title, url: 'https://jobs.example.org/' + i }, 't'));
    const out = applyFilters(list, { maxAgeDays: 0 });
    const kept = Array.isArray(out) ? out : (out.kept || out.postings || out.passed);
    console.log(JSON.stringify(kept.map((p) => p.company)));
  `]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim().split('\n').pop()), ['Example Manufacturing']);
});

test('a second manual ingest for the same source merges into the file instead of replacing it', () => {
  const root = mkRoot('ingest');
  const page = (n, rows) => writeJson(root, `in/page${n}.json`, rows.map(([company, title], i) => ({ company, title, location: 'Columbus, OH', url: `https://jobs.example.org/p${n}/${i}` })));
  const p1 = page(1, [['Example Tax Group', 'Senior Tax Accountant'], ['Example Manufacturing', 'Tax Analyst']]);
  const p2 = page(2, [['Example Tax Group', 'Senior Tax Accountant'], ['Example University', 'Tax Manager']]);
  for (const p of [p1, p2]) {
    const res = run(root, ['collectors/ingest-manual.js', p, '--source', 'sweep']);
    assert.equal(res.status, 0, res.stderr);
  }
  const date = fs.readdirSync(path.join(root, 'signals', 'discovered'))[0];
  const out = JSON.parse(fs.readFileSync(path.join(root, 'signals', 'discovered', date, 'manual-sweep.json'), 'utf8'));
  assert.equal(out.count, out.postings.length);
  assert.deepEqual(out.postings.map((p) => `${p.company}: ${p.title}`).sort(),
    ['Example Manufacturing: Tax Analyst', 'Example Tax Group: Senior Tax Accountant', 'Example University: Tax Manager']);
});

test('the resolve and verify scripts accept a ranked array and a manual capture object', () => {
  for (const script of ['resolve-linkedin-to-ats.js', 'verify-remote.js']) {
    const src = fs.readFileSync(path.join(REPO, 'scripts', script), 'utf8');
    assert.match(src, /Array\.isArray\(data\) \? data : \(data\.postings \|\| \[\]\)/, script);
    assert.match(src, /JSON\.stringify\(data, null, 1\)/, `${script} must write back the shape it read`);
  }
  // With nothing to do (no LinkedIn rows), both shapes run to the end offline.
  const root = mkRoot('shapes');
  const rows = [{ company: 'Example Hospital', title: 'Registered Nurse', canonicalUrl: 'https://jobs.example.org/1', remoteVerified: true }];
  const files = [writeJson(root, 'array.json', rows), writeJson(root, 'object.json', { source: 'manual:x', count: 1, postings: rows })];
  for (const file of files) {
    for (const args of [['scripts/resolve-linkedin-to-ats.js', file, '--write'], ['scripts/verify-remote.js', file, '--only-linkedin', '--write']]) {
      const res = run(root, args);
      assert.equal(res.status, 0, `${args[0]} on ${path.basename(file)}: ${res.stderr}`);
    }
  }
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(files[0], 'utf8'))));
  assert.equal(JSON.parse(fs.readFileSync(files[1], 'utf8')).postings.length, 1);
});

test('requiring a collectors entry point runs nothing', () => {
  const root = mkRoot('require');
  const res = run(root, ['-e', `
    for (const f of ['pipeline', 'ingest-manual', 'enrich-run', 'seed-files']) require('./collectors/' + f);
    console.log('loaded');
  `]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /loaded/);
  assert.deepEqual(fs.readdirSync(root), [], 'nothing may be written by a require');
});
