const fs = require('fs');
const path = require('path');

// Support both repo install (cwd) and global install (~/.jobe/)
const PROJECT_ROOT = fs.existsSync(path.resolve(__dirname, '..', 'package.json'))
  ? path.resolve(__dirname, '..')
  : path.join(process.env.HOME || process.env.USERPROFILE, '.jobe');

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

  const resolved = configPath
    || process.env.JOBE_CONFIG
    || path.join(PROJECT_ROOT, 'configs', 'default.json');

  const absPath = resolvePath(resolved);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Config not found at ${absPath}`);
  }

  const config = JSON.parse(fs.readFileSync(absPath, 'utf8'));

  if (!config.company && !config.candidate) {
    throw new Error('Config must have "company" or "candidate"');
  }

  if (config.output_dir) {
    config.output_dir = resolvePath(config.output_dir);
  } else {
    config.output_dir = path.join(PROJECT_ROOT, 'signals', 'snapshots');
  }

  if (config.report_dir) {
    config.report_dir = resolvePath(config.report_dir);
  } else {
    config.report_dir = path.join(PROJECT_ROOT, 'reports');
  }

  _config = config;
  return _config;
}

function loadEnv() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    path.join(PROJECT_ROOT, '.env'),
    home && path.join(home, '.jobe', '.env'),
  ].filter(Boolean);
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
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

function getProjectRoot() {
  return PROJECT_ROOT;
}

module.exports = { getConfig, resolvePath, loadEnv, getApiKey, checkRequiredKeys, getProjectRoot };
