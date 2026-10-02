'use strict';
// collectors/pipeline.js: the two stage filter (applyFilters before enrichment,
// finalizeRemoteAndRecency after it) is driven by the user's own policy in
// data/profile.json, with command line flags on top. Two synthetic users from
// unrelated professions: a registered nurse who works on site, and a tax
// accountant who works remotely. No network, no real workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mkRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `collectors-core-${tag}-`));
const writeJson = (root, rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
};

// The pipeline's own workspace: holds the queue, the negative list, and a
// workspace staffing list. It has NO profile, so its policy is the default.
const root = mkRoot('filters');
writeJson(root, 'data/companies/negative-list.json', { companySlugs: ['blocked-clinic'] });
writeJson(root, 'data/companies/staffing-list.json', { companySlugs: ['synthetic-staffing-partners'] });
writeJson(root, 'data/apply-queue.json', [
  { company: 'Riverbend Hospital', role: 'Registered Nurse, Oncology', applied: true, primaryUrl: 'https://example.org/old/1' },
  { company: 'Ledger and Finch', role: 'Senior Tax Accountant', resumeDocx: 'reports/skipped/ledger-and-finch/resume.docx' },
  { company: 'Harbor Clinic', role: 'Charge Nurse', primaryUrl: 'https://example.org/queued/7', alternativeUrls: ['https://example.org/queued/7b'] },
]);
process.env.JOBE_USER_ROOT = root;

const pipeline = require('../collectors/pipeline');
const { applyFilters, finalizeRemoteAndRecency, publishedMax, parseArgs, updateCompanyIndex } = pipeline;
const { buildProfile } = require('../lib/rank');
const { loadProfile, discoveryFilters } = require('../lib/profile');
const { createPosting } = require('../lib/posting');

// One user = one fresh root (the profile is cached per root).
function user(tag, seeds, discovery) {
  const r = mkRoot(tag);
  writeJson(r, 'data/queries/seeds.json', { queries: seeds.map((query) => ({ query })) });
  if (discovery) writeJson(r, 'data/profile.json', { discovery });
  return {
    filters: discoveryFilters(loadProfile({ root: r })),
    profile: buildProfile({ root: r }),
  };
}

const NURSE_SEEDS = ['Registered Nurse', 'Charge Nurse'];
const ACCOUNTANT_SEEDS = ['Tax Accountant', 'Senior Accountant'];

const day = 86400000;
const ago = (n) => new Date(Date.now() - n * day).toISOString();
let n = 0;
const make = (raw) => createPosting({
  company: 'Mercy West Health',
  location: 'Columbus, OH',
  url: `https://example.org/jobs/${++n}`,
  postedDate: ago(2),
  ...raw,
}, 'test-source');
const titles = (list) => list.map((p) => p.title);

test('no policy is permissive: every work mode and country survives both stages', () => {
  const nurse = user('nurse-default', NURSE_SEEDS, null);
  assert.equal(nurse.filters.remoteOnly, false);
  assert.equal(nurse.filters.usOnly, false);
  const postings = [
    make({ title: 'Registered Nurse, ICU' }),                                   // onsite, US
    make({ title: 'Registered Nurse, Telehealth', location: 'Remote' }),        // remote
    make({ title: 'Charge Nurse', location: 'Columbus, OH (Hybrid)' }),         // hybrid
    make({ title: 'Registered Nurse', location: 'Toronto, Ontario, Canada' }),  // not US
    make({ title: 'Nursing Supervisor', location: '' }),                        // unknown, inflected title
    make({ title: 'Registered Nurse', postedDate: null }),                      // no date
  ];
  const offRole = make({ title: 'Tax Accountant' });
  const { kept, rejected } = applyFilters([...postings, offRole], nurse.filters, nurse.profile);
  assert.deepEqual(kept, postings);
  assert.equal(rejected.role, 1, 'only the title outside the user target roles is dropped');
  const strict = finalizeRemoteAndRecency(kept, nurse.filters);
  assert.deepEqual(strict.kept, postings);
  assert.deepEqual(strict.rejected, { nonRemote: 0, recency: 0, location: 0, salary: 0 });
});

test('a user with no seeds and no policy keeps every title (no field is assumed)', () => {
  const nobody = user('nobody', [], null);
  const postings = [make({ title: 'Registered Nurse' }), make({ title: 'Tax Accountant' }), make({ title: 'Line Cook' })];
  assert.deepEqual(applyFilters(postings, nobody.filters, nobody.profile).kept, postings);
});

test('a remote policy (accountant): known onsite and hybrid drop early, unknown waits for enrichment, then must be remote', () => {
  const acct = user('acct-remote', ACCOUNTANT_SEEDS, { workModes: ['remote'] });
  assert.equal(acct.filters.remoteOnly, true);
  const remote = make({ title: 'Tax Accountant', location: 'Remote - United States' });
  const unknown = make({ title: 'Senior Accountant', location: 'United States' });
  const onsite = make({ title: 'Tax Accountant', location: 'Austin, TX' });
  const hybrid = make({ title: 'Tax Accountant', location: 'Austin, TX (Hybrid)' });
  const pre = applyFilters([remote, unknown, onsite, hybrid], acct.filters, acct.profile);
  assert.deepEqual(pre.kept, [remote, unknown]);
  assert.equal(pre.rejected.nonRemote, 2);
  const post = finalizeRemoteAndRecency(pre.kept, acct.filters);
  assert.deepEqual(post.kept, [remote], 'an unverified work mode is not presented as remote');
  assert.equal(post.rejected.nonRemote, 1);
});

test('remote and hybrid (accountant): a city only listing waits for enrichment, then must state an accepted mode', () => {
  const acct = user('acct-remote-hybrid', ACCOUNTANT_SEEDS, { workModes: ['remote', 'hybrid'], countries: ['US'] });
  assert.equal(acct.filters.remoteOnly, false);
  // A hybrid role is listed with its city and says hybrid only in the JD.
  const denver = make({ title: 'Tax Accountant', location: 'Denver, CO' });
  const columbus = make({ title: 'Senior Accountant', location: 'Columbus, OH' });
  const remote = make({ title: 'Tax Accountant', location: 'Remote - US' });
  assert.equal(denver.remote, 'onsite', 'the label only means no mode word was listed');
  const pre = applyFilters([denver, columbus, remote], acct.filters, acct.profile);
  assert.deepEqual(pre.kept, [denver, columbus, remote]);
  assert.equal(pre.rejected.nonRemote, 0);
  // Before enrichment says otherwise the city rows are still onsite: dropped.
  assert.deepEqual(finalizeRemoteAndRecency([denver, columbus, remote], acct.filters).kept, [remote]);
  // Enrichment read "three days a week in our Denver office" from the JD.
  const enriched = { ...denver, remote: 'hybrid' };
  assert.deepEqual(finalizeRemoteAndRecency([enriched, columbus, remote], acct.filters).kept, [enriched, remote]);

  // The same for a nurse who accepts hybrid only; a stated remote row still drops early.
  const nurse = user('nurse-hybrid', NURSE_SEEDS, { workModes: ['hybrid'] });
  const ward = make({ title: 'Registered Nurse' });
  const tele = make({ title: 'Registered Nurse, Telehealth', location: 'Remote' });
  const preNurse = applyFilters([ward, tele], nurse.filters, nurse.profile);
  assert.deepEqual(preNurse.kept, [ward]);
  assert.equal(preNurse.rejected.nonRemote, 1);
});

test('onsite and hybrid (nurse): remote drops, and a posting that states no mode is kept', () => {
  const nurse = user('nurse-onsite', NURSE_SEEDS, { workModes: ['onsite', 'hybrid'] });
  assert.equal(nurse.filters.remoteOnly, false);
  const onsite = make({ title: 'Registered Nurse, ICU' });
  const hybrid = make({ title: 'Charge Nurse', location: 'Columbus, OH (Hybrid)' });
  const unknown = make({ title: 'Registered Nurse', location: 'United States' });
  const remote = make({ title: 'Registered Nurse, Telehealth', location: 'Remote' });
  const pre = applyFilters([onsite, hybrid, unknown, remote], nurse.filters, nurse.profile);
  assert.deepEqual(pre.kept, [onsite, hybrid, unknown]);
  assert.equal(pre.rejected.nonRemote, 1);
  assert.deepEqual(finalizeRemoteAndRecency(pre.kept, nurse.filters).kept, [onsite, hybrid, unknown]);
});

test('country policy: ["US"] uses the US classifier, another country matches the location text, unknown is kept', () => {
  const us = user('nurse-us', NURSE_SEEDS, { countries: ['US'] });
  assert.equal(us.filters.usOnly, true);
  const ohio = make({ title: 'Registered Nurse' });
  const toronto = make({ title: 'Registered Nurse', location: 'Toronto, Ontario, Canada' });
  const noPlace = make({ title: 'Registered Nurse', location: 'Remote' });
  const a = applyFilters([ohio, toronto, noPlace], us.filters, us.profile);
  assert.deepEqual(a.kept, [ohio, noPlace]);
  assert.equal(a.rejected.location, 1);
  assert.deepEqual(finalizeRemoteAndRecency([ohio, toronto, noPlace], us.filters).kept, [ohio, noPlace]);

  const ca = user('acct-ca', ACCOUNTANT_SEEDS, { countries: ['CA', 'Canada'] });
  assert.equal(ca.filters.usOnly, false);
  const t1 = make({ title: 'Tax Accountant', location: 'Toronto, Ontario, Canada' });
  const t2 = make({ title: 'Tax Accountant', location: 'Columbus, OH' });
  const t3 = make({ title: 'Tax Accountant', location: 'Remote' });
  const b = applyFilters([t1, t2, t3], ca.filters, ca.profile);
  assert.deepEqual(b.kept, [t1, t3]);
  assert.equal(b.rejected.location, 1);
});

test('title policy: titleExclude drops a title, titleKeep rescues it, for either profession', () => {
  const nurse = user('nurse-titles', NURSE_SEEDS, { titleExclude: ['travel', 'per diem'], titleKeep: ['travel health'] });
  const nurseList = [
    make({ title: 'Registered Nurse, ICU' }),
    make({ title: 'Travel Registered Nurse' }),
    make({ title: 'Per Diem Charge Nurse' }),
    make({ title: 'Travel Health Nurse' }),
  ];
  const a = applyFilters(nurseList, nurse.filters, nurse.profile);
  assert.deepEqual(titles(a.kept), ['Registered Nurse, ICU', 'Travel Health Nurse']);
  assert.equal(a.rejected.role, 2);

  const acct = user('acct-titles', ACCOUNTANT_SEEDS, { titleExclude: ['intern', 'director'] });
  const acctList = [
    make({ title: 'Senior Tax Accountant' }),
    make({ title: 'Tax Accountant Intern' }),
    make({ title: 'Director of Accounting' }),
    make({ title: 'International Tax Accountant' }),
  ];
  const b = applyFilters(acctList, acct.filters, acct.profile);
  assert.deepEqual(titles(b.kept), ['Senior Tax Accountant', 'International Tax Accountant'], 'whole word match only');
});

test('pay floor: only a PUBLISHED band that tops out below the floor is dropped', () => {
  const acct = user('acct-floor', ACCOUNTANT_SEEDS, { salaryFloor: 90000 });
  const below = make({ title: 'Tax Accountant', compensation: { min: 60000, max: 80000, currency: 'USD' } });
  const reaches = make({ title: 'Tax Accountant', compensation: { min: 85000, max: 110000, currency: 'USD' } });
  const none = make({ title: 'Tax Accountant' });
  const hourly = make({ title: 'Tax Accountant', compensation: '$45 - $60 per hour' });
  const euros = make({ title: 'Tax Accountant', compensation: { min: 50000, max: 60000, currency: 'EUR' } });
  const textBelow = make({ title: 'Tax Accountant', compensation: '$60000 - $70000' });
  const pre = applyFilters([below, reaches, none, hourly, euros, textBelow], acct.filters, acct.profile);
  assert.equal(pre.kept.length, 6, 'the floor is a post enrichment gate');
  const post = finalizeRemoteAndRecency(pre.kept, acct.filters);
  assert.deepEqual(post.kept, [reaches, none, hourly, euros]);
  assert.equal(post.rejected.salary, 2);
  assert.deepEqual(post.kept.map((p) => p.salaryCheck), ['published', 'unknown', 'unknown', 'unknown']);

  const nurse = user('nurse-nofloor', NURSE_SEEDS, null);
  const low = make({ title: 'Registered Nurse', compensation: { min: 30000, max: 40000, currency: 'USD' } });
  assert.deepEqual(finalizeRemoteAndRecency([low], nurse.filters).kept, [low], 'no floor, nothing dropped by pay');
  assert.equal(low.salaryCheck, 'published');
  assert.equal(publishedMax({ compensation: { min: 30, max: 45, currency: 'USD' } }), null, 'an hourly figure is not a yearly band');
});

test('pay floor: compared only in the user currency and only for a yearly band; a bare dollar sign is USD only for a US posting', () => {
  // A registered nurse in Canada with a floor in Canadian dollars.
  const nurse = user('nurse-cad-floor', NURSE_SEEDS, { salaryFloor: 80000, salaryCurrency: 'CAD' });
  const rn = (compensation, location = 'Toronto, Ontario, Canada') => make({ title: 'Registered Nurse', location, compensation });
  const cadBelow = rn('CAD 60000 - 70000');
  const cadBelow2 = rn('$60,000 - $70,000 CAD');
  const cadSign = rn('C$60,000 to C$70,000');
  const bare = rn('$60,000 - $70,000');
  const usd = rn({ min: 60000, max: 70000, currency: 'USD' });
  const cadReach = rn('CAD 75000 - 90000');
  const unstated = rn({ min: 60000, max: 70000 });
  const monthly = rn('CAD $10,500 - $13,650 per month');
  const got = finalizeRemoteAndRecency([cadBelow, cadBelow2, cadSign, bare, usd, cadReach, unstated, monthly], nurse.filters);
  assert.deepEqual(got.kept, [bare, usd, cadReach, unstated, monthly]);
  assert.equal(got.rejected.salary, 3);
  assert.deepEqual(got.kept.map((p) => p.salaryCheck), ['unknown', 'unknown', 'published', 'unknown', 'unknown']);

  // A tax accountant in the United Kingdom with a floor in pounds.
  const acct = user('acct-gbp-floor', ACCOUNTANT_SEEDS, { salaryFloor: 55000, salaryCurrency: 'gbp' });
  const ta = (compensation) => make({ title: 'Tax Accountant', location: 'Leeds, England', compensation });
  const gbpText = ta('\u00a340,000 - \u00a345,000 per annum');
  const gbpCode = ta('GBP 40000 - 45000');
  const gbpObject = ta({ min: 40000, max: 45000, currency: 'GBP' });
  const euros = ta('\u20ac40.000 - \u20ac45.000');
  const b = finalizeRemoteAndRecency([gbpText, gbpCode, gbpObject, euros], acct.filters);
  assert.deepEqual(b.kept, [euros]);
  assert.equal(b.rejected.salary, 3);

  // The default currency is USD: a bare "$" counts only where the posting is in the US.
  assert.equal(publishedMax({ us: true, compensation: '$60,000 - $70,000' }), 70000);
  assert.equal(publishedMax({ us: null, compensation: '$60,000 - $70,000' }), null);
  assert.equal(publishedMax({ us: false, compensation: '$60,000 - $70,000' }), null);
  assert.equal(publishedMax({ us: false, compensation: 'US$60,000 - US$70,000' }), 70000, 'the text says USD');
  assert.equal(publishedMax({ us: true, compensation: '$60,000 - $70,000' }, 'CAD'), null);
  assert.equal(publishedMax({ us: true, compensation: { min: 60000, max: 70000, currency: 'USD', period: 'month' } }), null);
  assert.equal(publishedMax({ us: true, compensation: { min: 60000, max: 70000, currency: 'USD', period: 'year' } }), 70000);
  assert.equal(publishedMax({ us: true, compensation: '$10,500 - $13,650 per month' }), null);
  assert.equal(publishedMax({ us: true, compensation: '$40000 - $50000 per year' }), 50000);
});

test('regions: hybrid and onsite postings must name one of the user regions; remote is never touched', () => {
  const acct = user('acct-regions', ACCOUNTANT_SEEDS, { workModes: ['onsite', 'hybrid', 'remote'], countries: ['US'], regions: ['Denver', 'Colorado'] });
  assert.deepEqual(acct.filters.regions, ['Denver', 'Colorado']);
  const ta = (location, extra = {}) => make({ title: 'Tax Accountant', location, ...extra });
  const denver = ta('Denver, CO (On-site)');
  const boulder = ta('Boulder, Colorado (Hybrid)');
  const miami = ta('Miami, FL (On-site)');
  const anchorage = ta('Anchorage, AK (Hybrid)');
  const remote = ta('Remote - United States');
  const noPlace = ta('', { title: 'Tax Accountant (Hybrid)' });
  const silent = ta('Austin, TX');
  assert.deepEqual([denver, boulder, miami, anchorage, remote].map((p) => p.remote), ['onsite', 'hybrid', 'onsite', 'hybrid', 'remote']);
  const list = [denver, boulder, miami, anchorage, remote, noPlace, silent];
  const pre = applyFilters(list, acct.filters, acct.profile);
  assert.deepEqual(pre.kept, [denver, boulder, remote, noPlace, ...(silent.remote === 'unknown' ? [silent] : [])]);
  const post = finalizeRemoteAndRecency(list, acct.filters);
  assert.deepEqual(post.kept, [denver, boulder, remote, noPlace], 'after enrichment a posting that states no mode is read as on site');
  assert.equal(post.rejected.location, 3);

  // A region given by name keeps the postings that write its code, at both stages.
  const coded = ['Aurora, CO', 'Lakewood, CO, United States', 'Fort Collins, CO', 'Colorado Springs, CO'].map((l) => ta(l));
  const outside = ['Dallas, TX', 'Miami, FL (On-site)'].map((l) => ta(l));
  assert.deepEqual(applyFilters([...coded, ...outside], acct.filters, acct.profile).kept, coded);
  assert.deepEqual(finalizeRemoteAndRecency([...coded, ...outside], acct.filters).kept, coded);
  const ontario = user('nurse-ontario', NURSE_SEEDS, { workModes: ['onsite', 'hybrid'], countries: ['CA', 'Canada'], regions: ['Toronto', 'Ontario'] });
  const on = ['Mississauga, ON', 'North York, ON', 'Ottawa, ON', 'Brampton, Ontario', 'Hamilton, ON, Canada'].map((location) => make({ title: 'Registered Nurse', location }));
  const off = ['Vancouver, BC', 'Calgary, Alberta'].map((location) => make({ title: 'Registered Nurse', location }));
  assert.deepEqual(applyFilters([...on, ...off], ontario.filters, ontario.profile).kept, on);
  assert.deepEqual(finalizeRemoteAndRecency([...on, ...off], ontario.filters).kept, on);

  // A registered nurse in another region list, and no list at all.
  const nurse = user('nurse-regions', NURSE_SEEDS, { workModes: ['onsite'], regions: ['Leeds', 'Yorkshire'] });
  const rn = (location) => make({ title: 'Registered Nurse', location });
  const leeds = rn('Leeds, England (On-site)');
  const bristol = rn('Bristol, England (On-site)');
  assert.deepEqual(finalizeRemoteAndRecency([leeds, bristol], nurse.filters).kept, [leeds]);
  const open = user('nurse-noregions', NURSE_SEEDS, { workModes: ['onsite'] });
  assert.deepEqual(finalizeRemoteAndRecency([leeds, bristol], open.filters).kept, [leeds, bristol], 'an empty list keeps every place');
});

test('history and queue: a req already applied to or skipped never resurfaces, whatever the source URL', () => {
  const nurse = user('nurse-history', NURSE_SEEDS, null);
  const acct = user('acct-history', ACCOUNTANT_SEEDS, null);
  const applied = make({ title: 'Registered Nurse, Oncology', company: 'Riverbend Hospital' });
  const queued = make({ title: 'Charge Nurse', company: 'Harbor Clinic', url: 'https://example.org/queued/7b' });
  const fresh = make({ title: 'Registered Nurse, Oncology', company: 'Lakeside Hospital' });
  const a = applyFilters([applied, queued, fresh], nurse.filters, nurse.profile);
  assert.deepEqual(a.kept, [fresh]);
  assert.equal(a.rejected.history, 1);
  assert.equal(a.rejected.queue, 1);

  const skipped = make({ title: 'Senior Tax Accountant', company: 'Ledger and Finch' });
  const b = applyFilters([skipped], acct.filters, acct.profile);
  assert.equal(b.rejected.history, 1);
  const c = applyFilters([skipped], { ...acct.filters, historyFilter: false }, acct.profile);
  assert.deepEqual(c.kept, [skipped], '--include-applied lifts the history filter');
});

test('history by city: a queue row that recorded its location hides only that city, unless the policy is remote only', () => {
  const saved = process.env.JOBE_USER_ROOT;
  const r = mkRoot('history-city');
  writeJson(r, 'data/apply-queue.json', [
    { company: 'Lakeside Hospital', role: 'Registered Nurse', location: 'Ottawa, ON, Canada', skipped: true },
    { company: 'Harbor Tax Group', role: 'Tax Accountant', applied: true },
  ]);
  const script = `
    const { applyFilters } = require(${JSON.stringify(path.join(__dirname, '..', 'collectors', 'pipeline'))});
    const { createPosting } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'posting'))});
    const mk = (title, company, location, i) => createPosting({ title, company, location, url: 'https://example.org/h/' + i }, 't');
    const list = [
      mk('Registered Nurse', 'Lakeside Hospital', 'Ottawa, Ontario', 1),
      mk('Registered Nurse', 'Lakeside Hospital', 'Toronto, ON, Canada', 2),
      mk('Tax Accountant', 'Harbor Tax Group', 'Leeds, England', 3),
    ];
    const kept = (f) => applyFilters(list, f, null).kept.map((p) => p.location);
    console.log(JSON.stringify({ open: kept({}), remoteOnly: kept({ remoteOnly: true }) }));
  `;
  const res = require('child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, JOBE_USER_ROOT: r, JOBE_USER: '' } });
  process.env.JOBE_USER_ROOT = saved;
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.open, ['Toronto, ON, Canada'], 'the other city of a skipped req stays; a row with no location hides the req everywhere');
  assert.deepEqual(out.remoteOnly, [], 'remote only: the req is one job wherever it is listed');
});

test('excluded companies: negative list always, staffing list unless the user turns it off', () => {
  const nurse = user('nurse-staffing', NURSE_SEEDS, null);
  const direct = make({ title: 'Registered Nurse' });
  const blocked = make({ title: 'Registered Nurse', company: 'Blocked Clinic' });
  const broker = make({ title: 'Registered Nurse', company: 'Synthetic Staffing Partners' });
  const a = applyFilters([direct, blocked, broker], nurse.filters, nurse.profile);
  assert.deepEqual(a.kept, [direct]);
  assert.equal(a.rejected.negative, 2);

  const acct = user('acct-staffing', ACCOUNTANT_SEEDS, { excludeStaffing: false });
  assert.equal(acct.filters.excludeStaffing, false);
  const viaBroker = make({ title: 'Tax Accountant', company: 'Synthetic Staffing Partners' });
  const stillBlocked = make({ title: 'Tax Accountant', company: 'Blocked Clinic' });
  const b = applyFilters([viaBroker, stillBlocked], acct.filters, acct.profile);
  assert.deepEqual(b.kept, [viaBroker]);
  assert.equal(b.rejected.negative, 1);
});

test('recency: the window and the senior extension come from the policy; 0 turns the cut off', () => {
  const nurse = user('nurse-recency', NURSE_SEEDS, null);
  assert.equal(nurse.filters.maxAgeDays, 30);
  const fresh = make({ title: 'Registered Nurse' });
  const stale = make({ title: 'Registered Nurse', postedDate: ago(45) });
  const staleSenior = make({ title: 'Senior Registered Nurse', postedDate: ago(45) });
  const undated = make({ title: 'Charge Nurse', postedDate: null });
  const list = [fresh, stale, staleSenior, undated];
  const a = applyFilters(list, nurse.filters, nurse.profile);
  assert.deepEqual(a.kept, [fresh, undated]);
  assert.equal(a.rejected.recency, 2);
  assert.deepEqual(finalizeRemoteAndRecency(list, nurse.filters).kept, [fresh, undated]);

  const acct = user('acct-recency', ACCOUNTANT_SEEDS, { maxAgeDays: 10, seniorityExtensionDays: 20 });
  const tenPlus = make({ title: 'Tax Accountant', postedDate: ago(15) });
  const seniorTenPlus = make({ title: 'Senior Accountant', postedDate: ago(15) });
  assert.deepEqual(applyFilters([tenPlus, seniorTenPlus], acct.filters, acct.profile).kept, [seniorTenPlus]);
  assert.deepEqual(applyFilters([tenPlus], { ...acct.filters, maxAgeDays: 0 }, acct.profile).kept, [tenPlus]);
});

test('command line flags win over the profile, and set the short form and the list together', () => {
  const acct = user('acct-cli', ACCOUNTANT_SEEDS, { workModes: ['remote'], countries: ['US'], maxAgeDays: 10 });
  const cli = parseArgs(['--allow-onsite', '--no-us-only', '--max-age', '45', '--include-applied', '--senior-extension', '5']);
  const filters = { ...acct.filters, ...cli.filters };
  assert.equal(filters.remoteOnly, false);
  assert.deepEqual(filters.workModes, []);
  assert.equal(filters.usOnly, false);
  assert.deepEqual(filters.countries, []);
  assert.equal(filters.maxAgeDays, 45);
  assert.equal(filters.seniorityExtensionDays, 5);
  assert.equal(filters.historyFilter, false);
  const onsiteAbroad = make({ title: 'Tax Accountant', location: 'Toronto, Ontario, Canada', postedDate: ago(40) });
  assert.deepEqual(applyFilters([onsiteAbroad], filters, acct.profile).kept, [onsiteAbroad]);
  assert.equal(applyFilters([onsiteAbroad], acct.filters, acct.profile).kept.length, 0);

  const force = parseArgs(['--remote-only', '--us-only']).filters;
  assert.deepEqual(force, { remoteOnly: true, workModes: ['remote'], usOnly: true, countries: ['US'] });

  // A programmatic caller that only switches the short form off lifts the list too.
  const lifted = { ...acct.filters, remoteOnly: false, usOnly: false };
  assert.deepEqual(applyFilters([onsiteAbroad], { ...lifted, maxAgeDays: 45 }, acct.profile).kept, [onsiteAbroad]);
});

test('--query and --location build ad hoc queries with no assumed location', () => {
  const a = parseArgs(['--query', 'Registered Nurse', '--location', 'Columbus, OH', '--query', 'Charge Nurse']);
  assert.deepEqual(a.queries, [
    { query: 'Registered Nurse', location: 'Columbus, OH' },
    { query: 'Charge Nurse', location: '' },
  ]);
  const b = parseArgs(['--location', 'Remote', '--query', 'Tax Accountant', '--dry-run', '--no-enrich', '--source', 'remotive', '--max-enrich', '40', '--show-ghosts', '--no-harvest']);
  assert.deepEqual(b.queries, [{ query: 'Tax Accountant', location: 'Remote' }]);
  assert.deepEqual(b.filters, {}, 'a location is not a filter');
  assert.equal(b.dryRun && b.noEnrich && b.showGhosts && b.noHarvest, true);
  assert.equal(b.onlySource, 'remotive');
  assert.equal(b.maxEnrich, 40);
  assert.equal(a.unknown, undefined);
  assert.equal(b.unknown, undefined);
});

test('--help and unknown flags are reported, never ignored', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.deepEqual(parseArgs(['--dry-run', '--max-agee', '7', '--linkedin']).unknown, ['--max-agee', '7', '--linkedin']);
  const usage = pipeline.usage();
  assert.match(usage, /^Usage:/);
  for (const flag of ['--dry-run', '--source', '--no-enrich', '--max-enrich', '--max-age', '--senior-extension', '--remote-only', '--allow-onsite', '--us-only', '--no-us-only', '--include-applied', '--show-ghosts', '--no-harvest', '--query', '--location', '--help']) {
    assert.ok(usage.includes(flag), `usage names ${flag}`);
    assert.equal(parseArgs([flag, 'x']).unknown?.includes(flag) ?? false, false, `${flag} is a known flag`);
  }
  assert.doesNotMatch(usage, /\*\//);
});

test('the company index learns the ATS host of every posting URL it sees', () => {
  const at = (title, company, url) => make({ title, company, url });
  updateCompanyIndex([
    at('Registered Nurse', 'Acme Clinic', 'https://apply.workable.com/acme-clinic/j/ABC123/'),
    at('Tax Accountant', 'Acme Tax', 'https://acmetax.recruitee.com/o/tax-accountant'),
    at('Charge Nurse', 'Acme Health', 'https://acme-health.breezy.hr/p/charge-nurse'),
    at('Senior Accountant', 'Acme CPA', 'https://acmecpa.bamboohr.com/careers/12'),
    at('Registered Nurse', 'Acme Klinik', 'https://acme-klinik.jobs.personio.com/job/123'),
    at('Registered Nurse', 'Acme Hospital', 'https://boards.greenhouse.io/acmehospital/jobs/1'),
    at('Tax Accountant', 'Corner Bookkeeping', 'https://example.org/careers/9'),
  ]);
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'data/companies/index.json'), 'utf8'));
  const ats = Object.fromEntries(Object.entries(idx).map(([slug, e]) => [slug, e.ats]));
  assert.deepEqual(ats, {
    'acme-clinic': 'workable',
    'acme-health': 'breezy',
    'acme-klinik': 'personio',
    acmecpa: 'bamboohr',
    acmehospital: 'greenhouse',
    acmetax: 'recruitee',
    'corner-bookkeeping': 'other',
  });
  assert.equal(idx['acme-clinic'].name, 'Acme Clinic');
});

test('the senior extension is for senior, sr, principal and lead titles; a staff grade gets none', () => {
  const { ageSignal } = require('../lib/ghost-score');
  const nurse = user('nurse-staff', ['Staff Nurse', 'Registered Nurse'], { maxAgeDays: 30, seniorityExtensionDays: 15 });
  const acct = user('acct-staff', ['Staff Accountant', 'Senior Accountant'], { maxAgeDays: 30, seniorityExtensionDays: 15 });
  const old = (title) => make({ title, postedDate: ago(40) });
  const staffNurse = old('Staff Nurse');
  const staffAcct = old('Staff Accountant');
  const senior = old('Senior Accountant');
  const sr = old('Sr. Accountant');
  assert.deepEqual(applyFilters([staffNurse], nurse.filters, nurse.profile).kept, []);
  assert.deepEqual(finalizeRemoteAndRecency([staffNurse], nurse.filters).kept, []);
  assert.deepEqual(applyFilters([staffAcct, senior, sr], acct.filters, acct.profile).kept, [senior, sr]);
  assert.deepEqual(finalizeRemoteAndRecency([staffAcct, senior, sr], acct.filters).kept, [senior, sr]);
  assert.ok(ageSignal(staffNurse, nurse.filters) > 0, 'a 40 day old staff grade posting is aged');
  assert.equal(ageSignal(senior, acct.filters), 0);
});

test('a remote only user keeps home based and telework listings at both stages', () => {
  const acct = user('acct-home-based', ACCOUNTANT_SEEDS, { workModes: ['remote'], countries: ['GB', 'United Kingdom'] });
  const rows = [
    make({ title: 'Tax Accountant', location: 'Home Based, UK' }),
    make({ title: 'Tax Accountant', location: 'Homeworking' }),
    make({ title: 'Tax Accountant (Home Based)', location: 'United Kingdom' }),
    make({ title: 'Tax Accountant', location: 'United Kingdom', jdText: 'This is a home based role with quarterly office days optional.' }),
  ];
  const office = make({ title: 'Tax Accountant', location: 'Leeds, England' });
  const visits = make({ title: 'Home Based Care Accountant', location: 'United Kingdom' });
  assert.deepEqual(applyFilters([...rows, office], acct.filters, acct.profile).kept, rows);
  assert.deepEqual(finalizeRemoteAndRecency([...rows, office, visits], acct.filters).kept, rows);
});
