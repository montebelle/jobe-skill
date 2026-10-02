#!/usr/bin/env node
/**
 * Manual posting ingest — feeds human-in-the-loop captures (e.g. the
 * /jobe linkedin-tab mode reading the user's open LinkedIn search via the
 * Chrome extension) into the same normalize -> dedup -> rank flow the
 * discovery pipeline uses.
 *
 * Usage:
 *   node collectors/ingest-manual.js <postings.json> [--source linkedin-tab] [--top 25]
 *   node collectors/ingest-manual.js <read_page-dump> --from-accessibility --source linkedin-search
 *
 * The second form parses a Chrome-extension read_page (filter:"all") dump of a
 * LinkedIn search results page directly (via lib/linkedin.parseSearchCards).
 * Excluded companies are dropped before ranking: the user's negative list,
 * plus the shared staffing list unless discovery.excludeStaffing is false in
 * data/profile.json (lib/exclusions.js, the same loader the pipeline uses).
 * Titles then pass the same gate as the pipeline: the user's title policy
 * (discovery.titleExclude / titleKeep) and target roles.
 *
 * Input file (first form): JSON array of raw postings:
 *   [{ "title": "...", "company": "...", "location": "...", "url": "...",
 *      "postedDate": "YYYY-MM-DD" | "3 days ago" | null, "jdText": "..." }]
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
const { parseSearchCards } = require('../lib/linkedin');
const { loadExclusions } = require('../lib/exclusions');
const { loadProfile, discoveryFilters } = require('../lib/profile');

loadEnv();
const ROOT = getProjectRoot();   // active user workspace

function parseArgs(argv) {
  const opts = { file: null, source: 'manual', top: 25, fromAccessibility: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--source') opts.source = args[++i];
    else if (a === '--top') opts.top = parseInt(args[++i], 10) || 25;
    // --from-accessibility: input is a Chrome-extension read_page (filter:"all")
    // dump of a LinkedIn search page, not a pre-built postings JSON array.
    else if (a === '--from-accessibility') opts.fromAccessibility = true;
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

  const fileText = fs.readFileSync(opts.file, 'utf8');
  let raw;
  if (opts.fromAccessibility) {
    // Parse a LinkedIn search results page captured via read_page (filter:"all").
    raw = parseSearchCards(fileText);
  } else {
    try {
      raw = JSON.parse(fileText);
    } catch (err) {
      console.error(`Could not parse ${opts.file}: ${err.message}`);
      process.exit(1);
    }
  }
  if (!Array.isArray(raw)) { console.error('Input must be a JSON array of postings'); process.exit(1); }

  const sourceId = `manual:${opts.source}`;
  const normalized = [];
  let skipped = 0;
  for (const r of raw) {
    const p = createPosting(r, sourceId);
    if (p) normalized.push(p); else skipped++;
  }

  // Same merge as the pipeline: one row per city unless the user's policy is
  // remote only, where one req listed in several places is one job.
  const byLocation = !discoveryFilters(loadProfile({ root: ROOT })).remoteOnly;
  const merged = dedup(normalized, { byLocation });

  // Drop staffing agencies / unwanted companies before role-matching, so the
  // staffing "Promoted" noise that dominates deep search pages never surfaces.
  const exclude = loadExclusions({ root: ROOT }).all;
  const kept = merged.filter(p => !exclude.has(p.companySlug));
  const excluded = merged.length - kept.length;

  const profile = buildProfile({ root: ROOT });
  for (const p of kept) quickScore(p, { profile }); // mutates p.quickScore in place

  const roleMatched = kept.filter(p => isRoleMatch(p.title, profile));
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(ROOT, 'signals', 'discovered', date);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `manual-${opts.source}.json`);
  // A later run for the same source on the same day MERGES into the file (a
  // paged sweep ingests one page per run; replacing lost every earlier page).
  let earlier = [];
  try { earlier = JSON.parse(fs.readFileSync(outPath, 'utf8')).postings || []; } catch { /* first run */ }
  const union = earlier.length ? dedup([...earlier, ...roleMatched], { byLocation }) : roleMatched;
  union.sort((a, b) => (b.quickScore || 0) - (a.quickScore || 0));
  const top = union.slice(0, opts.top + earlier.length);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), source: sourceId, count: top.length, postings: top }, null, 2));

  console.log(`ingested ${raw.length} raw -> ${normalized.length} valid (${skipped} skipped) -> ${merged.length} after dedup -> ${excluded} staffing/excluded dropped -> ${roleMatched.length} role-matched`);
  console.log(`wrote top ${top.length} to ${path.relative(ROOT, outPath)}`);
  console.log('');
  for (const p of top.slice(0, 15)) {
    console.log(`  [${String(p.quickScore ?? '?').padStart(3)}] ${p.company} — ${p.title} (${p.remote}/${p.us}) ${p.canonicalUrl}`);
  }
}

if (require.main === module) main();

module.exports = { main, parseArgs };
