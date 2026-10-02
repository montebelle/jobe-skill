'use strict';
// lib/enrich.js: recency keys on the ORIGINAL publish date of an ATS record
// (never the refresh date, never a merged aggregator date). Fixture JSON only;
// global fetch is stubbed, so no network call is made. The JD cache lands in
// a temp workspace through JOBE_USER_ROOT.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-discovery-enrich-'));
const { enrich, fetchJd, isKnownAts, cachePath } = require('../lib/enrich');

const day = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * day).toISOString();
const FIRST_PUBLISHED = iso(120);
const REFRESHED = iso(3);
const AGGREGATOR_DATE = iso(1);
const LONG_JD = 'Assess patients, plan care, and document outcomes on a medical surgical unit. '.repeat(20);

const GREENHOUSE = {
  content: `&lt;p&gt;${LONG_JD}&lt;/p&gt;`,
  first_published: FIRST_PUBLISHED,
  updated_at: REFRESHED,
  location: { name: 'Austin, TX' },
  departments: [{ name: 'Nursing' }],
};
const ASHBY_ID = '1a2b3c4d-0000-4000-8000-000000000001';
const ASHBY = {
  jobs: [
    { id: 'unrelated', jobUrl: 'https://jobs.ashbyhq.com/harbortax/ffffffff-0000-4000-8000-00000000000f', descriptionPlain: 'other' },
    {
      id: 'internal-id-that-differs-from-the-url',
      jobUrl: `https://jobs.ashbyhq.com/harbortax/${ASHBY_ID}`,
      descriptionHtml: `<p>Prepare corporate and partnership returns. ${LONG_JD}</p>`,
      descriptionPlain: 'plain fallback',
      publishedAt: FIRST_PUBLISHED,
      location: 'Remote',
      department: 'Tax',
    },
  ],
};

let calls = [];
let greenhouseBody = GREENHOUSE;
global.fetch = async (url) => {
  calls.push(String(url));
  const body = /boards-api\.greenhouse\.io/.test(url) ? greenhouseBody
    : /api\.ashbyhq\.com/.test(url) ? ASHBY
      : null;
  return { ok: !!body, status: body ? 200 : 404, json: async () => body, text: async () => '' };
};

test('isKnownAts recognizes the hosts with an authoritative publish date', () => {
  assert.equal(isKnownAts('https://boards.greenhouse.io/mercywest/jobs/123'), true);
  assert.equal(isKnownAts('https://jobs.lever.co/mercywest/abc'), true);
  assert.equal(isKnownAts('https://jobs.ashbyhq.com/harbortax/x'), true);
  assert.equal(isKnownAts('https://mercy.wd5.myworkdayjobs.com/site/job/x'), true);
  assert.equal(isKnownAts('https://jobs.smartrecruiters.com/Harbor/1'), true);
  assert.equal(isKnownAts('https://example.org/careers/1'), false);
  assert.equal(isKnownAts(undefined), false);
});

test('Greenhouse: first_published wins over updated_at; updated_at is the fallback', async () => {
  const url = 'https://boards.greenhouse.io/mercywest/jobs/123';
  const data = await fetchJd(url);
  assert.equal(data.postedDate, FIRST_PUBLISHED);
  assert.match(data.jdText, /^Assess patients, plan care/, 'entity encoded markup is stripped');
  assert.equal(data.location, 'Austin, TX');
  greenhouseBody = { ...GREENHOUSE, first_published: undefined };
  assert.equal((await fetchJd(url)).postedDate, REFRESHED);
  greenhouseBody = GREENHOUSE;
});

test('Ashby: job found through its URL, HTML description preferred, publishedAt is the date', async () => {
  const data = await fetchJd(`https://jobs.ashbyhq.com/harbortax/${ASHBY_ID}`);
  assert.equal(data.postedDate, FIRST_PUBLISHED);
  assert.match(data.jdHtml, /^<p>Prepare corporate/);
  assert.match(data.jdText, /^Prepare corporate and partnership returns/, 'tags are stripped, not spelled out');
  assert.equal(data.department, 'Tax');
});

test('enrich: the ATS date replaces an aggregator date, even when a JD is already attached', async () => {
  calls = [];
  const posting = {
    title: 'Registered Nurse',
    canonicalUrl: 'https://boards.greenhouse.io/mercywest/jobs/123',
    alternateUrls: [],
    location: 'Austin, TX',
    jdText: LONG_JD,              // substantial: a non ATS row would short circuit
    postedDate: AGGREGATOR_DATE,  // stamped by a merged aggregator row
  };
  await enrich(posting);
  assert.equal(calls.length, 1, 'an ATS row is always re-derived');
  assert.equal(posting.postedDate, FIRST_PUBLISHED);
  assert.equal(posting.alive, true);
  assert.ok(fs.existsSync(cachePath(posting.canonicalUrl)));

  // Second posting for the same URL is served from the cache; the ATS date still wins.
  const again = { ...posting, jdText: null, postedDate: AGGREGATOR_DATE };
  await enrich(again);
  assert.equal(calls.length, 1, 'cache hit, no second fetch');
  assert.equal(again.postedDate, FIRST_PUBLISHED);
});

test('enrich: a non ATS row with a substantial JD short circuits and keeps its own date', async () => {
  calls = [];
  const posting = {
    title: 'Tax Accountant',
    canonicalUrl: 'https://example.org/careers/tax-accountant',
    alternateUrls: [],
    jdText: LONG_JD,
    postedDate: AGGREGATOR_DATE,
  };
  await enrich(posting);
  assert.equal(calls.length, 0);
  assert.equal(posting.postedDate, AGGREGATOR_DATE);
});

test('pay text: the currency is the one the text states, a bare dollar sign states none, a non yearly period is marked', () => {
  const { extractCompFromText } = require('../lib/enrich');
  const { stripHtml } = require('../lib/posting');
  const cases = [
    ['£55,000 - £65,000 per annum', { min: 55000, max: 65000, currency: 'GBP' }],
    ['£45k - £55k', { min: 45000, max: 55000, currency: 'GBP' }],
    ['€50.000 - €60.000', { min: 50000, max: 60000, currency: 'EUR' }],
    ['C$80,000 to C$95,000', { min: 80000, max: 95000, currency: 'CAD' }],
    ['CAD $80,000 - $95,000', { min: 80000, max: 95000, currency: 'CAD' }],
    ['$60,000 - $70,000 CAD', { min: 60000, max: 70000, currency: 'CAD' }],
    ['A$90,000 - A$100,000', { min: 90000, max: 100000, currency: 'AUD' }],
    ['US$70,000 - US$85,000', { min: 70000, max: 85000, currency: 'USD' }],
    ['70,000 USD - 85,000 USD', { min: 70000, max: 85000, currency: 'USD' }],
    ['$70,000 - $85,000', { min: 70000, max: 85000, currency: null }],
    ['$70,000 - $85,000 a year, Monday to Friday', { min: 70000, max: 85000, currency: null }],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(extractCompFromText(text), want, text);
    assert.deepEqual(extractCompFromText(stripHtml(`<p>Pay: ${text}</p>`)), want, `${text} after the JD cleanup`);
  }
  // A double hyphen, which is what an em dash becomes in many feeds.
  assert.deepEqual(extractCompFromText('The U.S. pay range for this position is $125,600 -- $234,150 annually'), { min: 125000, max: 234000, currency: null });
  // The raw strings a feed source emits (no JD cleanup on that path).
  assert.deepEqual(extractCompFromText('GBP 40000 - 50000'), { min: 40000, max: 50000, currency: 'GBP' });
  assert.deepEqual(extractCompFromText('USD 60000 - 70000'), { min: 60000, max: 70000, currency: 'USD' });
  // Not a yearly band.
  assert.equal(extractCompFromText('$10,500 - $13,650 per month').period, 'month');
  assert.equal(extractCompFromText('$10500 - $13650/mo').period, 'mo');
  assert.equal(extractCompFromText('$10500 - $13650/pay period').period, 'pay period');
  assert.equal(extractCompFromText('$10500 - $13650/ZZ').period, 'zz');
  assert.equal('period' in extractCompFromText('$92108 - $119746/yr'), false);
  // A currency code needs a word boundary on its left: a word that ends in
  // "aud", "eur" or "cad" does not start a band and hide the real one.
  assert.deepEqual(extractCompFromText('We reduced fraud 40,000 to 60,000 cases. Base pay $180,000 - $220,000'), { min: 180000, max: 220000, currency: null });
  assert.equal(extractCompFromText('Our auditors flag fraud 20,000 to 30,000 times a year.'), null);
  assert.equal(extractCompFromText('Patients applaud 150k to 200k visits'), null);
  assert.equal(extractCompFromText('An entrepreneur 10,000 to 20,000 strong community'), null);
  assert.deepEqual(extractCompFromText('Salary (AUD 100,000 to 120,000)'), { min: 100000, max: 120000, currency: 'AUD' });
  assert.deepEqual(extractCompFromText('EUR 50,000 to 60,000'), { min: 50000, max: 60000, currency: 'EUR' });
  // Not a pay band at all.
  for (const text of ['$50,000,000', 'JPY 5,000,000 - 7,000,000', '€40,000,000 raised', 'The Europe team of 120,000 people']) {
    assert.equal(extractCompFromText(text), null, text);
  }
});

test('Lever and Ashby: the pay period the feed states rides along, so a monthly band is never read as yearly', async () => {
  const saved = global.fetch;
  const ashbyId = '1a2b3c4d-0000-4000-8000-000000000002';
  const salary = (interval) => ({ compensationTiers: [{ components: [{ compensationType: 'Salary', minValue: 4000, maxValue: 5200, currencyCode: 'EUR', interval }] }] });
  global.fetch = async (url) => {
    const body = /api\.lever\.co/.test(url)
      ? { descriptionPlain: LONG_JD, categories: { location: 'Lyon' }, salaryRange: /monthly/.test(url) ? { min: 4000, max: 5200, currency: 'EUR', interval: 'per-month-salary' } : { min: 48000, max: 62400, currency: 'EUR' } }
      : { jobs: [{ id: ashbyId, jobUrl: `https://jobs.ashbyhq.com/ledgerfinch/${ashbyId}`, descriptionPlain: LONG_JD, compensation: salary('1 MONTH') }] };
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  try {
    const lever = await fetchJd('https://jobs.lever.co/monthly/0a0a0a0a-1111-4222-8333-444444444444');
    assert.deepEqual(lever.compensation, { min: 4000, max: 5200, currency: 'EUR', period: 'month' });
    const plain = await fetchJd('https://jobs.lever.co/yearly/0a0a0a0a-1111-4222-8333-555555555555');
    assert.deepEqual(plain.compensation, { min: 48000, max: 62400, currency: 'EUR' }, 'no stated interval, no period');
    const ashby = await fetchJd(`https://jobs.ashbyhq.com/ledgerfinch/${ashbyId}`);
    assert.deepEqual(ashby.compensation, { min: 4000, max: 5200, currency: 'EUR', period: 'month' });
    // The pay floor reads a monthly band as unknown pay and keeps the posting.
    const { publishedMax } = require('../collectors/pipeline');
    assert.equal(publishedMax({ compensation: lever.compensation, location: 'Lyon, France' }, 'EUR'), null);
    assert.equal(publishedMax({ compensation: plain.compensation, location: 'Lyon, France' }, 'EUR'), 62400);
  } finally { global.fetch = saved; }
});
