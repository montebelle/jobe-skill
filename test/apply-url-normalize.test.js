'use strict';
// lib/apply/url-normalize.js: posting URL -> the URL that shows the application
// form, and the wrapper board map (data, ships empty). Synthetic hosts only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-apply-url-'));
process.env.JOBE_USER_ROOT = ROOT;
const { normalizeApplyUrl, deriveBoardToken, wrapperBoards, WRAPPER_BOARD } = require('../lib/apply/url-normalize');

const wrappersFile = path.join(ROOT, 'data', 'apply-wrappers.json');

test('no wrapper map: the shipped config is empty and nothing is known', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'configs', 'apply-wrappers.json'), 'utf8'));
  assert.deepEqual(shipped, {});
  assert.deepEqual(wrapperBoards(), {});
  assert.deepEqual(WRAPPER_BOARD, {});
});

test('each ATS shape maps to its form URL', () => {
  const cases = [
    ['', { url: '', ats: 'unknown', needsManual: false }],
    ['https://jobs.ashbyhq.com/lakeside-health/abc-123', { url: 'https://jobs.ashbyhq.com/lakeside-health/abc-123/application', ats: 'ashby', needsManual: false }],
    ['https://jobs.ashbyhq.com/lakeside-health/abc-123/application', { url: 'https://jobs.ashbyhq.com/lakeside-health/abc-123/application', ats: 'ashby', needsManual: false }],
    ['https://harborledger.wd5.myworkdayjobs.com/en-US/careers/job/Tax-Accountant_R1', { url: 'https://harborledger.wd5.myworkdayjobs.com/en-US/careers/job/Tax-Accountant_R1', ats: 'workday', needsManual: true }],
    ['https://job-boards.greenhouse.io/lakesidehealth/jobs/4455', { url: 'https://job-boards.greenhouse.io/embed/job_app?for=lakesidehealth&token=4455', ats: 'greenhouse', needsManual: false }],
    ['https://boards.greenhouse.io/lakesidehealth/jobs/4455', { url: 'https://job-boards.greenhouse.io/embed/job_app?for=lakesidehealth&token=4455', ats: 'greenhouse', needsManual: false }],
    ['https://job-boards.greenhouse.io/embed/job_app?for=lakesidehealth&token=4455', { url: 'https://job-boards.greenhouse.io/embed/job_app?for=lakesidehealth&token=4455', ats: 'greenhouse', needsManual: false }],
    ['https://jobs.lever.co/harborledger/9f1c', { url: 'https://jobs.lever.co/harborledger/9f1c', ats: 'lever', needsManual: false }],
    ['https://careers.harborledger.example/openings/tax-accountant?gh_jid=7788', { url: 'https://boards.greenhouse.io/embed/job_app?for=harborledger&token=7788', ats: 'greenhouse', needsManual: false }],
    // a /jobs/<id> path alone is not a Greenhouse signal on an unknown host
    ['https://careers.harborledger.example/jobs/7788', { url: 'https://careers.harborledger.example/jobs/7788', ats: 'unknown', needsManual: false }],
  ];
  for (const [input, want] of cases) {
    const got = normalizeApplyUrl(input);
    assert.deepEqual({ url: got.url, ats: got.ats, needsManual: got.needsManual }, want, input);
  }
});

test('deriveBoardToken keeps the registrable domain label', () => {
  assert.equal(deriveBoardToken('careers.lakesidehealth.org'), 'lakesidehealth');
  assert.equal(deriveBoardToken('www.harborledger.co.uk'), 'harborledger');
  assert.equal(deriveBoardToken('jobs.apply.lakesidehealth.com'), 'lakesidehealth');
  assert.equal(deriveBoardToken('localhost'), '');
});

test('a workspace wrapper map supplies a board token the domain cannot give', () => {
  fs.mkdirSync(path.dirname(wrappersFile), { recursive: true });
  fs.writeFileSync(wrappersFile, JSON.stringify({
    $comment: 'notes are ignored',
    'Careers.LakesideHealth.org': 'lakesideregional',
    'careers.harborledger.example': 'bad token/../x',
    'careers.other.example': 42,
  }));
  assert.deepEqual(wrapperBoards(), { 'careers.lakesidehealth.org': 'lakesideregional' });

  // known host: the token comes from the map, and a /jobs/<id> path is enough
  const byParam = normalizeApplyUrl('https://careers.lakesidehealth.org/role?gh_jid=31');
  assert.equal(byParam.url, 'https://boards.greenhouse.io/embed/job_app?for=lakesideregional&token=31');
  const byPath = normalizeApplyUrl('https://careers.lakesidehealth.org/jobs/31');
  assert.equal(byPath.url, 'https://boards.greenhouse.io/embed/job_app?for=lakesideregional&token=31');
  const noId = normalizeApplyUrl('https://careers.lakesidehealth.org/about');
  assert.equal(noId.needsManual, true);

  // an unusable token is dropped, so that host still derives from its domain
  const derived = normalizeApplyUrl('https://careers.harborledger.example/x?gh_jid=5');
  assert.equal(derived.url, 'https://boards.greenhouse.io/embed/job_app?for=harborledger&token=5');

  fs.writeFileSync(wrappersFile, '{ not json');
  assert.deepEqual(wrapperBoards(), {});
});
