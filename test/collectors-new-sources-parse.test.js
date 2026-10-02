'use strict';
// Fetch, parse, and request shaping for the fourteen newer source plugins,
// against canned responses (global fetch is stubbed, no network). Fixtures are
// synthetic: a registered nurse search and a tax accountant search.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-new-sources-parse-'));

const src = (rel) => require(path.join(__dirname, '..', 'collectors', 'sources', rel));

const NURSE = [{ query: 'Registered Nurse', location: 'Chicago, IL' }];
const TAX = [{ query: 'Tax Accountant', location: 'Remote' }];
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});
const text = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => JSON.parse(body), text: async () => body,
});

// Run one discover() with fetch routed through `route(url, init)` and with the
// plugins' pacing sleeps made instant. Returns the postings, every request
// made, and the log lines.
async function run(mod, { queries, filters = {}, env = {}, route }) {
  const realFetch = global.fetch;
  const realSetTimeout = global.setTimeout;
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  const calls = [];
  const lines = [];
  const logger = { info: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) };
  Object.assign(process.env, env);
  global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
  global.fetch = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const res = await route(new URL(call.url), init);
    if (!res) throw new Error(`unexpected request ${call.url}`);
    return res;
  };
  try {
    const out = await mod.discover({ queries, filters, auth: {}, logger });
    return { out, calls, lines };
  } finally {
    global.fetch = realFetch;
    global.setTimeout = realSetTimeout;
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const titles = (out) => out.map(p => p.title).sort();

// ---- aggregators ----

test('arbeitnow: pages the feed, filters titles and age, folds the remote flag', async () => {
  const mod = src('aggregators/arbeitnow.js');
  const now = Math.floor(Date.now() / 1000);
  const page1 = {
    data: [
      { title: 'Registered Nurse (ICU)', company_name: 'Klinik Nord', location: 'Berlin', remote: true, url: 'https://example.org/a/1', created_at: now - 86400, description: '<p>Night shifts &amp; triage</p>' },
      { title: 'Registered Nurse', company_name: 'Klinik Nord', location: 'Hamburg, Germany', remote: false, url: 'https://example.org/a/2', created_at: now - 86400 },
      { title: 'Registered Nurse', company_name: 'Old Posting GmbH', location: 'Berlin', remote: true, url: 'https://example.org/a/3', created_at: now - 90 * 86400 },
      { title: 'Warehouse Operative', company_name: 'Lager AG', location: 'Berlin', remote: true, url: 'https://example.org/a/4', created_at: now - 86400 },
    ],
    links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' },
  };
  const page2 = {
    data: [{ title: 'Nurse Educator', company_name: 'Lakeside Clinic', location: 'Remote, United States', remote: true, url: 'https://example.org/a/5', created_at: now - 3600 }],
    links: { next: null },
  };
  const route = (u) => json(u.searchParams.get('page') === '2' ? page2 : page1);

  const open = await run(mod, { queries: NURSE, route });
  assert.equal(open.calls.length, 2, 'follows links.next');
  assert.deepEqual(titles(open.out), ['Nurse Educator', 'Registered Nurse', 'Registered Nurse (ICU)']);
  const icu = open.out.find(p => p.title.includes('ICU'));
  assert.equal(icu.location, 'Berlin (Remote)');
  assert.equal(icu.remote, 'remote');
  assert.match(icu.jdText, /Night shifts & triage/);
  assert.equal(icu.discoveredVia[0].sourceQuery, 'feed');
  const educator = open.out.find(p => p.title === 'Nurse Educator');
  assert.equal(educator.location, 'Remote, United States', 'a location that already says remote is not tagged twice');

  // The early keep applies only the halves the user's policy sets.
  const remote = await run(mod, { queries: NURSE, filters: { remoteOnly: true }, route });
  assert.deepEqual(titles(remote.out), ['Nurse Educator', 'Registered Nurse (ICU)']);
  const remoteUs = await run(mod, { queries: NURSE, filters: { remoteOnly: true, usOnly: true, maxAgeDays: 30 }, route });
  assert.ok(remoteUs.out.some(p => p.title === 'Nurse Educator'));
  assert.ok(remoteUs.out.every(p => p.us !== false));
});

test('findwork: seed roles are the queries; the remote flag follows the policy', async () => {
  const mod = src('aggregators/findwork.js');
  const route = () => json({ results: [
    { role: 'Tax Accountant', company_name: 'Ledgerline Partners', location: 'Denver, CO', remote: true, url: 'https://example.org/f/1', date_posted: daysAgo(1), text: '<p>Prepare returns</p>' },
    { role: 'Senior Tax Accountant', company_name: 'Harbor Tax Group', location: 'Austin, TX', remote: false, url: 'https://example.org/f/2', date_posted: daysAgo(2), text: '' },
  ] });
  const env = { FINDWORK_API_KEY: 'test-key' };

  const open = await run(mod, { queries: TAX, env, route });
  assert.equal(open.calls.length, 1);
  const u = new URL(open.calls[0].url);
  assert.equal(u.searchParams.get('search'), 'Tax Accountant');
  assert.equal(u.searchParams.has('remote'), false);
  assert.equal(open.calls[0].init.headers.Authorization, 'Token test-key');
  assert.deepEqual(open.out.map(p => p.location).sort(), ['Austin, TX', 'Remote, Denver, CO']);

  const remote = await run(mod, { queries: TAX, filters: { remoteOnly: true }, env, route });
  assert.equal(new URL(remote.calls[0].url).searchParams.get('remote'), 'true');

  const denied = await run(mod, { queries: [...TAX, ...NURSE], env, route: () => json({}, 401) });
  assert.deepEqual(denied.out, []);
  assert.equal(denied.calls.length, 1, 'stops after an auth failure');
});

test('hiring-cafe: opt in, search state from the policy, no coordinates', async () => {
  const mod = src('aggregators/hiring-cafe.js');
  const hits = [
    { apply_url: 'https://example.org/h/1', job_information: { title: 'Registered Nurse, Telehealth' }, v5_processed_job_data: { company_name: 'Mercy West Health', workplace_type: 'Remote', workplace_countries: ['US'], estimated_publish_date: daysAgo(1), yearly_min_compensation: 78000.4, yearly_max_compensation: 96000, listed_compensation_currency: 'usd', requirements_summary: 'Active RN license' } },
    { apply_url: 'https://example.org/h/4', job_information: { title: 'Staff Nurse' }, v5_processed_job_data: { company_name: 'Northgate Infirmary', workplace_type: 'Onsite', formatted_workplace_location: 'Leeds, United Kingdom', yearly_min_compensation: 60000, yearly_max_compensation: 80000, listed_compensation_currency: 'GBP' } },
    { apply_url: 'https://example.org/h/2', job_information: { title: 'Clinical Product Analytics Manager' }, v5_processed_job_data: { company_name: 'Unrelated Co', workplace_type: 'Onsite', formatted_workplace_location: 'Boston, MA' } },
    { apply_url: 'https://example.org/h/3', board_token: 'lakesideclinic', v5_processed_job_data: { core_job_title: 'Nurse Case Manager', workplace_type: 'Onsite', formatted_workplace_location: 'Chicago, IL', hourly_min_compensation: 41, hourly_max_compensation: 52 } },
  ];
  const route = (u) => (u.pathname === '/'
    ? text('<html><script id="__NEXT_DATA__">{"buildId":"build42","page":"/"}</script></html>')
    : json({ pageProps: { ssrHits: hits, ssrIsLastPage: true } }));
  const env = { HIRING_CAFE_OPT_IN: '1' };

  const open = await run(mod, { queries: NURSE, env, route });
  assert.equal(open.calls.length, 2);
  const data = new URL(open.calls[1].url);
  assert.equal(data.pathname, '/_next/data/build42/index.json');
  const state = JSON.parse(data.searchParams.get('searchState'));
  assert.deepEqual(state, { searchQuery: 'Registered Nurse', dateFetchedPastNDays: 30, sortBy: 'default' });
  assert.equal(open.calls[1].init.headers['User-Agent'], 'jobe-discovery/1.0 (personal job search)');
  assert.deepEqual(titles(open.out), ['Nurse Case Manager', 'Registered Nurse, Telehealth', 'Staff Nurse']);
  const tele = open.out.find(p => p.title.includes('Telehealth'));
  assert.equal(tele.location, 'Remote, United States');
  // The stated Hybrid type is kept, and country codes are written as names so
  // a code is never read as a US state.
  const { createPosting } = require('../lib/posting');
  const { countryOk } = require('../lib/profile');
  const at = (v) => createPosting({ title: 'Registered Nurse', company: 'Mercy West Health', url: 'https://example.org/h/9', location: mod.__test.loc(v) }, 'hiring-cafe');
  assert.equal(at({ workplace_type: 'Hybrid', workplace_countries: ['US'], formatted_workplace_location: 'Denver, Colorado, United States' }).remote, 'hybrid');
  assert.equal(mod.__test.loc({ workplace_type: 'Hybrid' }), 'Hybrid');
  assert.equal(mod.__test.loc({ workplace_type: 'Remote', workplace_countries: ['DE'] }), 'Remote - Germany');
  assert.equal(at({ workplace_type: 'Remote', workplace_countries: ['DE'] }).us, false);
  for (const code of ['CA', 'IN']) assert.equal(at({ workplace_type: 'Remote', workplace_countries: [code] }).us, false, code);
  assert.equal(mod.__test.loc({ workplace_type: 'Remote', workplace_countries: ['US', 'CA'] }), 'Remote - United States/Canada');
  const both = at({ workplace_type: 'Remote', workplace_countries: ['US', 'CA'] });
  assert.equal(both.us, true);
  assert.equal(countryOk(both.location, ['CA']), true);
  assert.equal(mod.__test.loc({ workplace_type: 'Onsite', workplace_countries: ['DE'] }), 'Germany');
  assert.deepEqual(tele.compensation, { min: 78000, max: 96000, currency: 'USD' });
  // A band in another currency keeps its own label, so a floor in the user's
  // currency reads it as unknown pay and keeps the posting.
  const leeds = open.out.find(p => p.title === 'Staff Nurse');
  assert.deepEqual(leeds.compensation, { min: 60000, max: 80000, currency: 'GBP' });
  const { finalizeRemoteAndRecency } = require('../collectors/pipeline');
  const gate = finalizeRemoteAndRecency([leeds, tele], { salaryFloor: 100000, salaryCurrency: 'USD', maxAgeDays: 30 });
  assert.deepEqual(gate.kept, [leeds]);
  assert.equal(leeds.salaryCheck, 'unknown');
  assert.equal(gate.rejected.salary, 1, 'the dollar band below the floor is the one dropped');
  const cm = open.out.find(p => p.title === 'Nurse Case Manager');
  assert.equal(cm.company, 'lakesideclinic');
  assert.equal(cm.compensation, '41 - 52/hr', 'no currency stated, none printed');

  const scoped = await run(mod, { queries: NURSE, filters: { remoteOnly: true, usOnly: true, maxAgeDays: 10 }, env, route });
  const s2 = JSON.parse(new URL(scoped.calls[1].url).searchParams.get('searchState'));
  assert.deepEqual(s2.workplaceTypes, ['Remote']);
  assert.equal(s2.dateFetchedPastNDays, 10);
  const off = await run(mod, { queries: NURSE, filters: { maxAgeDays: 0 }, env, route });
  assert.equal('dateFetchedPastNDays' in JSON.parse(new URL(off.calls[1].url).searchParams.get('searchState')), false, 'a window of 0 sends no recency cut');
  assert.equal(s2.locations.length, 1);
  assert.equal(s2.locations[0].address_components[0].short_name, 'US');
  assert.equal('geometry' in s2.locations[0], false);
  assert.doesNotMatch(JSON.stringify(s2), /\d+\.\d{3,}/, 'no coordinates in the request');

  assert.equal(mod.__test.optedIn({}), false);
  assert.equal(mod.__test.optedIn({ HIRING_CAFE_OPT_IN: '0' }), false);
  assert.equal(mod.__test.optedIn({ HIRING_CAFE_OPT_IN: 'yes' }), true);
});

test('jobicy: geo is sent only for a US policy; titles and age are filtered locally', async () => {
  const mod = src('aggregators/jobicy.js');
  const route = () => json({ jobs: [
    { url: 'https://example.org/j/1', jobTitle: 'Tax Accountant', companyName: 'Ledgerline Partners', jobGeo: 'Canada', jobType: ['part-time'], pubDate: daysAgo(2), salaryMin: 60000, salaryMax: 75000, salaryCurrency: 'CAD', jobDescription: '<p>Corporate &amp; personal returns</p>' },
    { url: 'https://example.org/j/2', jobTitle: 'Senior Tax Accountant', companyName: 'Harbor Tax Group', jobGeo: 'Anywhere', pubDate: daysAgo(3), salaryMin: 90000 },
    { url: 'https://example.org/j/3', jobTitle: 'Tax Accountant', companyName: 'Stale Books LLC', jobGeo: 'USA', pubDate: daysAgo(200) },
    { url: 'https://example.org/j/4', jobTitle: 'Customer Support Agent', companyName: 'Helpdesk Inc', jobGeo: 'USA', pubDate: daysAgo(1) },
    { url: 'https://example.org/j/5', jobTitle: 'Tax Accountant, Contract', companyName: 'Monthly Books Co', jobGeo: 'USA', pubDate: daysAgo(1), salaryMin: 11000, salaryMax: 14000, salaryCurrency: 'USD', salaryPeriod: 'monthly' },
    { url: 'https://example.org/j/6', jobTitle: 'Tax Accountant, Audit', companyName: 'Yearly Books Co', jobGeo: 'USA', pubDate: daysAgo(1), salaryMin: 70000, salaryMax: 90000, salaryCurrency: 'USD', salaryPeriod: 'yearly' },
  ] });

  const open = await run(mod, { queries: TAX, route });
  const u = new URL(open.calls[0].url);
  assert.equal(u.searchParams.get('tag'), 'Tax Accountant');
  assert.equal(u.searchParams.has('geo'), false);
  assert.deepEqual(titles(open.out), ['Senior Tax Accountant', 'Tax Accountant', 'Tax Accountant, Audit', 'Tax Accountant, Contract']);
  const byTitle = Object.fromEntries(open.out.map(p => [p.title, p]));
  // The pay period the feed states rides along: a monthly band is not read
  // as a yearly one, so the pay floor keeps the posting as unknown.
  const { publishedMax, finalizeRemoteAndRecency } = require('../collectors/pipeline');
  const monthly = byTitle['Tax Accountant, Contract'];
  assert.equal(monthly.compensation, 'USD 11000 - 14000/monthly');
  assert.equal(publishedMax(monthly, 'USD'), null);
  assert.equal(byTitle['Tax Accountant, Audit'].compensation, 'USD 70000 - 90000', 'a yearly band prints as before');
  assert.equal(publishedMax(byTitle['Tax Accountant, Audit'], 'USD'), 90000);
  const floored = finalizeRemoteAndRecency([monthly, byTitle['Tax Accountant, Audit']], { salaryFloor: 100000, salaryCurrency: 'USD' });
  assert.deepEqual(titles(floored.kept), ['Tax Accountant, Contract']);
  assert.equal(floored.kept[0].salaryCheck, 'unknown');
  assert.equal(byTitle['Tax Accountant'].location, 'Remote, Canada');
  assert.equal(byTitle['Tax Accountant'].compensation, 'CAD 60000 - 75000');
  assert.equal(byTitle['Senior Tax Accountant'].location, 'Remote', 'an unnamed region stays unknown without a country policy');
  assert.equal(byTitle['Senior Tax Accountant'].compensation, 'USD 90000+');
  assert.match(byTitle['Tax Accountant'].jdText, /Corporate & personal returns/);

  const us = await run(mod, { queries: TAX, filters: { usOnly: true }, route });
  assert.equal(new URL(us.calls[0].url).searchParams.get('geo'), 'usa');
  assert.equal(us.out.find(p => p.title === 'Senior Tax Accountant').location, 'Remote, USA');
});

test('jooble: posts the seed role with the seed location, or Remote under a remote policy', async () => {
  const mod = src('aggregators/jooble.js');
  const route = () => json({ jobs: [
    { title: 'Registered Nurse', company: 'Mercy West Health', location: 'Chicago, IL', link: 'https://example.org/o/1', updated: daysAgo(1), snippet: 'Full time <b>RN</b> role', salary: '$40 per hour' },
  ] });
  const env = { JOOBLE_API_KEY: 'test-key' };

  const open = await run(mod, { queries: NURSE, env, route });
  assert.equal(open.calls[0].url, 'https://jooble.org/api/test-key');
  assert.equal(open.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(open.calls[0].init.body), { keywords: 'Registered Nurse', location: 'Chicago, IL', page: '1' });
  assert.equal(open.out.length, 1);
  assert.equal(open.out[0].compensation, '$40 per hour');
  assert.equal(open.out[0].jdText, 'Full time RN role');

  const remote = await run(mod, { queries: NURSE, filters: { remoteOnly: true }, env, route });
  assert.equal(JSON.parse(remote.calls[0].init.body).location, 'Remote');

  const bare = await run(mod, { queries: ['Registered Nurse'], env, route });
  assert.equal(JSON.parse(bare.calls[0].init.body).location, '', 'no location is invented for a seed without one');
});

test('themuse: no category by default, optional categories from the environment', async () => {
  const mod = src('aggregators/themuse.js');
  const page0 = { results: [
    { name: 'Registered Nurse', company: { name: 'Mercy West Health' }, locations: [{ name: 'Flexible / Remote' }, { name: 'Chicago, IL' }], refs: { landing_page: 'https://example.org/m/1' }, publication_date: daysAgo(2), contents: '<p>Bedside care</p>' },
    { name: 'Nurse Practitioner', company: { name: 'Lakeside Clinic' }, locations: [], refs: { landing_page: 'https://example.org/m/2' }, publication_date: daysAgo(4), contents: '' },
    { name: 'Account Executive', company: { name: 'Salesly' }, locations: [{ name: 'Austin, TX' }], refs: { landing_page: 'https://example.org/m/3' }, publication_date: daysAgo(1), contents: '' },
    { name: 'Registered Nurse', company: { name: 'Stale Health' }, locations: [], refs: { landing_page: 'https://example.org/m/4' }, publication_date: daysAgo(300), contents: '' },
  ] };
  const route = (u) => json(u.searchParams.get('page') === '0' ? page0 : { results: [] });

  const open = await run(mod, { queries: NURSE, env: { THEMUSE_CATEGORIES: '' }, route });
  const first = new URL(open.calls[0].url);
  assert.equal(first.searchParams.has('category'), false);
  assert.equal(first.searchParams.has('location'), false);
  assert.equal(open.calls.length, 2, 'stops at the first empty page');
  assert.deepEqual(titles(open.out), ['Nurse Practitioner', 'Registered Nurse']);
  const byTitle = Object.fromEntries(open.out.map(p => [p.title, p]));
  assert.equal(byTitle['Registered Nurse'].location, 'Remote, Chicago, IL');
  assert.equal(byTitle['Nurse Practitioner'].location, '', 'no location means unknown when the search was not remote scoped');

  const scoped = await run(mod, {
    queries: NURSE, filters: { remoteOnly: true },
    env: { THEMUSE_CATEGORIES: 'Healthcare, Accounting and Finance ,' }, route,
  });
  const cats = scoped.calls.map(c => new URL(c.url).searchParams.get('category'));
  assert.deepEqual([...new Set(cats)], ['Healthcare', 'Accounting and Finance']);
  assert.equal(new URL(scoped.calls[0].url).searchParams.get('location'), 'Flexible / Remote');
  assert.equal(scoped.out.find(p => p.title === 'Nurse Practitioner').location, 'Remote');

  assert.deepEqual(mod.__test.categories({}), []);
});

test('usajobs: registered email as User-Agent, remote indicator only under a remote policy', async () => {
  const mod = src('aggregators/usajobs.js');
  const item = (d) => ({ MatchedObjectDescriptor: d });
  const route = () => json({ SearchResult: { SearchResultItems: [
    item({ PositionTitle: 'Nurse (Clinical/Critical Care)', OrganizationName: 'Veterans Health Administration', PositionLocationDisplay: 'Albany, New York', PositionLocation: [{ CountryCode: 'United States' }], ApplyURI: ['https://example.gov/job/1'], PublicationStartDate: daysAgo(3), PositionRemuneration: [{ MinimumRange: '72000', MaximumRange: '98000', RateIntervalCode: 'PA' }], UserArea: { Details: { JobSummary: 'Provides direct patient care.' } } }),
    item({ PositionTitle: 'Nurse', OrganizationName: 'Defense Health Agency', PositionLocationDisplay: 'Multiple Locations', PositionURI: 'https://example.gov/job/2', PublicationStartDate: daysAgo(5), PositionRemuneration: [{ MinimumRange: '38', RateIntervalCode: 'PH' }] }),
  ] } });
  const env = { USAJOBS_API_KEY: 'test-key', USAJOBS_EMAIL: 'applicant@example.org' };

  const open = await run(mod, { queries: NURSE, filters: { maxAgeDays: 90 }, env, route });
  const u = new URL(open.calls[0].url);
  assert.equal(u.searchParams.get('Keyword'), 'Registered Nurse');
  assert.equal(u.searchParams.has('RemoteIndicator'), false);
  assert.equal(u.searchParams.get('DatePosted'), '60', 'clamped to the API maximum');
  assert.equal(open.calls[0].init.headers['User-Agent'], 'applicant@example.org');
  assert.equal(open.calls[0].init.headers['Authorization-Key'], 'test-key');
  const byUrl = Object.fromEntries(open.out.map(p => [p.canonicalUrl, p]));
  const albany = byUrl['https://example.gov/job/1'];
  assert.equal(albany.location, 'Albany, New York, United States');
  assert.equal(albany.us, true);
  assert.equal(albany.compensation, '$72000 - $98000/yr');
  assert.equal(albany.jdText, 'Provides direct patient care.');
  assert.equal(byUrl['https://example.gov/job/2'].location, 'Multiple Locations');
  assert.equal(byUrl['https://example.gov/job/2'].compensation, '$38+/hr');

  const remote = await run(mod, { queries: NURSE, filters: { remoteOnly: true, maxAgeDays: 10 }, env, route });
  const r = new URL(remote.calls[0].url);
  assert.equal(r.searchParams.get('RemoteIndicator'), 'True');
  assert.equal(r.searchParams.get('DatePosted'), '10');
  const off = await run(mod, { queries: NURSE, filters: { maxAgeDays: 0 }, env, route });
  assert.equal(new URL(off.calls[0].url).searchParams.has('DatePosted'), false, 'a window of 0 sends no recency cut');

  // Pay periods: only a yearly band is compared with the floor.
  const { publishedMax } = require('../collectors/pipeline');
  const band = (code) => mod.__test.comp({ PositionRemuneration: [{ MinimumRange: '10500', MaximumRange: '13650', RateIntervalCode: code }] });
  assert.equal(band('PM'), '$10500 - $13650/mo');
  for (const code of ['PM', 'PW', 'PB', 'PD', 'PH', 'ZZ']) {
    assert.equal(publishedMax({ us: true, compensation: band(code) }), null, `${code} is not a yearly figure`);
  }
  assert.equal(publishedMax({ us: true, compensation: band('PA') }), 13000);
  assert.equal(publishedMax({ us: true, compensation: albany.compensation }), 98000);
  assert.ok(remote.out.every(p => p.location === 'Remote, United States' && p.remote === 'remote'));
});

test('working-nomads: one feed request, local title and age filter, remote label', async () => {
  const mod = src('aggregators/working-nomads.js');
  const route = () => json([
    { url: 'https://example.org/w/1', title: 'Tax Accountant', company_name: 'Ledgerline Partners', location: 'USA, Canada', pub_date: daysAgo(1), description: '<ul><li>Sales tax filings</li></ul>' },
    { url: 'https://example.org/w/2', title: 'Senior Accountant, Tax', company_name: 'Harbor Tax Group', location: '', pub_date: daysAgo(2), description: '' },
    { url: 'https://example.org/w/3', title: 'Tax Accountant', company_name: 'Stale Books LLC', location: 'Anywhere', pub_date: daysAgo(400), description: '' },
    { url: 'https://example.org/w/4', title: 'Graphic Designer', company_name: 'Pixels', location: 'Anywhere', pub_date: daysAgo(1), description: '' },
  ]);
  const { out, calls } = await run(mod, { queries: TAX, route });
  assert.equal(calls.length, 1);
  assert.deepEqual(out.map(p => p.location).sort(), ['Remote', 'Remote, USA, Canada']);
  assert.ok(out.every(p => p.remote === 'remote'));
  assert.match(out.find(p => p.title === 'Tax Accountant').jdText, /Sales tax filings/);
});

// ---- per company ATS crawlers ----

test('bamboohr: detail fetch for matched titles only, remote flag preserved, demo and redirects skipped', async () => {
  const mod = src('ats-direct/bamboohr.js');
  const lists = {
    mercywest: { result: [
      { id: 11, jobOpeningName: 'Registered Nurse, Float Pool', departmentLabel: 'Nursing', location: { city: 'Chicago', state: 'Illinois' }, isRemote: true },
      { id: 12, jobOpeningName: 'Facilities Technician', location: { city: 'Chicago', state: 'Illinois' } },
    ] },
    demo: { result: [{ id: 1, jobOpeningName: 'IT Security Engineer', location: { city: 'Mayfair' } }] },
  };
  const detail = { result: { jobOpening: {
    jobOpeningShareUrl: 'https://mercywest.bamboohr.com/careers/11?source=share',
    datePosted: daysAgo(4).slice(0, 10),
    description: '<p>Float across units</p>',
    compensation: '$38 - $46 per hour',
    location: { city: 'Chicago', state: 'Illinois', addressCountry: 'United States' },
  } } };
  const route = (u) => {
    const sub = u.hostname.split('.')[0];
    if (sub === 'gone') return json({}, 302);
    if (u.pathname === '/careers/list') return json(lists[sub] || { result: [] });
    if (u.pathname === '/careers/11/detail') return json(detail);
    return null;
  };
  const filters = { atsSlugs: { bamboohr: [{ slug: 'mercywest', name: 'Mercy West Health' }, 'demo', 'gone'] } };
  const { out, calls, lines } = await run(mod, { queries: NURSE, filters, route });

  assert.equal(calls.filter(c => c.url.includes('/detail')).length, 1, 'no detail request for an unmatched title');
  assert.ok(calls.every(c => c.init.redirect === 'manual'));
  assert.match(lines.join('\n'), /demo: shared demo tenant/);
  assert.equal(out.length, 1);
  const p = out[0];
  assert.equal(p.company, 'Mercy West Health');
  assert.equal(p.companySlug, 'mercywest');
  assert.equal(p.location, 'Remote, Chicago, Illinois, United States');
  assert.equal(p.remote, 'remote', 'the list entry remote flag survives a detail record that omits it');
  assert.equal(p.compensation, '$38 - $46 per hour');
  assert.equal(p.department, 'Nursing');
  assert.equal(p.jdText, 'Float across units');
  assert.ok(p.postedDate);
  assert.match(p.canonicalUrl, /^https:\/\/mercywest\.bamboohr\.com\/careers\/11/);
});

test('breezy: structured remote flag wins over the city; salary string kept', async () => {
  const mod = src('ats-direct/breezy.js');
  const route = () => json([
    { name: 'Tax Accountant', url: 'https://ledgerline.breezy.hr/p/aaa-tax-accountant', published_date: daysAgo(2), department: 'Tax', salary: ' $70k - $85k ', location: { name: 'Denver, CO', is_remote: true }, company: { name: 'Ledgerline Partners', friendly_id: 'ledgerline-partners' } },
    { name: 'Tax Accountant II', url: 'https://ledgerline.breezy.hr/p/bbb-tax-accountant-ii', published_date: daysAgo(3), location: { city: 'Denver', state: { name: 'Colorado' }, country: { name: 'United States' } } },
    { name: 'Office Manager', url: 'https://ledgerline.breezy.hr/p/ccc-office-manager', published_date: daysAgo(1) },
  ]);
  const { out, calls } = await run(mod, { queries: TAX, filters: { atsSlugs: { breezy: ['ledgerline'] } }, route });
  assert.equal(calls[0].url, 'https://ledgerline.breezy.hr/json');
  assert.equal(out.length, 2);
  const byTitle = Object.fromEntries(out.map(p => [p.title, p]));
  assert.equal(byTitle['Tax Accountant'].location, 'Remote, Denver, CO');
  assert.equal(byTitle['Tax Accountant'].remote, 'remote');
  assert.equal(byTitle['Tax Accountant'].company, 'Ledgerline Partners');
  assert.equal(byTitle['Tax Accountant'].companySlug, 'ledgerline-partners');
  assert.equal(byTitle['Tax Accountant'].compensation, '$70k - $85k');
  assert.equal(byTitle['Tax Accountant'].jdText, null);
  assert.equal(byTitle['Tax Accountant II'].location, 'Denver, Colorado, United States');
  assert.equal(byTitle['Tax Accountant II'].company, 'Ledgerline', 'falls back to the prettified slug');
});

test('personio: XML positions, primary office, CDATA description, pinned company name', async () => {
  const mod = src('ats-direct/personio.js');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>1001</id>
    <subcompany>Ledgerline Advisory</subcompany>
    <additionalOffices><office>Berlin</office></additionalOffices>
    <office>Munich</office>
    <department>Finance &amp; Tax</department>
    <name>Tax Accountant (m/w/d)</name>
    <jobDescriptions>
      <jobDescription><name>Tasks</name><value><![CDATA[<ul><li>Annual returns</li></ul>]]></value></jobDescription>
      <jobDescription><name>Profile</name><value><![CDATA[<p>Three years of practice</p>]]></value></jobDescription>
    </jobDescriptions>
    <createdAt>${daysAgo(6)}</createdAt>
  </position>
  <position><id>1002</id><office>Munich</office><name>Receptionist</name><createdAt>${daysAgo(2)}</createdAt></position>
  <position><office>Munich</office><name>Tax Accountant without an id</name></position>
</workzag-jobs>`;
  const route = (u) => (u.hostname.startsWith('closed.') ? text('', 307) : text(xml));
  const filters = { atsSlugs: { personio: [{ slug: 'ledgerline-gmbh', name: 'Ledgerline' }, 'closed'] } };
  const { out, calls } = await run(mod, { queries: TAX, filters, route });
  assert.equal(calls[0].url, 'https://ledgerline-gmbh.jobs.personio.com/xml');
  assert.equal(out.length, 1);
  const p = out[0];
  assert.equal(p.title, 'Tax Accountant (m/w/d)');
  assert.equal(p.company, 'Ledgerline');
  assert.equal(p.companySlug, 'ledgerline-gmbh');
  assert.equal(p.location, 'Munich', 'the first office outside additionalOffices');
  assert.equal(p.department, 'Finance & Tax');
  assert.equal(p.canonicalUrl, 'https://ledgerline-gmbh.jobs.personio.com/job/1001');
  assert.match(p.jdText, /Annual returns/);
  assert.match(p.jdText, /Three years of practice/);
  assert.ok(p.postedDate);

  // With no pinned name the legal form is dropped from the display name.
  const bare = await run(mod, { queries: TAX, filters: { atsSlugs: { personio: ['ledgerline-gmbh'] } }, route });
  assert.equal(bare.out[0].company, 'Ledgerline');
});

test('recruitee: published offers only, remote and hybrid flags folded, salary object', async () => {
  const mod = src('ats-direct/recruitee.js');
  const route = () => json({ offers: [
    { title: 'Registered Nurse', status: 'published', company_name: 'Lakeside Clinic', city: 'Utrecht', country: 'Netherlands', remote: true, careers_url: 'https://lakeside.recruitee.com/o/registered-nurse', published_at: daysAgo(2), description: '<p>Ward care</p>', salary: { min: 3200, max: 4100, currency: 'EUR', period: 'month' }, department: 'Nursing' },
    { title: 'Nurse Coordinator', status: 'published', city: 'Utrecht', country: 'Netherlands', hybrid: true, slug: 'nurse-coordinator', created_at: daysAgo(5), description: '' },
    { title: 'Registered Nurse (draft)', status: 'draft', careers_url: 'https://lakeside.recruitee.com/o/draft' },
    { title: 'Payroll Clerk', status: 'published', careers_url: 'https://lakeside.recruitee.com/o/payroll-clerk' },
  ] });
  const { out, calls } = await run(mod, { queries: NURSE, filters: { atsSlugs: { recruitee: ['lakeside'] } }, route });
  assert.equal(calls[0].url, 'https://lakeside.recruitee.com/api/offers/');
  assert.deepEqual(titles(out), ['Nurse Coordinator', 'Registered Nurse']);
  const byTitle = Object.fromEntries(out.map(p => [p.title, p]));
  assert.equal(byTitle['Registered Nurse'].location, 'Remote, Utrecht, Netherlands');
  assert.equal(byTitle['Registered Nurse'].remote, 'remote');
  assert.deepEqual(byTitle['Registered Nurse'].compensation, { min: 3200, max: 4100, currency: 'EUR', period: 'month' });
  // 4100 a month is not below a yearly floor of 50000: unknown, kept.
  const { finalizeRemoteAndRecency } = require('../collectors/pipeline');
  const floored = finalizeRemoteAndRecency([byTitle['Registered Nurse']], { salaryFloor: 50000, salaryCurrency: 'EUR' });
  assert.equal(floored.rejected.salary, 0);
  assert.equal(floored.kept[0].salaryCheck, 'unknown');
  const yearly = await run(mod, { queries: NURSE, filters: { atsSlugs: { recruitee: ['lakeside'] } }, route: () => json({ offers: [
    { title: 'Registered Nurse', status: 'published', city: 'Utrecht', country: 'Netherlands', careers_url: 'https://lakeside.recruitee.com/o/rn-year', published_at: daysAgo(2), salary: { min: 38000, max: 46000, currency: 'EUR', period: 'year' } },
  ] }) });
  assert.equal(finalizeRemoteAndRecency(yearly.out, { salaryFloor: 50000, salaryCurrency: 'EUR' }).rejected.salary, 1, 'a yearly band below the floor still drops');
  assert.equal(byTitle['Registered Nurse'].company, 'Lakeside Clinic');
  assert.equal(byTitle['Nurse Coordinator'].location, 'Utrecht, Netherlands (Hybrid)');
  assert.equal(byTitle['Nurse Coordinator'].remote, 'hybrid');
  assert.equal(byTitle['Nurse Coordinator'].company, 'Lakeside');
  assert.equal(byTitle['Nurse Coordinator'].canonicalUrl, 'https://lakeside.recruitee.com/o/nurse-coordinator');
});

test('workable: account name as company, telecommuting flag folded, URL fallbacks', async () => {
  const mod = src('ats-direct/workable.js');
  const route = (u) => (u.pathname.endsWith('/missing') ? json({}, 404) : json({ name: 'Harbor Tax Group', jobs: [
    { title: 'Senior Tax Accountant', url: 'https://apply.workable.com/j/AAA111', telecommuting: true, locations: [{ city: 'Austin', region: 'Texas', country: 'United States' }], published_on: daysAgo(3).slice(0, 10), description: '<p>Partnership returns</p>', department: 'Tax' },
    { title: 'Tax Accountant', shortcode: 'BBB222', city: 'Austin', state: 'Texas', country: 'United States', created_at: daysAgo(8).slice(0, 10), department: { name: 'Tax' } },
    { title: 'Front Desk Associate', url: 'https://apply.workable.com/j/CCC333' },
  ] }));
  const filters = { atsSlugs: { workable: ['harbor-tax-1', 'missing'] } };
  const { out, calls } = await run(mod, { queries: TAX, filters, route });
  assert.equal(calls[0].url, 'https://www.workable.com/api/accounts/harbor-tax-1?details=true');
  assert.equal(calls.length, 2);
  assert.deepEqual(titles(out), ['Senior Tax Accountant', 'Tax Accountant']);
  const byTitle = Object.fromEntries(out.map(p => [p.title, p]));
  assert.equal(byTitle['Senior Tax Accountant'].company, 'Harbor Tax Group');
  assert.equal(byTitle['Senior Tax Accountant'].companySlug, 'harbor-tax-group');
  assert.equal(byTitle['Senior Tax Accountant'].location, 'Remote, Austin, Texas, United States');
  assert.equal(byTitle['Senior Tax Accountant'].remote, 'remote');
  assert.equal(byTitle['Senior Tax Accountant'].jdText, 'Partnership returns');
  assert.equal(byTitle['Tax Accountant'].location, 'Austin, Texas, United States');
  assert.equal(byTitle['Tax Accountant'].canonicalUrl, 'https://apply.workable.com/j/BBB222');
  assert.equal(byTitle['Tax Accountant'].department, 'Tax');
});
