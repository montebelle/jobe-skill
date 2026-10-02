'use strict';
// lib/tracker-writer.js: tracker upsert, status update through the lifecycle
// locator, and report folder moves with queue + tracker path rewrite. Every
// file is written inside a JOBE_USER_ROOT temp workspace; synthetic postings
// only (a nurse role and an accountant role).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-lib-generation-tracker-'));
process.env.JOBE_USER_ROOT = ROOT;
const writer = require('../lib/tracker-writer');

const trackerPath = path.join(ROOT, 'data', 'tracker.md');
const tracker = () => fs.readFileSync(trackerPath, 'utf8');
const rowsFor = (slug) => tracker().split('\n').filter((line) => line.includes(`/${slug}/`));
const mkReport = (...segments) => {
  const dir = path.join(ROOT, 'reports', ...segments);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'resume.json'), '{}');
  return dir;
};

test('writes land in the temp workspace, created on demand', () => {
  assert.ok(!fs.existsSync(trackerPath));
  const first = writer.upsertTrackerRow({
    date: '2030-01-05', company: 'Lakeside Medical Center', role: 'Charge Nurse | Nights', score: 82,
    status: 'Evaluated', reportDir: 'reports/evaluate/lakeside-charge-nurse/', notes: 'new',
  }, 'lakeside-charge-nurse');
  assert.deepEqual(first, { rowNumber: 1, inserted: true, removedDuplicates: 0 });
  assert.ok(fs.existsSync(trackerPath));
  // A pipe inside a cell never shifts the columns.
  assert.match(rowsFor('lakeside-charge-nurse')[0], /\| Charge Nurse \/ Nights \| 82 \| Evaluated \|/);
  assert.throws(() => writer.upsertTrackerRow({ date: '2030-01-05' }, '  '), /slug is required/);
});

test('upsertTrackerRow replaces a lifecycle-moved slug without duplicating it', () => {
  const slug = 'harbor-tax-accountant';
  const oldNumber = writer.appendTrackerRow({
    date: '2030-01-06', company: 'Old Co', role: 'Old Role', score: 1,
    status: 'Skipped', reportDir: `reports/skipped/${slug}/`, notes: 'old',
  });
  const row = {
    date: '2030-01-07', company: 'Harbor Tax Group', role: 'Tax Accountant', score: 91,
    status: 'Queued', reportDir: `reports/queue/${slug}/`, notes: 'current',
  };
  const first = writer.upsertTrackerRow(row, slug);
  const second = writer.upsertTrackerRow(row, slug);
  const rows = rowsFor(slug);

  assert.equal(first.inserted, false);
  assert.equal(second.inserted, false);
  assert.equal(first.rowNumber, oldNumber);
  assert.equal(first.rowNumber, second.rowNumber);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /\| Harbor Tax Group \| Tax Accountant \| 91 \| Queued \|/);
  assert.match(rows[0], new RegExp(`reports/queue/${slug}/`));
  // The other posting's row is untouched.
  assert.equal(rowsFor('lakeside-charge-nurse').length, 1);
});

test('upsertTrackerRow collapses historical duplicates onto the first row', () => {
  const slug = 'dup-clinic-nurse';
  const base = { date: '2030-01-08', company: 'Dup Clinic', role: 'Staff Nurse', score: 70, status: 'Evaluated', notes: '' };
  const firstNumber = writer.appendTrackerRow({ ...base, reportDir: `reports/${slug}/` });
  writer.appendTrackerRow({ ...base, reportDir: `reports/evaluate/${slug}/` });
  const out = writer.upsertTrackerRow({ ...base, status: 'Queued', reportDir: `reports/queue/${slug}/` }, slug);
  assert.deepEqual(out, { rowNumber: firstNumber, inserted: false, removedDuplicates: 1 });
  assert.equal(rowsFor(slug).length, 1);
  // A slug that is only a suffix of another slug is a different posting.
  assert.equal(writer.upsertTrackerRow({ ...base, reportDir: 'reports/queue/clinic-nurse/' }, 'clinic-nurse').inserted, true);
});

test('moveReportFolder moves across buckets and rewrites queue + tracker paths', () => {
  const slug = 'harbor-tax-accountant';
  mkReport('queue', slug);
  writer.pushQueueEntry({
    slug, company: 'Harbor Tax Group',
    resumeDocx: `reports/queue/${slug}/resume.docx`,
    coverLetterDocx: `reports/queue/${slug}/cover-letter.docx`,
  });
  writer.pushQueueEntry({ slug: 'other', resumeDocx: 'reports/queue/other/resume.docx' });

  assert.equal(writer.locateReportDir(ROOT, slug), path.join(ROOT, 'reports', 'queue', slug));
  assert.equal(writer.moveReportFolder(slug, 'applied'), true);
  assert.ok(fs.existsSync(path.join(ROOT, 'reports', 'applied', slug, 'resume.json')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'reports', 'queue', slug)));

  const entry = writer.readQueue().find((e) => e.slug === slug);
  assert.equal(entry.resumeDocx, `reports/applied/${slug}/resume.docx`);
  assert.equal(entry.coverLetterDocx, `reports/applied/${slug}/cover-letter.docx`);
  assert.equal(entry.reportDir, `reports/applied/${slug}/`);
  assert.equal(writer.readQueue().find((e) => e.slug === 'other').resumeDocx, 'reports/queue/other/resume.docx');
  assert.match(rowsFor(slug)[0], new RegExp(`\\| reports/applied/${slug}/ \\|`));

  // Already there: no-op. Unknown bucket: an error, never a silent move.
  assert.equal(writer.moveReportFolder(slug, 'applied'), false);
  assert.equal(writer.moveReportFolder('no-such-slug', 'applied'), false);
  assert.throws(() => writer.moveReportFolder(slug, 'somewhere'), /bucket must be one of/);
  assert.deepEqual(writer.LIFECYCLE_BUCKETS, ['verify', 'evaluate', 'queue', 'manual', 'applied', 'skipped', 'archive', 'audit']);
});

test('updateTrackerStatus finds the row wherever the folder sits', () => {
  const slug = 'harbor-tax-accountant'; // now in reports/applied/
  assert.equal(writer.updateTrackerStatus({ slug, newStatus: 'Applied', notesAppend: 'submitted' }), true);
  assert.match(rowsFor(slug)[0], /\| Applied \| reports\/applied\/harbor-tax-accountant\/ \| current; submitted \|/);

  // Stale path in the tracker (the folder is gone): still matched by slug.
  assert.equal(writer.updateTrackerStatus({ slug: 'lakeside-charge-nurse', newStatus: 'Skipped' }), true);
  assert.match(rowsFor('lakeside-charge-nurse')[0], /\| Skipped \|/);

  // By explicit reportDir, and the misses.
  assert.equal(writer.updateTrackerStatus({ reportDir: 'reports/queue/dup-clinic-nurse/', newStatus: 'Applied' }), true);
  assert.match(rowsFor('dup-clinic-nurse')[0], /\| Applied \|/);
  assert.equal(writer.updateTrackerStatus({ slug: 'no-such-slug', newStatus: 'Applied' }), false);
  assert.equal(writer.updateTrackerStatus({ newStatus: 'Applied' }), false);
  // 'clinic-nurse' must not have been touched by the 'dup-clinic-nurse' update.
  assert.match(rowsFor('clinic-nurse').find((r) => !r.includes('dup-')), /\| Evaluated \|/);
});

test('locateReportDir finds legacy layouts; a move to manual files flat', () => {
  mkReport('legacy-flat');
  mkReport('needs-manual', 'legacy-needs-manual');
  mkReport('manual', 'archive', '2030-01-02', 'legacy-archived');
  mkReport('manual', 'archive', '2030-02-02', 'legacy-archived'); // newest date wins

  assert.equal(writer.locateReportDir(ROOT, 'legacy-flat'), path.join(ROOT, 'reports', 'legacy-flat'));
  assert.equal(writer.locateReportDir(ROOT, 'legacy-needs-manual'), path.join(ROOT, 'reports', 'needs-manual', 'legacy-needs-manual'));
  assert.equal(writer.locateReportDir(ROOT, 'legacy-archived'), path.join(ROOT, 'reports', 'manual', 'archive', '2030-02-02', 'legacy-archived'));
  assert.equal(writer.locateReportDir(ROOT, 'nowhere'), null);

  writer.pushQueueEntry({ slug: 'legacy-flat', resumeDocx: 'reports/legacy-flat/resume.docx' });
  assert.equal(writer.moveReportFolder('legacy-flat', 'queue'), true);
  assert.equal(writer.readQueue().find((e) => e.slug === 'legacy-flat').resumeDocx, 'reports/queue/legacy-flat/resume.docx');

  // The old bucket name still works as a destination and means manual.
  assert.equal(writer.moveReportFolder('legacy-needs-manual', 'needs-manual'), true);
  assert.ok(fs.existsSync(path.join(ROOT, 'reports', 'manual', 'legacy-needs-manual')));
  assert.equal(writer.moveReportFolder('legacy-archived', 'manual'), true);
  assert.ok(fs.existsSync(path.join(ROOT, 'reports', 'manual', 'legacy-archived', 'resume.json')));
});

test('locateReportDir never resolves outside reports/ or onto a bucket folder', () => {
  fs.mkdirSync(path.join(ROOT, 'outside'), { recursive: true });
  for (const bad of ['../outside', '..', '.', '', 'queue', 'applied', 'needs-manual', 'a/b', 'a\\b', null, undefined]) {
    assert.equal(writer.locateReportDir(ROOT, bad), null, `slug ${JSON.stringify(bad)}`);
  }
  assert.equal(writer.moveReportFolder('queue', 'applied'), false);
  assert.ok(fs.existsSync(path.join(ROOT, 'reports', 'queue')));
});

test('paths are resolved per call, so a workspace switch is honored', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-lib-generation-tracker-b-'));
  process.env.JOBE_USER_ROOT = other;
  try {
    assert.deepEqual(writer.readQueue(), []);
    assert.equal(writer.appendTrackerRow({ date: '2030-03-01', company: 'B', role: 'R', status: 'Evaluated' }), 1);
    assert.ok(fs.existsSync(path.join(other, 'data', 'tracker.md')));
  } finally {
    process.env.JOBE_USER_ROOT = ROOT;
  }
  assert.ok(!tracker().includes('| B | R |'));
});
