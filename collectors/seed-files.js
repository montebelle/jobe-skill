/**
 * Seed lists that ship with the code and that a user may extend.
 *
 * Two files are read for every list, the user's own copy first and the shared
 * copy second, and the entries are unioned (duplicates dropped):
 *
 *   portals          <workspace>/data/companies/portals.json
 *                    <system>/configs/portals.json
 *   non-tech-seed    <workspace>/data/companies/non-tech-seed.json
 *                    <system>/configs/non-tech-seed.json
 *
 * The shared portals file ships EMPTY and no shared non-tech-seed file ships
 * at all (the path is read only if an install adds one): that list is the
 * user's workspace copy (ignored by git, created from
 * templates/non-tech-seed.template.json). The shared path is under configs/,
 * never data/, because in single user mode data/ at the install root is one
 * person's own files and a named workspace must not read them. No curated
 * employer list comes with the code.
 * A user adds the employers they care about to the workspace copy (or lets
 * `/jobe onboard` do it) and never has to edit a shared file. A missing or
 * malformed file is an empty list. In single user mode the workspace and the
 * system root are the same directory, so a file is read once.
 */

const fs = require('fs');
const path = require('path');
const { getUserRoot, getSystemRoot } = require('../lib/config');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The list stored under `key` in each file, workspace first. A legacy file
// that is one flat array is taken whole.
function seedList(key, workspaceRel, systemRel = workspaceRel) {
  const files = new Set([
    path.join(getUserRoot(), workspaceRel),
    path.join(getSystemRoot(), systemRel),
  ]);
  const out = [];
  const seen = new Set();
  for (const file of files) {
    const data = readJson(file);
    const list = Array.isArray(data) ? data : (data && Array.isArray(data[key]) ? data[key] : []);
    for (const entry of list) {
      if (entry == null) continue;
      const id = JSON.stringify(entry);
      if (!seen.has(id)) { seen.add(id); out.push(entry); }
    }
  }
  return out;
}

// Board slugs for one ATS ("greenhouse", "lever", "ashby", ...). Entries are a
// slug string or { slug, name? }; a legacy flat array holds { ats, slug }.
const portalList = (ats) => seedList(ats, 'data/companies/portals.json', 'configs/portals.json');

// Tenants for the ATSes with no cross company search ("workday",
// "smartrecruiters", "icims"). Entry shapes are documented in the seed file.
const nonTechSeed = (key) => seedList(key, 'data/companies/non-tech-seed.json', 'configs/non-tech-seed.json');

module.exports = { seedList, portalList, nonTechSeed };
