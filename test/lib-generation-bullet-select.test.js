'use strict';
// lib/bullet-select.js: per posting selection from the user's own library.
// Role keys and the company map are data; nothing about an employer or a
// field lives in code. Synthetic nurse and accountant fixtures in
// JOBE_USER_ROOT temp workspaces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function workspace(library) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-lib-generation-select-'));
  if (library !== undefined) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'bullet-library.json'), typeof library === 'string' ? library : JSON.stringify(library));
  }
  return root;
}

const NURSE_LIBRARY = {
  _comment: 'synthetic registered nurse library',
  companyKeyMap: { 'Lakeside Medical Center': 'current', 'Northfield Clinic': 'prior1', 'Hillcrest Care': 'prior2' },
  current: [
    { id: 'current-med-safety', keywords: ['medication safety', 'double check'], studyGroup: 'med-safety', text: 'Cut medication errors 38% with a double check protocol for high alert drugs.' },
    { id: 'current-med-safety-method', keywords: ['medication safety', 'barcode'], studyGroup: 'med-safety', text: 'Introduced barcode verification at the bedside as part of the medication safety protocol.' },
    { id: 'current-falls', keywords: ['falls prevention', 'rounding'], text: 'Reduced falls 22% with hourly rounding and bed alarm audits.' },
    { id: 'current-precept', keywords: ['preceptor', 'orientation'], text: 'Precepted 9 new graduate nurses through a twelve week orientation.' },
  ],
  prior1: [
    { id: 'prior1-triage', keywords: ['triage'], text: 'Triaged 40 walk in patients per shift at a community clinic.' },
  ],
  prior2: [
    { id: 'prior2-aide', keywords: ['patient care'], text: 'Supported daily patient care for a 30 resident wing.' },
  ],
  selectedProjects: [
    { id: 'proj-rounding-a', name: 'Rounding Checklist', keywords: ['rounding', 'falls prevention'], text: 'Hourly rounding checklist adopted by two units.' },
    { id: 'proj-rounding-b', name: 'Rounding Checklist', keywords: ['rounding'], text: 'A second framing of the same rounding checklist.' },
    { id: 'proj-guide', keywords: ['orientation'], text: 'Orientation guide for new graduates.' },
  ],
};

const BASELINE = {
  defaultBulletCounts: { current: 3, prior1: 1, prior2: 0 },
  experience: [
    { title: 'Charge Nurse', company: 'Lakeside Medical Center', dates: '2022 to Present', bullets: ['baseline current bullet'] },
    { title: 'Staff Nurse', company: 'Northfield Clinic', dates: '2018 to 2022', bullets: ['baseline prior bullet'] },
    { title: 'Nurse Aide', company: 'Hillcrest Care', dates: '2016 to 2018', bullets: ['baseline aide bullet'] },
    { title: 'Volunteer', company: 'Unmapped Shelter', dates: '2015 to 2016', bullets: ['baseline volunteer bullet'] },
  ],
};

const JD = 'Charge nurse. Medication safety and falls prevention on a medical surgical unit. Medication safety audits, rounding, and falls prevention teaching every shift.';

const NURSE_ROOT = workspace(NURSE_LIBRARY);
process.env.JOBE_USER_ROOT = NURSE_ROOT;
const { pickBullets, buildExperience, pickProjects, loadLibrary } = require('../lib/bullet-select');

test('buildExperience uses baseline.defaultBulletCounts and the library companyKeyMap', () => {
  const exp = buildExperience(BASELINE, { jdText: JD });
  // prior2 has a count of 0 and is dropped; the unmapped entry passes through.
  assert.deepEqual(exp.map((e) => e.company), ['Lakeside Medical Center', 'Northfield Clinic', 'Unmapped Shelter']);
  assert.equal(exp[0].bullets.length, 3);
  assert.deepEqual(exp[1].bullets, [NURSE_LIBRARY.prior1[0].text]);
  assert.deepEqual(exp[2].bullets, ['baseline volunteer bullet']);
  // Title, dates, and the rest of the baseline entry are kept.
  assert.equal(exp[0].title, 'Charge Nurse');
});

test('one bullet per studyGroup: two framings of the same work never both render', () => {
  const picked = pickBullets('current', { jdText: JD }, 4);
  const medSafety = picked.filter((t) => /medication (errors|safety)/i.test(t));
  assert.equal(medSafety.length, 1);
  assert.equal(picked.length, 3); // 4 in the pool, one suppressed as a duplicate framing
  // JD relevant evidence leads.
  assert.match(picked[0], /medication|falls/i);
});

test('spec.bulletCounts and spec.companyKeyMap override the baseline and the library', () => {
  const exp = buildExperience(BASELINE, {
    jdText: JD,
    bulletCounts: { current: 1, prior1: 1, prior2: 1 },
    companyKeyMap: { 'Unmapped Shelter': 'prior2' },
  });
  assert.equal(exp[0].bullets.length, 1);
  assert.equal(exp.length, 4);
  assert.deepEqual(exp[3].bullets, [NURSE_LIBRARY.prior2[0].text]);
});

test('never a bare company header: an emptied pool falls back to the baseline bullets', () => {
  const exp = buildExperience(BASELINE, { jdText: JD, excludeBullets: ['prior1-triage'] });
  assert.deepEqual(exp[1].bullets, ['baseline prior bullet']);
  for (const e of exp) assert.ok(e.bullets.length > 0, `${e.company} rendered with zero bullets`);
});

test('pinned bullets come first and excluded bullets never appear', () => {
  const picked = pickBullets('current', { jdText: JD, pinBullets: ['current-precept'], excludeBullets: ['current-falls'] }, 2);
  assert.match(picked[0], /Precepted/);
  assert.ok(!picked.some((t) => /falls/.test(t)));
  assert.deepEqual(pickBullets('no-such-role', { jdText: JD }, 3), []);
});

test('pickProjects dedups by project name', () => {
  const projects = pickProjects({ jdText: JD }, 3);
  assert.equal(projects.filter((p) => p.name === 'Rounding Checklist').length, 1);
  assert.deepEqual(projects.map((p) => p.name).sort(), ['Rounding Checklist', 'guide']);
});

test('a workspace with no library, or a malformed one, selects nothing and keeps the baseline', () => {
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(String(m));
  try {
    for (const root of [workspace(), workspace('{ not json')]) {
      process.env.JOBE_USER_ROOT = root;
      assert.deepEqual(loadLibrary(), {});
      const accountant = {
        defaultBulletCounts: { current: 4 },
        experience: [{ title: 'Tax Accountant', company: 'Harbor Tax Group', dates: '2021 to Present', bullets: ['Prepared 340 returns per season.'] }],
      };
      assert.deepEqual(buildExperience(accountant, { jdText: 'Tax accountant preparing returns.' }), accountant.experience);
      assert.deepEqual(pickProjects({ jdText: 'Tax accountant preparing returns.' }), []);
    }
  } finally {
    console.warn = warn;
    process.env.JOBE_USER_ROOT = NURSE_ROOT;
  }
  // The missing file is silent; the malformed one says so once.
  assert.equal(warned.length, 1);
  assert.match(warned[0], /bullet-library\.json is unreadable/);
  // Back in the first workspace the real library is still served.
  assert.ok(Array.isArray(loadLibrary().current));
});
