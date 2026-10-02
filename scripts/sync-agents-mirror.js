#!/usr/bin/env node
'use strict';
// Generate the files the Codex host reads from the Claude Code sources, so the
// two copies of the skill cannot drift (a hand kept copy goes stale in weeks).
//
//   .claude/skills/jobe/**     -> .agents/skills/jobe/**      byte for byte
//   .claude/agents/jobe-*.md   -> .codex/agents/jobe-*.toml   name, description, developer_instructions
//   .claude/CLAUDE.md          -> AGENTS.md                   same text under a one line notice
//
// The text is NOT rewritten per host. SKILL.md already looks for its modes
// folder under both hosts, and the modes address the workspace through
// ${WORKSPACE} and ${JOBE_HOME}, never through a host folder. If a host ever
// needs different wording, change the shared source so it reads for both; a
// substitution table here is the last resort.
//
// Personal files that an older layout kept inside the skill folder
// (modes/_profile.md, reference.md) are never copied, and never deleted from
// the mirror either.
//
// Usage: node scripts/sync-agents-mirror.js           write whatever is out of date
//        node scripts/sync-agents-mirror.js --check   change nothing, exit 1 when stale
// Edit the source under .claude/, then run this. test/codex-mirror.test.js fails
// when the mirror is stale.

const fs = require('fs');
const path = require('path');

const SKILL_SRC = '.claude/skills/jobe';
const SKILL_DST = '.agents/skills/jobe';
const AGENT_SRC = '.claude/agents';
const AGENT_DST = '.codex/agents';
const GUIDE_SRC = '.claude/CLAUDE.md';
const GUIDE_DST = 'AGENTS.md';
const PERSONAL = new Set(['_profile.md', 'reference.md']);
const NOTICE = (src) => `GENERATED from ${src} by scripts/sync-agents-mirror.js. Edit that file, then run the script.`;

// Files under root/rel as forward slash paths, minus personal files and dotfiles.
function walk(root, rel) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map((f) => String(f).split(path.sep).join('/'))
    .filter((f) => {
      const name = path.posix.basename(f);
      return !name.startsWith('.') && !PERSONAL.has(name) && fs.statSync(path.join(dir, f)).isFile();
    })
    .sort();
}

// One Claude agent file (frontmatter + markdown body) as a Codex agent file.
// The frontmatter keys `model` and `allowed-tools` have no Codex counterpart.
// ponytail: reads single line `key: value` frontmatter only; a folded or quoted
// multi line value needs a YAML parser.
function toToml(md, src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(md);
  if (!m) throw new Error(`${src}: no frontmatter block`);
  const key = (k) => {
    const hit = new RegExp(`^${k}:[ \\t]*(.*)$`, 'm').exec(m[1]);
    const v = hit ? hit[1].trim().replace(/^(["'])(.*)\1$/, '$2') : '';
    if (!v || v === '>' || v === '|') throw new Error(`${src}: frontmatter needs a single line "${k}"`);
    return v;
  };
  const body = m[2].trim();
  // A TOML literal string keeps the body readable and unescaped. A body that
  // could close it early falls back to one escaped line (JSON string escapes
  // are valid TOML basic string escapes).
  const literal = !body.includes("'''") && !body.endsWith("'");
  return [
    `# ${NOTICE(src)}`,
    `name = ${JSON.stringify(key('name'))}`,
    `description = ${JSON.stringify(key('description'))}`,
    `developer_instructions = ${literal ? `'''\n${body}'''` : JSON.stringify(body)}`,
    '',
  ].join('\n');
}

// Every generated file: repo relative path -> Buffer.
function plan(root) {
  const read = (rel) => fs.readFileSync(path.join(root, rel));
  if (!fs.existsSync(path.join(root, SKILL_SRC, 'SKILL.md'))) {
    throw new Error(`${SKILL_SRC}/SKILL.md not found under ${root}: run this from a clone of the repo`);
  }
  const out = new Map();
  for (const f of walk(root, SKILL_SRC)) out.set(`${SKILL_DST}/${f}`, read(`${SKILL_SRC}/${f}`));
  for (const f of walk(root, AGENT_SRC).filter((n) => /^jobe-[^/]*\.md$/.test(n))) {
    const src = `${AGENT_SRC}/${f}`;
    out.set(`${AGENT_DST}/${f.replace(/\.md$/, '.toml')}`, Buffer.from(toToml(read(src).toString('utf8'), src)));
  }
  if (fs.existsSync(path.join(root, GUIDE_SRC))) {
    out.set(GUIDE_DST, Buffer.concat([Buffer.from(`<!-- ${NOTICE(GUIDE_SRC)} -->\n\n`), read(GUIDE_SRC)]));
  }
  return out;
}

// What differs from the plan: [{ file, why }]. Extra files count only where
// everything is generated (the skill mirror) or carries our prefix (agents).
function stale(root) {
  const want = plan(root);
  const issues = [];
  for (const [file, buf] of want) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) issues.push({ file, why: 'missing' });
    else if (!fs.readFileSync(abs).equals(buf)) issues.push({ file, why: 'differs' });
  }
  const have = [
    ...walk(root, SKILL_DST).map((f) => `${SKILL_DST}/${f}`),
    ...walk(root, AGENT_DST).filter((n) => /^jobe-[^/]*\.toml$/.test(n)).map((f) => `${AGENT_DST}/${f}`),
  ];
  for (const file of have) if (!want.has(file)) issues.push({ file, why: 'extra' });
  return issues;
}

function sync(root) {
  const want = plan(root);
  const issues = stale(root);
  for (const { file, why } of issues) {
    const abs = path.join(root, file);
    if (why === 'extra') { fs.rmSync(abs); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, want.get(file));
  }
  return issues;
}

module.exports = { plan, stale, sync, toToml };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const check = process.argv.includes('--check');
  let issues;
  try { issues = check ? stale(root) : sync(root); } catch (e) { console.error(e.message); process.exit(2); }
  for (const { file, why } of issues) console.log(`${check ? 'stale' : 'wrote'} (${why}): ${file}`);
  if (check && issues.length) {
    console.error(`${issues.length} generated file(s) out of date. Run: node scripts/sync-agents-mirror.js`);
    process.exit(1);
  }
  console.log(issues.length ? `${issues.length} file(s) updated.` : 'Mirror is up to date.');
}
