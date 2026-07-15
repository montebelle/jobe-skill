#!/usr/bin/env node
/**
 * Multi-user workspace manager. One machine, many people, each targeting a
 * different field (non-profits, film, operations, ...). Each person gets an
 * isolated workspace under `<install root>/users/<slug>/` holding their profile,
 * evidence, resume baseline, bullet library, tracker, queue, reports, signals,
 * and their own emergent company index. The shared SYSTEM layer (code, configs,
 * field-neutral ATS seeds) stays at the install root and is read by every user.
 *
 * Usage:
 *   node scripts/user.js list                 list workspaces (* = active)
 *   node scripts/user.js current [--path]     print the active user (or its dir)
 *   node scripts/user.js new <name>           scaffold a workspace + make it active
 *   node scripts/user.js use <name>           switch the active user
 *   node scripts/user.js migrate <name>       move existing single-user data into users/<name>/
 *
 * The active user is also overridable per-process with the JOBE_USER env var,
 * which wins over the users/.active pointer this script writes.
 */
const fs = require('fs');
const path = require('path');
const {
  getSystemRoot, getUsersDir, getActiveUser, userRootFor,
  listUsers, setActiveUser, sanitizeSlug,
} = require('../lib/config');

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

function scaffold(root) {
  for (const d of [
    'data/queries', 'data/companies',
    'reports/applied', 'reports/skipped',
    'signals/snapshots', 'signals/cache/jd', 'signals/discovered', 'signals/apply',
  ]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  // Best-effort seed from shipped templates; onboard fills the real content.
  copyIfMissing(templatePath('_profile.template.md'), path.join(root, '_profile.md'));
  copyIfMissing(templatePath('reference.template.md'), path.join(root, 'reference.md'));
  copyIfMissing(templatePath('resume-baseline.template.json'), path.join(root, 'data', 'resume-baseline.json'));
  copyIfMissing(templatePath('bullet-library.template.json'), path.join(root, 'data', 'bullet-library.json'));
  copyIfMissing(templatePath('apply-profile.template.json'), path.join(root, 'data', 'apply-profile.json'));
  // Field-specific starting files: copy the shared industry-neutral examples.
  copyIfMissing(path.join(SYS, 'data', 'queries', 'seeds.json'), path.join(root, 'data', 'queries', 'seeds.json'));
  copyIfMissing(path.join(SYS, 'data', 'companies', 'negative-list.json'), path.join(root, 'data', 'companies', 'negative-list.json'));
}

function cmdList() {
  const active = getActiveUser();
  const users = listUsers();
  if (!users.length) {
    console.log('No workspaces yet (single-user mode). Create one with:  node scripts/user.js new <name>');
    return;
  }
  console.log('Workspaces:');
  for (const u of users) console.log(`  ${u === active ? '*' : ' '} ${u}`);
  if (!active) console.log('\n(no active user set — run `node scripts/user.js use <name>`)');
}

function cmdCurrent(args) {
  const active = getActiveUser();
  if (args.includes('--path')) {
    console.log(active ? userRootFor(active) : SYS);
    return;
  }
  console.log(active || '(none — single-user mode)');
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
  if (fs.existsSync(root)) { console.error(`Workspace "${slug}" already exists — refusing to overwrite.`); process.exit(1); }
  fs.mkdirSync(root, { recursive: true });
  const items = ['data', 'reports', 'signals', '_profile.md', 'reference.md', '.env'];
  let moved = 0;
  for (const item of items) {
    const src = path.join(SYS, item);
    if (!fs.existsSync(src)) continue;
    fs.renameSync(src, path.join(root, item));
    moved++;
  }
  // Legacy single-user installs keep _profile.md / reference.md in the shared
  // skill dir (~/.claude); pull them into the workspace so they do not leak to
  // a future second user via the router's single-user fallback.
  const legacy = {
    '_profile.md': [
      ...MODES_CANDIDATES.map((d) => path.join(d, '_profile.md')),
    ],
    'reference.md': [
      path.join(SYS, '.claude', 'skills', 'jobe', 'reference.md'),
      HOME && path.join(HOME, '.claude', 'skills', 'jobe', 'reference.md'),
      path.join(SYS, 'reference.md'),
    ].filter(Boolean),
  };
  for (const [name, cands] of Object.entries(legacy)) {
    const dest = path.join(root, name);
    if (fs.existsSync(dest)) continue;
    const src = firstExisting(...cands);
    if (src) { fs.renameSync(src, dest); moved++; }
  }
  // The data/ move sweeps the SHARED, field-neutral seeds and any machine-level
  // .env into the workspace. Restore copies at the install root so every OTHER
  // user (and Workday/SmartRecruiters/iCIMS + the staffing filter) still works.
  for (const shared of ['data/companies/non-tech-seed.json', 'data/companies/staffing-list.json', '.env']) {
    const inWs = path.join(root, shared);
    const atSys = path.join(SYS, shared);
    if (fs.existsSync(inWs) && !fs.existsSync(atSys)) {
      fs.mkdirSync(path.dirname(atSys), { recursive: true });
      fs.copyFileSync(inWs, atSys);
    }
  }
  setActiveUser(slug);
  console.log(`Migrated ${moved} item(s) of existing single-user data into "${slug}"  ->  ${root}`);
  console.log('That data is now isolated under the workspace; the shared system layer (code, configs, seeds) stays in place.');
}

const [cmd, ...rest] = process.argv.slice(2);
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
