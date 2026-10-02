'use strict';
// Docs drift check. The documents state facts about the code (how many source
// plugins, which lifecycle buckets, the profile shape, which files exist).
// Each test reads the fact from the code and fails when a document no longer
// says the same thing, so a stale claim cannot ship.
//
// No network, nothing written. The workspace is an empty temp directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-facts-'));

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DOCS = {
  readme: 'README.md',
  architecture: 'ARCHITECTURE.md',
  contract: 'DATA_CONTRACT.md',
  claude: '.claude/CLAUDE.md',
  sources: 'docs/discovery-sources.md',
  evidence: 'docs/evidence-retrieval-layer.md',
};
const text = Object.fromEntries(Object.entries(DOCS).map(([k, rel]) => [k, read(rel)]));

const { loadSources } = require('../collectors/pipeline');
const { LIFECYCLE_BUCKETS } = require('../lib/tracker-writer');
const { DEFAULTS } = require('../lib/profile');

const jsIn = (rel) => fs.readdirSync(path.join(ROOT, rel)).filter((f) => f.endsWith('.js'));

test('source count and every source id match the plugin registry', () => {
  const sources = loadSources();
  const n = sources.length;
  assert.ok(n > 0);
  for (const key of ['readme', 'architecture', 'contract', 'claude', 'sources']) {
    assert.match(text[key], new RegExp(`\\b${n} (source plugins|plugins|sources)\\b`),
      `${DOCS[key]} must state the real source count (${n})`);
  }
  for (const s of sources) {
    for (const key of ['sources', 'claude']) {
      assert.ok(text[key].includes('`' + s.id + '`'), `${DOCS[key]} does not list source id ${s.id}`);
    }
  }
  // Per folder counts, as stated in the coverage map.
  const count = (dir) => jsIn(path.join('collectors', 'sources', dir)).length;
  const stated = `${count('aggregators')} aggregators, ${count('company-specific')} company specific, `
    + `${count('ats-directories')} ATS directory, ${count('ats-direct')} ATS direct`;
  for (const key of ['sources', 'contract']) {
    assert.ok(text[key].includes(stated), `${DOCS[key]} must say "${stated}"`);
  }
});

test('lifecycle buckets in the docs are the ones the code exports', () => {
  for (const key of ['architecture', 'contract', 'claude']) {
    for (const b of LIFECYCLE_BUCKETS) {
      assert.ok(text[key].includes('`' + b + '`'), `${DOCS[key]} does not name the ${b} bucket`);
    }
  }
});

test('the profile shape printed in DATA_CONTRACT.md equals lib/profile.js DEFAULTS', () => {
  const after = text.contract.split('## The profile file')[1] || '';
  const block = (after.match(/```json\n([\s\S]*?)```/) || [])[1];
  assert.ok(block, 'DATA_CONTRACT.md has no json block under "The profile file"');
  assert.deepEqual(JSON.parse(block), DEFAULTS);
});

test('module and list counts stated in the docs match the tree', () => {
  const lib = jsIn('lib').length;
  const apply = jsIn(path.join('lib', 'apply')).length;
  assert.ok(text.contract.includes('`lib/*.js` (' + lib + ' modules)'), `DATA_CONTRACT.md: lib module count is ${lib}`);
  assert.ok(text.contract.includes('`lib/apply/*.js` (' + apply + ' modules)'), `DATA_CONTRACT.md: lib/apply module count is ${apply}`);
  assert.ok(text.claude.includes('`lib/` modules (' + lib + ')'), `.claude/CLAUDE.md: lib module count is ${lib}`);
  assert.ok(text.claude.includes('`lib/apply/` modules (' + apply + ')'), `.claude/CLAUDE.md: lib/apply module count is ${apply}`);

  const staffing = JSON.parse(read('data/companies/staffing-list.json')).companySlugs.length;
  for (const key of ['readme', 'contract', 'claude']) {
    assert.match(text[key], new RegExp(`\\b${staffing} (staffing )?agency and broker slugs`),
      `${DOCS[key]} must state the staffing list size (${staffing})`);
  }
});

test('every script is named in the project guidance', () => {
  for (const f of jsIn('scripts')) {
    assert.ok(text.claude.includes('`' + f + '`') || text.claude.includes('`scripts/' + f + '`'),
      `.claude/CLAUDE.md does not mention scripts/${f}: add it to the script list there and in README.md`);
  }
});

test('every repo path the docs name exists', () => {
  // A backticked path under a shipped folder. Paths with a placeholder, a
  // glob, or a brace set are shapes, not files.
  const PATH_RE = /`((?:lib|scripts|collectors|templates|configs|docs|test|web|\.claude)\/[A-Za-z0-9_./-]+\.(?:js|json|md|sh|ts))`/g;
  // Named on purpose although absent from a fresh clone: an optional install
  // wide file, older locations of personal files that migrate moves, and the
  // harness's own untracked local settings file.
  const OPTIONAL = new Set(['configs/archetypes.json', 'configs/apply-profile.json', '.claude/skills/jobe/modes/_profile.md', '.claude/settings.local.json']);
  const missing = [];
  for (const [key, body] of Object.entries(text)) {
    for (const m of body.matchAll(PATH_RE)) {
      const rel = m[1];
      if (OPTIONAL.has(rel)) continue;
      if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`${DOCS[key]}: ${rel}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('SKILL Step 0 takes the code root from Jobe marker files, not from any Node project', () => {
  const skill = read('.claude/skills/jobe/SKILL.md');
  const line = skill.split('\n').find((l) => l.includes('JOBE_HOME="$(pwd)"'));
  assert.ok(line, 'SKILL.md Step 0 no longer sets JOBE_HOME from the current folder');
  const { spawnSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-home-'));
  const run = (cwd) => spawnSync('bash', ['-c', `${line}\necho "$JOBE_HOME"`], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home } }).stdout.trim();
  // An unrelated Node project: package.json and lib/, nothing of Jobe.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-otherproj-'));
  fs.writeFileSync(path.join(other, 'package.json'), '{}');
  fs.mkdirSync(path.join(other, 'lib'));
  assert.equal(run(other), path.join(home, '.jobe'));
  assert.equal(fs.realpathSync(run(ROOT)), fs.realpathSync(ROOT));
});

test('the cover letter examples in _shared.md pass the gate they illustrate', () => {
  const { auditCoverLetter } = require('../lib/tailor');
  const shared = read('.claude/skills/jobe/modes/_shared.md');
  const bar = shared.split('### Cover Letter Quality Bar')[1].split('\n---')[0];
  const items = bar.split('\n').filter((l) => /^[123]\. \*\*/.test(l)).map((l) => [...l.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.equal(items.length, 3);
  const [outcomes, leadership, decisions] = items;
  assert.ok(outcomes.length && leadership.length && decisions.length, 'each element needs a quoted example');
  // Every combination of one example per element must clear the bar.
  for (const o of outcomes) for (const l of leadership) for (const d of decisions) {
    const res = auditCoverLetter(`${o}. ${l}. ${d}.`);
    assert.deepEqual(res.issues, [], `"${o}" + "${l}" + "${d}"`);
  }
});

test('batch.md gives the follow up workflows their required root and workspace', () => {
  const batch = read('.claude/skills/jobe/modes/batch.md');
  const line = batch.split('\n').find((l) => l.includes('wf-recenter-batch.js') && l.includes('wf-fill-batch.js'));
  assert.ok(line, 'batch.md no longer names the follow up workflows on one line');
  for (const arg of ['root: "${JOBE_HOME}"', 'workspace: "${WORKSPACE}"']) assert.ok(line.includes(arg), `missing ${arg}`);
  for (const f of ['wf-recenter-batch.js', 'wf-fill-batch.js', 'wf-compress-batch.js']) {
    assert.match(read(`scripts/${f}`), /args\.\$\{k\} is required/, `${f} no longer requires root and workspace: update batch.md`);
  }
});

test('the stated Node version is the one the dependencies require', () => {
  const lock = JSON.parse(read('package-lock.json'));
  const pkg = JSON.parse(read('package.json'));
  const floor = (range) => Number((/^>=\s*(\d+)/.exec(String(range).trim()) || [])[1] || 0);
  // The highest plain ">= N" floor among the direct dependencies.
  const need = Math.max(...Object.keys(pkg.dependencies).map((d) => floor(((lock.packages[`node_modules/${d}`] || {}).engines || {}).node)));
  assert.ok(need > 0);
  assert.equal(floor(pkg.engines.node), need, 'package.json engines.node');
  assert.equal(floor(lock.packages[''].engines.node), need, 'package-lock.json root engines.node');
  assert.ok(text.readme.includes(`[Node.js](https://nodejs.org/) ${need} or newer`), `README.md must say Node.js ${need} or newer`);
  assert.ok(text.readme.includes(`node-%E2%89%A5${need}-`), 'README.md badge');
});

test('every pipeline flag is listed in the guidance, README and find mode', () => {
  const src = read('collectors/pipeline.js');
  const flags = [...new Set([...src.slice(src.indexOf('function parseArgs')).matchAll(/a === '(--[a-z-]+)'/g)].map((m) => m[1]))]
    .filter((f) => f !== '--atomic'); // internal, undocumented on purpose
  assert.ok(flags.includes('--help') && flags.length > 10);
  const find = read('.claude/skills/jobe/modes/find.md');
  for (const f of flags) {
    for (const [name, body] of [['.claude/CLAUDE.md', text.claude], ['README.md', text.readme], ['find.md', find]]) {
      assert.ok(body.includes('`' + f), `${name} does not list ${f}`);
    }
  }
  // No mode hands a mode level flag to the script, which rejects unknown flags.
  for (const f of fs.readdirSync(path.join(ROOT, '.claude/skills/jobe/modes'))) {
    assert.doesNotMatch(read(`.claude/skills/jobe/modes/${f}`), /pipeline\.js[^\n`]*--linkedin/, `${f} passes --linkedin to the pipeline`);
  }
});

test('the dashboard filter caption names no fixed work mode or country', () => {
  const page = read('web/src/app/discovery/page.tsx');
  const caption = (/label="After filter"[^>]*caption="([^"]+)"/.exec(page) || [])[1];
  assert.ok(caption, 'After filter stat not found');
  assert.doesNotMatch(caption, /\b(remote|US|onsite|hybrid)\b/);
});

test('the docs describe the score, paper size, seed paths and search markets the code has now', () => {
  const src = read('lib/rank.js');
  const num = (name) => Number(src.match(new RegExp(`const ${name} = ([\\d.]+)`))[1]);
  for (const key of ['readme', 'architecture', 'contract', 'claude', 'sources']) {
    for (const [re, why] of [
      [/requirement lines \(its qualifications|requirement sized sentences/, 'the round 1 coverage formula'],
      [/`?share`? ?>= ?0\.5|used for gate1 only/, 'the removed share value'],
      [/holds no US entry/, 'A4 for every list without a US entry'],
      [/the whole text when no section heading is found/, 'the old keyword scope rule'],
    ]) assert.ok(!re.test(text[key]), `${DOCS[key]} still states ${why}`);
  }
  assert.match(text.architecture, new RegExp(`ratedness = min\\(1, rated terms / ${num('FULL_TABLE')}\\)`));
  assert.match(text.claude, new RegExp(`/ ${num('FULL_TABLE')}, capped at 1`));
  // The blend, the weakness share and the trust measure are stated with the code's own constants.
  assert.match(text.architecture, new RegExp(`weight    = ${num('PRIOR_WEIGHT')} \\* \\(1 - ratedness\\)`));
  assert.match(text.architecture, new RegExp(`share of rated weaknesses / ${num('WEAK_SHARE')}\\)`));
  assert.match(text.architecture, new RegExp(`max\\(0, ${num('STRONG')} - level\\) / ${num('DEFICIT')}\\)`));
  assert.match(text.architecture, new RegExp(`max\\(derived / ${num('FIELD_FULL')}, `));
  for (const key of ['readme', 'claude', 'architecture', 'contract']) assert.ok(!/weighted by `?ratedness|fades as you rate more skills/.test(text[key]), `${DOCS[key]} still describes a plain blend by ratedness`);
  assert.match(text.claude, new RegExp(`${num('COVERED_FLOOR')} is none and ${num('COVERED_FULL')} is full`));
  for (const key of ['readme', 'claude', 'architecture']) assert.match(text[key], /at most 67/, DOCS[key]);

  // Paper size: every country the docs name as Letter is one the code treats so.
  const { pageSetup } = require('../lib/profile');
  for (const c of ['US', 'Canada', 'Mexico', 'Philippines']) assert.equal(pageSetup({ discovery: { countries: [c] } }).pageSize, 'letter', c);
  assert.equal(pageSetup({ discovery: { countries: ['DE', 'Germany'] } }).pageSize, 'a4');

  // The employer seed is never read from data/ at the install root.
  const seedFiles = read('collectors/seed-files.js');
  assert.match(seedFiles, /nonTechSeed = \(key\) => seedList\(key, 'data\/companies\/non-tech-seed\.json', 'configs\/non-tech-seed\.json'\)/);
  for (const key of ['contract', 'claude']) assert.match(text[key], /configs\/non-tech-seed\.json`? \(none ships\)/, DOCS[key]);

  // Sources the docs say take their market from the user's country do so.
  for (const id of ['serpapi-google-jobs', 'serpapi-site-search', 'jsearch']) {
    assert.match(read(`collectors/sources/aggregators/${id}.js`), /searchCountry\(/, id);
    const row = text.sources.split('\n').find((l) => l.startsWith('| `' + id + '` |'));
    assert.ok(row && !/United States only/.test(row) && /single country your country list names/.test(row), `docs row for ${id}`);
  }
});

test('no document says a table of strengths alone changes nothing, and each states the field check as the code has it', () => {
  const limits = read('docs/known-limitations.md');
  for (const key of ['readme', 'architecture', 'contract', 'claude']) {
    assert.ok(!/changes nothing|nothing changes|changes no score|scores as if nothing were rated|move by a point|moves by about a point/.test(text[key]), `${DOCS[key]} still says a table of strengths alone changes nothing`);
    assert.match(text[key], /count as evidence/, `${DOCS[key]} does not say the rated terms still count as evidence`);
  }
  assert.match(limits, /its terms still enter the evidence vocabulary/);
  assert.ok(!/move by a point|moves by about a point|nothing changes/.test(limits), 'docs/known-limitations.md still understates what a table of strengths alone does');
  for (const key of ['readme', 'architecture', 'contract', 'claude']) assert.match(text[key], /can cross the 55 floor/, DOCS[key]);
  // The field check as the code has it: rated skills named never open the table by themselves.
  assert.match(read('lib/rank.js'), /Math\.min\(1, \(rated\.length - 1\) \/ 2\) \* Math\.min\(1, 2 \* derived \/ FIELD_FULL\)/);
  for (const key of ['readme', 'architecture', 'contract', 'claude']) {
    assert.ok(!/unless the posting names three or more|open the table in full (?:in|on a posting from) any field|is scored by them too/.test(text[key]), `${DOCS[key]} still says three rated skills open the table in any field`);
    assert.match(text[key], /halve the coverage/, DOCS[key]);
  }
  assert.match(text.architecture, /named \* min\(1, derived \/ 0\.25\)/);
  assert.match(text.claude, /min\(1, \(rated skills named - 1\) \/ 2\) \* min\(1, derived \/ 0\.25\)/);
  assert.ok(!/under any title that names three or more rated skills/.test(limits));
  for (const key of ['readme', 'contract']) assert.match(text[key], /words that postings in every field use \(leadership, communication, training/, DOCS[key]);
  for (const key of ['readme', 'contract', 'claude']) assert.match(text[key], /general tools and methods that other fields share \(spreadsheets, SQL, reporting, data analysis/, DOCS[key]);
});

test('docs/known-limitations.md names every file that carries a ponytail comment, and the README links it', () => {
  const doc = read('docs/known-limitations.md');
  assert.match(text.readme, /\(docs\/known-limitations\.md\)/);
  assert.match(text.sources, /\(known-limitations\.md\)/);
  const carriers = ['install-local.sh'];
  for (const dir of ['lib', 'collectors', 'scripts']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) {
      const rel = path.join(dir, String(f)).split(path.sep).join('/');
      if (/\.(js|sh)$/.test(rel) && /ponytail:/.test(read(rel))) carriers.push(rel);
    }
  }
  assert.ok(carriers.length > 20, 'the scan found the comments');
  for (const rel of carriers) assert.ok(doc.includes('`' + rel + '`'), `docs/known-limitations.md does not list the ceiling in ${rel}`);
  // Every row names a file that exists.
  for (const m of doc.matchAll(/^\| `([\w./-]+\.(?:js|sh))`/gm)) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `${m[1]} is listed and does not exist`);
});
