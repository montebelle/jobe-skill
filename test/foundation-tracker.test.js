'use strict';
// lib/tracker.js reads the tracker rows lib/tracker-writer.js writes. Synthetic
// rows from two unrelated professions in a JOBE_USER_ROOT temp workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-foundation-tracker-'));
const { upsertTrackerRow } = require('../lib/tracker-writer');
const tracker = require('../lib/tracker');

test('a row with no score keeps its columns: status, folder and notes are read in place', () => {
  upsertTrackerRow({ date: '2026-09-01', company: 'Acme Health', role: 'Staff Nurse', score: '', status: 'Applied', reportDir: 'reports/applied/acme-health-staff-nurse/', notes: 'auto' }, 'acme-health-staff-nurse');
  upsertTrackerRow({ date: '2026-09-02', company: 'Harbor Tax Group', role: 'Tax Accountant', score: '', status: 'Applied', reportDir: 'reports/applied/harbor-tax-group-tax-accountant/', notes: '' }, 'harbor-tax-group-tax-accountant');
  upsertTrackerRow({ date: '2026-09-03', company: 'Ledger and Finch', role: 'Senior Accountant', score: 82, status: 'Evaluated', reportDir: 'reports/queue/ledger-and-finch-senior-accountant/', notes: 'scored' }, 'ledger-and-finch-senior-accountant');
  const rows = tracker.parseTracker();
  assert.equal(rows.length, 3, 'a row with an empty score and empty notes is not dropped');
  const nurse = rows.find((r) => r.company === 'Acme Health');
  assert.deepEqual([nurse.score, nurse.status, nurse.resume, nurse.notes], ['', 'Applied', 'reports/applied/acme-health-staff-nurse/', 'auto']);
  const scored = rows.find((r) => r.company === 'Ledger and Finch');
  assert.deepEqual([scored.score, scored.status, scored.notes], ['82', 'Evaluated', 'scored']);
  assert.equal(tracker.getStats().Applied, 2);

  // updateStatus rewrites the row with every column still in place.
  tracker.updateStatus(nurse.num, 'Interviewing', 'screen');
  const after = tracker.parseTracker().find((r) => r.company === 'Acme Health');
  assert.deepEqual([after.score, after.status, after.resume, after.notes], ['', 'Interviewing', 'reports/applied/acme-health-staff-nurse/', 'screen']);
});
