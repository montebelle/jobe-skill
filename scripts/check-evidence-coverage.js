#!/usr/bin/env node
'use strict';

/**
 * Evidence -> library coverage check.
 *
 * The deterministic selector (lib/bullet-select.js + lib/tailor.js
 * rankEvidence) reads ONLY <workspace>/data/bullet-library.json. The narrative
 * evidence file (reference.md, or whatever evidence.ledger names in
 * data/profile.json) is never parsed by it. So a capability written up in the
 * evidence file but absent from the library is "trapped": the selector can
 * never surface it.
 *
 * This check reads the user's capability list (<workspace>/data/
 * evidence-anchors.json, optional, template: templates/
 * evidence-anchors.template.json) and flags every anchor with no matching
 * library bullet. Exit 1 on any gap, so it can gate evidence additions (add a
 * bullet OR the check fails). No anchors file, an empty one, or no library:
 * nothing to check, exit 0. A file that exists but is not valid JSON: exit 2.
 *
 *   node scripts/check-evidence-coverage.js            # human report
 *   node scripts/check-evidence-coverage.js --quiet    # only failures + summary
 *   node scripts/check-evidence-coverage.js --json     # machine readable
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('../lib/config');

// null when the file is absent. A file that is there but does not parse is an
// error (exit 2): a typo must never read as "nothing configured".
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`cannot parse ${file}: ${e.message}`); process.exit(2); }
}

function flattenBullets(lib) {
  const out = [];
  for (const role of Object.keys(lib || {})) {
    if (!Array.isArray(lib[role])) continue;
    for (const b of lib[role]) {
      if (!b) continue;
      const blob = ((b.text || '') + ' ' + (b.keywords || []).join(' ')).toLowerCase();
      out.push({ id: b.id, role, blob });
    }
  }
  return out;
}

// An anchor { id, section, terms[] } is covered when any bullet blob contains
// any of its terms (case insensitive substring).
function coverage(lib, anchors) {
  const bullets = flattenBullets(lib);
  return (anchors || []).filter((a) => a && a.id).map((a) => {
    const terms = (a.terms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
    const hits = bullets.filter((b) => terms.some((t) => b.blob.includes(t)));
    return { id: a.id, section: a.section, covered: hits.length > 0, hitCount: hits.length, hitIds: hits.slice(0, 4).map((h) => h.id) };
  });
}

function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const asJson = args.includes('--json');
  const root = getProjectRoot();

  const anchorDoc = readJson(path.join(root, 'data', 'evidence-anchors.json'));
  const anchors = anchorDoc && Array.isArray(anchorDoc.anchors) ? anchorDoc.anchors : [];
  const lib = readJson(path.join(root, 'data', 'bullet-library.json'));
  const skipped = !anchors.length
    ? 'no anchors configured (data/evidence-anchors.json is absent or empty); coverage gate skipped.'
    : !lib ? 'no bullet library (data/bullet-library.json is absent); coverage gate skipped.' : null;
  if (skipped) {
    if (asJson) process.stdout.write(JSON.stringify({ total: 0, covered: 0, gaps: 0, results: [] }, null, 2) + '\n');
    else console.log(skipped);
    process.exit(0);
  }

  const results = coverage(lib, anchors);
  const covered = results.filter((r) => r.covered);
  const gaps = results.filter((r) => !r.covered);

  if (asJson) {
    process.stdout.write(JSON.stringify({ total: results.length, covered: covered.length, gaps: gaps.length, results }, null, 2) + '\n');
  } else {
    if (!quiet) {
      for (const r of results) {
        const mark = r.covered ? 'OK  ' : 'GAP ';
        const detail = r.covered ? `(${r.hitCount} bullet${r.hitCount > 1 ? 's' : ''}: ${r.hitIds.join(', ')})` : '<-- NO LIBRARY BULLET; trapped in the evidence file';
        console.log(`${mark} ${String(r.id).padEnd(30)} ${detail}`);
      }
      console.log('');
    }
    if (gaps.length) {
      console.log('UNCOVERED (written up in the evidence file with no library bullet -> the selector cannot surface it):');
      for (const g of gaps) console.log(`  - ${g.id}  [${g.section || ''}]`);
      console.log('');
    }
    console.log(`Coverage: ${covered.length}/${results.length} anchors have at least 1 library bullet.` + (gaps.length ? `  ${gaps.length} GAP(S).` : '  All covered.'));
  }

  process.exit(gaps.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { flattenBullets, coverage };
