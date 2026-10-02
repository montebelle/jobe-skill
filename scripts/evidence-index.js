#!/usr/bin/env node
'use strict';

/**
 * Deterministic evidence fact index over the user's own work folders.
 *
 * A skill can read as a "gap" in a tailoring brief even though it is plainly
 * used in the user's own work, simply because no bullet or skills entry names
 * it. This script scans every project under the configured evidence roots for
 * the user's own vocabulary and writes one queryable index, so "does the
 * candidate have X?" becomes a lookup against every project instead of a guess.
 * lib/tailor.js tailorBrief() credits the index: a term proven there never
 * reads as a gap. The index only CREDITS evidence; it never strips a stated
 * skill.
 *
 * It is optional. It helps when the evidence is plain text (source code,
 * notes, markdown); a user with no such folders skips it and nothing changes.
 * A semantic code search tool can complement it; that is outside this script
 * and never required.
 *
 * WHAT IS LOOKED FOR (no shipped tool table decides this): the keywords of the
 * user's bullet library, the skills block of the resume baseline, and
 * evidence.tools[] in data/profile.json. An evidence.tools entry is a plain
 * name, or { name, match: ["regex source", ...], aliases: ["other spelling"] }
 * for a tool whose presence is proven by something other than its name.
 * Spelling variants are folded through TOOL_ALIAS (lib/tailor.js).
 *
 * WHERE: --roots a,b,c wins. Otherwise evidence.roots[] in data/profile.json
 * (a leading ~ expands to the home directory), plus JOBE_EVIDENCE_ROOTS (path
 * list), plus <workspace>/data/.evidence-corpus when it exists. No roots: the
 * script says so and exits 0 without writing anything.
 *
 * OUTPUT: <workspace>/data/evidence-index.json. It holds absolute paths and
 * README excerpts, so it is USER data and must stay out of version control.
 *
 *   node scripts/evidence-index.js build [--roots a,b,c]   # scan -> data/evidence-index.json
 *   node scripts/evidence-index.js has <tool>              # which projects have it (exit 1 if none)
 *   node scripts/evidence-index.js tools                   # every tool -> project count
 *   node scripts/evidence-index.js selftest                # the index file is well formed
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getProjectRoot } = require('../lib/config');
const { loadProfile } = require('../lib/profile');
const { TOOL_ALIAS, flattenSkillItems, canonicalSkill } = require('../lib/tailor');

const outFile = (root) => path.join(root, 'data', 'evidence-index.json');
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

function evidenceRoots(cliRoots, root = getProjectRoot()) {
  const listed = cliRoots
    ? cliRoots.split(',')
    : [
        ...loadProfile({ root }).evidence.roots,
        ...(process.env.JOBE_EVIDENCE_ROOTS || '').split(path.delimiter),
        path.join(root, 'data', '.evidence-corpus'),
      ];
  const roots = listed
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => path.resolve(expandHome(r.trim())));
  return [...new Set(roots)].filter((r) => fs.existsSync(r));
}

// Text file types worth reading, plus dependency manifests and READMEs by name.
// ponytail: plain text only. Office documents, PDFs, and spreadsheets are not
// read; export them to text (or keep notes beside them) to have them indexed.
const TEXT_EXT = new Set(['.py', '.js', '.ts', '.tsx', '.jsx', '.ipynb', '.go', '.rs', '.java', '.sql',
  '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.swift', '.kt', '.scala', '.r', '.m', '.sh',
  '.md', '.txt', '.rst']);
const SKIP_DIR = new Set(['node_modules', '.git', 'venv', '.venv', 'dist', 'build', '__pycache__',
  '.next', 'target', 'vendor', '.pytest_cache', 'site-packages', 'google-cloud-sdk']);
const SCAN_FILES = /^(requirements.*\.txt|pyproject\.toml|Pipfile|environment\.ya?ml|setup\.py|setup\.cfg|package\.json|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle.*|README.*|Dockerfile.*|.*\.tf|docker-compose.*)$/i;

// Words in any script: letters, marks, and digits (plus + and #) are kept.
const tokens = (s) => String(s).normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}\p{N}+#]+/u).filter(Boolean);
// ponytail: a term in a script written without spaces between words (or with
// particles attached to the word, as in Hangul) is matched as a plain
// substring, with no word boundary. Upgrade path: a word segmenter.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The user's own vocabulary: Map<key, { names: string[][], match: RegExp[] }>
 * plus the alias map to store in the index. `names` are token sequences; a
 * project has the tool when one sequence appears in a file (or a file name).
 * `skipped` lists the terms that cannot be searched for (too short).
 */
function vocabulary(root = getProjectRoot()) {
  const vocab = new Map();
  const aliases = {};
  const seen = new Set();
  const add = (name, match, extraAliases) => {
    const low = canonicalSkill(name);
    if (!low) return;
    const key = own(TOOL_ALIAS, low) ? TOOL_ALIAS[low] : low;
    seen.add(key);
    const spellings = [low, key,
      ...Object.keys(TOOL_ALIAS).filter((a) => TOOL_ALIAS[a] === key),
      ...(Array.isArray(extraAliases) ? extraAliases.map(canonicalSkill).filter(Boolean) : [])];
    for (const a of spellings) if (a !== key && !own(TOOL_ALIAS, a)) aliases[a] = key;
    const entry = vocab.get(key) || { names: [], match: [] };
    const pattern = (rx) => { if (!entry.match.some((m) => m.source === rx.source)) entry.match.push(rx); };
    for (const s of new Set(spellings)) {
      if (UNSPACED.test(s)) {
        // One character proves nothing as a substring (same reason as below).
        if ([...s].length > 1) pattern(new RegExp(escapeRe(s.normalize('NFC')).replace(/ /g, '\\s*'), 'iu'));
        continue;
      }
      const seq = tokens(s);
      // ponytail: a bare one or two letter word ("go", "r", "ai") matches far
      // too much text to prove anything, so it is only found through a longer
      // alias or an explicit evidence.tools match pattern.
      if (!seq.length || (seq.length === 1 && /^[a-z]{1,2}$/.test(seq[0]))) continue;
      if (!entry.names.some((n) => n.join(' ') === seq.join(' '))) entry.names.push(seq);
    }
    for (const src of Array.isArray(match) ? match : []) {
      try { pattern(new RegExp(src, 'i')); } catch { console.warn(`evidence.tools: ignoring invalid match pattern for "${name}": ${src}`); }
    }
    if (entry.names.length || entry.match.length) vocab.set(key, entry);
  };

  const lib = readJson(path.join(root, 'data', 'bullet-library.json')) || {};
  for (const bullets of Object.values(lib)) {
    if (!Array.isArray(bullets)) continue;
    for (const b of bullets) for (const k of (b && Array.isArray(b.keywords) ? b.keywords : [])) add(k);
  }
  const baseline = readJson(path.join(root, 'data', 'resume-baseline.json'));
  for (const s of flattenSkillItems(baseline && baseline.skills)) add(s);
  for (const t of loadProfile({ root }).evidence.tools) {
    if (typeof t === 'string') add(t);
    else if (t && typeof t.name === 'string') add(t.name, t.match, t.aliases);
  }
  return { vocab, aliases, skipped: [...seen].filter((k) => !vocab.has(k)) };
}

// A project is a folder under a root: a child that holds .git, or (for a
// grouping folder) each grandchild that holds .git, or the child itself when
// it is a plain folder. A root that holds .git, or holds only files, is one
// project by itself.
function listProjects(roots) {
  const projects = [];
  const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));
  const subdirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIR.has(e.name))
        .map((e) => path.join(dir, e.name));
    } catch { return []; }
  };
  for (const root of roots) {
    const children = subdirs(root);
    if (isRepo(root) || !children.length) { projects.push(root); continue; }
    for (const dir of children) {
      if (isRepo(dir)) { projects.push(dir); continue; }
      const nested = subdirs(dir).filter(isRepo);
      projects.push(...(nested.length ? nested : [dir]));
    }
  }
  return [...new Set(projects)];
}

// One walk per project (depth 5, files up to 5 MB, vendored folders skipped).
// Each readable file is reduced to its word sequence, the file name included,
// and tested against every vocabulary entry not yet found in this project.
function scanProject(dir, vocab) {
  const found = new Set();
  const files = {};
  const pending = new Map(vocab);
  (function walk(d, depth) {
    if (depth > 5) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT_EXT.has(ext)) files[ext] = (files[ext] || 0) + 1;
      else if (!SCAN_FILES.test(e.name)) continue;
      if (!pending.size) continue;
      let txt; try { if (fs.statSync(p).size > 5000000) continue; txt = fs.readFileSync(p, 'utf8').normalize('NFC'); } catch { continue; }
      const seq = tokens(e.name + ' ' + txt);
      const words = new Set(seq);
      const norm = ' ' + seq.join(' ') + ' ';
      for (const [key, entry] of pending) {
        const hit = entry.names.some((n) => words.has(n[0]) && (n.length === 1 || norm.includes(' ' + n.join(' ') + ' ')))
          || entry.match.some((rx) => rx.test(txt));
        if (hit) { found.add(key); pending.delete(key); }
      }
    }
  })(dir, 0);
  return { tools: [...found].sort(), files };
}

function readme(dir) {
  for (const n of ['README.md', 'readme.md', 'README.rst', 'README.txt']) {
    try { return fs.readFileSync(path.join(dir, n), 'utf8').slice(0, 1200); } catch {}
  }
  return '';
}

// Returns the index, or null when there is nothing to scan (and writes nothing).
function build(cliRoots, root = getProjectRoot()) {
  const roots = evidenceRoots(cliRoots, root);
  if (!roots.length) {
    console.log('no evidence roots configured; nothing indexed (set evidence.roots in data/profile.json, or pass --roots).');
    return null;
  }
  const { vocab, aliases, skipped } = vocabulary(root);
  if (skipped.length) console.log(`not searched (too short to prove anything by name; give it a longer alias or a match pattern in evidence.tools): ${skipped.join(', ')}`);
  if (!vocab.size) {
    console.log('no vocabulary to look for yet (bullet library keywords, baseline skills, and evidence.tools are all empty); nothing indexed.');
    return null;
  }
  const repos = [];
  const toolPresence = {};
  for (const dir of listProjects(roots)) {
    const { tools, files } = scanProject(dir, vocab);
    for (const tool of tools) (toolPresence[tool] ||= []).push(path.basename(dir));
    repos.push({ name: path.basename(dir), path: dir, files, tools, readme: readme(dir) });
  }
  const index = { generatedFrom: roots, repoCount: repos.length, toolPresence, aliases, repos };
  const out = outFile(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(index, null, 2));
  console.log(`indexed ${repos.length} project(s) from ${roots.length} root(s) -> ${path.relative(root, out)}`);
  console.log(`looked for ${vocab.size} term(s); found ${Object.keys(toolPresence).length}`);
  return index;
}

function load(root = getProjectRoot()) {
  const idx = readJson(outFile(root));
  if (!idx) { console.error('no index; run: node scripts/evidence-index.js build'); process.exit(2); }
  return idx;
}

function main() {
  const argv = process.argv.slice(2);
  const [cmd, arg] = argv;
  const rootsFlag = argv.includes('--roots') ? argv[argv.indexOf('--roots') + 1] : null;
  if (cmd === 'build') return void build(rootsFlag);
  if (cmd === 'has') {
    if (!arg) { console.error('usage: evidence-index.js has <tool>'); process.exit(2); }
    const idx = load();
    const aliases = { ...TOOL_ALIAS, ...(idx.aliases || {}) };
    const low = canonicalSkill(arg);
    const key = own(aliases, low) ? aliases[low] : low;
    const hits = (idx.toolPresence || {})[key] || [];
    console.log(hits.length ? `${arg}: ${hits.length} project(s) -> ${hits.join(', ')}` : `${arg}: NOT FOUND in the indexed evidence`);
    process.exit(hits.length ? 0 : 1);
  }
  if (cmd === 'selftest') {
    const idx = load();
    const bad = [];
    if (!Number.isInteger(idx.repoCount) || !Array.isArray(idx.repos) || idx.repos.length !== idx.repoCount) bad.push('repoCount does not match repos[]');
    if (!idx.toolPresence || typeof idx.toolPresence !== 'object') bad.push('toolPresence is missing');
    else for (const [t, r] of Object.entries(idx.toolPresence)) if (!Array.isArray(r) || !r.length) bad.push(`toolPresence.${t} is not a non-empty list`);
    console.log(bad.length ? 'FAIL: ' + bad.join('; ') : `OK: ${idx.repoCount} project(s), ${Object.keys(idx.toolPresence).length} tool(s)`);
    process.exit(bad.length ? 1 : 0);
  }
  if (cmd === 'tools') {
    const idx = load();
    Object.entries(idx.toolPresence || {}).sort((a, b) => b[1].length - a[1].length)
      .forEach(([t, r]) => console.log(`  ${t.padEnd(24)} ${r.length}`));
    return;
  }
  console.error('usage: evidence-index.js build [--roots a,b,c] | has <tool> | tools | selftest');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { build, evidenceRoots, vocabulary, listProjects, scanProject };
