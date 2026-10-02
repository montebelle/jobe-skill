#!/usr/bin/env node
/**
 * Multi-user workspace manager. One machine, many people, each targeting a
 * different field (non-profits, film, operations, ...). Each person gets an
 * isolated workspace under `<install root>/users/<slug>/` holding their profile,
 * evidence, resume baseline, bullet library, tracker, queue, reports, signals,
 * and their own emergent company index. The shared SYSTEM layer (code, configs,
 * the staffing list) stays at the install root and is read by every user.
 *
 * Usage:
 *   node scripts/user.js list                 list workspaces (* = active)
 *   node scripts/user.js current [--path]     print the active user (or its dir)
 *   node scripts/user.js new <name>           scaffold a workspace + make it active
 *   node scripts/user.js use <name>           switch the active user
 *   node scripts/user.js migrate <name>       move existing single-user data into users/<name>/
 *
 * The active user is also overridable per-process with the JOBE_USER env var,
 * which wins over the users/.active pointer this script writes. JOBE_USER_ROOT
 * (an absolute path) overrides the workspace directory itself; `current --path`
 * reports whatever lib/config.js resolves, so mode text and Node code agree.
 */
const fs = require('fs');
const path = require('path');
const {
  getSystemRoot, getUserRoot, getActiveUser, userRootFor,
  listUsers, setActiveUser, sanitizeSlug,
} = require('../lib/config');
const { LIFECYCLE_BUCKETS } = require('../lib/tracker-writer');

const SYS = getSystemRoot();

function copyIfMissing(src, dest) {
  if (!src || !fs.existsSync(src) || fs.existsSync(dest)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

// First existing path among candidates (templates live in different places in
// the dev-repo layout vs the installed ~/.jobe + ~/.claude layout).
function firstExisting(...cands) {
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const MODES_CANDIDATES = [
  path.join(SYS, '.claude', 'skills', 'jobe', 'modes'),
  HOME && path.join(HOME, '.claude', 'skills', 'jobe', 'modes'),
].filter(Boolean);

function templatePath(name) {
  return firstExisting(
    path.join(SYS, 'templates', name),
    ...MODES_CANDIDATES.map((d) => path.join(d, name)),
  );
}

// Every shipped template and where it lands in a workspace. Each one is inert
// when copied (empty lists, blank answers, examples under note keys), so a
// scaffolded workspace asserts nothing about the person until onboarding fills
// it in. A template missing from the install is skipped, never an error.
// test/root-integration-scaffold.test.js fails when templates/ gains a file
// that has no row here.
const TEMPLATE_DESTS = {
  '_profile.template.md': '_profile.md',
  'reference.template.md': 'reference.md',
  'profile.template.json': 'data/profile.json',
  'resume-baseline.template.json': 'data/resume-baseline.json',
  'bullet-library.template.json': 'data/bullet-library.json',
  'apply-profile.template.json': 'data/apply-profile.json',
  'archetypes.template.json': 'data/archetypes.json',
  'career-narrative.template.md': 'data/career-narrative.md',
  'evidence-anchors.template.json': 'data/evidence-anchors.json',
  'evidence-depth.template.json': 'data/evidence-depth.json',
  'seeds.template.json': 'data/queries/seeds.json',
  'negative-list.template.json': 'data/companies/negative-list.json',
  'non-tech-seed.template.json': 'data/companies/non-tech-seed.json',
  'portals.template.json': 'data/companies/portals.json',
};

function scaffold(root) {
  for (const d of [
    'data/queries', 'data/companies',
    ...LIFECYCLE_BUCKETS.map((b) => `reports/${b}`),
    'signals/snapshots', 'signals/cache/jd', 'signals/discovered', 'signals/apply',
  ]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  // Never overwrites: a file the person already has always wins.
  for (const [name, dest] of Object.entries(TEMPLATE_DESTS)) {
    copyIfMissing(templatePath(name), path.join(root, dest));
  }
}

function cmdList() {
  const active = getActiveUser();
  const users = listUsers();
  if (!users.length) {
    console.log('No workspaces yet (single user mode). Create one with:  node scripts/user.js new <name>');
    return;
  }
  console.log('Workspaces:');
  for (const u of users) console.log(`  ${u === active ? '*' : ' '} ${u}`);
  if (!active) console.log('\n(no active user set: run `node scripts/user.js use <name>`)');
}

function cmdCurrent(args) {
  if (args.includes('--path')) {
    console.log(getUserRoot());
    return;
  }
  console.log(getActiveUser() || '(none: single user mode)');
}

function cmdNew(name) {
  const slug = sanitizeSlug(name);
  if (!slug) { console.error('Provide a workspace name, e.g.  node scripts/user.js new film'); process.exit(1); }
  const root = userRootFor(slug);
  const fresh = !fs.existsSync(root);
  scaffold(root);
  setActiveUser(slug);
  console.log(`${fresh ? 'Created' : 'Updated'} workspace "${slug}"  ->  ${root}`);
  console.log('Now active. Next: run `/jobe onboard` to fill in the profile, resume baseline, bullets, and evidence.');
}

function cmdUse(name) {
  const slug = sanitizeSlug(name);
  if (!slug) { console.error('Provide a workspace name, e.g.  node scripts/user.js use ops'); process.exit(1); }
  if (!fs.existsSync(userRootFor(slug))) {
    console.error(`No workspace "${slug}". Existing: ${listUsers().join(', ') || '(none)'}. Create it with:  node scripts/user.js new ${slug}`);
    process.exit(1);
  }
  setActiveUser(slug);
  console.log(`Active user is now "${slug}"  ->  ${userRootFor(slug)}`);
}

function cmdMigrate(name) {
  const slug = sanitizeSlug(name);
  if (!slug) { console.error('Provide a workspace name, e.g.  node scripts/user.js migrate default'); process.exit(1); }
  const root = userRootFor(slug);
  if (fs.existsSync(root)) { console.error(`Workspace "${slug}" already exists. Refusing to overwrite.`); process.exit(1); }
  fs.mkdirSync(root, { recursive: true });
  // Everything personal lives under these, so files added later (data/profile.json,
  // data/archetypes.json, the evidence files, ...) are carried by the data/ move.
  const items = ['data', 'reports', 'signals', '_archive', '_profile.md', 'reference.md', '.env'];
  let moved = 0;
  for (const item of items) {
    const src = path.join(SYS, item);
    if (!fs.existsSync(src)) continue;
    fs.renameSync(src, path.join(root, item));
    moved++;
  }
  // Personal files that older layouts kept in a SHARED place: the profile and
  // evidence file in the skill dir (~/.claude), emphasis buckets and application
  // answers under configs/. Pull them into the workspace, or a later second user
  // would inherit them through the single user and system fallbacks.
  const legacy = {
    '_profile.md': [
      ...MODES_CANDIDATES.map((d) => path.join(d, '_profile.md')),
    ],
    'reference.md': [
      path.join(SYS, '.claude', 'skills', 'jobe', 'reference.md'),
      HOME && path.join(HOME, '.claude', 'skills', 'jobe', 'reference.md'),
      path.join(SYS, 'reference.md'),
    ].filter(Boolean),
    'data/archetypes.json': [path.join(SYS, 'configs', 'archetypes.json')],
    'data/apply-profile.json': [path.join(SYS, 'configs', 'apply-profile.json')],
  };
  for (const [name, cands] of Object.entries(legacy)) {
    const dest = path.join(root, name);
    if (fs.existsSync(dest)) continue;
    const src = firstExisting(...cands);
    if (!src) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    moved++;
  }
  // The data/ move also swept SHARED files into the workspace. Put them back so
  // every other user keeps working, without handing this person's data on:
  //   staffing-list.json  system data: moved back.
  //   .env                machine level keys: copied, so both layers have them.
  // The employer seed (non-tech-seed.json) is a personal file like the rest of
  // data/: it stays in the workspace and nothing is left at the shared path.
  const ws = (rel) => path.join(root, rel);
  const sys = (rel) => path.join(SYS, rel);
  const STAFFING = 'data/companies/staffing-list.json';
  fs.mkdirSync(sys('data/companies'), { recursive: true });
  if (fs.existsSync(ws(STAFFING)) && !fs.existsSync(sys(STAFFING))) fs.renameSync(ws(STAFFING), sys(STAFFING));
  if (fs.existsSync(ws('.env')) && !fs.existsSync(sys('.env'))) fs.copyFileSync(ws('.env'), sys('.env'));
  setActiveUser(slug);
  console.log(`Migrated ${moved} item(s) of existing single user data into "${slug}"  ->  ${root}`);
  console.log('That data is now isolated under the workspace; the shared system layer (code, configs, shared lists) stays in place.');
}

function main([cmd, ...rest]) {
  switch (cmd) {
    case 'list': case 'ls': cmdList(); break;
    case 'current': case 'whoami': cmdCurrent(rest); break;
    case 'new': case 'create': cmdNew(rest[0]); break;
    case 'use': case 'switch': cmdUse(rest[0]); break;
    case 'migrate': cmdMigrate(rest[0]); break;
    default:
      console.log('Usage: node scripts/user.js <list | current [--path] | new <name> | use <name> | migrate <name>>');
      if (cmd) process.exit(1);
  }
}

module.exports = { scaffold, TEMPLATE_DESTS };

if (require.main === module) main(process.argv.slice(2));
