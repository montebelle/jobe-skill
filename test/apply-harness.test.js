'use strict';
// scripts/camoufox-apply.js (the location guard verdict and the embed frame
// context) and scripts/apply-helpers/submit.sh (workspace resolution, values
// passed as arguments). No browser is launched and no site is contacted: the
// harness file is only required, and submit.sh is run against a state file
// that already says "submitted".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-apply-harness-'));
process.env.JOBE_USER_ROOT = ROOT;
const { locationVerdict, bestFormFrame, frameCtx } = require('../scripts/camoufox-apply.js');
const { discoveryFilters } = require('../lib/profile');

const policy = (discovery) => discoveryFilters({ discovery });
const NURSE_PAGE = { loc: 'Chicago, IL', title: 'Charge Nurse, Medical Surgical', body: '' };
const REMOTE_PAGE = { loc: 'Remote - United States', title: 'Senior Tax Accountant', body: '' };

test('requiring the harness starts nothing and writes nothing', () => {
  assert.deepEqual(fs.readdirSync(ROOT), []);
});

test('location guard: no policy on file never blocks', () => {
  for (const li of [NURSE_PAGE, REMOTE_PAGE, { loc: 'Berlin, Germany', title: 'Steuerberater', body: 'You must be based in Germany.' }, {}]) {
    assert.equal(locationVerdict(li, policy({})).blocked, false);
    assert.equal(locationVerdict(li, undefined).blocked, false);
  }
});

test('location guard: the work mode policy is the user\'s own', () => {
  // a user who works on site is not blocked from an on site posting
  assert.equal(locationVerdict(NURSE_PAGE, policy({ workModes: ['onsite', 'hybrid'] })).blocked, false);
  // a user who only works remotely is
  const v = locationVerdict(NURSE_PAGE, policy({ workModes: ['remote'] }));
  assert.equal(v.blocked, true);
  assert.equal(v.remote, 'onsite');
  assert.match(v.why, /Outside your location policy \(workModes=\[remote\]/);
  assert.equal(locationVerdict(REMOTE_PAGE, policy({ workModes: ['remote'] })).blocked, false);
  // a city alone states no mode: a hybrid role is listed with its city, so
  // only a remote only policy blocks it (same rule as the discovery listing stage)
  assert.equal(locationVerdict(NURSE_PAGE, policy({ workModes: ['hybrid'] })).blocked, false);
  assert.equal(locationVerdict(NURSE_PAGE, policy({ workModes: ['remote', 'hybrid'] })).blocked, false);
  assert.equal(locationVerdict({ loc: 'Leeds, England', title: 'Tax Accountant', body: 'Hybrid: two days a week in the office.' }, policy({ workModes: ['hybrid'] })).blocked, false);
  // a page that states a mode outside the policy is still blocked
  assert.equal(locationVerdict(REMOTE_PAGE, policy({ workModes: ['hybrid'] })).blocked, true);
  assert.equal(locationVerdict({ loc: 'Chicago, IL', title: 'Charge Nurse (Hybrid)', body: '' }, policy({ workModes: ['remote'] })).blocked, true);
  assert.equal(locationVerdict({ loc: 'Chicago, IL', title: 'Charge Nurse (Hybrid)', body: '' }, policy({ workModes: ['onsite'] })).blocked, true);
  // and the reverse: on site only
  assert.equal(locationVerdict(REMOTE_PAGE, policy({ workModes: ['onsite'] })).blocked, true);
  // a page that states no work mode proceeds to the glance
  assert.equal(locationVerdict({ loc: '', title: 'Tax Accountant', body: '' }, policy({ workModes: ['remote'] })).blocked, false);
});

test('location guard: the country policy is the user\'s own', () => {
  const toronto = { loc: 'Toronto, Canada', title: 'Tax Accountant', body: '' };
  assert.equal(locationVerdict(toronto, policy({ countries: ['US'] })).blocked, true);
  assert.equal(locationVerdict(toronto, policy({ countries: ['CA'] })).blocked, false);
  assert.equal(locationVerdict(toronto, policy({ countries: ['US', 'Canada'] })).blocked, false);
  assert.equal(locationVerdict({ loc: 'Berlin, Germany', title: 'Nurse', body: '' }, policy({ countries: ['CA'] })).blocked, true);
  assert.equal(locationVerdict(REMOTE_PAGE, policy({ countries: ['US'] })).blocked, false);
  // The guard blocks only a page that names ANOTHER country. A city, a city
  // plus region, or an everyday alias of the user's country proceeds.
  const page = (loc, title) => ({ loc, title, body: '' });
  const ca = policy({ countries: ['CA', 'Canada'] });
  for (const loc of ['Toronto, ON', 'Toronto, Ontario', 'Toronto', 'Vancouver, BC']) {
    assert.equal(locationVerdict(page(loc, 'Registered Nurse'), ca).blocked, false, loc);
  }
  assert.match(locationVerdict(page('Austin, TX', 'Registered Nurse'), ca).why, /country not in your list/);
  assert.equal(locationVerdict(page('Lyon, France', 'Registered Nurse'), ca).blocked, true);
  const gb = policy({ countries: ['GB', 'United Kingdom'] });
  for (const loc of ['Remote - UK', 'London, England (Remote)', 'Remote - Great Britain', 'London']) {
    assert.equal(locationVerdict(page(loc, 'Tax Accountant'), gb).blocked, false, loc);
  }
  // A list that mixes the United States with another country keeps that
  // country's cities and regions too, and still blocks a third country.
  for (const countries of [['US', 'Canada'], ['US', 'CA'], ['US', 'CA', 'Canada']]) {
    const mixed = policy({ countries });
    for (const loc of ['Toronto, ON', 'Toronto, Ontario', 'Toronto', 'Vancouver, BC', 'Montreal, QC', 'Calgary, Alberta', 'Austin, TX', 'Chicago, IL']) {
      assert.equal(locationVerdict(page(loc, 'Registered Nurse'), mixed).blocked, false, `${loc} under ${countries}`);
    }
    for (const loc of ['London, UK', 'Lyon, France', 'Berlin, Germany']) {
      assert.equal(locationVerdict(page(loc, 'Tax Accountant'), mixed).blocked, true, `${loc} under ${countries}`);
    }
  }
  assert.equal(locationVerdict(page('Dublin, Ireland', 'Tax Accountant'), gb).blocked, true);
  assert.equal(locationVerdict(page('New York, NY', 'Tax Accountant'), gb).blocked, true);
});

test('location guard: a residency requirement stated only in the description', () => {
  const us = policy({ workModes: ['remote'], countries: ['US'] });
  const foreign = locationVerdict({ loc: 'Remote', title: 'Tax Accountant', body: 'This role is remote. You must be based in Canada to apply.' }, us);
  assert.equal(foreign.blocked, true);
  assert.equal(foreign.us, 'jd-foreign-residency');
  const both = locationVerdict({ loc: 'Remote', title: 'Tax Accountant', body: 'You must be based in Canada or the United States.' }, us);
  assert.equal(both.blocked, false);
  assert.match(both.note, /also allows yours/);
  // the description check is not applied to a user with a different country list
  const ca = policy({ countries: ['CA'] });
  assert.equal(locationVerdict({ loc: 'Remote', title: 'Tax Accountant', body: 'You must be based in Canada to apply.' }, ca).blocked, false);
});

test('embed frame: the frame holding the form is chosen and element calls go to it', async () => {
  const frame = (n, name) => ({ name, evaluate: async () => n, locator: (s) => `${name}:${s}`, innerText: async () => `${name} text` });
  const main = frame(1, 'main');
  const embed = frame(9, 'embed');
  const page = {
    frames: () => [main, embed], mainFrame: () => main,
    keyboard: { id: 'kb' }, mouse: { id: 'mouse' },
    waitForTimeout: async (ms) => ms, setDefaultTimeout: () => {}, screenshot: async () => 'shot', isClosed: () => false,
  };
  assert.equal(await bestFormFrame(page), embed);
  // an inline form (the main frame has the fields) needs no frame context
  const only = frame(9, 'only');
  assert.equal(await bestFormFrame({ frames: () => [only], mainFrame: () => only }), null);
  // a frame with a couple of inputs (a search box) is not the form
  assert.equal(await bestFormFrame({ frames: () => [main, frame(2, 'widget')], mainFrame: () => main }), null);

  const ctx = frameCtx(page, embed);
  assert.equal(ctx.locator('input'), 'embed:input');
  assert.equal(await ctx.innerText('body'), 'embed text');
  assert.equal(ctx.keyboard, page.keyboard);
  assert.equal(await ctx.screenshot(), 'shot');
});

test('submit.sh records in the active workspace and treats company text as data', { skip: process.platform === 'win32' }, () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-apply-submit-'));
  const slug = 'apply-test-harborledger-tax-accountant';
  const put = (rel, content) => { const f = path.join(ws, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
  put(`signals/apply/${slug}/state.json`, JSON.stringify({ phase: 'submitted', postSubmitExcerpt: 'Thank you for applying' }));
  put(`reports/queue/${slug}/resume.json`, '{}');
  put('data/apply-queue.json', JSON.stringify([{ slug, company: 'Harbor Ledger', role: 'Tax Accountant', reportDir: `reports/queue/${slug}/` }]));
  put('data/tracker.md', `# Application Tracker\n\n| # | Date | Company | Role | Score | Status | Resume | Notes |\n|---|------|---------|------|-------|--------|--------|-------|\n| 1 | 2030-01-05 | Harbor Ledger | Tax Accountant | 80 | Evaluated | reports/queue/${slug}/ | new |\n`);
  // a company name that would break out of a quoted script if it were pasted into one
  const company = `O'Dell "Ledger" & Sons'); require('fs').writeFileSync('${path.join(ws, 'pwned')}','x'); ('`;
  const script = path.join(__dirname, '..', 'scripts', 'apply-helpers', 'submit.sh');
  const res = spawnSync('bash', [script, slug, company, 'Tax Accountant $(touch pwned)'], { env: { ...process.env, JOBE_USER_ROOT: ws }, cwd: ws, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /PHASE=submitted \| Thank you for applying/);

  assert.ok(!fs.existsSync(path.join(ws, 'pwned')));
  assert.ok(fs.existsSync(path.join(ws, 'reports', 'applied', slug)));
  assert.ok(!fs.existsSync(path.join(ws, 'reports', 'queue', slug)));
  const queue = JSON.parse(fs.readFileSync(path.join(ws, 'data', 'apply-queue.json'), 'utf8'));
  assert.equal(queue[0].applied, true);
  assert.equal(queue[0].reportDir, `reports/applied/${slug}/`);
  assert.match(fs.readFileSync(path.join(ws, 'data', 'tracker.md'), 'utf8'), new RegExp(`\\| Applied \\| reports/applied/${slug}/ \\| new; auto-apply; submitted `));
  const followups = fs.readFileSync(path.join(ws, 'data', 'followups.md'), 'utf8');
  assert.ok(followups.includes(`Follow up with ${company} (Tax Accountant $(touch pwned))`));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, 'signals', 'apply', slug, 'control.json'), 'utf8')), { action: 'done' });

  // a slug that is not one plain path segment is refused before anything runs
  const bad = spawnSync('bash', [script, '../x', 'A', 'B'], { env: { ...process.env, JOBE_USER_ROOT: ws }, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
