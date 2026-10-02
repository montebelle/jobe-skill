'use strict';
// collectors/pipeline.js --dry-run and collectors/ingest-manual.js, run as
// child processes in throwaway workspaces (JOBE_USER_ROOT). The dry run must
// print the queries derived from the user's own seeds and the merged filters,
// reach no network, and write nothing. Two synthetic users from unrelated
// professions: a registered nurse and a tax accountant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const mkRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `collectors-core-${tag}-`));
const writeJson = (root, rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
};

// Preloaded into the child: any attempt to reach the network leaves a marker
// file and throws, so "no network call" is asserted, not assumed.
const guardDir = mkRoot('guard');
const marker = path.join(guardDir, 'network-was-called');
const guard = path.join(guardDir, 'no-network.js');
fs.writeFileSync(guard, `
const fs = require('fs');
const trip = (what) => () => { fs.writeFileSync(${JSON.stringify(marker)}, what); throw new Error('network call in a dry run: ' + what); };
globalThis.fetch = trip('fetch');
for (const mod of ['http', 'https']) { const m = require(mod); m.request = trip(mod + '.request'); m.get = trip(mod + '.get'); }
require('net').Socket.prototype.connect = trip('net.connect');
`);

test('the network guard itself trips (so the assertions below mean something)', () => {
  const res = spawnSync(process.execPath, ['--require', guard, '-e', 'fetch("https://example.org/")'], { encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'fetch');
  fs.unlinkSync(marker);
});

function run(script, root, args) {
  const res = spawnSync(process.execPath, ['--require', guard, path.join(REPO, script), ...args], {
    env: { ...process.env, JOBE_USER_ROOT: root, JOBE_USER: '' },
    encoding: 'utf8',
  });
  return res;
}

const NURSE_SEEDS = [
  { query: 'Registered Nurse', location: 'Columbus, OH' },
  { query: 'Charge Nurse', location: 'Columbus, OH' },
];
const ACCOUNTANT_SEEDS = [
  { query: 'Tax Accountant', location: 'Remote' },
  { query: 'Senior Accountant', location: 'Remote' },
];

test('dry run, registered nurse: queries are the seeds, filters are the profile, nothing is fetched or written', () => {
  const root = mkRoot('dry-nurse');
  writeJson(root, 'data/queries/seeds.json', { queries: NURSE_SEEDS });
  writeJson(root, 'data/profile.json', {
    discovery: { workModes: ['onsite', 'hybrid'], countries: ['US'], maxAgeDays: 21, titleExclude: ['travel'], companySites: ['careers.example.org'] },
  });
  const res = run('collectors/pipeline.js', root, ['--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.queries, NURSE_SEEDS);
  assert.ok(out.sources.includes('greenhouse-direct') && out.sources.includes('linkedin-guest'));
  assert.equal(out.filters.remoteOnly, false);
  assert.deepEqual(out.filters.workModes, ['onsite', 'hybrid']);
  assert.equal(out.filters.usOnly, true);
  assert.equal(out.filters.maxAgeDays, 21);
  assert.deepEqual(out.filters.companySites, ['careers.example.org']);
  assert.equal(fs.existsSync(marker), false, 'no network call');
  assert.equal(fs.existsSync(path.join(root, 'signals')), false, 'nothing written');
  assert.equal(fs.existsSync(path.join(root, 'data/companies/index.json')), false, 'index untouched');
});

test('dry run, tax accountant: a different user gets different queries, and a flag beats the profile', () => {
  const root = mkRoot('dry-accountant');
  writeJson(root, 'data/queries/seeds.json', { queries: ACCOUNTANT_SEEDS });
  writeJson(root, 'data/profile.json', { discovery: { workModes: ['remote'], maxAgeDays: 12, salaryFloor: 85000 } });
  const res = run('collectors/pipeline.js', root, ['--dry-run', '--max-age', '7', '--allow-onsite']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.queries, ACCOUNTANT_SEEDS);
  assert.equal(out.filters.maxAgeDays, 7, 'flag over profile');
  assert.equal(out.filters.remoteOnly, false, 'flag over profile');
  assert.deepEqual(out.filters.workModes, []);
  assert.equal(out.filters.salaryFloor, 85000);
  assert.equal(out.filters.usOnly, false, 'no country policy, no country filter');
  assert.equal(fs.existsSync(marker), false, 'no network call');
});

test('--help prints the usage and an unknown flag stops the run: neither reaches the network or writes', () => {
  const root = mkRoot('cli-guard');
  writeJson(root, 'data/queries/seeds.json', { queries: NURSE_SEEDS });
  const help = run('collectors/pipeline.js', root, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage:/);
  assert.match(help.stdout, /--dry-run/);
  const typo = run('collectors/pipeline.js', root, ['--no-enrichh']);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown argument: --no-enrichh/);
  assert.match(typo.stderr, /Usage:/);
  assert.equal(typo.stdout, '');
  assert.equal(fs.existsSync(marker), false, 'no network call');
  assert.equal(fs.existsSync(path.join(root, 'signals')), false, 'nothing written');
  assert.equal(fs.existsSync(path.join(root, 'data', 'companies')), false, 'nothing written');
});

test('dry run, fresh workspace: no seeds and no policy give no queries and permissive filters', () => {
  const root = mkRoot('dry-empty');
  const res = run('collectors/pipeline.js', root, ['--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.queries, []);
  assert.deepEqual(
    { remoteOnly: out.filters.remoteOnly, usOnly: out.filters.usOnly, workModes: out.filters.workModes, countries: out.filters.countries, salaryFloor: out.filters.salaryFloor, companySites: out.filters.companySites },
    { remoteOnly: false, usOnly: false, workModes: [], countries: [], salaryFloor: null, companySites: [] },
  );
  assert.equal(out.filters.maxAgeDays, 30);

  // --query replaces the seeds for one run.
  const adhoc = run('collectors/pipeline.js', root, ['--dry-run', '--query', 'Registered Nurse', '--location', 'Columbus, OH']);
  assert.deepEqual(JSON.parse(adhoc.stdout).queries, [{ query: 'Registered Nurse', location: 'Columbus, OH' }]);
  assert.equal(fs.existsSync(marker), false, 'no network call');
});

test('manual ingest: excluded companies and the title policy apply before ranking', () => {
  const root = mkRoot('ingest-nurse');
  writeJson(root, 'data/queries/seeds.json', { queries: NURSE_SEEDS });
  writeJson(root, 'data/profile.json', { discovery: { titleExclude: ['travel'] } });
  writeJson(root, 'data/companies/negative-list.json', { companySlugs: ['blocked-clinic'] });
  writeJson(root, 'data/companies/staffing-list.json', { companySlugs: ['synthetic-staffing-partners'] });
  const input = path.join(root, 'captured.json');
  const row = (title, company, i) => ({ title, company, location: 'Columbus, OH', url: `https://example.org/jobs/${i}`, postedDate: '2 days ago' });
  fs.writeFileSync(input, JSON.stringify([
    row('Registered Nurse, ICU', 'Mercy West Health', 1),
    row('Charge Nurse', 'Lakeside Hospital', 2),
    row('Registered Nurse', 'Blocked Clinic', 3),
    row('Registered Nurse', 'Synthetic Staffing Partners', 4),
    row('Travel Registered Nurse', 'Lakeside Hospital', 5),
    row('Tax Accountant', 'Ledger and Finch', 6),
  ]));
  const res = run('collectors/ingest-manual.js', root, [input, '--source', 'capture']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /2 staffing\/excluded dropped -> 2 role-matched/);
  const date = fs.readdirSync(path.join(root, 'signals/discovered'))[0];
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'signals/discovered', date, 'manual-capture.json'), 'utf8'));
  assert.deepEqual(saved.postings.map((p) => p.title).sort(), ['Charge Nurse', 'Registered Nurse, ICU']);
  assert.equal(fs.existsSync(marker), false, 'no network call');
});

test('manual ingest: one title in several cities stays one row per city unless the policy is remote only', () => {
  const ingest = (tag, seeds, discovery, rows) => {
    const root = mkRoot(tag);
    writeJson(root, 'data/queries/seeds.json', { queries: seeds });
    if (discovery) writeJson(root, 'data/profile.json', { discovery });
    const input = path.join(root, 'captured.json');
    fs.writeFileSync(input, JSON.stringify(rows));
    const saved = () => {
      const date = fs.readdirSync(path.join(root, 'signals/discovered'))[0];
      return JSON.parse(fs.readFileSync(path.join(root, 'signals/discovered', date, 'manual-linkedin-search.json'), 'utf8')).postings;
    };
    const once = () => run('collectors/ingest-manual.js', root, [input, '--source', 'linkedin-search']);
    return { once, saved };
  };
  const cards = (title, company, cities) => cities.map((location, i) => ({
    title, company, location, url: `https://www.linkedin.com/jobs/view/${title.length}${company.length}${i}00`, postedDate: '2 days ago',
  }));
  const nurseRows = [
    ...cards('Registered Nurse', 'Example Health', ['Denver, CO', 'Aurora, CO', 'Boulder, CO']),
    ...cards('Charge Nurse', 'Lakeside Hospital', ['Remote', 'United States (Remote)']),
  ];

  // A nurse who works on site: three cities are three jobs, and a second run
  // of the same page (a paged sweep) does not collapse them again.
  const onsite = ingest('ingest-cities', NURSE_SEEDS, { workModes: ['hybrid', 'onsite'] }, nurseRows);
  let res = onsite.once();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /-> 4 after dedup/, res.stdout);
  res = onsite.once();
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(onsite.saved().map((p) => p.location).sort(), ['Aurora, CO', 'Boulder, CO', 'Denver, CO', 'Remote']);

  // No profile at all behaves the same (nothing is assumed about work mode).
  res = ingest('ingest-nopolicy', NURSE_SEEDS, null, nurseRows).once();
  assert.match(res.stdout, /-> 4 after dedup/, res.stdout);

  // A remote only accountant: one req listed in several places is one job.
  const acctRows = cards('Tax Accountant', 'Ledger and Finch', ['Toronto, ON', 'Ottawa, ON', 'Hamilton, ON']);
  res = ingest('ingest-remote', ACCOUNTANT_SEEDS, { workModes: ['remote'] }, acctRows).once();
  assert.match(res.stdout, /-> 1 after dedup/, res.stdout);
  res = ingest('ingest-acct-onsite', ACCOUNTANT_SEEDS, { workModes: ['onsite', 'hybrid'], countries: ['CA', 'Canada'] }, acctRows).once();
  assert.match(res.stdout, /-> 3 after dedup/, res.stdout);
  assert.equal(fs.existsSync(marker), false, 'no network call');
});
