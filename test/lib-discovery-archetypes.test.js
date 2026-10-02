'use strict';
// lib/archetypes.js lookup order (workspace data/, then workspace configs/,
// then the system default) and lib/patterns.js reading bucket names from the
// user's own taxonomy. Synthetic fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function workspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-discovery-archetypes-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const NURSE_BUCKETS = {
  $comment: 'synthetic registered nurse taxonomy',
  'Acute Care': { keywords: ['icu', 'triage', 'telemetry'], portfolioDomains: ['A1'] },
  'Community / Outreach': { keywords: ['outreach', 'home visit'] },
};
const row = (i, status, notes) => `| ${i} | 2000-01-0${i} | Example Health ${i} | Registered Nurse | 70 | ${status} | - | ${notes} |`;

const root = workspace({
  'data/archetypes.json': NURSE_BUCKETS,
  'configs/archetypes.json': { 'Older Location': { keywords: ['icu'] } },
  'data/tracker.md': [
    '# Application Tracker', '',
    '| # | Date | Company | Role | Score | Status | Resume | Notes |',
    '|---|------|---------|------|-------|--------|--------|-------|',
    row(1, 'Applied', 'archetype: Acute Care'),
    row(2, 'Responded', 'Acute Care, night shift'),
    row(3, 'Interviewing', 'community role, strong fit'),
    row(4, 'Skipped', 'Community / Outreach'),
    row(5, 'Applied', 'Some Bucket Nobody Defined'),
    row(6, 'Applied', 'no bucket noted'),
    '',
  ].join('\n'),
});
process.env.JOBE_USER_ROOT = root;

const { ARCHETYPES, detectArchetype, loadTaxonomy } = require('../lib/archetypes');
const { analyzePatterns, archetypeMatchers } = require('../lib/patterns');

test('workspace data/archetypes.json wins; notes keys are not buckets', () => {
  assert.deepEqual(Object.keys(ARCHETYPES), ['Acute Care', 'Community / Outreach']);
  assert.deepEqual(Object.keys(loadTaxonomy(root)), ['Acute Care', 'Community / Outreach']);
});

test('workspace configs/archetypes.json is the fallback; nothing ships by default', () => {
  const older = workspace({ 'configs/archetypes.json': { 'Corporate Tax': { keywords: ['corporate return'] } } });
  assert.deepEqual(Object.keys(loadTaxonomy(older)), ['Corporate Tax']);

  const { getSystemRoot } = require('../lib/config');
  const systemFile = path.join(getSystemRoot(), 'configs', 'archetypes.json');
  assert.equal(fs.existsSync(systemFile), false, 'no taxonomy ships with the code');
  assert.deepEqual(loadTaxonomy(workspace()), {});
  assert.deepEqual(loadTaxonomy(workspace({ 'data/archetypes.json': '{ not json' })), {});
});

test('detectArchetype uses the user buckets and falls back to General', () => {
  const hit = detectArchetype('ICU triage nurse for a telemetry unit, some outreach.');
  assert.equal(hit.primary, 'Acute Care');
  assert.equal(hit.secondary, 'Community / Outreach');
  assert.deepEqual(hit.portfolioDomains, ['A1']);
  const outreach = detectArchetype('Home visit and outreach coordinator.');
  assert.equal(outreach.primary, 'Community / Outreach');
  assert.deepEqual(outreach.portfolioDomains, []);
  assert.equal(detectArchetype('Prepare partnership tax returns.').primary, 'General');
  assert.equal(detectArchetype(undefined).primary, 'General');
});

test('patterns counts the user\'s own bucket names, by full name or by the head of a "Head / Tail" name', () => {
  const result = analyzePatterns();
  assert.equal(result.insufficient, false);
  assert.deepEqual(result.archetypePerformance.counts, { 'Acute Care': 2, 'Community / Outreach': 2 });
  assert.deepEqual(result.archetypePerformance.successes, { 'Acute Care': 1, 'Community / Outreach': 1 });
});

test('no taxonomy means no archetype analysis', () => {
  assert.deepEqual(archetypeMatchers({}), []);
  const m = archetypeMatchers({ 'Corporate Tax': {}, 'Audit (External)': {} });
  assert.equal(m.find((x) => x.re.test('fit: audit (external) team')).name, 'Audit (External)');
  assert.equal(m.find((x) => x.re.test('incorporate taxes')), undefined, 'whole phrase only');
});
