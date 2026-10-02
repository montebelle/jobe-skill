'use strict';
// scripts/resolve-linkedin-to-ats.js, scripts/verify-remote.js and
// scripts/linkedin-guest-sweep.js: the pure matching, stamping and parsing
// parts. Synthetic postings from two unrelated fields (nursing, tax
// accounting). fetch is replaced by a route table; nothing touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-discovery-resolve-'));
const { bestMatch, norm, stampResolved } = require('../scripts/resolve-linkedin-to-ats');
const { extractSignals, linkedinJobId, verifyOne } = require('../scripts/verify-remote');
const { parseCompanies, searchLocation, promote } = require('../scripts/linkedin-guest-sweep');

function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers || {} });
    const hit = routes.find(([needle]) => u.includes(needle));
    const { status = 200, text = '' } = hit ? hit[1] : { status: 404 };
    return { ok: status >= 200 && status < 300, status, url: u, text: async () => text, json: async () => ({}) };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const LI_URL = 'https://www.linkedin.com/jobs/view/registered-nurse-at-lakeview-hospital-1234567890';
const page = (inner) => `<html><body>${inner}<p>${'About the team and the work. '.repeat(20)}</p></body></html>`;

// ── resolve-linkedin-to-ats ─────────────────────────────────

test('norm drops parentheticals and work mode noise before matching', () => {
  assert.equal(norm('Registered Nurse (Remote) - Full-Time, USA'), 'registered nurse');
  assert.equal(norm('Senior Tax Accountant | Hybrid'), 'senior tax accountant');
  assert.equal(norm(null), '');
});

test('bestMatch picks the exact title over a shorter sibling', () => {
  const jobs = [{ title: 'Tax Accountant' }, { title: 'Senior Tax Accountant' }];
  const m = bestMatch('Senior Tax Accountant', jobs);
  assert.equal(m.job, jobs[1]);
  assert.equal(m.score, 1);
});

test('bestMatch refuses two near ties below 0.75: never link a different requisition', () => {
  const jobs = [{ title: 'Registered Nurse ICU Days' }, { title: 'Registered Nurse PACU Nights' }];
  // Both overlap 3 of 5 distinct words (0.6): strong, but not decisive.
  assert.equal(bestMatch('Registered Nurse ICU Nights', jobs), null);
});

test('bestMatch accepts 0.5 overlap only with a clear margin over the runner up', () => {
  const decisive = bestMatch('Senior Tax Accountant Partnerships', [{ title: 'Tax Accountant' }, { title: 'Payroll Specialist' }]);
  assert.equal(decisive.job.title, 'Tax Accountant');
  assert.equal(decisive.score, 0.5);
  // Same best score, but a runner up within 0.08 of it.
  assert.equal(bestMatch('Senior Tax Accountant Partnerships', [{ title: 'Tax Accountant' }, { title: 'Senior Accountant' }]), null);
  // Below 0.5 is never a match, however lonely.
  assert.equal(bestMatch('Registered Nurse ICU Nights Float Pool', [{ title: 'Nurse Educator' }]), null);
});

test('bestMatch accepts 0.75 and above even when the board lists the title twice', () => {
  const jobs = [{ title: 'Registered Nurse', location: 'Columbus, OH' }, { title: 'Registered Nurse', location: 'Denver, CO' }];
  const m = bestMatch('Registered Nurse', jobs);
  assert.equal(m.job, jobs[0]);
  assert.equal(m.score, 1);
  assert.equal(bestMatch('', jobs), null);
  assert.equal(bestMatch('Registered Nurse', []), null);
});

test('stampResolved rewrites the posting from the ATS record and keeps the LinkedIn link', () => {
  const p = {
    title: 'Registered Nurse', company: 'Lakeview Hospital', canonicalUrl: LI_URL, alternateUrls: [LI_URL],
    location: 'Remote - United States', remote: 'remote', us: true, hqLocation: 'Columbus, OH',
  };
  const job = { title: 'Registered Nurse', location: 'Toronto, Ontario', remoteFlag: null, url: 'https://boards.greenhouse.io/lakeviewhospital/jobs/11' };
  const mode = stampResolved(p, { ats: 'greenhouse', slug: 'lakeviewhospital' }, { job, score: 1 });
  assert.equal(mode, 'onsite');
  assert.equal(p.canonicalUrl, job.url);
  assert.equal(p.linkedinUrl, LI_URL);
  assert.deepEqual(p.alternateUrls, [LI_URL]);
  assert.equal(p.atsResolved, true);
  assert.equal(p.atsBoard, 'greenhouse:lakeviewhospital');
  assert.equal(p.atsMatchScore, 1);
  assert.equal(p.location, 'Toronto, Ontario');
  assert.equal(p.hqLocation, 'Columbus, OH');
  assert.equal(p.remote, 'onsite');
  assert.equal(p.us, false);
  assert.equal(p.remoteVerified, false);
  assert.equal(p.verifyStatus, 'not-remote');
  assert.equal(p.verifiedLocation, 'Toronto, Ontario');
  assert.equal(p.verifiedWorkplace, 'onsite');
});

test('stampResolved derives the work mode from the ATS location, flag and workplace type', () => {
  const board = { ats: 'lever', slug: 'harbortax' };
  const stamp = (job) => {
    const p = { title: 'Tax Accountant', company: 'Harbor Tax Group', url: 'https://www.linkedin.com/jobs/view/1234567890' };
    stampResolved(p, board, { job: { title: 'Tax Accountant', url: 'https://jobs.lever.co/harbortax/x', ...job }, score: 1 });
    return p;
  };
  const remote = stamp({ location: 'Remote - US', remoteFlag: null });
  assert.deepEqual([remote.remote, remote.remoteVerified, remote.verifyStatus, remote.us], ['remote', true, 'remote', true]);
  // A posting recorded only under `url` still keeps its LinkedIn link.
  assert.equal(remote.linkedinUrl, 'https://www.linkedin.com/jobs/view/1234567890');
  assert.deepEqual(remote.alternateUrls, ['https://www.linkedin.com/jobs/view/1234567890']);

  assert.equal(stamp({ location: 'Denver, CO', remoteFlag: true }).remote, 'remote');
  assert.equal(stamp({ location: 'Denver, CO', remoteFlag: true, workplaceType: 'hybrid' }).remote, 'hybrid');
  // The shape an Ashby board gives its hybrid jobs: the flag is set, the field says Hybrid.
  const hybrid = stamp({ location: 'Leeds', remoteFlag: true, workplaceType: 'Hybrid' });
  assert.deepEqual([hybrid.remote, hybrid.remoteVerified, hybrid.verifyStatus], ['hybrid', false, 'not-remote']);
  assert.equal(stamp({ location: 'Denver, CO', remoteFlag: false }).verifyStatus, 'not-remote');
  const unknown = stamp({ location: '', remoteFlag: null });
  assert.deepEqual([unknown.remote, unknown.verifyStatus, unknown.remoteVerified, unknown.verifiedLocation], ['unknown', 'inconclusive', false, null]);
});

test('boardJobs carries the Ashby workplace type, so a hybrid job with the remote flag set resolves hybrid', async () => {
  const { boardJobs } = require('../scripts/resolve-linkedin-to-ats');
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ jobs: [
    { title: 'Registered Nurse', location: 'Leeds', isRemote: true, workplaceType: 'Hybrid', jobUrl: 'https://jobs.ashbyhq.com/northfield/1' },
    { title: 'Tax Accountant', location: 'Leeds', isRemote: true, workplaceType: 'Remote', jobUrl: 'https://jobs.ashbyhq.com/northfield/2' },
  ] }) });
  try {
    const jobs = await boardJobs('ashby', 'northfield');
    const modes = jobs.map((job) => {
      const p = { title: job.title, company: 'Northfield Care', canonicalUrl: LI_URL };
      return [stampResolved(p, { ats: 'ashby', slug: 'northfield' }, { job, score: 1 }), p.verifyStatus];
    });
    assert.deepEqual(modes, [['hybrid', 'not-remote'], ['remote', 'remote']]);
  } finally { globalThis.fetch = original; }
});

test('stampResolved keeps the earlier country verdict unless the ATS location decides one', () => {
  const stamp = (location, title = 'Registered Nurse', us = true) => {
    const p = { title, company: 'Lakeview Hospital', canonicalUrl: LI_URL, location: 'Remote - United States', remote: 'remote', us };
    stampResolved(p, { ats: 'ashby', slug: 'lakeview' }, { job: { title, location, remoteFlag: true, url: 'https://jobs.ashbyhq.com/lakeview/x' }, score: 1 });
    return p.us;
  };
  // An ATS location that names no country leaves the verdict as it was.
  assert.equal(stamp('Remote'), true);
  assert.equal(stamp(''), true);
  assert.equal(stamp('Remote', 'Tax Accountant', false), false);
  // A decided verdict, from the location or from a region in the title, overwrites it.
  assert.equal(stamp('Remote - US', 'Tax Accountant', false), true);
  assert.equal(stamp('Remote, Canada'), false);
  assert.equal(stamp('Remote', 'Tax Accountant - LATAM'), false);
});

// ── verify-remote ───────────────────────────────────────────

test('linkedinJobId reads the numeric id from each URL shape', () => {
  assert.equal(linkedinJobId(LI_URL), '1234567890');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/view/1234567890/?refId=x'), '1234567890');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/search/?currentJobId=9876543210&keywords=tax'), '9876543210');
  assert.equal(linkedinJobId('https://boards.greenhouse.io/harbortax/jobs/555'), null);
  assert.equal(linkedinJobId(undefined), null);
});

test('extractSignals reads the workplace type and location the page displays', () => {
  assert.equal(extractSignals('<span class="topcard__flavor">Hybrid</span>').workplace, 'hybrid');
  const card = extractSignals(
    '<div class="topcard__flavor-row"><span class="topcard__flavor"><a href="#">Lakeview Hospital</a></span>'
    + '<span class="topcard__flavor topcard__flavor--bullet">Columbus, OH</span></div>'
    + '<span class="topcard__flavor">On-site</span>');
  assert.equal(card.location, 'Columbus, OH');
  assert.equal(card.workplace, 'onsite');
  // No workplace field: fall back to the page text.
  assert.equal(extractSignals('<p>This is a fully remote role.</p>').workplace, 'remote');
  assert.equal(extractSignals('<p>Work in-person at our clinic.</p>').workplace, 'onsite');
  assert.equal(extractSignals('<p>Hybrid schedule, two days at the firm.</p>').workplace, 'hybrid');
  // A flavor that is only home based wording is a work mode, not a place.
  const home = extractSignals('<span class="topcard__flavor topcard__flavor--bullet">United Kingdom</span><span class="topcard__flavor">Home Based</span>');
  // It is not the workplace field either: verifyOne confirms it against the JD.
  assert.deepEqual([home.location, home.workplace, home.home], ['United Kingdom', null, true]);
  assert.equal(extractSignals('<span class="topcard__flavor topcard__flavor--bullet">Nursing Home, Leeds</span>').workplace, null);
  const none = extractSignals('<p>Prepare partnership returns.</p>');
  assert.deepEqual([none.location, none.workplace], [null, null]);
});

test('verifyOne reads a LinkedIn posting through the logged out guest endpoint only', async () => {
  const f = stubFetch([['jobs-guest/jobs/api/jobPosting/1234567890', {
    text: page('<span class="topcard__flavor topcard__flavor--bullet">Columbus, OH</span><span class="topcard__flavor">Hybrid</span>'),
  }]]);
  try {
    const v = await verifyOne({ title: 'Registered Nurse', canonicalUrl: LI_URL });
    assert.deepEqual(v, { verifyStatus: 'not-remote', remoteVerified: false, verifiedLocation: 'Columbus, OH', verifiedWorkplace: 'hybrid', httpStatus: 200 });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/1234567890');
    const headerNames = Object.keys(f.calls[0].headers).map((h) => h.toLowerCase());
    assert.equal(headerNames.includes('cookie'), false);
    assert.equal(headerNames.includes('authorization'), false);
  } finally { f.restore(); }
});

test('verifyOne: a home based flavor is remote only when the title and JD do not state hybrid', async () => {
  const card = (flavor, jd) => page('<span class="topcard__flavor"><a href="#">Northfield Care</a></span>'
    + `<span class="topcard__flavor topcard__flavor--bullet">${flavor}</span><p>${jd}</p>`);
  const f = stubFetch([
    ['jobPosting/4444444441', { text: card('Home Based', 'This role is hybrid: you will work 3 days per week in the office in Leeds.') }],
    ['jobPosting/4444444442', { text: card('Home Based', 'You will work 3 days per week in the office.') }],
    ['jobPosting/4444444443', { text: card('Home Based', 'Prepare and review returns for clients.') }],
    ['jobPosting/4444444444', { text: card('Home Based, UK', 'You will work 3 days per week in the office.') }],
    ['jobPosting/4444444445', { text: card('Home Based', 'Triage calls for our hybrid cloud phone system.') }],
  ]);
  try {
    const run = async (n, title) => {
      const v = await verifyOne({ title, canonicalUrl: `https://www.linkedin.com/jobs/view/${n}` });
      return [v.verifyStatus, v.remoteVerified, v.verifiedWorkplace, v.verifiedLocation];
    };
    assert.deepEqual(await run('4444444441', 'Tax Accountant'), ['not-remote', false, 'hybrid', 'Home Based']);
    assert.deepEqual(await run('4444444442', 'Registered Nurse'), ['not-remote', false, 'hybrid', 'Home Based']);
    // A silent JD: the flavor stands, and the location is the flavor, never the employer.
    assert.deepEqual(await run('4444444443', 'Tax Accountant'), ['remote', true, 'remote', 'Home Based']);
    assert.deepEqual(await run('4444444443', 'Tax Accountant (Hybrid)'), ['not-remote', false, 'hybrid', 'Home Based']);
    assert.equal((await run('4444444444', 'Tax Accountant'))[1], false);
    // The bare word with no hybrid statement does not overrule the flavor.
    assert.deepEqual(await run('4444444445', 'Registered Nurse'), ['remote', true, 'remote', 'Home Based']);
  } finally { f.restore(); }
});

test('verifyOne confirms a remote role from the page alone, never from an unreachable one', async () => {
  const f = stubFetch([
    ['jobPosting/1111111111', { text: page('<span class="topcard__flavor">Remote</span>') }],
    ['jobPosting/2222222222', { text: page('<p>Prepare and review returns for clients.</p>') }],
    ['jobPosting/3333333333', { status: 429 }],
    ['/careers/tax-accountant', { text: page('<p>This position is 100% remote.</p>') }],
  ]);
  try {
    const li = (id) => ({ title: 'Tax Accountant', canonicalUrl: `https://www.linkedin.com/jobs/view/tax-accountant-${id}` });
    const remote = await verifyOne(li('1111111111'));
    assert.deepEqual([remote.verifyStatus, remote.remoteVerified, remote.verifiedWorkplace], ['remote', true, 'remote']);
    const unclear = await verifyOne(li('2222222222'));
    assert.deepEqual([unclear.verifyStatus, unclear.remoteVerified], ['inconclusive', false]);
    const blocked = await verifyOne(li('3333333333'));
    assert.deepEqual([blocked.verifyStatus, blocked.remoteVerified, blocked.httpStatus], ['unreachable', false, 429]);
    // Any other URL is fetched as is.
    const direct = await verifyOne({ title: 'Tax Accountant', url: 'https://www.harbortax.example/careers/tax-accountant' });
    assert.equal(direct.verifyStatus, 'remote');
    assert.equal(f.calls[f.calls.length - 1].url, 'https://www.harbortax.example/careers/tax-accountant');
  } finally { f.restore(); }
});

// ── linkedin-guest-sweep ────────────────────────────────────

test('parseCompanies reads employer names from guest search cards', () => {
  const html = '<ul>'
    + '<li><div class="base-search-card"><h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="#"> Lakeview Hospital </a></h4></div></li>'
    + '<li><div class="base-search-card"><h4 class="base-search-card__subtitle">Harbor Tax &amp; Advisory</h4></div></li>'
    + '<li><div class="base-search-card"><h3>no subtitle here</h3></div></li>'
    + '</ul>';
  assert.deepEqual(parseCompanies(html), ['Lakeview Hospital', 'Harbor Tax & Advisory']);
  assert.deepEqual(parseCompanies(''), []);
  assert.deepEqual(parseCompanies(undefined), []);
});

test('searchLocation follows the country policy and is unrestricted without one', () => {
  assert.equal(searchLocation([]), null);
  assert.equal(searchLocation(undefined), null);
  assert.equal(searchLocation(['US']), 'United States');
  assert.equal(searchLocation(['CA']), 'Canada');
  assert.equal(searchLocation(['Germany']), 'Germany');
  assert.equal(searchLocation(['US', 'CA']), null);
  assert.equal(searchLocation(['CA', 'Canada']), 'Canada');
  assert.equal(searchLocation(['', null]), null);
});

test('promote merges a resolved name into the index without losing run history', () => {
  const idx = {
    lakeviewhospital: { name: 'Lakeview Hospital', ats: 'other', sources: ['linkedin-guest'], urls: ['https://x.example/1'], postingCountByRun: { r1: 3 }, hiresPerPosting: 0.4 },
    harbortax: { name: 'Harbor Tax Group', ats: 'greenhouse', sources: ['greenhouse'], lastSeen: 'earlier' },
  };
  const results = [
    { name: 'Lakeview Hospital', hit: { ats: 'lever', slug: 'lakeviewhospital' } },
    { name: 'Harbor Tax Group', hit: { ats: 'greenhouse', slug: 'harbortax' } },
    { name: 'Northside Clinic', hit: { ats: 'ashby', slug: 'northsideclinic' } },
    { name: 'Unresolvable Co', hit: null },
  ];
  const { added, byAts } = promote(idx, results, 'now');
  assert.equal(added, 2);
  assert.deepEqual(byAts, { lever: 1, greenhouse: 1, ashby: 1 });
  assert.deepEqual(idx.lakeviewhospital, {
    name: 'Lakeview Hospital', ats: 'lever', lastSeen: 'now', sources: ['linkedin-guest', 'linkedin-guest-resolve'],
    urls: ['https://x.example/1'], postingCountByRun: { r1: 3 }, hiresPerPosting: 0.4, recentLayoff: null,
  });
  // An entry already on a real board is left exactly as it was.
  assert.equal(idx.harbortax.lastSeen, 'earlier');
  assert.deepEqual(idx.northsideclinic.postingCountByRun, {});
  assert.equal(Object.keys(idx).length, 3);
});
