'use strict';
// The source plugins that ship in collectors/sources, exercised offline: fetch
// is replaced by a stub that serves canned responses and fails on anything
// unexpected, so no request ever leaves the machine. Synthetic users from two
// unrelated professions (a registered nurse, a tax accountant).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-core-sources-'));
const writeJson = (rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
};
// The user's own seed files (workspace copies).
writeJson('data/companies/portals.json', {
  greenhouse: ['acmehospital'],
  ashby: [{ slug: 'acmetax', name: 'Acme Tax' }],
  lever: ['acmehospital', 'acmehospital'],
});
writeJson('data/companies/non-tech-seed.json', {
  workday: [{ host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'Careers', company: 'Acme Health System', industry: 'healthcare' }],
  smartrecruiters: [{ companyId: 'AcmeTax', company: 'Acme Tax', industry: 'accounting' }],
  icims: [{ host: 'careers-acme.icims.com', company: 'Acme Health System', industry: 'healthcare' }],
});
process.env.JOBE_USER_ROOT = root;
process.env.LINKEDIN_GUEST_PAGES = '1';
delete process.env.WWR_CATEGORIES;

// Sources pause between requests; shrink every pause so the file runs fast.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms || 0, 5), ...rest);

// ---- fetch stub ----
let calls = [];
let handler = null;
const respond = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
globalThis.fetch = async (url, opts = {}) => {
  const call = { url: String(url), opts };
  calls.push(call);
  if (!handler) throw new Error(`unexpected fetch: ${call.url}`);
  return handler(call);
};
const withFetch = async (fn, run) => {
  calls = [];
  handler = fn;
  try { return await run(); } finally { handler = null; }
};

const logs = [];
const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
const ctx = (queries, filters = {}, auth = {}) => ({ queries: queries.map((query) => ({ query })), filters, auth, logger, limiter: { wait: async () => {} } });
const NURSE = ['Registered Nurse', 'Charge Nurse'];
const ACCOUNTANT = ['Tax Accountant'];
const KEYS = { serpApiKey: 'k', braveApiKey: 'k', adzunaAppId: 'k', adzunaAppKey: 'k', jsearchApiKey: 'k' };
const day = 86400000;
const iso = (n) => new Date(Date.now() - n * day).toISOString();

const SRC = path.join(__dirname, '..', 'collectors', 'sources');
const load = (rel) => require(path.join(SRC, rel));
const OWNED = [
  'aggregators/adzuna', 'aggregators/brave-search', 'aggregators/himalayas', 'aggregators/hn-who-is-hiring',
  'aggregators/jsearch', 'aggregators/linkedin-guest', 'aggregators/remoteok', 'aggregators/remotive',
  'aggregators/serpapi-google-jobs', 'aggregators/serpapi-site-search', 'aggregators/weworkremotely',
  'company-specific/amazon-jobs', 'company-specific/apple-jobs', 'ats-directories/ashby-directory',
  'ats-direct/greenhouse', 'ats-direct/lever', 'ats-direct/workday', 'ats-direct/smartrecruiters', 'ats-direct/icims',
];

test('every plugin honours the contract shape', () => {
  const ids = new Set();
  for (const rel of OWNED) {
    const mod = load(rel);
    assert.equal(typeof mod.id, 'string', rel);
    assert.equal(typeof mod.name, 'string', rel);
    assert.equal(typeof mod.discover, 'function', rel);
    assert.ok(Array.isArray(mod.requires), rel);
    assert.ok(!ids.has(mod.id), `duplicate id ${mod.id}`);
    ids.add(mod.id);
  }
});

test('search based plugins carry no role vocabulary: with no seeds they return [] and fetch nothing', async () => {
  const searchBased = [
    'aggregators/adzuna', 'aggregators/brave-search', 'aggregators/jsearch', 'aggregators/linkedin-guest',
    'aggregators/remotive', 'aggregators/serpapi-google-jobs', 'aggregators/serpapi-site-search',
    'company-specific/amazon-jobs', 'company-specific/apple-jobs',
    'ats-direct/workday', 'ats-direct/smartrecruiters', 'ats-direct/icims',
  ];
  for (const rel of searchBased) {
    calls = [];
    const got = await load(rel).discover(ctx([], { companySites: ['careers.example.org'] }, KEYS));
    assert.deepEqual(got, [], rel);
    assert.equal(calls.length, 0, `${rel} fetched with no seeds`);
  }
});

test('seed files: the workspace copy is read first, unioned with the shared copy, duplicates dropped', () => {
  const { portalList, nonTechSeed, seedList } = require('../collectors/seed-files');
  assert.equal(portalList('greenhouse')[0], 'acmehospital');
  assert.deepEqual(portalList('ashby')[0], { slug: 'acmetax', name: 'Acme Tax' });
  assert.equal(portalList('lever').filter((s) => s === 'acmehospital').length, 1);
  assert.equal(nonTechSeed('workday')[0].tenant, 'acme');
  assert.deepEqual(seedList('nothing-here', 'data/companies/portals.json', 'configs/does-not-exist.json'), []);

  // The employer seed is read from the workspace and from the shared configs
  // folder, never from data/ at the install root: in single user mode that is
  // one person's own file, and a named workspace must not scan it.
  const { getSystemRoot } = require('../lib/config');
  const real = fs.readFileSync;
  const read = [];
  fs.readFileSync = (file, ...rest) => { read.push(String(file)); return real(file, ...rest); };
  try { nonTechSeed('smartrecruiters'); } finally { fs.readFileSync = real; }
  assert.deepEqual(read, [
    path.join(root, 'data/companies/non-tech-seed.json'),
    path.join(getSystemRoot(), 'configs/non-tech-seed.json'),
  ]);
});

test('lever and ashby: the pay period the feed states goes with the band', async () => {
  const { publishedMax } = require('../collectors/pipeline');
  const lever = await withFetch(({ url }) => {
    if (!url.includes('/postings/acmehospital')) return respond({}, { status: 404 });
    return respond([
      { text: 'Registered Nurse, ICU', hostedUrl: 'https://jobs.lever.co/acmehospital/1', categories: { location: 'Columbus, OH' }, createdAt: Date.now() - day, salaryRange: { min: 38, max: 52, currency: 'USD', interval: 'per-hour-wage' } },
      { text: 'Charge Nurse', hostedUrl: 'https://jobs.lever.co/acmehospital/2', categories: { location: 'Columbus, OH' }, createdAt: Date.now() - day, salaryRange: { min: 82000, max: 96000, currency: 'USD', interval: 'per-year-salary' } },
      { text: 'Registered Nurse, Oncology', hostedUrl: 'https://jobs.lever.co/acmehospital/3', categories: { location: 'Columbus, OH' }, createdAt: Date.now() - day, salaryRange: { min: 6500, max: 7800, currency: 'USD', interval: 'per-month-salary' } },
      { text: 'Registered Nurse, Float', hostedUrl: 'https://jobs.lever.co/acmehospital/4', categories: { location: 'Columbus, OH' }, createdAt: Date.now() - day, salaryRange: { min: 80000, max: 90000, currency: 'USD' } },
    ]);
  }, () => load('ats-direct/lever').discover(ctx(NURSE)));
  assert.deepEqual(lever.map((p) => p.compensation.period), ['hour', 'year', 'month', undefined]);
  assert.deepEqual(lever.map((p) => publishedMax(p, 'USD')), [null, 96000, null, 90000], 'only a yearly band is compared with a yearly floor');

  const ashby = await withFetch(({ url }) => {
    if (!url.includes('/job-board/acmetax')) return respond({}, { status: 404 });
    const tier = (interval, minValue, maxValue) => ({ compensationTiers: [{ components: [{ compensationType: 'Salary', interval, currencyCode: 'USD', minValue, maxValue }] }] });
    return respond({ jobs: [
      { id: 'b1', title: 'Tax Accountant', location: 'Remote', isRemote: true, publishedAt: iso(2), compensation: tier('1 YEAR', 70000, 90000) },
      { id: 'b2', title: 'Tax Accountant, Seasonal', location: 'Remote', isRemote: true, publishedAt: iso(2), compensation: tier('1 HOUR', 40, 55) },
      { id: 'b3', title: 'Tax Accountant, Contract', location: 'Remote', isRemote: true, publishedAt: iso(2), compensation: tier('1 MONTH', 6000, 7500) },
    ] });
  }, () => load('ats-directories/ashby-directory').discover(ctx(ACCOUNTANT)));
  assert.deepEqual(ashby.map((p) => p.compensation.period), ['year', 'hour', 'month']);
  assert.deepEqual(ashby.map((p) => publishedMax(p, 'USD')), [90000, null, null]);
});

test('greenhouse: the posted date is the original publish date, not the refresh date', async () => {
  const first = iso(40);
  const got = await withFetch(({ url }) => {
    if (url.endsWith('/boards/acmehospital/jobs?content=true')) {
      return respond({ jobs: [
        { title: 'Registered Nurse, ICU', absolute_url: 'https://boards.greenhouse.io/acmehospital/jobs/1', location: { name: 'Columbus, OH' }, first_published: first, updated_at: iso(1), content: '&lt;p&gt;Care for patients&lt;/p&gt;' },
        { title: 'Charge Nurse', absolute_url: 'https://boards.greenhouse.io/acmehospital/jobs/2', location: { name: 'Columbus, OH' }, updated_at: iso(3) },
        { title: 'Tax Accountant', absolute_url: 'https://boards.greenhouse.io/acmehospital/jobs/3', location: { name: 'Columbus, OH' }, updated_at: iso(3) },
      ] });
    }
    if (url.endsWith('/boards/acmehospital')) return respond({ name: 'Acme Hospital' });
    return respond({}, { status: 404 });
  }, () => load('ats-direct/greenhouse').discover(ctx(NURSE)));
  assert.deepEqual(got.map((p) => p.title), ['Registered Nurse, ICU', 'Charge Nurse'], 'titles gated by the user seeds');
  assert.equal(got[0].postedDate, first);
  assert.equal(got[0].company, 'Acme Hospital');
  assert.ok(got[1].postedDate, 'falls back to updated_at when no first_published');
});

test('ashby: publishedAt is the posted date; the slug comes from the user portals file', async () => {
  const published = iso(20);
  const got = await withFetch(({ url }) => {
    if (url.includes('/job-board/acmetax')) {
      return respond({ jobs: [
        { id: 'a1', title: 'Senior Tax Accountant', location: 'Remote', isRemote: true, publishedAt: published, updatedAt: iso(1), descriptionPlain: 'Prepare returns' },
      ] });
    }
    return respond({}, { status: 404 });
  }, () => load('ats-directories/ashby-directory').discover(ctx(ACCOUNTANT)));
  assert.equal(got.length, 1);
  assert.equal(got[0].postedDate, published);
  assert.equal(got[0].remote, 'remote');
});

test('workday: tenants come from the user seed file and search terms from the user seeds', async () => {
  const got = await withFetch(({ url, opts }) => {
    assert.equal(url, 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs');
    const term = JSON.parse(opts.body).searchText;
    assert.ok(NURSE.includes(term), `search term ${term} is a seed role`);
    return respond({ jobPostings: [
      { title: 'Registered Nurse - Oncology', externalPath: '/job/Columbus/RN_R-1', locationsText: 'Columbus, OH', postedOn: 'Posted 3 Days Ago' },
      { title: 'Payroll Accountant', externalPath: '/job/Columbus/PA_R-2', locationsText: 'Columbus, OH', postedOn: 'Posted 3 Days Ago' },
    ] });
  }, () => load('ats-direct/workday').discover(ctx(NURSE)));
  assert.deepEqual(got.map((p) => p.title), ['Registered Nurse, Oncology']);
  assert.equal(got[0].company, 'Acme Health System');
  assert.equal(calls.length, 2, 'one search per seed role');
});

test('serpapi google jobs: stops on 429, stops on an empty page, names a country only under a policy', async () => {
  let n = 0;
  const quota = () => respond('slow down', { status: 429, headers: { 'retry-after': '0.001' } });
  const serve = () => {
    n++;
    if (n === 1) {
      return respond({
        jobs_results: [{ title: 'Tax Accountant', company_name: 'Ledger and Finch', location: 'Remote', apply_options: [{ link: 'https://example.org/apply/1' }], description: 'Prepare returns' }],
        serpapi_pagination: { next_page_token: 'tok' },
      });
    }
    return respond({ jobs_results: [], serpapi_pagination: { next_page_token: 'stale' } });
  };
  const src = load('aggregators/serpapi-google-jobs');
  const quotaRows = await withFetch(quota, () => src.discover(ctx(ACCOUNTANT, {}, KEYS)));
  assert.deepEqual(quotaRows, []);
  assert.equal(calls.length, 1, 'a provider quota response stops the source immediately');

  n = 0;
  const got = await withFetch(serve, () => src.discover(ctx(ACCOUNTANT, {}, KEYS)));
  assert.equal(got.length, 1);
  assert.equal(calls.length, 2, 'one result page, then one empty page and no more');
  assert.equal(new URL(calls[0].url).searchParams.has('location'), false, 'no policy, no country');

  assert.equal(new URL(calls[0].url).searchParams.has('gl'), false, 'no policy, no market');

  n = 2;
  await withFetch(serve, () => src.discover(ctx(ACCOUNTANT, { usOnly: true }, KEYS)));
  assert.equal(new URL(calls[0].url).searchParams.get('location'), 'United States');

  // The search market is the user's single country code; several countries, or
  // a name alone, leave it unset.
  const market = async (rel, countries) => {
    n = 2;
    await withFetch(serve, () => load(rel).discover(ctx(ACCOUNTANT, { countries }, KEYS)));
    return new URL(calls[0].url).searchParams.get('gl');
  };
  for (const rel of ['aggregators/serpapi-google-jobs', 'aggregators/serpapi-site-search']) {
    assert.equal(await market(rel, ['GB', 'United Kingdom']), 'gb', rel);
    assert.equal(await market(rel, ['CA', 'Canada']), 'ca', rel);
    assert.equal(await market(rel, ['GB', 'IE']), null, rel);
    assert.equal(await market(rel, ['Germany']), 'de', rel);
    assert.equal(await market(rel, ['UK']), 'gb', rel);
    assert.equal(await market(rel, []), null, rel);
  }
});

test('site search (serpapi and brave): roles from the seeds, company sites only from the user list', () => {
  const serp = load('aggregators/serpapi-site-search');
  const brave = load('aggregators/brave-search');
  const queries = NURSE.map((query) => ({ query, location: 'Columbus, OH' }));
  for (const mod of [serp, brave]) {
    const none = mod.buildSiteQueries(queries, { companySites: [] });
    assert.equal(none.length, serp.ATS_DOMAINS.length * NURSE.length, 'ATS domains only');
    assert.ok(none.every((q) => /"Registered Nurse"|"Charge Nurse"/.test(q.query)));
    assert.ok(none.every((q) => !/ remote/.test(q.query)), 'no remote hint without a remote policy');
    assert.ok(none.every((q) => q.location === ''), 'a seed location is never stamped on a search hit');

    const mine = mod.buildSiteQueries(queries, { remoteOnly: true, companySites: ['https://careers.example.org/', { site: 'example.com/jobs', company: 'Example Health' }] });
    const extra = mine.slice(serp.ATS_DOMAINS.length * NURSE.length);
    assert.deepEqual(extra.map((q) => q.domain), [
      { site: 'careers.example.org', company: 'Example' },
      { site: 'example.com/jobs', company: 'Example Health' },
    ]);
    assert.match(extra[0].query, /^site:careers\.example\.org \("Registered Nurse" OR "Charge Nurse"\) remote/);
    assert.match(extra[1].query, /^site:example\.com inurl:jobs /);
    assert.deepEqual(mod.buildSiteQueries([], { companySites: ['careers.example.org'] }), [], 'no seeds, nothing to search');
  }
});

test('brave: the search market follows the country policy and is unset without one', async () => {
  const brave = load('aggregators/brave-search');
  const serve = () => respond({ web: { results: [] } });
  await withFetch(serve, () => brave.discover(ctx(ACCOUNTANT, {}, KEYS)));
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => !new URL(c.url).searchParams.has('country')));
  assert.ok(calls.every((c) => /^\d{4}-\d\d-\d\dto\d{4}-\d\d-\d\d$/.test(new URL(c.url).searchParams.get('freshness'))), 'the default window');
  await withFetch(serve, () => brave.discover(ctx(ACCOUNTANT, { countries: ['US'], usOnly: true }, KEYS)));
  assert.ok(calls.every((c) => new URL(c.url).searchParams.get('country') === 'us'));
  // The form onboarding writes (code plus name) still picks the market, and a
  // window of 0 sends no freshness range.
  await withFetch(serve, () => brave.discover(ctx(NURSE, { countries: ['CA', 'Canada'], maxAgeDays: 0 }, KEYS)));
  assert.ok(calls.every((c) => new URL(c.url).searchParams.get('country') === 'ca'));
  assert.ok(calls.every((c) => !new URL(c.url).searchParams.has('freshness')));
});

const card = (title, company, location, id) => `<li><div class="base-card">
  <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${id}?refId=abc"></a>
  <h3 class="base-search-card__title">${title}</h3>
  <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/x">${company}</a></h4>
  <span class="job-search-card__location">${location}</span>
  <time datetime="${iso(2).slice(0, 10)}">2 days ago</time></div></li>`;
const CARDS = [
  card('Registered Nurse, Telehealth', 'Mercy West Health', 'Columbus, OH', 101),
  card('Registered Nurse (Hybrid)', 'Lakeside Hospital', 'Dayton, OH', 102),
  card('Charge Nurse - Chicago', 'Harbor Clinic', 'Chicago, IL', 103),
].join('\n');
// Titles that name a place no metro table would hold, and titles that do not.
const PLACE_CARDS = [
  card('Tax Manager - Leeds', 'Ledger and Finch', 'Leeds, England, United Kingdom', 201),
  card('Tax Accountant (Manchester)', 'Harbor Tax Group', 'Manchester, England, United Kingdom', 202),
  card('Registered Nurse - Calgary, AB', 'Lakeside Hospital', 'Toronto, Ontario, Canada', 203),
  card('Tax Senior, Sheffield office', 'Ledger and Finch', 'Sheffield, England, United Kingdom', 204),
  card('Tax Manager', 'Ledger and Finch', 'Leeds, England, United Kingdom', 205),
  card('Tax Manager, United Kingdom', 'Harbor Tax Group', 'United Kingdom', 206),
  card('Registered Nurse - ICU', 'Lakeside Hospital', 'Halifax, Nova Scotia, Canada', 207),
  card('Tax Accountant (Remote, United Kingdom)', 'Harbor Tax Group', 'Bristol, England, United Kingdom', 208),
].join('\n');

test('linkedin guest: the search scope comes from the policy, and no policy narrows nothing', async () => {
  const src = load('aggregators/linkedin-guest');
  assert.deepEqual(src.searchScope({}), { tprSeconds: 30 * 86400, workTypes: '', geo: '' });
  assert.deepEqual(src.searchScope({ remoteOnly: true, workModes: ['remote'], usOnly: true, countries: ['US'], maxAgeDays: 7 }),
    { tprSeconds: 7 * 86400, workTypes: '2', geo: 'United States' });
  assert.deepEqual(src.searchScope({ workModes: ['onsite', 'hybrid'], countries: ['CA', 'Canada'], maxAgeDays: 0 }),
    { tprSeconds: 0, workTypes: '1,3', geo: 'Canada' });

  const got = await withFetch(() => respond(CARDS), () => src.discover(ctx(['Registered Nurse'], { maxAgeDays: 30 })));
  const qs = new URL(calls[0].url).searchParams;
  assert.equal(qs.get('keywords'), 'Registered Nurse');
  assert.equal(qs.has('f_WT'), false);
  assert.equal(qs.has('location'), false);
  assert.deepEqual(got.map((p) => [p.location, p.hqLocation, p.remoteVerified]), [
    ['Columbus, OH', 'Columbus, OH', false],
    ['Dayton, OH', 'Dayton, OH', false],
    ['Chicago, IL', 'Chicago, IL', false],
  ]);
});

test('linkedin guest: discovery is not verification under a remote search', async () => {
  const src = load('aggregators/linkedin-guest');
  const filters = { remoteOnly: true, workModes: ['remote'], usOnly: true, countries: ['US'], maxAgeDays: 9 };
  const got = await withFetch(() => respond(CARDS), () => src.discover(ctx(['Registered Nurse'], filters)));
  const qs = new URL(calls[0].url).searchParams;
  assert.equal(qs.get('f_WT'), '2');
  assert.equal(qs.get('location'), 'United States');
  assert.equal(qs.get('f_TPR'), `r${9 * 86400}`);
  const [plain, hybridTitle, cityTitle] = got;
  assert.equal(plain.remote, 'remote', 'a provisional label, to survive the listing stage gate');
  assert.equal(plain.hqLocation, 'Columbus, OH', 'the displayed city is kept as the cross check');
  assert.equal(plain.remoteVerified, false, 'only verification may confirm a work mode');
  assert.equal(hybridTitle.location, 'Dayton, OH', 'a title that says hybrid is never stamped remote');
  assert.equal(hybridTitle.remote, 'hybrid');
  assert.equal(cityTitle.location, 'Chicago, IL', 'a title that names a city is never stamped remote');
  assert.notEqual(cityTitle.remote, 'remote');
  assert.ok(got.every((p) => p.remoteVerified === false));
});

test('linkedin guest: a title that names a place is never stamped remote, in any country', async () => {
  const src = load('aggregators/linkedin-guest');
  const filters = { remoteOnly: true, workModes: ['remote'], countries: ['GB', 'United Kingdom'], maxAgeDays: 30 };
  const got = await withFetch(() => respond(PLACE_CARDS), () => src.discover(ctx(['Tax Accountant'], filters)));
  assert.equal(new URL(calls[0].url).searchParams.get('location'), 'United Kingdom');
  const byTitle = Object.fromEntries(got.map((p) => [p.title, p]));
  for (const [title, shown] of [
    ['Tax Manager, Leeds', 'Leeds, England, United Kingdom'],
    ['Tax Accountant (Manchester)', 'Manchester, England, United Kingdom'],
    ['Registered Nurse, Calgary, AB', 'Toronto, Ontario, Canada'],
    ['Tax Senior, Sheffield office', 'Sheffield, England, United Kingdom'],
  ]) {
    assert.equal(byTitle[title].location, shown, `${title}: keeps the displayed location`);
    assert.notEqual(byTitle[title].remote, 'remote', title);
  }
  for (const title of ['Tax Manager', 'Tax Manager, United Kingdom', 'Registered Nurse, ICU', 'Tax Accountant (Remote, United Kingdom)']) {
    assert.equal(byTitle[title].location, 'Remote, United Kingdom', `${title}: no place in the title, provisional remote label`);
    assert.equal(byTitle[title].remote, 'remote', title);
  }
  const t = (title, location) => src.titleNamesPlace({ title, location });
  assert.equal(t('Staff Nurse (Leeds, UK)', 'London, England, United Kingdom'), true);
  assert.equal(t('Tax Accountant - Lyon, France', ''), true);
  assert.equal(t('Senior Accountant, Tax', 'Columbus, OH'), false);
  assert.equal(t('Accountant - Payroll, HR', 'Denver, CO'), false);
  assert.equal(t('Charge Nurse - Med Surg, Nights', 'Denver, CO'), false);
  assert.equal(t('Reading Specialist', 'Reading, PA'), false);
  // A region code that is also a title abbreviation is a place only when the
  // card shows the same code.
  for (const [title, location] of [
    ['Nurse Practitioner - Surgery, OR', 'Dallas, TX'], ['Charge Nurse - Labor and Delivery, IN', 'Chicago, IL'],
    ['Accountant - Payroll, AR', 'Austin, TX'], ['Radiographer - Imaging, CT', 'Boston, MA'],
    ['Physician - Emergency Medicine, MD', 'Dallas, TX'],
  ]) assert.equal(t(title, location), false, title);
  assert.equal(t('Staff Nurse (Portland, OR)', 'Portland, OR'), true);
  assert.equal(t('Staff Nurse - Calgary, AB', 'Toronto, ON'), true);
  assert.equal(t('Tax Accountant - Calgary, Alberta', 'Toronto, ON'), true);
  // A work mode word on the card is never the city the title is matched against.
  assert.equal(t('Registered Nurse (Remote)', 'Remote, OR'), false);
  assert.equal(t('Tax Accountant | Remote', 'Remote, United States'), false);
});

test('linkedin guest: one search per accepted work type, and a card carries the facet it came from', async () => {
  const src = load('aggregators/linkedin-guest');
  const serve = ({ url }) => {
    const type = new URL(url).searchParams.get('f_WT');
    if (type === '2') return respond(card('Tax Accountant', 'Ledger and Finch', 'Columbus, OH', 301));
    if (type === '3') return respond([
      card('Tax Accountant', 'Harbor Tax Group', 'Denver, CO', 302),
      card('Senior Accountant (On-site)', 'Harbor Tax Group', 'Denver, CO', 303),
    ].join('\n'));
    return respond('');
  };
  const filters = { workModes: ['remote', 'hybrid'], usOnly: true, countries: ['US'], maxAgeDays: 30 };
  const got = await withFetch(serve, () => src.discover(ctx(['Tax Accountant'], filters)));
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('f_WT')), ['2', '3'], 'never one request with both facets');
  const [remote, hybrid, onsiteTitle] = got;
  assert.equal(remote.remote, 'remote');
  assert.equal(remote.location, 'Remote, United States');
  assert.equal(hybrid.remote, 'hybrid', 'a card from the hybrid search is labeled hybrid at its displayed city');
  assert.equal(hybrid.location, 'Denver, CO (Hybrid)');
  assert.equal(hybrid.hqLocation, 'Denver, CO');
  assert.equal(onsiteTitle.location, 'Denver, CO', 'a title that states another mode is not labeled hybrid');
  assert.ok(got.every((p) => p.remoteVerified === false));
  // Both labeled rows pass the listing stage and the strict stage under that policy.
  const { applyFilters, finalizeRemoteAndRecency } = require('../collectors/pipeline');
  const { buildProfile } = require('../lib/rank');
  const pre = applyFilters(got, { ...filters, historyFilter: false }, buildProfile({ queries: [{ query: 'Tax Accountant' }, { query: 'Senior Accountant' }], root }));
  assert.deepEqual(pre.kept, got, 'the city only card waits for enrichment');
  assert.deepEqual(finalizeRemoteAndRecency(got, filters).kept, [remote, hybrid]);

  // A nurse who works on site or hybrid, and no policy at all.
  await withFetch(() => respond(''), () => src.discover(ctx(['Registered Nurse'], { workModes: ['onsite', 'hybrid'] })));
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('f_WT')), ['1', '3']);
  await withFetch(() => respond(''), () => src.discover(ctx(['Registered Nurse'], {})));
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.has('f_WT')), [false]);
});

test('feed sources filter on the user titles and emit no field label', async () => {
  const feed = [
    { legal: 'notice' },
    { id: 1, slug: 'tax-accountant-1', position: 'Tax Accountant', company: 'Ledger and Finch', location: 'United States', date: iso(2), url: 'https://example.org/r/1', salary_min: 70000, salary_max: 90000 },
    { id: 2, slug: 'registered-nurse-2', position: 'Registered Nurse', company: 'Mercy West Health', location: 'United States', date: iso(2), url: 'https://example.org/r/2' },
  ];
  const got = await withFetch(() => respond(feed), () => load('aggregators/remoteok').discover(ctx(ACCOUNTANT, { maxAgeDays: 30 })));
  assert.deepEqual(got.map((p) => p.title), ['Tax Accountant']);
  assert.equal(got[0].discoveredVia[0].sourceQuery, 'feed');

  // Recency: one shared reading. A 60 day old row is dropped by a 30 day
  // window (and by the default), and kept when the window is 0 (off).
  const old = [{ id: 3, slug: 'tax-accountant-3', position: 'Tax Accountant', company: 'Harbor Tax Group', location: 'Canada', date: iso(60), url: 'https://example.org/r/3' }];
  const remoteok = (filters) => withFetch(() => respond(old), () => load('aggregators/remoteok').discover(ctx(ACCOUNTANT, filters)));
  assert.equal((await remoteok({ maxAgeDays: 30 })).length, 0);
  assert.equal((await remoteok({})).length, 0);
  assert.equal((await remoteok({ maxAgeDays: 90 })).length, 1);
  assert.equal((await remoteok({ maxAgeDays: 0 })).length, 1);
  const nomads = (filters) => withFetch(
    () => respond([{ title: 'Registered Nurse', company_name: 'Mercy West Health', url: 'https://example.org/n/1', pub_date: iso(60), location: 'Anywhere' }]),
    () => load('aggregators/working-nomads').discover(ctx(NURSE, filters)),
  );
  assert.equal((await nomads({ maxAgeDays: 30 })).length, 0);
  assert.equal((await nomads({ maxAgeDays: 0 })).length, 1);

  const rss = `<rss><channel><item><title>Mercy West Health: Registered Nurse, Telehealth</title><link>https://example.org/w/1</link><pubDate>${new Date(Date.now() - day).toUTCString()}</pubDate><region>USA Only</region><description>Care</description></item></channel></rss>`;
  const wwr = await withFetch(() => respond(rss), () => load('aggregators/weworkremotely').discover(ctx(NURSE, { maxAgeDays: 30 })));
  assert.deepEqual(calls.map((c) => c.url), ['https://weworkremotely.com/remote-jobs.rss'], 'only the catch all feed by default');
  assert.equal(wwr.length, 1);
});

test('country and work mode are sent only when the policy asks: adzuna, jsearch, amazon, apple', async () => {
  // adzuna: market from the country list, no remote bias, no dollar sign outside the US market
  const adz = await withFetch(() => respond({ results: [
    { title: 'Tax Accountant', company: { display_name: 'Ledger and Finch' }, location: { display_name: 'Leeds' }, redirect_url: 'https://example.org/a/1', created: iso(1), salary_min: 40000, salary_max: 50000 },
  ] }), () => load('aggregators/adzuna').discover(ctx(ACCOUNTANT, { countries: ['GB', 'United Kingdom'], maxAgeDays: 30 }, KEYS)));
  assert.match(calls[0].url, /\/jobs\/gb\/search\/1\?/);
  assert.equal(new URL(calls[0].url).searchParams.has('where'), false);
  assert.equal(adz[0].compensation, '40000 - 50000');
  assert.equal(new URL(calls[0].url).searchParams.get('max_days_old'), '30');
  await withFetch(() => respond({ results: [] }), () => load('aggregators/adzuna').discover(ctx(ACCOUNTANT, { countries: ['US'], remoteOnly: true, maxAgeDays: 0 }, KEYS)));
  assert.match(calls[0].url, /\/jobs\/us\/search\/1\?/);
  assert.equal(new URL(calls[0].url).searchParams.get('where'), 'remote');
  assert.equal(new URL(calls[0].url).searchParams.has('max_days_old'), false, 'a window of 0 sends no recency cut');
  // no country policy: no market is assumed, the source skips
  const none = await withFetch(() => respond({ results: [] }), () => load('aggregators/adzuna').discover(ctx(ACCOUNTANT, {}, KEYS)));
  assert.deepEqual(none, []);
  assert.equal(calls.length, 0);

  // jsearch
  await withFetch(() => respond({ data: [] }), () => load('aggregators/jsearch').discover(ctx(ACCOUNTANT, {}, KEYS)));
  let qs = new URL(calls[0].url).searchParams;
  assert.equal(qs.get('query'), 'Tax Accountant');
  assert.equal(qs.has('work_from_home'), false);
  assert.equal(qs.has('country'), false, 'no policy, no market');
  assert.equal(qs.get('date_posted'), 'month');
  for (const [countries, want] of [[['GB', 'United Kingdom'], 'gb'], [['CA', 'Canada'], 'ca'], [['GB', 'IE'], null], [['Germany'], 'de'], [['UK'], 'gb']]) {
    await withFetch(() => respond({ data: [] }), () => load('aggregators/jsearch').discover(ctx(ACCOUNTANT, { countries }, KEYS)));
    assert.equal(new URL(calls[0].url).searchParams.get('country'), want, String(countries));
    assert.equal(new URL(calls[0].url).searchParams.get('query'), 'Tax Accountant', 'no country words are added to the query');
  }
  const js = await withFetch(() => respond({ data: [
    { job_title: 'Tax Accountant', employer_name: 'Ledger and Finch', job_city: 'Leeds', job_apply_link: 'https://example.org/js/1', job_min_salary: 40000, job_max_salary: 50000, job_salary_currency: 'gbp', job_salary_period: 'YEAR' },
    { job_title: 'Tax Accountant', employer_name: 'Harbor Tax Group', job_city: 'Leeds', job_apply_link: 'https://example.org/js/2', job_min_salary: 40000, job_max_salary: 50000 },
  ] }), () => load('aggregators/jsearch').discover(ctx(ACCOUNTANT, { maxAgeDays: 0 }, KEYS)));
  assert.equal(new URL(calls[0].url).searchParams.get('date_posted'), 'all', 'a window of 0 sends no recency cut');
  assert.equal(js[0].compensation, 'GBP 40000 - 50000 per year');
  assert.equal(js[1].compensation, '40000 - 50000', 'no currency stated, none printed');
  await withFetch(() => respond({ data: [] }), () => load('aggregators/jsearch').discover(ctx(ACCOUNTANT, { usOnly: true, remoteOnly: true }, KEYS)));
  qs = new URL(calls[0].url).searchParams;
  assert.equal(qs.get('query'), 'Tax Accountant in united states');
  assert.equal(qs.get('work_from_home'), 'true');

  // amazon
  await withFetch(() => respond({ jobs: [] }), () => load('company-specific/amazon-jobs').discover(ctx(NURSE, {})));
  assert.ok(calls.every((c) => !new URL(c.url).searchParams.has('country[]')));
  await withFetch(() => respond({ jobs: [] }), () => load('company-specific/amazon-jobs').discover(ctx(NURSE, { usOnly: true })));
  assert.ok(calls.every((c) => new URL(c.url).searchParams.get('country[]') === 'US'));

  // apple
  const html = '<a href="/en-us/details/200000001/registered-nurse-onsite-clinic?team=x">x</a>';
  const apple = await withFetch(() => respond(html), () => load('company-specific/apple-jobs').discover(ctx(['Registered Nurse'], {})));
  assert.equal(new URL(calls[0].url).searchParams.has('location'), false);
  assert.equal(apple[0].location, '');
  const appleUs = await withFetch(() => respond(html), () => load('company-specific/apple-jobs').discover(ctx(['Registered Nurse'], { usOnly: true })));
  assert.equal(new URL(calls[0].url).searchParams.get('location'), 'united-states-USA');
  assert.equal(appleUs[0].location, 'United States');
});

test('serpapi site search: a hit that states no place carries no location, whatever the seeds say', async () => {
  const src = load('aggregators/serpapi-site-search');
  const serve = () => respond({ organic_results: [
    { title: 'Registered Nurse, Medical Surgical', link: 'https://careers.icims.com/jobs/1/job', snippet: 'A 300 bed hospital serving the coast.' },
    { title: 'Registered Nurse ICU', link: 'https://careers.icims.com/jobs/2/job', snippet: 'Join our unit in Hamilton, ON today.' },
  ] });
  const queries = [{ query: 'Registered Nurse', location: 'Toronto, ON' }];
  const got = await withFetch(serve, () => src.discover({ queries, filters: { workModes: ['onsite', 'hybrid'], regions: ['Toronto', 'Ontario'], maxAgeDays: 30 }, auth: KEYS, logger }));
  const byUrl = Object.fromEntries(got.map((p) => [p.canonicalUrl, p]));
  const bare = byUrl['https://careers.icims.com/jobs/1/job'];
  assert.equal(bare.location, '', 'never the seed location');
  assert.equal(bare.remote, 'unknown');
  assert.equal(bare.us, null);
  assert.equal(byUrl['https://careers.icims.com/jobs/2/job'].location, 'Hamilton, ON', 'a place the snippet states is kept');
});

test('work that needs the candidate on site is searched in the seed place; the remote search stays country wide', async () => {
  const lg = load('aggregators/linkedin-guest');
  const seeds = (rows) => ({ queries: rows.map(([query, location]) => ({ query, location })), auth: KEYS, logger });
  const sent = () => calls.map((c) => { const q = new URL(c.url).searchParams; return [q.get('f_WT'), q.get('location')]; });

  // A nurse who works on site or hybrid in Colorado.
  const nurse = seeds([['Registered Nurse', 'Denver, CO'], ['Registered Nurse', 'Colorado'], ['Registered Nurse', 'Boulder, CO']]);
  await withFetch(() => respond(''), () => lg.discover({ ...nurse, filters: { workModes: ['hybrid', 'onsite'], usOnly: true, countries: ['US'], regions: ['Denver', 'Colorado'] } }));
  assert.deepEqual(sent(), [
    ['3', 'Denver, CO, United States'], ['3', 'Colorado, United States'],
    ['1', 'Denver, CO, United States'], ['1', 'Colorado, United States'],
  ], 'the first two seed places, per accepted mode');

  // An accountant who also accepts remote: the remote search names the country alone.
  const acct = seeds([['Tax Accountant', 'Leeds'], ['Tax Accountant', 'Remote']]);
  const got = await withFetch(({ url }) => respond(new URL(url).searchParams.get('f_WT') === '2' ? card('Tax Accountant', 'Ledger and Finch', 'London, England, United Kingdom', 401) : ''),
    () => lg.discover({ ...acct, filters: { workModes: ['remote', 'onsite'], countries: ['GB', 'United Kingdom'] } }));
  assert.deepEqual(sent(), [['2', 'United Kingdom'], ['1', 'Leeds, United Kingdom']]);
  assert.equal(got[0].location, 'Remote, United Kingdom', 'the provisional remote label still names the country');

  // No seed place: the user's first region written as a name; no region either: the country as before.
  await withFetch(() => respond(''), () => lg.discover({ ...seeds([['Registered Nurse', 'Remote']]), filters: { workModes: ['onsite'], countries: ['CA', 'Canada'], regions: ['ON', 'Toronto', 'Ontario'] } }));
  assert.deepEqual(sent(), [['1', 'Toronto, Canada']]);
  await withFetch(() => respond(''), () => lg.discover({ ...seeds([['Registered Nurse', '']]), filters: { workModes: ['onsite'], countries: ['CA', 'Canada'] } }));
  assert.deepEqual(sent(), [['1', 'Canada']]);
  // No work mode policy: one search with no facet, never narrowed to a seed place.
  await withFetch(() => respond(''), () => lg.discover({ ...nurse, filters: {} }));
  assert.deepEqual(sent(), [[null, null]]);
  // A list of bare codes sends the country by its name.
  assert.equal(lg.searchScope({ countries: ['GB'] }).geo, 'United Kingdom');
  assert.equal(lg.searchScope({ countries: ['XX'] }).geo, '');
  // Several bare codes: no country is picked, and a seed place goes out as written.
  assert.equal(lg.searchScope({ countries: ['US', 'CA'] }).geo, '');
  assert.equal(lg.searchScope({ countries: ['GB', 'IE'] }).geo, '');
  assert.equal(lg.searchScope({ countries: ['GB', 'gb'] }).geo, 'United Kingdom');
  await withFetch(() => respond(''), () => lg.discover({ ...seeds([['Registered Nurse', 'Toronto, ON'], ['Registered Nurse', 'Denver, CO']]), filters: { workModes: ['onsite'], countries: ['US', 'CA'] } }));
  assert.deepEqual(sent(), [['1', 'Toronto, ON'], ['1', 'Denver, CO']]);
  const two = await withFetch(() => respond(card('Tax Accountant', 'Ledger and Finch', 'Toronto, Ontario, Canada', 402)), () => lg.discover({ ...seeds([['Tax Accountant', 'Remote']]), filters: { workModes: ['remote'], countries: ['US', 'CA'] } }));
  assert.deepEqual(sent().slice(0, 1), [['2', null]]);
  assert.doesNotMatch(two[0].location, /United States/, 'no country is stamped on the provisional remote label');

  // adzuna, jsearch, usajobs: the place is sent only under a policy with no remote work.
  const onSite = { workModes: ['hybrid', 'onsite'], usOnly: true, countries: ['US'] };
  const adz = load('aggregators/adzuna');
  await withFetch(() => respond({ results: [] }), () => adz.discover({ ...nurse, filters: onSite }));
  assert.equal(new URL(calls[0].url).searchParams.get('where'), 'Denver, CO');
  assert.equal(calls.length, 1, 'one request per role as before');
  await withFetch(() => respond({ results: [] }), () => adz.discover({ ...nurse, filters: { ...onSite, workModes: ['remote', 'hybrid'] } }));
  assert.equal(new URL(calls[0].url).searchParams.has('where'), false, 'remote accepted: the search is not narrowed');
  await withFetch(() => respond({ results: [] }), () => adz.discover({ ...acct, filters: { workModes: ['onsite'], countries: ['UK'] } }));
  assert.match(calls[0].url, /\/jobs\/gb\/search\/1\?/, 'the alias UK is the gb market');
  assert.equal(new URL(calls[0].url).searchParams.get('where'), 'Leeds');

  const js = load('aggregators/jsearch');
  await withFetch(() => respond({ data: [] }), () => js.discover({ ...nurse, filters: onSite }));
  assert.equal(new URL(calls[0].url).searchParams.get('query'), 'Registered Nurse in Denver, CO');
  await withFetch(() => respond({ data: [] }), () => js.discover({ ...nurse, filters: { usOnly: true, countries: ['US'] } }));
  assert.equal(new URL(calls[0].url).searchParams.get('query'), 'Registered Nurse in united states', 'no work mode policy: unchanged');

  const usa = load('aggregators/usajobs').__test.searchParams;
  assert.equal(usa('Registered Nurse', 30, 1, false, ['Denver, CO', 'Colorado']).get('LocationName'), 'Denver, CO;Colorado');
  assert.equal(usa('Registered Nurse', 30, 1, false).has('LocationName'), false);
  assert.equal(usa('Registered Nurse', 30, 1, true, ['Denver, CO']).has('LocationName'), false, 'the remote search is unchanged');
});

test('adzuna: a predicted salary is an estimate, never a published band', async () => {
  const row = (extra) => ({ title: 'Tax Accountant', company: { display_name: 'Ledger and Finch' }, location: { display_name: 'Columbus, Ohio' }, created: iso(1), salary_min: 52000, salary_max: 52000, ...extra });
  const got = await withFetch(() => respond({ results: [
    row({ redirect_url: 'https://example.org/a/11', salary_is_predicted: '1' }),
    row({ redirect_url: 'https://example.org/a/12', salary_is_predicted: 1 }),
    row({ redirect_url: 'https://example.org/a/13', salary_is_predicted: '0' }),
    row({ redirect_url: 'https://example.org/a/14' }),
  ] }), () => load('aggregators/adzuna').discover(ctx(ACCOUNTANT, { usOnly: true, countries: ['US'], maxAgeDays: 30 }, KEYS)));
  assert.deepEqual(got.map((p) => p.compensation), [null, null, '$52000 - $52000', '$52000 - $52000']);
  const { finalizeRemoteAndRecency } = require('../collectors/pipeline');
  const gate = finalizeRemoteAndRecency(got, { salaryFloor: 60000, salaryCurrency: 'USD', maxAgeDays: 30 });
  assert.deepEqual(gate.kept.map((p) => p.canonicalUrl), ['https://example.org/a/11', 'https://example.org/a/12'], 'the estimate is unknown pay and kept; the published band is below the floor');
});
