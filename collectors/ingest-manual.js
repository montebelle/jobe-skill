#!/usr/bin/env node
/**
 * Manual posting ingest — feeds human-in-the-loop captures (e.g. the
 * /jobe linkedin-tab mode reading the user's open LinkedIn search via the
 * Chrome extension) into the same normalize -> dedup -> rank flow the
 * discovery pipeline uses.
 *
 * Usage:
 *   node collectors/ingest-manual.js <postings.json> [--source linkedin-tab] [--top 25]
 *
 * Input file: JSON array of raw postings:
 *   [{ "title": "...", "company": "...", "location": "...", "url": "...",
 *      "postedDate": "2026-06-01" | "3 days ago" | null, "jdText": "..." }]
 *
 * Output: signals/discovered/{YYYY-MM-DD}/manual-{source}.json (ranked),
 * plus a console summary. Postings then flow into evaluate/batch like any
 * pipeline output. No login automation anywhere — the human captured the
 * page; this script only structures and ranks what they captured.
 */

const fs = require('fs');
const path = require('path');

const { loadEnv, getProjectRoot } = require('../lib/config');
const { createPosting } = require('../lib/posting');
const { dedup } = require('../lib/dedup');
const { buildProfile, quickScore, isRoleMatch } = require('../lib/rank');

loadEnv();
const ROOT = getProjectRoot();

function parseArgs(argv) {
  const opts = { file: null, source: 'manual', top: 25 };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source') opts.source = args[++i];
    else if (a === '--top') opts.top = parseInt(args[++i], 10) || 25;
    else if (!a.startsWith('--')) opts.file = a;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv);
  if (!opts.file || !fs.existsSync(opts.file)) {
    console.error('Usage: node collectors/ingest-manual.js <postings.json> [--source linkedin-tab] [--top 25]');
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
  } catch (err) {
    console.error(`Could not parse ${opts.file}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(raw)) { console.error('Input must be a JSON array of postings'); process.exit(1); }

  const sourceId = `manual:${opts.source}`;
  const normalized = [];
  let skipped = 0;
  for (const r of raw) {
    const p = createPosting(r, sourceId);
    if (p) normalized.push(p); else skipped++;
  }

  const merged = dedup(normalized);
  const profile = buildProfile({ root: ROOT });
  for (const p of merged) quickScore(p, { profile }); // mutates p.quickScore in place

  const roleMatched = merged.filter(p => isRoleMatch(p.title, profile));
  roleMatched.sort((a, b) => (b.quickScore || 0) - (a.quickScore || 0));
  const top = roleMatched.slice(0, opts.top);

  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(ROOT, 'signals', 'discovered', date);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `manual-${opts.source}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), source: sourceId, count: top.length, postings: top }, null, 2));

  console.log(`ingested ${raw.length} raw -> ${normalized.length} valid (${skipped} skipped) -> ${merged.length} after dedup -> ${roleMatched.length} role-matched`);
  console.log(`wrote top ${top.length} to ${path.relative(ROOT, outPath)}`);
  console.log('');
  for (const p of top.slice(0, 15)) {
    console.log(`  [${String(p.quickScore ?? '?').padStart(3)}] ${p.company} — ${p.title} (${p.remote}/${p.us}) ${p.canonicalUrl}`);
  }
}

main();
