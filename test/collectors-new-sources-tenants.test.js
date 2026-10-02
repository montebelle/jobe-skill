'use strict';
// lib/ats-tenants.js: where the per company ATS crawlers get their tenants
// (explicit slugs, the portals seed files, the workspace company index).
// Synthetic employers from two unrelated fields (health care, tax accounting).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-new-sources-tenants-'));
const write = (base, rel, body) => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
};
write(root, 'data/companies/portals.json', {
  $schema: 'notes are ignored',
  bamboohr: [{ slug: 'mercywest', name: 'Mercy West Health' }, 'Lakeside-Clinic'],
  personio: [{ sub: 'ledgerline-gmbh', company: 'Ledgerline' }],
  workable: ['bad/slug', 'evil.example.com', '', null, 42, { name: 'no slug' }],
});
write(root, 'data/companies/index.json', {
  'harbor-tax': { name: 'Harbor Tax Group', ats: 'recruitee', urls: [] },
  'northside-hospital': { name: 'Northside Hospital', ats: 'other', urls: ['https://northside.bamboohr.com/careers/42'] },
  'coastal-cpa': { name: 'coastal-cpa', ats: 'breezy', urls: ['https://coastal-cpa.breezy.hr/p/abc123'] },
  mercywest: { name: 'A Different Name', ats: 'bamboohr' },
  riverbend: { name: 'Riverbend Care', ats: 'breezy', breezySub: 'riverbend-care' },
  vendor: { name: 'Vendor Site', ats: 'other', urls: ['https://www.bamboohr.com/careers'] },
  greenhouse_co: { name: 'Other ATS', ats: 'greenhouse', urls: ['https://boards.greenhouse.io/otherats/jobs/1'] },
  junk: 'not an object',
});
process.env.JOBE_USER_ROOT = root;

const { loadTenants, prettify } = require('../lib/ats-tenants');

const sorted = (list) => [...list].sort((a, b) => a.slug.localeCompare(b.slug));

test('tenants are the union of the portals seed and the company index', () => {
  assert.deepEqual(sorted(loadTenants({ filters: {} }, 'bamboohr')), [
    { slug: 'lakeside-clinic', name: null },
    { slug: 'mercywest', name: 'Mercy West Health' },   // the pinned name beats the index name
    { slug: 'northside', name: 'Northside Hospital' },  // adopted from a URL on the ATS host
  ]);
  assert.deepEqual(loadTenants({ filters: {} }, 'personio'), [{ slug: 'ledgerline-gmbh', name: 'Ledgerline' }]);
  assert.deepEqual(sorted(loadTenants({ filters: {} }, 'breezy')), [
    { slug: 'coastal-cpa', name: null },                // a name equal to the key is a placeholder
    { slug: 'riverbend-care', name: 'Riverbend Care' },
  ]);
});

test('explicit slugs for one run come first and may pin a name', () => {
  const ctx = { filters: { atsSlugs: { recruitee: ['Summit-Books', { slug: 'harbor-tax', name: 'Harbor Tax (pinned)' }] } } };
  assert.deepEqual(loadTenants(ctx, 'recruitee'), [
    { slug: 'summit-books', name: null },
    { slug: 'harbor-tax', name: 'Harbor Tax (pinned)' },
  ]);
  // A pinned name that differs from the slug only by letter case is kept.
  const cased = { filters: { atsSlugs: { personio: [{ slug: 'ems', name: 'EMS' }, { slug: 'lakeside', name: 'lakeside' }] } } };
  assert.deepEqual(loadTenants(cased, 'personio').slice(0, 2), [{ slug: 'ems', name: 'EMS' }, { slug: 'lakeside', name: null }]);
  // Without the explicit entry the index supplies the same tenant.
  assert.deepEqual(loadTenants({ filters: {} }, 'recruitee'), [{ slug: 'harbor-tax', name: 'Harbor Tax Group' }]);
});

test('a slug that is not a plain label is refused', () => {
  // Slugs are interpolated into a hostname or path by the crawlers.
  assert.deepEqual(loadTenants({ filters: {} }, 'workable'), []);
  const hostile = { filters: { atsSlugs: { workable: ['evil.example.com/x', '../etc', 'a b', 'ok-tenant_1'] } } };
  assert.deepEqual(loadTenants(hostile, 'workable'), [{ slug: 'ok-tenant_1', name: null }]);
});

test('missing or malformed files give no tenants and never throw', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-new-sources-tenants-empty-'));
  write(empty, 'data/companies/portals.json', '{ not json');
  write(empty, 'data/companies/index.json', '[1, 2, 3]');
  process.env.JOBE_USER_ROOT = empty;
  try {
    for (const ats of ['workable', 'recruitee', 'breezy', 'bamboohr', 'personio']) {
      assert.deepEqual(loadTenants({ filters: {} }, ats), [], ats);
      assert.deepEqual(loadTenants(undefined, ats), [], ats);
      assert.deepEqual(loadTenants({ filters: { atsSlugs: { [ats]: 'not-a-list' } } }, ats), [], ats);
    }
  } finally {
    process.env.JOBE_USER_ROOT = root;
  }
});

test('prettify turns a slug into a display name', () => {
  assert.equal(prettify('mercy-west-health'), 'Mercy West Health');
  assert.equal(prettify('ledgerline'), 'Ledgerline');
  assert.equal(prettify(''), '');
});
