'use strict';
// scripts/classify-gate.js and scripts/verify-listing.js: apply gate
// classification and listing verification. Synthetic employers from two
// unrelated fields (a hospital hiring nurses, a firm hiring tax accountants).
// fetch is replaced by a route table; nothing here touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function workspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-discovery-gate-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

process.env.JOBE_USER_ROOT = workspace();
const { classify, verifyGreenhouseBoard } = require('../scripts/classify-gate');
const { parseUrl, remoteFrom, remoteVerdict, titleSim, verify } = require('../scripts/verify-listing');
const { detectAts } = require('../lib/apply/filler');

// Route table fetch: the first route whose needle is in the URL answers; any
// other URL is a 404, so a missed route can never reach a real host.
function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const hit = routes.find(([needle]) => u.includes(needle));
    if (hit && hit[1].throws) throw new Error('The operation was aborted due to timeout');
    const { status = 200, json, text } = hit ? hit[1] : { status: 404 };
    return {
      ok: status >= 200 && status < 300, status, url: u,
      json: async () => json,
      text: async () => (text !== undefined ? text : JSON.stringify(json || '')),
    };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const UUID = '0a1b2c3d-1111-2222-3333-444455556666';

test('classify: boards the filler completes are not gated', () => {
  const gh = classify('https://boards.greenhouse.io/lakeviewhospital/jobs/4012345');
  assert.deepEqual([gh.gated, gh.gateType, gh.board], [false, 'greenhouse', 'lakeviewhospital']);
  const eu = classify('https://job-boards.eu.greenhouse.io/harbortax/jobs/555');
  assert.deepEqual([eu.gated, eu.gateType, eu.board], [false, 'greenhouse', 'harbortax']);
  const embed = classify('https://boards.greenhouse.io/embed/job_app?for=harbortax&token=555');
  assert.deepEqual([embed.gated, embed.board], [false, 'harbortax']);
  assert.equal(classify(`https://jobs.lever.co/lakeview/${UUID}`).gateType, 'lever');
  assert.equal(classify(`https://jobs.ashbyhq.com/harbortax/${UUID}`).gated, false);
});

test('classify: account walls, unsupported systems, job boards and unknown sites are gated', () => {
  const cases = [
    ['https://lakeview.wd5.myworkdayjobs.com/en-US/careers/job/Registered-Nurse_R1', 'workday'],
    ['https://careers-lakeview.icims.com/jobs/1234/registered-nurse/job', 'icims'],
    ['https://jobs.smartrecruiters.com/HarborTax/999-senior-tax-accountant', 'smartrecruiters'],
    ['https://harbortax.bamboohr.com/careers/42', 'bamboohr'],
    ['https://apply.workable.com/harbor-tax/j/ABC123/', 'workable'],
    ['https://www.linkedin.com/jobs/view/tax-accountant-at-harbor-tax-1234567890', 'aggregator-unresolved'],
    ['https://www.indeed.com/viewjob?jk=abc', 'aggregator-unresolved'],
    ['https://www.lakeviewhospital.example/careers/rn-icu', 'custom-site'],
  ];
  for (const [url, gateType] of cases) {
    const g = classify(url);
    assert.equal(g.gated, true, url);
    assert.equal(g.gateType, gateType, url);
    assert.ok(g.reason, url);
  }
  assert.equal(classify('').gateType, 'custom-site');
  assert.equal(classify(undefined).gated, true);
});

test('classify agrees with what the apply filler supports', () => {
  const samples = [
    'https://boards.greenhouse.io/lakeviewhospital/jobs/1',
    `https://jobs.lever.co/lakeview/${UUID}`,
    `https://jobs.ashbyhq.com/harbortax/${UUID}`,
    'https://lakeview.wd1.myworkdayjobs.com/x/job/1',
    'https://jobs.smartrecruiters.com/HarborTax/1',
    'https://careers-lakeview.icims.com/jobs/1/job',
    'https://jobs.jobvite.com/harbortax/job/o1',
  ];
  for (const url of samples) {
    const supported = ['greenhouse', 'lever', 'ashby'].includes(detectAts(url));
    assert.equal(!classify(url).gated, supported, url);
  }
});

test('classify: an employer domain fronting Greenhouse yields board candidates to verify', () => {
  const g = classify('https://careers.example.com/jobs/rn-icu?gh_jid=123');
  assert.equal(g.gated, false);
  assert.equal(g.gateType, 'greenhouse-embed');
  assert.equal(g.ghJid, '123');
  assert.ok(g.boardCandidates.includes('example'));
  assert.match(g.applyUrl, /greenhouse\.io\/embed\/job_app\?for=example&token=123$/);
  // Host shapes whose board is not the bare label still offer the stripped form.
  assert.ok(classify('https://harbortaxcareers.com/open?gh_jid=9').boardCandidates.includes('harbortax'));
  assert.ok(classify('https://withlakeview.org/open?gh_jid=9').boardCandidates.includes('lakeview'));
});

test('classify: the user wrapper map names the first board candidate', () => {
  const before = process.env.JOBE_USER_ROOT;
  process.env.JOBE_USER_ROOT = workspace({ 'data/apply-wrappers.json': { 'careers.example.com': 'lakeviewhealth' } });
  try {
    const g = classify('https://careers.example.com/jobs/rn-icu?gh_jid=123');
    assert.equal(g.boardCandidates[0], 'lakeviewhealth');
    assert.ok(g.boardCandidates.includes('example'));
    assert.match(g.applyUrl, /for=lakeviewhealth&token=123/);
  } finally { process.env.JOBE_USER_ROOT = before; }
});

test('verifyGreenhouseBoard returns the first candidate that serves the job id', async () => {
  const f = stubFetch([['/boards/lakeviewhealth/jobs/123', { json: { title: 'x' } }]]);
  try {
    assert.equal(await verifyGreenhouseBoard(['example', 'lakeviewhealth'], '123'), 'lakeviewhealth');
    assert.equal(await verifyGreenhouseBoard(['example'], '123'), null);
    assert.equal(await verifyGreenhouseBoard([], '123'), null);
  } finally { f.restore(); }
});

test('parseUrl recognizes each listing shape', () => {
  assert.deepEqual(parseUrl('https://boards.greenhouse.io/lakeviewhospital/jobs/4012345'),
    { ats: 'greenhouse', board: 'lakeviewhospital', id: '4012345', eu: false });
  assert.deepEqual(parseUrl('https://job-boards.eu.greenhouse.io/harbortax/jobs/555?gh_src=x'),
    { ats: 'greenhouse', board: 'harbortax', id: '555', eu: true });
  assert.deepEqual(parseUrl('https://boards.greenhouse.io/embed/job_app?for=harbortax&token=555'),
    { ats: 'greenhouse', board: 'harbortax', id: '555', eu: false });
  const guessed = parseUrl('https://careers.example.com/jobs/rn-icu?gh_jid=123');
  assert.equal(guessed.ats, 'greenhouse');
  assert.equal(guessed.id, '123');
  assert.equal(guessed.guessed, true);
  assert.ok(guessed.candidates.includes('example'));
  assert.deepEqual(parseUrl(`https://jobs.ashbyhq.com/Harbor%20Tax/${UUID}`), { ats: 'ashby', board: 'Harbor Tax', id: UUID });
  assert.deepEqual(parseUrl(`https://jobs.lever.co/lakeview/${UUID}/apply`), { ats: 'lever', board: 'lakeview', id: UUID });
  assert.deepEqual(parseUrl('https://lakeview.wd5.myworkdayjobs.com/x/job/1'), { ats: 'other' });
  assert.deepEqual(parseUrl(), { ats: 'other' });
});

test('remoteFrom: location and workplace fields first, then JD text, then the ATS flag', () => {
  assert.equal(remoteFrom('Columbus, OH'), 'onsite');
  assert.equal(remoteFrom('Remote - US'), 'remote');
  assert.equal(remoteFrom('Denver, CO (Hybrid)'), 'hybrid');
  assert.equal(remoteFrom('Denver, CO', '', null, 'On-site'), 'onsite');
  assert.equal(remoteFrom('Denver, CO', '', null, 'remote'), 'remote');
  assert.equal(remoteFrom('', 'This is a fully remote position.'), 'remote');
  assert.equal(remoteFrom('', ''), 'unknown');
  assert.equal(remoteFrom('', '', true), 'remote');
  assert.equal(remoteFrom('', '', false), 'onsite');
  // The flag is the weakest signal: JD text that says hybrid beats flag=true.
  assert.equal(remoteFrom('', 'Hybrid: three days a week on the unit.', true), 'hybrid');
  assert.equal(remoteFrom('Denver, CO', 'Clients are served in a hybrid model.', true), 'hybrid');
});

test('remoteVerdict: a remote flag or a remote field yields to a hybrid statement in the title or JD', () => {
  const days = 'You will work 3 days per week in the office.';
  assert.deepEqual(remoteVerdict('Columbus, OH', days, true), ['hybrid', false]);
  assert.deepEqual(remoteVerdict('United States', days, true), ['hybrid', false]);
  assert.deepEqual(remoteVerdict('Columbus, OH', 'Join our team.', true, null, 'Analyst (Hybrid)'), ['hybrid', false]);
  assert.deepEqual(remoteVerdict('', '', true), ['remote', false]);
  // "Flexible" in a location is not a JD statement: the flag stands.
  assert.deepEqual(remoteVerdict('Flexible', 'Prepare returns.', true), ['remote', false]);
  assert.deepEqual(remoteVerdict('', 'Fully remote. Must be located in the United States.', true), ['remote', false]);
  // The same statement beats a remote location or workplace field, as in the pipeline label.
  assert.deepEqual(remoteVerdict('Remote', days), ['hybrid', false]);
  assert.deepEqual(remoteVerdict('Denver, CO', days, null, 'remote', 'Staff Nurse'), ['hybrid', false]);
  assert.deepEqual(remoteVerdict('Remote - US', 'Triage patients by phone.'), ['remote', false]);
});

test('remoteVerdict: home based wording is remote only when it is the whole place', () => {
  assert.deepEqual(remoteVerdict('Home Based, UK'), ['remote', false]);
  assert.deepEqual(remoteVerdict('Homeworking'), ['remote', false]);
  assert.equal(remoteFrom('Home Based Primary Care, Denver, CO'), 'onsite');
  assert.equal(remoteFrom('Nursing Home, Leeds'), 'onsite');
});

test('remoteFrom reads the title and JD the way the pipeline does before guessing from a bare location', () => {
  assert.equal(remoteFrom('United States', 'This role is remote. You will care for patients by phone.'), 'remote');
  assert.equal(remoteFrom('Anywhere', 'Location: Remote (United States)'), 'remote');
  assert.equal(remoteFrom('United States', 'Prepare returns.', null, null, 'Senior Accountant (Remote)'), 'remote');
  assert.equal(remoteFrom('United States', 'Join our team.'), 'onsite');
  // A named city is never flipped to remote by the JD or the title.
  assert.equal(remoteFrom('New York, NY', 'This role is remote.'), 'onsite');
  assert.equal(remoteFrom('New York, NY', 'Prepare returns.', null, null, 'Senior Accountant (Remote)'), 'onsite');
  assert.equal(remoteFrom('United States', 'You will work 3 days per week in the office.'), 'hybrid');
  // The order above is intact: JD text before the flag, the flag before the pipeline reading.
  assert.equal(remoteFrom('United States', 'Our ledger runs on a hybrid cloud.', true), 'hybrid');
  assert.equal(remoteFrom('United States', 'This role is remote.', false), 'onsite');
});

test('remoteVerdict marks a coarse reading as a guess and a stated mode as firm', () => {
  const guess = (...a) => remoteVerdict(...a);
  // Firm: the ATS field, a phrase level reading, the flag, a named city.
  assert.deepEqual(guess('Remote - US'), ['remote', false]);
  assert.deepEqual(guess('Denver, CO (Hybrid)'), ['hybrid', false]);
  assert.deepEqual(guess('Denver, CO', '', null, 'On-site'), ['onsite', false]);
  assert.deepEqual(guess('United States', 'This is a hybrid role: 3 days per week in the office.'), ['hybrid', false]);
  assert.deepEqual(guess('United States', 'This role is remote.'), ['remote', false]);
  assert.deepEqual(guess('', '', true), ['remote', false]);
  assert.deepEqual(guess('', '', false), ['onsite', false]);
  assert.deepEqual(guess('Columbus, OH', 'Care for patients on the unit.'), ['onsite', false]);
  assert.deepEqual(guess('', ''), ['unknown', false]);
  // Guesses: both modes offered, a bare word, a loose phrase beside a city, a country alone.
  assert.deepEqual(guess('Columbus, OH (Hybrid); United States (Remote)'), ['hybrid', true]);
  assert.deepEqual(guess('United States', 'Our ledger runs on a hybrid cloud.'), ['hybrid', true]);
  assert.deepEqual(guess('Columbus, OH', 'We are a remote-first clinic network.'), ['remote', true]);
  assert.deepEqual(guess('United States', 'Join our team.'), ['onsite', true]);
  // An unconfirmed bare word yields to the pipeline's phrase level remote reading,
  // still as a guess; it never yields to the ATS flag or to a named city.
  assert.deepEqual(guess('United States', 'This role is remote. You will migrate workloads to our hybrid cloud platform.'), ['remote', true]);
  assert.deepEqual(guess('United States', 'Our ledger runs on a hybrid cloud.', null, null, 'Senior Accountant (Remote)'), ['remote', true]);
  assert.deepEqual(guess('Denver, CO', 'Registered Nurse. Hybrid cloud.', true), ['hybrid', true]);
  assert.deepEqual(guess('Denver, CO', 'This role is remote. Hybrid cloud.'), ['hybrid', true]);
  assert.deepEqual(guess('United States', 'This role is remote. Hybrid: 3 days per week in the office.'), ['hybrid', false]);
  // A JD residence rule with no city in the location (the rendered page path
  // passes no location) is a guess; beside a named city it stays firm.
  const residence = 'Telehealth Registered Nurse. This is a remote position. Candidates must be located in the United States and hold a compact licence.';
  assert.deepEqual(guess('', residence), ['onsite', true]);
  assert.deepEqual(guess('United States', 'Senior Tax Accountant. Must be based in the US or Canada.'), ['onsite', true]);
  assert.deepEqual(guess('Columbus, OH', residence), ['onsite', false]);
  assert.deepEqual(guess('', 'You will work 3 days per week in the office.'), ['hybrid', false]);
});

test('titleSim is a Jaccard over title words', () => {
  assert.equal(titleSim('Registered Nurse, ICU', 'Registered Nurse ICU'), 1);
  assert.equal(titleSim('Senior Tax Accountant', 'Registered Nurse'), 0);
  assert.equal(titleSim('', 'Registered Nurse'), 0);
  const partial = titleSim('Senior Tax Accountant', 'Tax Accountant');
  assert.ok(partial > 0.6 && partial < 0.7);
});

test('a list that does not exist yet is a hint and exit 0, like the other helpers; no argument is a usage error', () => {
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'verify-listing.js');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, JOBE_USER_ROOT: workspace() } });
  const missing = run(path.join(workspace(), 'ranked-enriched.json'));
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /no list at .*run \/jobe find first/);
  assert.equal(run().status, 1);
});

test('verify: Greenhouse reports the ORIGINAL publish date, not the last update', async () => {
  const f = stubFetch([['/boards/harbortax/jobs/555', { json: {
    title: 'Senior Tax Accountant', location: { name: 'Remote - US' }, content: '<p>Prepare returns.</p>',
    first_published: '2031-01-05T00:00:00Z', updated_at: '2031-03-20T00:00:00Z',
    pay_input_ranges: [{ min_cents: 9000000, max_cents: 11000000 }],
  } }]]);
  try {
    const v = await verify({ title: 'Senior Tax Accountant', canonicalUrl: 'https://boards.greenhouse.io/harbortax/jobs/555' });
    assert.equal(v.status, 'ok');
    assert.equal(v.stillOpen, true);
    assert.equal(v.postedDate, '2031-01-05T00:00:00Z');
    assert.equal(v.remote, 'remote');
    assert.equal(v.titleSim, 1);
    assert.equal(v.comp, '90000-110000');
  } finally { f.restore(); }
});

test('verify: the ATS record own title and JD are read, and a bare country location is marked as a guess', async () => {
  const job = (title, content) => ({ json: { title, location: { name: 'United States' }, content } });
  const f = stubFetch([
    ['/boards/harbortax/jobs/601', job('Senior Tax Accountant (Remote)', '<p>Prepare returns.</p>')],
    ['/boards/harbortax/jobs/602', job('Triage Nurse', '<p>This role is remote. You will care for patients by phone.</p>')],
    ['/boards/harbortax/jobs/603', job('Triage Nurse', '<p>Join our team.</p>')],
  ]);
  try {
    const at = (id) => verify({ title: 'Recorded Title', canonicalUrl: `https://boards.greenhouse.io/harbortax/jobs/${id}` });
    const byTitle = await at(601);
    assert.equal(byTitle.remote, 'remote');
    assert.equal('remoteGuess' in byTitle, false);
    assert.equal((await at(602)).remote, 'remote');
    const bare = await at(603);
    assert.equal(bare.remote, 'onsite');
    assert.equal(bare.remoteGuess, true);
  } finally { f.restore(); }
});

test('verify: a named Greenhouse board that 404s is gone', async () => {
  const f = stubFetch([]);
  try {
    const v = await verify({ title: 'Registered Nurse', canonicalUrl: 'https://boards.greenhouse.io/lakeviewhospital/jobs/777' });
    assert.equal(v.status, 'gone');
    assert.equal(v.stillOpen, false);
  } finally { f.restore(); }
});

test('verify: a fetch failure is never gone; only a 404 or 410 from the listing own API is', async () => {
  const gh = { title: 'Registered Nurse', canonicalUrl: 'https://boards.greenhouse.io/lakeviewhospital/jobs/777' };
  const lever = { title: 'Tax Accountant', canonicalUrl: `https://jobs.lever.co/harbortax/${UUID}` };
  const run = async (routes, p) => { const f = stubFetch(routes); try { return await verify(p); } finally { f.restore(); } };
  const pair = (v) => [v.status, v.stillOpen];
  // The first host fails and the second says 404: unknown, not gone.
  assert.deepEqual(pair(await run([['boards-api.greenhouse.io', { status: 503 }], ['boards-api.eu.greenhouse.io', { status: 404 }]], gh)), ['needs-agent', null]);
  assert.deepEqual(pair(await run([['boards-api.greenhouse.io', { throws: true }], ['boards-api.eu.greenhouse.io', { status: 404 }]], gh)), ['needs-agent', null]);
  assert.deepEqual(pair(await run([['greenhouse.io', { status: 429 }]], gh)), ['needs-agent', null]);
  // The first host says 404 and the second cannot be reached: gone.
  assert.deepEqual(pair(await run([['boards-api.eu.greenhouse.io', { throws: true }]], gh)), ['gone', false]);
  // A listing on the second host is found there.
  const eu = await run([['boards-api.eu.greenhouse.io', { json: { title: 'Registered Nurse', location: { name: 'Remote' }, content: '' } }]], gh);
  assert.deepEqual(pair(eu), ['ok', true]);
  assert.deepEqual(pair(await run([['api.lever.co', { status: 503 }]], lever)), ['needs-agent', null]);
  assert.deepEqual(pair(await run([['api.lever.co', { throws: true }]], lever)), ['needs-agent', null]);
  assert.deepEqual(pair(await run([['api.lever.co', { status: 404 }]], lever)), ['gone', false]);
  // A careers page with no API: a rate limit or server error page is not read as a listing.
  const page = { title: 'x', canonicalUrl: 'https://www.lakeviewhospital.example/careers/busy' };
  const filler = ' This position has been filled with filler text.'.repeat(80);
  assert.deepEqual(pair(await run([['/careers/busy', { status: 503, text: filler }]], page)), ['needs-agent', null]);
  assert.deepEqual(pair(await run([['/careers/busy', { status: 429, text: filler }]], page)), ['needs-agent', null]);
  assert.deepEqual(pair(await run([['/careers/busy', { throws: true }]], page)), ['needs-agent', null]);
});

test('verify: a guessed board that cannot be confirmed is handed over, not reported gone', async () => {
  const f = stubFetch([]);
  try {
    const v = await verify({ title: 'Registered Nurse, ICU', canonicalUrl: 'https://careers.example.com/jobs/rn-icu?gh_jid=123' });
    assert.equal(v.status, 'needs-agent');
    assert.equal(v.stillOpen, null);
    assert.match(v.detail, /not confirmed/);
  } finally { f.restore(); }
});

test('verify: a guessed board is confirmed against its candidates before use', async () => {
  const before = process.env.JOBE_USER_ROOT;
  process.env.JOBE_USER_ROOT = workspace({ 'data/apply-wrappers.json': { 'careers.example.com': 'lakeviewhealth' } });
  const f = stubFetch([['/boards/lakeviewhealth/jobs/123', { json: {
    title: 'Registered Nurse, ICU', location: { name: 'Columbus, OH' }, content: 'Twelve hour shifts on the unit.',
    first_published: '2031-02-01T00:00:00Z',
  } }]]);
  try {
    const v = await verify({ title: 'Registered Nurse - ICU', canonicalUrl: 'https://careers.example.com/jobs/rn-icu?gh_jid=123' });
    assert.equal(v.status, 'ok');
    assert.equal(v.board, 'lakeviewhealth');
    assert.equal(v.remote, 'onsite');
    assert.equal(v.location, 'Columbus, OH');
  } finally { f.restore(); process.env.JOBE_USER_ROOT = before; }
});

test('verify: Ashby trusts the JD over its remote flag, and a missing job is gone', async () => {
  const board = { jobs: [{
    jobUrl: `https://jobs.ashbyhq.com/harbortax/${UUID}`, title: 'Tax Accountant', location: 'Denver, CO',
    isRemote: true, descriptionPlain: 'A hybrid role: two days a week in the Denver office.', publishedAt: '2031-02-10T00:00:00Z',
    compensation: { compensationTierSummary: '$80K - $95K' },
  }] };
  const f = stubFetch([['job-board/harbortax', { json: board }], ['job-board/downboard', { status: 500 }]]);
  try {
    const v = await verify({ title: 'Tax Accountant', canonicalUrl: `https://jobs.ashbyhq.com/harbortax/${UUID}` });
    assert.equal(v.status, 'ok');
    assert.equal(v.remote, 'hybrid');
    assert.equal(v.comp, '$80K - $95K');
    const gone = await verify({ title: 'Tax Accountant', canonicalUrl: 'https://jobs.ashbyhq.com/harbortax/ffffffff-1111-2222-3333-444455556666' });
    assert.equal(gone.status, 'gone');
    const down = await verify({ title: 'Tax Accountant', canonicalUrl: `https://jobs.ashbyhq.com/downboard/${UUID}` });
    assert.equal(down.status, 'board-error');
    assert.equal(down.stillOpen, null);
  } finally { f.restore(); }
});

test('verify: Ashby workplaceType is the stated mode; the remote flag it also sets on hybrid jobs never overrides it', async () => {
  const id = (n) => `0a1b2c3d-1111-2222-3333-44445555000${n}`;
  const job = (n, o) => ({ jobUrl: `https://jobs.ashbyhq.com/northfield/${id(n)}`, descriptionPlain: 'Join our ward team.', publishedAt: '2031-02-10T00:00:00Z', ...o });
  const board = { jobs: [
    job(1, { title: 'Registered Nurse', location: 'Leeds', workplaceType: 'Hybrid', isRemote: true }),
    job(2, { title: 'Tax Accountant', location: 'Columbus, OH', workplaceType: 'Remote', isRemote: true, descriptionPlain: 'This is a hybrid role: 3 days per week in the office.' }),
    job(3, { title: 'Registered Nurse', location: 'Leeds', workplaceType: 'OnSite', isRemote: false }),
    job(4, { title: 'Tax Accountant', location: 'Columbus, OH', workplaceType: 'Remote', isRemote: true }),
    job(5, { title: 'Tax Accountant', location: 'Columbus, OH', isRemote: true }),
  ] };
  const f = stubFetch([['job-board/northfield', { json: board }]]);
  try {
    const rows = [];
    for (const [n, label] of [[1, 'hybrid'], [2, 'hybrid'], [3, 'onsite'], [4, 'remote'], [5, 'remote']]) {
      // The pipeline label, as the Ashby source folds the field into the location.
      const p = { title: board.jobs[n - 1].title, company: 'Northfield Care', canonicalUrl: board.jobs[n - 1].jobUrl, remote: label, location: board.jobs[n - 1].location };
      p.verify = await verify(p);
      rows.push(p);
    }
    assert.deepEqual(rows.map((p) => [p.verify.remote, p.verify.remoteGuess]), [['hybrid', undefined], ['hybrid', undefined], ['onsite', undefined], ['remote', undefined], ['remote', undefined]]);
    const { select, workMode } = require('../scripts/final-list');
    const opts = (workModes) => ({ filters: { workModes, countries: [], minScore: null, excludeStaffing: false }, excluded: new Set(), titlePolicy: { exclude: null, keep: null } });
    assert.equal(workMode(rows[0]), 'hybrid');
    assert.equal(select([rows[0]], opts(['remote'])).keep.length, 0);
    assert.equal(select([rows[0]], opts(['hybrid'])).keep.length, 1);
    assert.deepEqual(select(rows, opts(['remote'])).keep.map((p) => p.canonicalUrl), [board.jobs[3].jobUrl, board.jobs[4].jobUrl]);
  } finally { f.restore(); }
});

test('verify: a page with no API is checked for closed wording, and a thin page is handed over', async () => {
  const body = (s) => `<html><body>${s}${' filler text for the page body.'.repeat(80)}</body></html>`;
  const f = stubFetch([
    ['/careers/open', { text: body('<h1>Registered Nurse</h1><p>Work from home triage line.</p>') }],
    ['/careers/closed', { text: body('<p>This position has been filled.</p>') }],
    ['/careers/thin', { text: '<div id="app"></div>' }],
    ['/careers/missing', { status: 410, text: '' }],
  ]);
  try {
    const base = 'https://www.lakeviewhospital.example/careers/';
    const open = await verify({ title: 'Registered Nurse', canonicalUrl: base + 'open' });
    assert.deepEqual([open.status, open.stillOpen, open.remote], ['ok-page', true, 'remote']);
    assert.equal((await verify({ title: 'x', canonicalUrl: base + 'closed' })).status, 'closed');
    assert.equal((await verify({ title: 'x', canonicalUrl: base + 'thin' })).status, 'needs-agent');
    assert.equal((await verify({ title: 'x', canonicalUrl: base + 'missing' })).status, 'gone');
  } finally { f.restore(); }
});
