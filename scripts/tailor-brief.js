#!/usr/bin/env node
/**
 * Emit the JD-grounded tailoring brief for a posting (the deterministic half of
 * resume tailoring). The LLM generator (modes/evaluate.md Block E) consumes
 * this, then reframes real evidence into the JD's language.
 *
 * Usage:
 *   node scripts/tailor-brief.js <jd.txt|posting.json>
 *   node scripts/tailor-brief.js --url <canonicalUrl>   # look up in today's ranked-enriched
 */
const fs = require('fs');
const path = require('path');
const { tailorBrief } = require('../lib/tailor');
const { getProjectRoot } = require('../lib/config');

const ROOT = getProjectRoot();
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'resume-baseline.json'), 'utf8'));

function jdFromArgs(argv) {
  const a = argv.slice(2);
  if (a[0] === '--url') {
    const url = a[1];
    // Scan the most recent discovery folders (newest first) for the posting,
    // so this works regardless of which day the run was saved.
    const base = path.join(ROOT, 'signals', 'discovered');
    const days = fs.existsSync(base)
      ? fs.readdirSync(base).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
      : [];
    for (const d of days) {
      const f = path.join(base, d, 'ranked-enriched.json');
      if (!fs.existsSync(f)) continue;
      const post = JSON.parse(fs.readFileSync(f, 'utf8')).find(p => p.canonicalUrl === url);
      if (post) return post.jdText || '';
    }
    throw new Error('url not found in any discovered ranked-enriched.json: ' + url);
  }
  const p = a[0];
  if (!p || !fs.existsSync(p)) throw new Error('usage: tailor-brief.js <jd.txt|posting.json> | --url <canonicalUrl>');
  const raw = fs.readFileSync(p, 'utf8');
  try { const j = JSON.parse(raw); return j.jdText || j.description || raw; } catch { return raw; }
}

const brief = tailorBrief(jdFromArgs(process.argv), baseline);
// compact, human + LLM readable
console.log('ARCHETYPE:', brief.jd.archetype, '| seniority:', brief.jd.seniority);
console.log('TOP JD KEYWORDS:', brief.jd.keywords.slice(0, 14).map(k => `${k.term}(${k.count})`).join(', '));
console.log('STACK:', brief.jd.stack.join(', ') || '(none detected)');
console.log('\nRESPONSIBILITIES (mirror these):');
brief.jd.responsibilities.forEach(r => console.log('  - ' + r));
console.log('\nQUALIFICATIONS:');
brief.jd.qualifications.forEach(q => console.log('  - ' + q));
console.log('\nEVIDENCE RANKED BY JD FIT (reframe these; do not emit verbatim):');
for (const role of Object.keys(brief.evidenceByRole)) {
  const top = brief.evidenceByRole[role].filter(e => e.score > 0).slice(0, 4);
  if (top.length) console.log(`  [${role}] ` + top.map(e => `${e.id}{${e.matched.slice(0, 5).join(',')}}`).join('  '));
}
console.log('\nHONEST GAPS (position adjacency, do not fabricate):', brief.coverage.gaps.join(', ') || 'none');
console.log('\nGENERATOR CHECKLIST:');
brief.checklist.forEach(c => console.log('  [ ] ' + c));
