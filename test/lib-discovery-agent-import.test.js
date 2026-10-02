'use strict';
// lib/agent-import.js: the fallback import path applies the same gates as the
// pipeline (title policy, excluded companies, work mode, country, recency),
// driven by the user's profile. Synthetic registered nurse workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-discovery-agent-import-'));
const write = (rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
};
write('data/queries/seeds.json', { queries: [{ query: 'Registered Nurse' }, { query: 'Nurse Case Manager' }] });
write('data/companies/negative-list.json', { companySlugs: ['blocked-clinic'] });
write('data/companies/staffing-list.json', { companySlugs: ['synthetic-staffing-partners'] });
write('data/profile.json', {
  discovery: { workModes: ['remote'], countries: ['US'], maxAgeDays: 10, titleExclude: ['travel'] },
});
process.env.JOBE_USER_ROOT = root;

const { applyAgentFilters, extractSlug } = require('../lib/agent-import');
const { buildProfile } = require('../lib/rank');
const { createPosting } = require('../lib/posting');

const day = 86400000;
let n = 0;
const make = (raw) => createPosting({
  company: 'Mercy West Health',
  location: 'Remote - United States',
  url: `https://example.org/jobs/${++n}`,
  postedDate: new Date(Date.now() - 2 * day).toISOString(),
  ...raw,
}, 'test-source');

const profile = buildProfile({ root });

test('the profile policy gates the import: role, company, country, work mode, recency', () => {
  const keep = make({ title: 'Registered Nurse, Telehealth' });
  const undated = make({ title: 'Nurse Case Manager', postedDate: null });
  const postings = [
    keep,
    undated,
    make({ title: 'Tax Accountant' }),                                  // role
    make({ title: 'Travel Registered Nurse' }),                         // title policy
    make({ title: 'Registered Nurse', company: 'Blocked Clinic' }),     // negative list
    make({ title: 'Registered Nurse', company: 'Synthetic Staffing Partners' }), // staffing list
    make({ title: 'Registered Nurse', location: 'Toronto, Canada' }),   // country
    make({ title: 'Registered Nurse', location: 'Austin, TX' }),        // onsite
    make({ title: 'Registered Nurse', postedDate: new Date(Date.now() - 40 * day).toISOString() }), // stale
  ];
  const { kept, rej } = applyAgentFilters(postings, profile);
  assert.deepEqual(kept, [keep, undated], 'an unknown date is kept');
  assert.deepEqual(rej, { role: 2, company: 2, location: 1, nonRemote: 1, recency: 1 });
});

test('explicit options win over the profile; no policy drops nothing but the role and company gates', () => {
  const postings = [
    make({ title: 'Registered Nurse', location: 'Toronto, Canada' }),
    make({ title: 'Registered Nurse', location: 'Austin, TX' }),
    make({ title: 'Registered Nurse', postedDate: new Date(Date.now() - 400 * day).toISOString() }),
    make({ title: 'Registered Nurse', company: 'Synthetic Staffing Partners' }),
    make({ title: 'Registered Nurse', company: 'Blocked Clinic' }),
  ];
  const open = { remoteOnly: false, usOnly: false, countries: [], maxAgeDays: 0, excludeStaffing: false };
  const { kept, rej } = applyAgentFilters(postings, profile, open);
  assert.equal(kept.length, 4);
  assert.deepEqual(rej, { role: 0, company: 1, location: 0, nonRemote: 0, recency: 0 });

  const canada = applyAgentFilters(postings.slice(0, 2), profile, { ...open, countries: ['CA', 'Canada'] });
  assert.deepEqual(canada.kept.map((p) => p.location), ['Toronto, Canada']);
});

test('work mode is the user list in its strict form, and regions gate on site work', () => {
  const remote = make({ title: 'Registered Nurse, Telehealth', location: 'Remote - United States' });
  const onsite = make({ title: 'Registered Nurse', location: 'Austin, TX' });
  const hybrid = make({ title: 'Charge Nurse (Hybrid)', location: 'Denver, CO' });
  const silent = make({ title: 'Nurse Case Manager', location: 'United States' });
  const open = { remoteOnly: false, usOnly: false, countries: [], maxAgeDays: 0 };
  const run = (opts) => applyAgentFilters([remote, onsite, hybrid, silent], profile, { ...open, ...opts });

  const onSite = run({ workModes: ['onsite', 'hybrid'] });
  assert.deepEqual(onSite.kept, [onsite, hybrid, silent], 'a posting that states no mode is read as onsite');
  assert.equal(onSite.rej.nonRemote, 1);

  const flexible = run({ workModes: ['remote', 'hybrid'] });
  assert.deepEqual(flexible.kept, [remote, hybrid]);
  assert.equal(flexible.rej.nonRemote, 2);

  assert.equal(run({ workModes: [] }).kept.length, 4, 'no list, no gate');

  const regional = run({ workModes: [], regions: ['Denver', 'Colorado'] });
  assert.deepEqual(regional.kept, [remote, hybrid], 'remote is never gated by region');
  assert.equal(regional.rej.location, 2);
});

test('the senior headroom extends the recency window only when the user sets one', () => {
  const p = [make({ title: 'Senior Registered Nurse', postedDate: new Date(Date.now() - 20 * day).toISOString() })];
  assert.equal(applyAgentFilters(p, profile).kept.length, 0);
  assert.equal(applyAgentFilters(p, profile, { seniorityExtensionDays: 15 }).kept.length, 1);
});

test('extractSlug recognizes every direct ATS host', () => {
  assert.deepEqual(extractSlug('https://job-boards.greenhouse.io/mercywest/jobs/1'), { ats: 'greenhouse', slug: 'mercywest' });
  assert.deepEqual(extractSlug('https://jobs.lever.co/harbortax/abc'), { ats: 'lever', slug: 'harbortax' });
  assert.deepEqual(extractSlug('https://mercy.wd5.myworkdayjobs.com/careers/job/x'), { ats: 'workday', slug: 'mercy' });
  assert.deepEqual(extractSlug('https://apply.workable.com/mercy-west/j/ABC123'), { ats: 'workable', slug: 'mercy-west' });
  assert.deepEqual(extractSlug('https://harbortax.recruitee.com/o/tax-accountant'), { ats: 'recruitee', slug: 'harbortax' });
  assert.deepEqual(extractSlug('https://mercywest.breezy.hr/p/abc'), { ats: 'breezy', slug: 'mercywest' });
  assert.deepEqual(extractSlug('https://mercywest.bamboohr.com/careers/12'), { ats: 'bamboohr', slug: 'mercywest' });
  assert.deepEqual(extractSlug('https://harbortax.jobs.personio.com/job/34'), { ats: 'personio', slug: 'harbortax' });
  assert.equal(extractSlug('https://www.bamboohr.com/careers'), null, 'the vendor site is not a tenant');
  assert.equal(extractSlug('https://apply.workable.com/j/ABC123'), null);
  assert.equal(extractSlug('https://example.org/jobs/1'), null);
  assert.equal(extractSlug(null), null);
});
