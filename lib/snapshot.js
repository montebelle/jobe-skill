const fs = require('fs');
const path = require('path');
const { getConfig, resolvePath } = require('./config');

function snapshotDir(companySlug, date) {
  const config = getConfig();
  const base = resolvePath(config.output_dir);
  const dateStr = date || new Date().toISOString().slice(0, 10);
  const dir = path.join(base, companySlug, dateStr);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveSnapshot(companySlug, dataType, data, date) {
  const dir = snapshotDir(companySlug, date);
  const filePath = path.join(dir, `${dataType}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Snapshot saved: ${filePath}`);
  return filePath;
}

function loadSnapshot(companySlug, dataType, date) {
  const dir = snapshotDir(companySlug, date);
  const filePath = path.join(dir, `${dataType}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function latestSnapshotDate(companySlug) {
  const config = getConfig();
  const base = resolvePath(config.output_dir);
  const compDir = path.join(base, companySlug);
  if (!fs.existsSync(compDir)) return null;
  const dirs = fs.readdirSync(compDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

module.exports = { snapshotDir, saveSnapshot, loadSnapshot, latestSnapshotDate };
