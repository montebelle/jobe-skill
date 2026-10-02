'use strict';
// lib/config.js: the JOBE_USER_ROOT override and the relaxed config check, plus
// the shipped configs/default.json shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-foundation-config-'));
process.env.JOBE_USER_ROOT = TMP;
delete process.env.JOBE_CONFIG;
const config = require('../lib/config');

test('JOBE_USER_ROOT overrides the workspace root, not the system root', () => {
  assert.equal(config.getUserRoot(), TMP);
  assert.equal(config.getProjectRoot(), TMP);
  assert.equal(config.getSystemRoot(), path.resolve(__dirname, '..'));
  assert.notEqual(config.getSystemRoot(), TMP);
});

test('JOBE_USER_ROOT beats JOBE_USER and falls away when unset', () => {
  const saved = { root: process.env.JOBE_USER_ROOT, user: process.env.JOBE_USER };
  try {
    process.env.JOBE_USER = 'synthetic-nurse';
    assert.equal(config.getUserRoot(), TMP);
    delete process.env.JOBE_USER_ROOT;
    assert.equal(config.getUserRoot(), path.join(config.getUsersDir(), 'synthetic-nurse'));
  } finally {
    process.env.JOBE_USER_ROOT = saved.root;
    if (saved.user === undefined) delete process.env.JOBE_USER; else process.env.JOBE_USER = saved.user;
  }
});

test('a relative JOBE_USER_ROOT is an error, never a fall through to real data', () => {
  process.env.JOBE_USER_ROOT = 'some/relative/dir';
  try {
    assert.throws(() => config.getUserRoot(), /absolute path/);
    assert.throws(() => config.getProjectRoot(), /absolute path/);
  } finally {
    process.env.JOBE_USER_ROOT = TMP;
  }
});

test('the shipped default config loads without any personal block', () => {
  const shipped = path.join(config.getSystemRoot(), 'configs', 'default.json');
  const raw = JSON.parse(fs.readFileSync(shipped, 'utf8'));
  assert.equal('candidate' in raw, false);
  assert.equal('company' in raw, false);
  assert.equal('company_tiers' in raw, false);
  assert.deepEqual(
    [raw.match_thresholds.strong, raw.match_thresholds.good, raw.match_thresholds.stretch],
    [80, 65, 55],
  );
  assert.ok(raw.api_keys);

  const cfg = config.getConfig(shipped);
  assert.equal(cfg.output_dir, path.join(TMP, 'signals', 'snapshots'));
  assert.equal(cfg.report_dir, path.join(TMP, 'reports'));
  assert.deepEqual(config.checkRequiredKeys(), []);
});

test('getConfig accepts any JSON object and rejects everything else', () => {
  const empty = path.join(TMP, 'empty.json');
  fs.writeFileSync(empty, '{}');
  assert.equal(config.getConfig(empty).report_dir, path.join(TMP, 'reports'));

  const list = path.join(TMP, 'list.json');
  fs.writeFileSync(list, '[]');
  assert.throws(() => config.getConfig(list), /JSON object/);
  assert.throws(() => config.getConfig(path.join(TMP, 'absent.json')), /Config not found/);
});
