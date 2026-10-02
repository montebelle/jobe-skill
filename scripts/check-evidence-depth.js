#!/usr/bin/env node
'use strict';

/**
 * Evidence DEPTH gate.
 *
 * check-evidence-coverage.js verifies a capability HAS a bullet. This verifies
 * the bullet is DEEP: at least one bullet about a major body of work names HOW
 * it works (the method, technique, protocol, or process), not only its size or
 * outcome. Two examples of the failure it catches:
 *   scale only : "a shift scheduling system used by 12 clinics"
 *   method     : "constraint based shift assignment with a fairness cap"
 *   scale only : "reviewed 340 client returns in one filing season"
 *   method     : "a three way reconciliation of ledger, bank feed, and receipts"
 * The scale only bullet passes coverage but reads shallow. This gate flags it.
 *
 * For each entry in <workspace>/data/evidence-depth.json (optional user file,
 * template: templates/evidence-depth.template.json):
 *   - `match`      finds the bullets about it (text + keywords contain any term)
 *   - `mechanisms` are method level terms at least one matched bullet MUST contain
 * An entry with matched bullets but ZERO mechanism terms is SHALLOW -> exit 1.
 * An entry with no matched bullets is skipped (coverage's job, not depth's).
 * No depth file, or an empty one: nothing to check, exit 0. A depth file or
 * bullet library that exists but is not valid JSON: exit 2.
 *
 *   node scripts/check-evidence-depth.js                  # whole bullet library
 *   node scripts/check-evidence-depth.js --resume <json>  # one resume JSON
 *   node scripts/check-evidence-depth.js --json           # machine readable
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('../lib/config');

const dataFile = (name) => path.join(getProjectRoot(), 'data', name);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The CLI reading: null when the file is absent, exit 2 when it is there but
// does not parse, so a typo never reads as "nothing configured".
function readJsonOrDie(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`cannot parse ${file}: ${e.message}`); process.exit(2); }
}

const bulletText = (b) => (typeof b === 'string' ? b : (b && b.text) || '');

function flattenBullets(lib) {
  const out = [];
  for (const role of Object.keys(lib || {})) {
    if (!Array.isArray(lib[role])) continue;
    for (const b of lib[role]) {
      if (!b) continue;
      out.push({ id: b.id, blob: ((b.text || '') + ' ' + (b.keywords || []).join(' ')).toLowerCase() });
    }
  }
  return out;
}

// Resume-level depth: flatten summary + every rendered bullet (experience +
// selectedProjects) into pseudo-bullets, then run the SAME match/mechanism test.
// This catches the real failure: a resume that names a major body of work but
// only at scale/outcome, never its method.
function flattenResume(resume) {
  const out = [];
  if (resume.summary) out.push({ id: 'summary', blob: String(resume.summary).toLowerCase() });
  for (const exp of resume.experience || []) {
    for (const b of exp.bullets || []) out.push({ id: (exp.company || '') + '-bullet', blob: bulletText(b).toLowerCase() });
  }
  for (const p of resume.selectedProjects || []) {
    if (p) out.push({ id: 'project:' + (p.name || ''), blob: String(p.summary || '').toLowerCase() });
  }
  return out;
}

function evaluate(bullets, systems) {
  return (systems || []).map((s) => {
    const match = (s.match || []).map((t) => String(t).toLowerCase());
    const mech = (s.mechanisms || []).map((t) => String(t).toLowerCase());
    const matched = bullets.filter((b) => match.some((t) => b.blob.includes(t)));
    if (!matched.length) return { id: s.id, status: 'absent', deepIds: [] };
    const deep = matched.filter((b) => mech.some((t) => b.blob.includes(t)));
    return { id: s.id, status: deep.length ? 'deep' : 'shallow', matchedCount: matched.length, deepIds: deep.slice(0, 4).map((d) => d.id) };
  });
}

// [] when the user has no depth file (or it is malformed): the gate is a no-op.
// The CLI passes its own strict reading of the file.
function loadSystems(doc = readJson(dataFile('evidence-depth.json'))) {
  return doc && Array.isArray(doc.systems) ? doc.systems.filter((s) => s && s.id) : [];
}

function main() {
  const asJson = process.argv.includes('--json');
  const resumeFlag = process.argv.indexOf('--resume');
  const systems = loadSystems(readJsonOrDie(dataFile('evidence-depth.json')));

  if (!systems.length) {
    if (asJson) process.stdout.write(JSON.stringify({ deep: 0, shallow: [], absent: 0, results: [] }, null, 2) + '\n');
    else console.log('no systems configured (data/evidence-depth.json is absent or empty); depth gate skipped.');
    process.exit(0);
  }

  // --resume <path>: gate ONE resume. An entry it references but keeps shallow fails.
  if (resumeFlag >= 0) {
    const resumePath = process.argv[resumeFlag + 1];
    const resume = resumePath && readJson(resumePath);
    if (!resume) { console.error(`cannot read resume JSON: ${resumePath || '(no path given)'}`); process.exit(2); }
    const results = evaluate(flattenResume(resume), systems).filter((r) => r.status !== 'absent');
    const shallow = results.filter((r) => r.status === 'shallow');
    if (asJson) { process.stdout.write(JSON.stringify({ shallow: shallow.map((s) => s.id), deep: results.filter((r) => r.status === 'deep').map((d) => d.id) }, null, 2) + '\n'); }
    else {
      for (const r of results) console.log(`${r.status === 'deep' ? 'DEEP   ' : 'SHALLOW'} ${r.id}` + (r.status === 'shallow' ? '  <-- referenced but no method or mechanism named; select/reframe the deep bullet' : ''));
      console.log(shallow.length ? `\n${shallow.length} item(s) shallow in this resume.` : '\nEvery referenced item names its method.');
    }
    process.exit(shallow.length ? 1 : 0);
  }

  const lib = readJsonOrDie(dataFile('bullet-library.json'));
  if (!lib) {
    console.log('no bullet library (data/bullet-library.json is absent); depth gate skipped.');
    process.exit(0);
  }
  const results = evaluate(flattenBullets(lib), systems);

  const shallow = results.filter((r) => r.status === 'shallow');
  const deep = results.filter((r) => r.status === 'deep');
  const absent = results.filter((r) => r.status === 'absent');

  if (asJson) {
    process.stdout.write(JSON.stringify({ deep: deep.length, shallow: shallow.length, absent: absent.length, results }, null, 2) + '\n');
  } else {
    for (const r of results) {
      const mark = r.status === 'deep' ? 'DEEP   ' : r.status === 'shallow' ? 'SHALLOW' : 'absent ';
      const detail = r.status === 'deep' ? `(method named: ${r.deepIds.join(', ')})`
        : r.status === 'shallow' ? `<-- ${r.matchedCount} bullet(s) about it, NONE name the method or mechanism`
        : '(no bullet yet: coverage gate, not depth)';
      console.log(`${mark} ${String(r.id).padEnd(28)} ${detail}`);
    }
    console.log('');
    if (shallow.length) {
      console.log('SHALLOW (bullets exist but describe scale/outcome, not the method; deepen from the source material):');
      for (const s of shallow) console.log(`  - ${s.id}`);
      console.log('');
    }
    console.log(`Depth: ${deep.length}/${deep.length + shallow.length} present items name their method.` + (shallow.length ? `  ${shallow.length} SHALLOW.` : '  All deep.'));
  }
  process.exit(shallow.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { evaluate, flattenBullets, flattenResume, loadSystems };
