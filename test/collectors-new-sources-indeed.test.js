'use strict';
// collectors/sources/aggregators/indeed-camoufox.js: pure helpers plus the
// opt in gate. No browser is launched and no network is touched. Fixtures are
// synthetic (a registered nurse search and a tax accountant search).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-new-sources-indeed-'));
fs.mkdirSync(path.join(root, 'data', 'queries'), { recursive: true });
const seeds = [{ query: 'Registered Nurse', location: 'Chicago, IL' }, { query: 'Tax Accountant', location: '' }];
fs.writeFileSync(path.join(root, 'data', 'queries', 'seeds.json'), JSON.stringify({ queries: seeds }));
process.env.JOBE_USER_ROOT = root;

const source = require('../collectors/sources/aggregators/indeed-camoufox');
const { dedup } = require('../lib/dedup');
const { buildProfile, quickScore } = require('../lib/rank');

const {
  buildSearchUrl,
  canonicalIndeedUrl,
  chooseDirectEmployerUrl,
  dedupeRecords,
  isChallengePage,
  normalizeCardRecord,
  normalizePostedText,
  recordToPosting,
  selectQueries,
  sourceEnabled,
} = source.__test;

test('search URL carries query, remote, recency, and pagination filters when the policy is remote', () => {
  const url = new URL(buildSearchUrl(
    { query: 'Registered Nurse', location: 'Chicago, IL' },
    { remoteOnly: true, maxAgeDays: 10 },
    2,
  ));
  assert.equal(url.origin, 'https://www.indeed.com');
  assert.equal(url.searchParams.get('q'), 'Registered Nurse');
  assert.equal(url.searchParams.get('l'), 'Remote');
  assert.equal(url.searchParams.get('fromage'), '10');
  assert.equal(url.searchParams.get('sort'), 'date');
  assert.match(url.searchParams.get('sc'), /attr\(DSQF7\)/);
  assert.equal(url.searchParams.get('start'), '20');
});

test('with no work mode policy the search uses the seed location and no remote facet', () => {
  const onsite = new URL(buildSearchUrl({ query: 'Registered Nurse', location: 'Chicago, IL' }, {}));
  assert.equal(onsite.searchParams.get('l'), 'Chicago, IL');
  assert.equal(onsite.searchParams.get('sc'), null);
  assert.equal(onsite.searchParams.get('fromage'), '30');
  assert.equal(onsite.searchParams.get('start'), null);

  const nowhere = new URL(buildSearchUrl({ query: 'Tax Accountant', location: '' }, { remoteOnly: false, maxAgeDays: 7 }));
  assert.equal(nowhere.searchParams.has('l'), false, 'no location is invented for a seed without one');
  assert.equal(nowhere.searchParams.get('fromage'), '7');
});

test('query selection accepts pipeline objects, removes duplicates, and stays bounded', () => {
  assert.deepEqual(selectQueries([
    { query: 'Registered Nurse', location: 'Chicago, IL' },
    { query: ' registered nurse ', location: 'Remote' },
    'Tax Accountant',
    { query: 'Payroll Specialist', location: 'Remote' },
  ], 2), [
    { query: 'Registered Nurse', location: 'Chicago, IL' },
    { query: 'Tax Accountant', location: '' },
  ]);
  assert.deepEqual(selectQueries([], 3), []);
  assert.deepEqual(selectQueries(undefined, 3), []);
});

test('relative posting text is normalized and parsed by Posting', () => {
  assert.equal(normalizePostedText('Employer Active 3 days ago'), '3 days ago');
  const record = normalizeCardRecord({
    jk: 'abc123',
    title: ' Registered Nurse, Telehealth ',
    company: ' Mercy West Health ',
    location: 'Remote',
    postedDate: 'Employer Active 3 days ago',
    detailLoaded: true,
    jdText: 'This role is remote within the country. Triage patients by phone and video.',
  });
  const posting = recordToPosting(record, 'https://www.indeed.com/jobs?q=nurse', 'Registered Nurse');
  const ageDays = (Date.now() - new Date(posting.postedDate).getTime()) / 86400000;
  assert.ok(ageDays > 2.9 && ageDays < 3.1);
  assert.equal(posting.remote, 'remote');
  assert.equal(posting.remoteVerified, true);
  assert.equal(posting.us, null);
  assert.equal(posting.discoveredVia[0].source, 'indeed-camoufox');
});

test('the Indeed job key is retained while a direct ATS URL is preferred', () => {
  const indeedUrl = canonicalIndeedUrl('/rc/clk?jk=abc123&from=serp', null);
  assert.equal(indeedUrl, 'https://www.indeed.com/viewjob?jk=abc123');
  const direct = chooseDirectEmployerUrl([
    'https://www.indeed.com/applystart?jk=abc123',
    'https://boards.greenhouse.io/example/jobs/12345?gh_src=indeed',
  ]);
  assert.equal(direct, 'https://boards.greenhouse.io/example/jobs/12345?gh_src=indeed');

  const record = normalizeCardRecord({
    jk: 'abc123',
    url: '/viewjob?jk=abc123&from=serp',
    title: 'Tax Accountant',
    company: 'Ledgerline Partners',
    location: 'Remote - United States',
    externalUrls: [direct],
  });
  const posting = recordToPosting(record, 'https://www.indeed.com/jobs?q=tax', 'Tax Accountant');
  assert.equal(posting.canonicalUrl, 'https://boards.greenhouse.io/example/jobs/12345');
  assert.ok(posting.alternateUrls.includes('https://www.indeed.com/viewjob?jk=abc123'));
});

test('duplicate cards collapse by job key and prefer the record with JD text', () => {
  const records = dedupeRecords([
    { jk: 'same-key', title: 'Tax Accountant', company: 'Ledgerline Partners', location: 'Remote', postedDate: 'Today', externalUrls: ['https://jobs.example.com/careers/tax-accountant'] },
    { jk: 'same-key', title: 'Tax Accountant', company: 'Ledgerline Partners', location: 'Remote', postedDate: 'Today', detailLoaded: true, jdText: 'This position is remote.' },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].jdText, 'This position is remote.');
  assert.equal(records[0].directUrl, 'https://jobs.example.com/careers/tax-accountant');
});

test('verification and access denied pages are detected without false positives', () => {
  assert.equal(isChallengePage({ title: 'Security Check - Indeed.com', text: 'Additional Verification Required. Your Ray ID for this request is 123.' }), true);
  assert.equal(isChallengePage({ title: 'Registered Nurse Jobs', text: 'Find jobs Company reviews Remote registered nurse tax accountant' }), false);
});

test('a remote label seen only on the card stays unverified', () => {
  const record = normalizeCardRecord({
    jk: 'unverified123',
    title: 'Registered Nurse',
    company: 'Mercy West Health',
    location: 'Remote',
    detailLoaded: true,
    jdText: 'Benefits include flexible work options.',
  });
  assert.equal(record.remoteVerified, false);
});

test('the source is off by default and runs only on an explicit opt in', async () => {
  assert.equal(sourceEnabled({}), false);
  assert.equal(sourceEnabled({ INDEED_CAMOUFOX_ENABLED: '' }), false);
  assert.equal(sourceEnabled({ INDEED_CAMOUFOX_ENABLED: '0' }), false);
  assert.equal(sourceEnabled({ INDEED_CAMOUFOX_ENABLED: 'false' }), false);
  assert.equal(sourceEnabled({ INDEED_CAMOUFOX_ENABLED: '1' }), true);
  assert.equal(sourceEnabled({ INDEED_CAMOUFOX_ENABLED: 'true' }), true);
  assert.deepEqual(source.requires, ['INDEED_CAMOUFOX_ENABLED']);

  const previous = process.env.INDEED_CAMOUFOX_ENABLED;
  const realFetch = global.fetch;
  let fetched = 0;
  global.fetch = async () => { fetched++; throw new Error('network disabled in tests'); };
  const messages = [];
  const logger = { info: msg => messages.push(msg), warn: msg => messages.push(msg), error: msg => messages.push(msg) };
  try {
    // Default: off, even with usable queries. No browser, no network.
    delete process.env.INDEED_CAMOUFOX_ENABLED;
    assert.deepEqual(await source.discover({ queries: seeds, filters: { remoteOnly: true, maxAgeDays: 10 }, logger }), []);
    assert.match(messages.join(' '), /off by default.*INDEED_CAMOUFOX_ENABLED=1/);

    // Opted in but no seed roles: returns before the browser is ever loaded.
    process.env.INDEED_CAMOUFOX_ENABLED = '1';
    messages.length = 0;
    assert.deepEqual(await source.discover({ queries: [], filters: {}, logger }), []);
    assert.match(messages.join(' '), /no seed roles/);
    assert.equal(fetched, 0);
  } finally {
    global.fetch = realFetch;
    if (previous == null) delete process.env.INDEED_CAMOUFOX_ENABLED;
    else process.env.INDEED_CAMOUFOX_ENABLED = previous;
  }
});

test('loading the plugin does not load the browser launcher', () => {
  const loaded = Object.keys(require.cache).filter(f => /lib[\\/]apply[\\/]camoufox\.js$/.test(f));
  assert.deepEqual(loaded, []);
});

test('canonical postings flow through dedup and quick ranking unchanged', () => {
  const record = normalizeCardRecord({
    jk: 'flow123',
    title: 'Senior Tax Accountant',
    company: 'Ledgerline Partners',
    location: 'Remote - United States',
    postedDate: 'Today',
    detailLoaded: true,
    jdText: 'This role is remote in the United States. Prepare federal and state returns.',
  });
  const posting = recordToPosting(record, 'https://www.indeed.com/jobs?q=tax', 'Tax Accountant');
  const merged = dedup([posting, posting]);
  assert.equal(merged.length, 1);
  const profile = buildProfile({ queries: seeds, root });
  assert.doesNotThrow(() => quickScore(merged[0], { profile }));
  assert.equal(typeof merged[0].quickScore, 'number');
  assert.equal(merged[0].canonicalUrl, 'https://www.indeed.com/viewjob?jk=flow123');
});
