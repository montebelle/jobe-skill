'use strict';
/**
 * The dashboard keeps a TypeScript mirror of the report folder lifecycle
 * (web/src/lib/paths.ts). It cannot import lib/tracker-writer.js, so this
 * check fails when the two bucket lists drift, or when a dashboard module
 * grows a bucket list of its own again.
 *
 * ponytail: static source check, not a run of the TypeScript code (the web
 * app has its own dependencies and is not installed for `npm test`). Upgrade
 * path: a web side test runner once the dashboard has one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'data-templates-web-'));
process.on('exit', () => fs.rmSync(process.env.JOBE_USER_ROOT, { recursive: true, force: true }));

const WEB_LIB = path.join(__dirname, '..', 'web', 'src', 'lib');
const src = (name) => fs.readFileSync(path.join(WEB_LIB, name), 'utf8');
const listIn = (text, name) => {
  const m = text.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  assert.ok(m, `${name} not found`);
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
};

test('the dashboard bucket list equals LIFECYCLE_BUCKETS in lib/tracker-writer.js', () => {
  const { LIFECYCLE_BUCKETS } = require('../lib/tracker-writer');
  assert.deepStrictEqual(listIn(src('paths.ts'), 'LIFECYCLE_BUCKETS'), LIFECYCLE_BUCKETS);
});

test('the dashboard reads the same legacy bucket names as lib/tracker-writer.js', () => {
  const libText = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tracker-writer.js'), 'utf8');
  assert.deepStrictEqual(listIn(src('paths.ts'), 'LEGACY_BUCKETS'), listIn(libText, 'LEGACY_BUCKETS'));
});

test('the dashboard score bands are the ones configs/default.json sets', () => {
  const t = require('../configs/default.json').match_thresholds;
  const cuts = [...src('format.ts').matchAll(/score >= (\d+)\) return '(\w+)'/g)].map((m) => [m[2], Number(m[1])]);
  assert.deepStrictEqual(Object.fromEntries(cuts), { strong: t.strong, good: t.good, stretch: t.stretch });
});

test('report lookups and moves go through the one locator', () => {
  const data = src('data.ts');
  const writer = src('writer.ts');
  assert.match(data, /findReportDir\(slug: string\)[^{]*\{\s*return locateReportDir\(slug\);/);
  assert.match(writer, /import \{[^}]*\blocateReportDir\b[^}]*\} from '\.\/paths'/);
  assert.match(writer, /import \{[^}]*\bLIFECYCLE_BUCKETS\b[^}]*\} from '\.\/paths'/);
  // No module joins a bucket name onto the reports folder by itself.
  for (const [name, text] of [['data.ts', data], ['writer.ts', writer]]) {
    assert.ok(!/paths\.reports,\s*'[a-z-]+'/.test(text), `${name} hardcodes a bucket`);
    assert.ok(!/`reports\/\$\{slug\}/.test(text), `${name} assumes the flat reports/<slug>/ layout`);
  }
});

test('the dashboard honors the JOBE_USER_ROOT workspace override', () => {
  const paths = src('paths.ts');
  assert.match(paths, /process\.env\.JOBE_USER_ROOT/);
  assert.match(paths, /path\.isAbsolute/);
});
