'use strict';
// collectors/pipeline.js run(), end to end and offline: one direct ATS source,
// a stubbed fetch, a throwaway workspace. Proves the wiring between discovery,
// the listing stage filter, enrichment, the strict gate, and the summary for a
// synthetic registered nurse who works on site in the United States.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-core-run-'));
const writeJson = (rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
};
writeJson('data/queries/seeds.json', { queries: [
  { query: 'Registered Nurse', location: 'Columbus, OH' },
  { query: 'Charge Nurse', location: 'Columbus, OH' },
] });
writeJson('data/profile.json', {
  discovery: { workModes: ['onsite', 'hybrid'], countries: ['US'], titleExclude: ['travel'], salaryFloor: 60000 },
});
writeJson('data/companies/portals.json', { greenhouse: ['acmehospital'] });
process.env.JOBE_USER_ROOT = root;

const day = 86400000;
const iso = (n) => new Date(Date.now() - n * day).toISOString();
const body = (pay) => `&lt;p&gt;Provide direct patient care on a busy unit, coordinate with physicians, document assessments, and mentor new staff across shifts.&lt;/p&gt;&lt;p&gt;${pay}&lt;/p&gt;`;
const JOBS = [
  { id: 1, title: 'Registered Nurse, ICU', location: 'Columbus, OH', first: iso(3), pay: 'Pay range: $70,000 to $85,000 per year.' },
  { id: 2, title: 'Registered Nurse, Telehealth', location: 'Remote', first: iso(3), pay: '' },
  { id: 3, title: 'Travel Registered Nurse', location: 'Columbus, OH', first: iso(3), pay: '' },
  { id: 4, title: 'Registered Nurse, Float Pool', location: 'Columbus, OH', first: iso(60), pay: '' },
  { id: 5, title: 'Charge Nurse', location: 'Columbus, OH', first: iso(4), pay: 'Pay range: $40,000 to $50,000 per year.' },
  { id: 6, title: 'Staff Accountant', location: 'Columbus, OH', first: iso(3), pay: '' },
  { id: 7, title: 'Registered Nurse, Cardiology', location: 'United States', detailLocation: 'Columbus, OH', first: iso(5), pay: '' },
];
const listRow = (j) => ({
  title: j.title,
  absolute_url: `https://boards.greenhouse.io/acmehospital/jobs/${j.id}`,
  location: { name: j.location },
  first_published: j.first,
  updated_at: iso(1), // every req was refreshed yesterday; only first_published is honest
  content: body(j.pay),
});

const fetched = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  fetched.push(u);
  const ok = (data) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) });
  if (u.endsWith('/boards/acmehospital/jobs?content=true')) return ok({ jobs: JOBS.map(listRow) });
  if (u.endsWith('/boards/acmehospital')) return ok({ name: 'Acme Hospital' });
  const m = u.match(/\/boards\/acmehospital\/jobs\/(\d+)$/);
  if (m) {
    const j = JOBS.find((x) => String(x.id) === m[1]);
    return ok({ ...listRow(j), location: { name: j.detailLocation || j.location } });
  }
  if (/boards-api\.greenhouse\.io/.test(u)) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
  throw new Error(`unexpected fetch: ${u}`);
};

const { run } = require('../collectors/pipeline');

test('run(): policy driven filters at both stages, original publish date, pay floor, summary', async () => {
  const realError = console.error;
  console.error = () => {}; // the pipeline logs progress to stderr
  let final;
  try {
    final = await run({ onlySource: 'greenhouse-direct', noHarvest: true });
  } finally {
    console.error = realError;
  }
  assert.ok(fetched.every((u) => u.startsWith('https://boards-api.greenhouse.io/')), 'only the stubbed board was contacted');
  assert.deepEqual(final.map((p) => p.title).sort(), ['Registered Nurse, Cardiology', 'Registered Nurse, ICU']);

  const icu = final.find((p) => /ICU/.test(p.title));
  assert.equal(icu.company, 'Acme Hospital');
  assert.equal(icu.salaryCheck, 'published');
  assert.deepEqual(icu.compensation, { min: 70000, max: 85000, currency: null }, 'a bare dollar sign is not labeled with a currency');
  assert.equal(typeof icu.matchScore, 'number');
  const cardio = final.find((p) => /Cardiology/.test(p.title));
  assert.equal(cardio.remote, 'onsite', 'the work mode was verified from the enriched posting');
  assert.equal(cardio.salaryCheck, 'unknown', 'unknown pay is kept and labeled');

  const outDir = path.join(root, 'signals', 'discovered', fs.readdirSync(path.join(root, 'signals', 'discovered'))[0]);
  const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'discovery-summary.json'), 'utf8'));
  assert.equal(summary.perSource['greenhouse-direct'], 6, 'the source gate dropped the title outside the seeds');
  assert.equal(summary.rejected.role, 1, 'title policy: travel');
  assert.equal(summary.rejected.nonRemote, 1, 'remote is outside this user work modes');
  assert.equal(summary.rejected.recency, 1, 'first published 60 days ago, refreshed yesterday');
  assert.equal(summary.afterFilter, 3);
  assert.equal(summary.postEnrichRejected.salary, 1, 'published band tops out below the floor');
  assert.equal(summary.finalCount, 2);
  assert.equal(summary.payUnknown, 1);
  assert.equal(summary.needsAgentFallback, true);

  const filterReport = JSON.parse(fs.readFileSync(path.join(outDir, 'filter-report.json'), 'utf8'));
  assert.deepEqual(filterReport.filters.workModes, ['onsite', 'hybrid']);
  assert.equal(filterReport.filters.usOnly, true);

  const idx = JSON.parse(fs.readFileSync(path.join(root, 'data/companies/index.json'), 'utf8'));
  assert.equal(idx.acmehospital.ats, 'greenhouse');
});
