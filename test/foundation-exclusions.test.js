'use strict';
// lib/exclusions.js: the user negative list, the shared staffing list, and the
// excludeStaffing gate. Synthetic company names only; every workspace is a
// JOBE_USER_ROOT style temp directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function workspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-foundation-exclusions-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

process.env.JOBE_USER_ROOT = workspace();
const { getSystemRoot } = require('../lib/config');
const { companySlug } = require('../lib/posting');
const { loadExclusions } = require('../lib/exclusions');

const NEGATIVE = 'data/companies/negative-list.json';
const STAFFING = 'data/companies/staffing-list.json';
const PROFILE = 'data/profile.json';

function systemStaffing() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(getSystemRoot(), STAFFING), 'utf8'));
    return (j.companySlugs || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  } catch { return []; }
}

test('an empty workspace has no negative list and the shared staffing list', () => {
  const x = loadExclusions();
  assert.equal(x.negative.size, 0);
  assert.deepEqual([...x.staffing].sort(), [...new Set(systemStaffing())].sort());
  assert.deepEqual([...x.all].sort(), [...x.staffing].sort());
});

test('the negative list comes from the workspace, trimmed and lowercased', () => {
  const root = workspace({ [NEGATIVE]: { companySlugs: [' Northside-Clinic ', 'harbor-tax-group', '', 42, null] } });
  const x = loadExclusions({ root });
  assert.deepEqual([...x.negative].sort(), ['harbor-tax-group', 'northside-clinic']);
  // Entries line up with the slug every posting carries.
  assert.ok(x.all.has(companySlug('Northside Clinic')));
  assert.ok(x.all.has(companySlug('Harbor Tax Group')));
  for (const s of systemStaffing()) assert.ok(x.all.has(s));
});

test('a workspace staffing list is unioned with the shared one', () => {
  const root = workspace({ [STAFFING]: { companySlugs: ['temp-shift-agency'] } });
  const x = loadExclusions({ root });
  assert.ok(x.staffing.has('temp-shift-agency'));
  assert.ok(x.all.has('temp-shift-agency'));
  assert.equal(x.negative.has('temp-shift-agency'), false);
  for (const s of systemStaffing()) assert.ok(x.staffing.has(s));
});

test('excludeStaffing false leaves only the negative list', () => {
  const files = {
    [NEGATIVE]: { companySlugs: ['harbor-tax-group'] },
    [STAFFING]: { companySlugs: ['temp-shift-agency'] },
  };
  const x = loadExclusions({ root: workspace(files), excludeStaffing: false });
  assert.equal(x.staffing.size, 0);
  assert.deepEqual([...x.all], ['harbor-tax-group']);
});

test('the gate defaults to the profile and an explicit argument wins', () => {
  const files = {
    [STAFFING]: { companySlugs: ['temp-shift-agency'] },
    [PROFILE]: { discovery: { excludeStaffing: false } },
  };
  assert.equal(loadExclusions({ root: workspace(files) }).staffing.size, 0);
  assert.ok(loadExclusions({ root: workspace(files), excludeStaffing: true }).staffing.has('temp-shift-agency'));
});

test('malformed or oddly shaped files are empty lists, never errors', () => {
  for (const body of ['{ not json', '[]', '{"companySlugs": "northside-clinic"}', 'null']) {
    const x = loadExclusions({ root: workspace({ [NEGATIVE]: body }), excludeStaffing: false });
    assert.equal(x.all.size, 0, body);
  }
});
