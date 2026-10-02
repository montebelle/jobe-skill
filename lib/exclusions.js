/**
 * Company exclusions shared by the discovery pipeline, the manual ingest, and
 * the final list script, so all three drop the same employers.
 *
 *   negative  the user's own unwanted companies
 *             <workspace>/data/companies/negative-list.json
 *   staffing  agencies and brokers that list roles on behalf of other employers
 *             <system>/data/companies/staffing-list.json (shared, ships with the
 *             code) plus an optional <workspace>/data/companies/staffing-list.json
 *   all       the union, which is what a caller filters on
 *
 * Both files have the shape { "companySlugs": ["some-company", ...] }. Entries
 * are compared as is against Posting.companySlug (lib/posting.js companySlug),
 * so they must already be lowercase and hyphenated; this module only trims and
 * lowercases them. A missing or malformed file is an empty list.
 *
 * The staffing filter is gated by discovery.excludeStaffing in the user's
 * profile (default true). When it is off, `staffing` is empty and `all` equals
 * `negative`.
 */

const fs = require('fs');
const path = require('path');
const { getUserRoot, getSystemRoot } = require('./config');
const { loadProfile, discoveryFilters } = require('./profile');

function readSlugs(file, into) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const s of (j && Array.isArray(j.companySlugs) ? j.companySlugs : [])) {
      const slug = typeof s === 'string' ? s.trim().toLowerCase() : '';
      if (slug) into.add(slug);
    }
  } catch { /* file optional */ }
  return into;
}

function loadExclusions({ root, excludeStaffing } = {}) {
  root = root || getUserRoot();
  if (excludeStaffing === undefined) {
    excludeStaffing = discoveryFilters(loadProfile({ root })).excludeStaffing;
  }
  const negative = readSlugs(path.join(root, 'data', 'companies', 'negative-list.json'), new Set());
  const staffing = new Set();
  if (excludeStaffing) {
    readSlugs(path.join(getSystemRoot(), 'data', 'companies', 'staffing-list.json'), staffing);
    readSlugs(path.join(root, 'data', 'companies', 'staffing-list.json'), staffing);
  }
  return { negative, staffing, all: new Set([...negative, ...staffing]) };
}

module.exports = { loadExclusions };
