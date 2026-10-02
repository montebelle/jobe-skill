'use strict';
// The smaller profile driven pieces: lib/linkedin.js search URL and query
// list, lib/sync-check.js evidence ledger, lib/ghost-score.js senior headroom
// and generic title signal, lib/slug-harvest.js search market. Synthetic tax
// accountant workspace, with a registered nurse workspace for contrast.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function workspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-discovery-policy-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const root = workspace({
  'data/queries/seeds.json': { queries: ['Tax Accountant', 'Senior Tax Accountant', 'Tax Intern', 'Internal Audit Associate'] },
  'data/profile.json': {
    discovery: {
      workModes: ['remote', 'hybrid'], countries: ['US'], maxAgeDays: 10, seniorityExtensionDays: 15,
      titleExclude: ['intern', 'senior'], titleKeep: ['senior tax'],
    },
    evidence: { ledger: 'data/my-evidence.md' },
  },
});
process.env.JOBE_USER_ROOT = root;
process.env.HOME = root; // keeps the legacy evidence fallback inside the temp workspace

const linkedin = require('../lib/linkedin');
const { runSyncCheck } = require('../lib/sync-check');
const { ghostScore, ageSignal, titleFuzzSignal } = require('../lib/ghost-score');
const { searchCountry } = require('../lib/slug-harvest');

const params = (url) => new URL(url).searchParams;

test('linkedin search URL follows the discovery policy', () => {
  const q = params(linkedin.buildSearchUrl({ keywords: 'tax accountant', start: 25 }));
  assert.equal(q.get('keywords'), 'tax accountant');
  assert.equal(q.get('geoId'), linkedin.US_GEO_ID);
  assert.equal(q.get('f_WT'), '2,3', 'remote and hybrid facets');
  assert.equal(q.get('f_TPR'), linkedin.DATE_FILTERS.week, 'closest preset to a 10 day window');
  assert.equal(q.get('start'), '25');
});

test('linkedin search URL with no policy has no work mode facet and no geo restriction', () => {
  const none = { usOnly: false, workModes: [], maxAgeDays: 30 };
  const q = params(linkedin.buildSearchUrl({ keywords: 'registered nurse', filters: none }));
  assert.equal(q.has('f_WT'), false);
  assert.equal(q.has('geoId'), false);
  assert.equal(q.has('distance'), false);
  assert.equal(q.get('f_TPR'), linkedin.DATE_FILTERS.month);
  assert.equal(params(linkedin.buildSearchUrl({ keywords: 'x', filters: { ...none, maxAgeDays: 90 } })).has('f_TPR'), false);

  // Explicit arguments win over the policy.
  const forced = params(linkedin.buildSearchUrl({ keywords: 'x', remote: true, geoId: null, datePosted: 'day' }));
  assert.equal(forced.get('f_WT'), '2');
  assert.equal(forced.has('geoId'), false);
  assert.equal(forced.get('f_TPR'), linkedin.DATE_FILTERS.day);
  assert.equal(params(linkedin.buildSearchUrl({ keywords: 'x', remote: false })).has('f_WT'), false);
  assert.throws(() => linkedin.buildSearchUrl({}), /keywords required/);
  assert.deepEqual([1, 7, 12, 30, 31, 0].map(linkedin.datePreset), ['day', 'week', 'week', 'month', 'any', 'any']);
});

test('linkedin queries come from the seeds and skip titles the policy excludes', () => {
  assert.deepEqual(linkedin.profileQueries(), ['Tax Accountant', 'Senior Tax Accountant', 'Internal Audit Associate']);
  const nurse = workspace({ 'data/queries/seeds.json': { queries: [{ query: 'Registered Nurse' }, { query: 'Charge Nurse' }] } });
  assert.deepEqual(linkedin.profileQueries({ root: nurse }), ['Registered Nurse', 'Charge Nurse']);
  assert.deepEqual(linkedin.profileQueries({ root: workspace() }), []);
});

test('sync check reads the ledger path from the profile; a missing ledger is a warning, not a failure', () => {
  const evidence = (r) => r.warnings.filter((w) => /my-evidence\.md/.test(w));
  const missing = runSyncCheck();
  assert.equal(missing.ok, true);
  assert.deepEqual(evidence(missing), ['data/my-evidence.md not found. Portfolio evidence unavailable.']);

  const ledger = path.join(root, 'data', 'my-evidence.md');
  fs.writeFileSync(ledger, 'one\ntwo\nthree\n');
  assert.match(evidence(runSyncCheck())[0], /my-evidence\.md exists but seems thin \(4 lines\)/);

  fs.writeFileSync(ledger, Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'));
  const full = runSyncCheck();
  assert.equal(full.ok, true);
  assert.deepEqual(evidence(full), []);
});

test('ghost score: senior headroom is the user setting, default none', () => {
  const posting = { title: 'Senior Tax Accountant', postedDate: new Date(Date.now() - 40 * 86400000).toISOString() };
  assert.ok(ageSignal(posting) > 0, 'no headroom unless one is passed');
  assert.equal(ageSignal(posting, { seniorityExtensionDays: 15 }), 0);
  assert.equal(ghostScore(posting).signals.age, 0, 'profile sets 15 days of headroom');
  assert.ok(ghostScore(posting, { seniorityExtensionDays: 0 }).signals.age > 0, 'an explicit value wins');
  assert.ok(ghostScore({ ...posting, title: 'Tax Accountant' }).signals.age > 0, 'headroom is for senior titles only');
});

test('ghost score: the age baseline follows the recency window; a window of 0 turns it off', () => {
  const at = (days) => ({ title: 'Registered Nurse, Medical Surgical', postedDate: new Date(Date.now() - days * 86400000).toISOString() });
  assert.equal(ghostScore(at(50), { maxAgeDays: 30 }).label, 'Suspicious');
  assert.equal(ghostScore(at(50), { maxAgeDays: 60 }).label, 'High Confidence');
  assert.equal(ghostScore(at(58), { maxAgeDays: 90 }).label, 'High Confidence');
  assert.equal(ghostScore(at(50), { maxAgeDays: 0 }).signals.age, 0);
  assert.equal(ghostScore(at(400), { maxAgeDays: 0 }).signals.age, 0);
  assert.equal(ghostScore({ title: 'Tax Accountant, Partnerships' }, { maxAgeDays: 0 }).signals.age, 0.1, 'undated stays mildly suspect');
  // A narrow window keeps the 30 day baseline (this workspace sets 10 days).
  assert.equal(ghostScore(at(25)).signals.age, 0);
  assert.ok(ghostScore(at(50)).signals.age >= 0.6);
  assert.equal(ageSignal(at(50)), ageSignal(at(50), { maxAgeDays: 30 }), 'default baseline is 30 days');
});

test('linkedin cards: location and pay are read for any country, not only US shaped text', () => {
  const card = (ref, title, company, location, pay, id) => [
    `listitem [ref_${ref}]`,
    `  link "${title} with verification" [ref_${ref + 1}] href="/jobs/view/${id}/?trk=x"`,
    `  image "${company} logo"`,
    `  generic "${title}"`,
    `  generic "${company}"`,
    `  generic "${location}"`,
    ...(pay ? [`  generic "${pay}"`] : []),
    '  generic "2 days ago"',
  ].join('\n');
  const cards = linkedin.parseSearchCards([
    card(10, 'Staff Nurse', 'Northgate Infirmary', 'Manchester, England, United Kingdom (Hybrid)', '\u00a332K/yr - \u00a338K/yr', 9001),
    card(20, 'Tax Accountant', 'Ledger and Finch', 'Denver, CO (On-site)', '$70K/yr - $85K/yr', 9002),
    card(30, 'Registered Nurse', 'Lakeside Hospital', 'Toronto, Ontario, Canada (On-site)', '', 9003),
    card(40, 'Manager, Tax (Remote)', 'Area Nine Group', 'United Kingdom (Remote)', '', 9004),
  ].join('\n'));
  assert.deepEqual(cards.map((c) => [c.title, c.company, c.location, c.compensation]), [
    ['Staff Nurse', 'Northgate Infirmary', 'Manchester, England, United Kingdom (Hybrid)', '\u00a332K/yr - \u00a338K/yr'],
    ['Tax Accountant', 'Ledger and Finch', 'Denver, CO (On-site)', '$70K/yr - $85K/yr'],
    ['Registered Nurse', 'Lakeside Hospital', 'Toronto, Ontario, Canada (On-site)', null],
    ['Manager, Tax (Remote)', 'Area Nine Group', 'United Kingdom (Remote)', null],
  ]);
});

test('ghost score: a bare title with no level is mildly generic in any field', () => {
  assert.equal(titleFuzzSignal({ title: 'Registered Nurse' }), 0.15);
  assert.equal(titleFuzzSignal({ title: 'Accountant' }), 0.15);
  assert.equal(titleFuzzSignal({ title: 'Senior Accountant' }), 0);
  assert.equal(titleFuzzSignal({ title: 'Registered Nurse II' }), 0);
  assert.equal(titleFuzzSignal({ title: 'Tax Accountant, Partnerships' }), 0);
  assert.equal(titleFuzzSignal({ title: 'Nursing Talent Network' }), 0.8);
  assert.equal(ghostScore({ title: 'Registered Nurse', postedDate: new Date().toISOString() }).label, 'High Confidence');
});

test('slug harvest search market follows a single country policy', () => {
  assert.equal(searchCountry(['US']), 'us');
  assert.equal(searchCountry(['CA', 'Canada']), 'ca', 'a code and its name are one country');
  assert.equal(searchCountry(['Canada', 'CA']), 'ca');
  assert.equal(searchCountry(['GB', 'United Kingdom']), 'gb');
  assert.equal(searchCountry(['CA', 'Canada', 'GB', 'United Kingdom']), null, 'several countries leave the market unset');
  assert.equal(searchCountry(['Canada']), 'ca', 'a name alone resolves to its code');
  assert.equal(searchCountry(['UK']), 'gb', 'an everyday alias resolves to the ISO code');
  assert.equal(searchCountry(['United Kingdom']), 'gb');
  assert.equal(searchCountry(['UK', 'Ireland']), null);
  assert.equal(searchCountry(['Denver']), null, 'a place that is no country sets no market');
  assert.equal(searchCountry([]), null);
  assert.equal(searchCountry(undefined), null);
});
