const fs = require('fs');
const path = require('path');

// Support both repo install (cwd) and global install (~/.jobe/)
const PROJECT_ROOT = fs.existsSync(path.resolve(__dirname, '..', 'package.json'))
  ? path.resolve(__dirname, '..')
  : path.join(process.env.HOME || process.env.USERPROFILE, '.jobe');

// ── Multi-user workspaces ───────────────────────────────────────────────
// One machine, many people, each targeting a different field. The SYSTEM layer
// (code, configs, field-neutral ATS seeds) is shared and lives at PROJECT_ROOT.
// Each person's USER layer (profile, evidence, resume baseline, bullet library,
// tracker, queue, reports, signals, their emergent company index) lives in an
// isolated workspace under `<PROJECT_ROOT>/users/<slug>/`.
//
//   getSystemRoot()  -> PROJECT_ROOT  (shared code + configs + seeds)
//   getUserRoot()    -> the ACTIVE user's workspace, or PROJECT_ROOT when no
//                       user is configured (single-user / back-compat: existing
//                       installs keep reading ~/.jobe/data, ~/.jobe/reports, ...)
//   getProjectRoot() -> alias of getUserRoot() (the "active data root"); kept so
//                       the ~25 existing user-layer call sites need no change.
//
// Active user precedence: JOBE_USER env  >  users/.active pointer file  >  none.

const USERS_DIRNAME = 'users';
const ACTIVE_POINTER = '.active';

// Path-safe slug: lowercase, [a-z0-9_-] only, no traversal. Returns null if empty.
function sanitizeSlug(s) {
  const slug = String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || null;
}

function getSystemRoot() {
  return PROJECT_ROOT;
}

function getUsersDir() {
  return path.join(PROJECT_ROOT, USERS_DIRNAME);
}

// The slug of the active user, or null when unconfigured (single-user mode).
function getActiveUser() {
  if (process.env.JOBE_USER) return sanitizeSlug(process.env.JOBE_USER);
  const pointer = path.join(getUsersDir(), ACTIVE_POINTER);
  if (fs.existsSync(pointer)) {
    try { return sanitizeSlug(fs.readFileSync(pointer, 'utf8')); } catch { /* fall through */ }
  }
  return null;
}

// Absolute workspace dir for a given slug (does not check existence).
function userRootFor(slug) {
  const s = sanitizeSlug(slug);
  return s ? path.join(getUsersDir(), s) : PROJECT_ROOT;
}

// The active user's workspace root, or PROJECT_ROOT when unconfigured.
function getUserRoot() {
  const u = getActiveUser();
  return u ? path.join(getUsersDir(), u) : PROJECT_ROOT;
}

// Back-compat alias. Historically "the root under which this run's data lives";
// with workspaces that is the active user's workspace. System files that must
// stay shared (configs, ATS seeds) now call getSystemRoot() explicitly.
function getProjectRoot() {
  return getUserRoot();
}

// List configured workspace slugs (empty when single-user).
function listUsers() {
  const dir = getUsersDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => sanitizeSlug(n) === n)
    .sort();
}

// Point the active-user pointer at `slug`. Does not create the workspace.
function setActiveUser(slug) {
  const s = sanitizeSlug(slug);
  if (!s) throw new Error('invalid user slug');
  const dir = getUsersDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ACTIVE_POINTER), s + '\n');
  return s;
}

function resolvePath(p) {
  if (p.startsWith('~')) {
    return path.join(process.env.HOME || process.env.USERPROFILE, p.slice(1));
  }
  if (!path.isAbsolute(p)) {
    return path.resolve(PROJECT_ROOT, p);
  }
  return p;
}

let _config = null;

function getConfig(configPath) {
  if (_config && !configPath) return _config;

  // configs/ is SYSTEM layer (shared) — resolve against the system root.
  const resolved = configPath
    || process.env.JOBE_CONFIG
    || path.join(getSystemRoot(), 'configs', 'default.json');

  const absPath = resolvePath(resolved);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Config not found at ${absPath}`);
  }

  const config = JSON.parse(fs.readFileSync(absPath, 'utf8'));

  if (!config.company && !config.candidate) {
    throw new Error('Config must have "company" or "candidate"');
  }

  // output_dir / report_dir are USER layer — a RELATIVE value (as shipped in
  // default.json) resolves against the active workspace, not the install root.
  // Absolute / ~ values are honored as-is.
  const underWorkspace = (v) =>
    (v.startsWith('~') || path.isAbsolute(v)) ? resolvePath(v) : path.join(getUserRoot(), v);
  config.output_dir = config.output_dir ? underWorkspace(config.output_dir) : path.join(getUserRoot(), 'signals', 'snapshots');
  config.report_dir = config.report_dir ? underWorkspace(config.report_dir) : path.join(getUserRoot(), 'reports');

  _config = config;
  return _config;
}

function loadEnv() {
  const home = process.env.HOME || process.env.USERPROFILE;
  // Per-workspace .env wins (a user can hold their own keys); then the shared
  // machine-level .env; then ~/.jobe/.env. First writer wins per var.
  const candidates = [
    path.join(getUserRoot(), '.env'),
    path.join(getSystemRoot(), '.env'),
    home && path.join(home, '.jobe', '.env'),
  ].filter(Boolean);
  const seen = new Set();
  for (const envPath of candidates) {
    if (seen.has(envPath) || !fs.existsSync(envPath)) continue;
    seen.add(envPath);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

function getApiKey(name) {
  const config = getConfig();
  const keyConfig = config.api_keys?.[name];
  if (!keyConfig) return null;
  return process.env[keyConfig.env_var] || null;
}

function checkRequiredKeys() {
  const config = getConfig();
  const missing = [];
  for (const [name, keyConfig] of Object.entries(config.api_keys || {})) {
    if (keyConfig.required && !process.env[keyConfig.env_var]) {
      missing.push(`${name} (${keyConfig.env_var})`);
    }
  }
  return missing;
}

module.exports = {
  getConfig, resolvePath, loadEnv, getApiKey, checkRequiredKeys,
  getProjectRoot, getSystemRoot, getUserRoot, getUsersDir,
  getActiveUser, userRootFor, listUsers, setActiveUser, sanitizeSlug,
};
