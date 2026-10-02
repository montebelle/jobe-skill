'use strict';
// The Codex host files (.agents/skills/jobe/**, .codex/agents/jobe-*.toml,
// AGENTS.md) are GENERATED from the sources under .claude/ by
// scripts/sync-agents-mirror.js. Two kinds of check:
//   1. The shipped tree: the mirror is up to date and every agent file parses.
//      When this fails after an edit under .claude/, run
//      `node scripts/sync-agents-mirror.js` and stage the result.
//   2. The generator itself, against a synthetic tree in a temp directory (a
//      registered nurse and a tax accountant as the two unrelated fixtures):
//      personal files are never copied or deleted, stale and extra files are
//      detected, and --check exits 1.
// No network. Nothing is written inside the repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mirror-'));
process.env.JOBE_USER_ROOT = TMP;

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'sync-agents-mirror.js');
const { plan, stale, sync, toToml } = require(SCRIPT);

// Minimal reader for the three key shape the generator writes: `key = "basic
// string"` lines and one ''' literal block. Not a TOML parser.
function parseAgentToml(text) {
  const lines = text.split('\n');
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith('#')) continue;
    const m = /^([a-z_]+) = (.*)$/.exec(line);
    assert.ok(m, `not a key = value line: ${line.slice(0, 80)}`);
    assert.ok(!(m[1] in out), `duplicate key ${m[1]}`);
    if (m[2] === "'''") {
      const rest = lines.slice(i + 1).join('\n');
      const end = rest.indexOf("'''");
      assert.ok(end >= 0, 'unterminated literal string');
      assert.equal(rest.slice(end + 3).trim(), '', 'text after the closing quotes');
      out[m[1]] = rest.slice(0, end);
      break;
    }
    out[m[1]] = JSON.parse(m[2]);
  }
  return out;
}

const frontmatter = (md) => /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);

test('the shipped mirror is up to date (run node scripts/sync-agents-mirror.js when this fails)', () => {
  assert.deepEqual(stale(REPO), []);
  const run = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('the skill mirror is a byte copy and carries no personal file', () => {
  const files = [...plan(REPO).keys()];
  const skill = files.filter((f) => f.startsWith('.agents/skills/jobe/'));
  assert.ok(skill.includes('.agents/skills/jobe/SKILL.md'));
  assert.ok(skill.includes('.agents/skills/jobe/modes/_shared.md'));
  assert.ok(skill.includes('.agents/skills/jobe/modes/_profile.template.md'), 'the shipped template is mirrored');
  for (const f of files) assert.ok(!/(^|\/)(_profile\.md|reference\.md)$/.test(f), `personal file in the plan: ${f}`);
  for (const f of skill) {
    const src = path.join(REPO, f.replace('.agents/', '.claude/'));
    assert.ok(fs.readFileSync(src).equals(fs.readFileSync(path.join(REPO, f))), `${f} differs from its source`);
  }
  // The copied router must find its modes folder under either host.
  assert.match(fs.readFileSync(path.join(REPO, '.agents/skills/jobe/SKILL.md'), 'utf8'), /\.agents\/skills\/jobe\/modes/);
});

test('every Codex agent file parses and matches its Claude agent', () => {
  const dir = path.join(REPO, '.codex', 'agents');
  const tomls = fs.readdirSync(dir).filter((f) => f.endsWith('.toml')).sort();
  const sources = fs.readdirSync(path.join(REPO, '.claude', 'agents')).filter((f) => /^jobe-.*\.md$/.test(f)).sort();
  assert.deepEqual(tomls, sources.map((f) => f.replace(/\.md$/, '.toml')));
  assert.ok(tomls.length >= 4);
  for (const f of tomls) {
    const got = parseAgentToml(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(Object.keys(got), ['name', 'description', 'developer_instructions'], f);
    const fm = frontmatter(fs.readFileSync(path.join(REPO, '.claude', 'agents', f.replace(/\.toml$/, '.md')), 'utf8'));
    assert.equal(got.name, f.replace(/\.toml$/, ''));
    assert.equal(got.description, /^description:\s*(.+)$/m.exec(fm[1])[1].trim());
    assert.equal(got.developer_instructions, fm[2].trim(), `${f}: body differs from the Claude agent`);
  }
});

test('AGENTS.md is the project guidance under a generated notice', () => {
  const agents = fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8');
  const [notice, blank, ...rest] = agents.split('\n');
  assert.match(notice, /^<!-- GENERATED from \.claude\/CLAUDE\.md by scripts\/sync-agents-mirror\.js\. .* -->$/);
  assert.equal(blank, '');
  assert.equal(rest.join('\n'), fs.readFileSync(path.join(REPO, '.claude', 'CLAUDE.md'), 'utf8'));
});

test('generator on a synthetic tree: copies, skips personal files, detects stale and extra files', () => {
  const root = path.join(TMP, 'tree');
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const has = (rel) => fs.existsSync(path.join(root, rel));
  put('.claude/CLAUDE.md', '# Guidance\n');
  put('.claude/skills/jobe/SKILL.md', '---\nname: jobe\n---\nRouter\n');
  put('.claude/skills/jobe/modes/_shared.md', 'Shared rules\n');
  put('.claude/skills/jobe/modes/_profile.md', 'Registered nurse, 9 years, night shift charge nurse\n');
  put('.claude/skills/jobe/reference.md', 'Tax accountant: 140 returns per season\n');
  put('.claude/skills/jobe/.DS_Store', 'x');
  put('.claude/agents/jobe-ward-brief.md',
    '---\nname: jobe-ward-brief\ndescription: Summarize a nursing unit posting\nmodel: sonnet\nallowed-tools: Read\n---\n\n# Ward brief\n\nList the unit, the shift, and the license the posting asks for.\n');
  put('.claude/agents/jobe-ledger-brief.md',
    "---\nname: jobe-ledger-brief\ndescription: \"Summarize a tax accounting posting\"\n---\n# Ledger brief\n\nQuote the firm's own words, e.g. 'busy season'\n");
  put('.claude/agents/other-agent.md', '---\nname: other\ndescription: not ours\n---\nbody\n');

  assert.ok(stale(root).length > 0, 'an empty mirror is stale');
  sync(root);
  assert.deepEqual(stale(root), []);
  assert.ok(has('.agents/skills/jobe/SKILL.md') && has('.agents/skills/jobe/modes/_shared.md') && has('AGENTS.md'));
  assert.ok(!has('.agents/skills/jobe/modes/_profile.md'), 'a personal profile was copied');
  assert.ok(!has('.agents/skills/jobe/reference.md'), 'a personal evidence file was copied');
  assert.ok(!has('.agents/skills/jobe/.DS_Store'));
  assert.ok(!has('.codex/agents/other-agent.toml'), 'only jobe-* agents are generated');

  const ward = parseAgentToml(fs.readFileSync(path.join(root, '.codex/agents/jobe-ward-brief.toml'), 'utf8'));
  assert.deepEqual(ward, {
    name: 'jobe-ward-brief',
    description: 'Summarize a nursing unit posting',
    developer_instructions: '# Ward brief\n\nList the unit, the shift, and the license the posting asks for.',
  });
  // A body that ends in a quote cannot sit in a literal block: one escaped line.
  const ledgerText = fs.readFileSync(path.join(root, '.codex/agents/jobe-ledger-brief.toml'), 'utf8');
  assert.ok(!ledgerText.includes("'''"));
  const ledger = parseAgentToml(ledgerText);
  assert.equal(ledger.description, 'Summarize a tax accounting posting');
  assert.equal(ledger.developer_instructions, "# Ledger brief\n\nQuote the firm's own words, e.g. 'busy season'");

  // Source edited: stale until the next sync.
  put('.claude/skills/jobe/modes/_shared.md', 'Shared rules, edited\n');
  put('.claude/CLAUDE.md', '# Guidance, edited\n');
  assert.deepEqual(stale(root).map((i) => `${i.why} ${i.file}`).sort(),
    ['differs .agents/skills/jobe/modes/_shared.md', 'differs AGENTS.md']);

  // The script run as a command (a copy inside the synthetic tree resolves that
  // tree as its root): --check exits 1 and writes nothing, a plain run repairs.
  put('scripts/sync-agents-mirror.js', fs.readFileSync(SCRIPT));
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-agents-mirror.js'), ...args], { encoding: 'utf8' });
  assert.equal(cli('--check').status, 1);
  assert.equal(stale(root).length, 2, '--check must not write');
  assert.equal(cli().status, 0);
  assert.equal(cli('--check').status, 0);

  // A leftover in the mirror is removed; a personal file there is left alone.
  put('.agents/skills/jobe/modes/retired.md', 'old mode\n');
  put('.codex/agents/jobe-retired.toml', 'name = "jobe-retired"\n');
  put('.codex/agents/mine.toml', 'name = "mine"\n');
  put('.agents/skills/jobe/modes/_profile.md', 'Tax accountant, enrolled agent\n');
  assert.deepEqual(stale(root).map((i) => `${i.why} ${i.file}`).sort(),
    ['extra .agents/skills/jobe/modes/retired.md', 'extra .codex/agents/jobe-retired.toml']);
  sync(root);
  assert.ok(!has('.agents/skills/jobe/modes/retired.md') && !has('.codex/agents/jobe-retired.toml'));
  assert.ok(has('.codex/agents/mine.toml'), 'an agent file without our prefix was deleted');
  assert.equal(fs.readFileSync(path.join(root, '.agents/skills/jobe/modes/_profile.md'), 'utf8'), 'Tax accountant, enrolled agent\n');
  assert.deepEqual(stale(root), []);
});

test('toToml refuses an agent file it cannot read safely', () => {
  assert.throws(() => toToml('# no frontmatter\n', 'x.md'), /no frontmatter/);
  assert.throws(() => toToml('---\nname: a\n---\nbody\n', 'x.md'), /single line "description"/);
  assert.throws(() => toToml('---\nname: a\ndescription: >\n  folded\n---\nbody\n', 'x.md'), /single line "description"/);
  // Three quotes inside the body would close a literal block early.
  const escaped = toToml("---\nname: a\ndescription: d\n---\nuse ''' here\n", 'x.md');
  assert.equal(parseAgentToml(escaped).developer_instructions, "use ''' here");
});
