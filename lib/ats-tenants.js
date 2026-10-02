/**
 * Tenant lists for the per company ATS crawlers (workable, recruitee, breezy,
 * bamboohr, personio).
 *
 * No employer list ships with the code. A tenant is the account slug or
 * subdomain a board is served under, and it comes from the union of:
 *
 *   1. ctx.filters.atsSlugs[<ats>]                 explicit, for one run
 *   2. <workspace>/data/companies/portals.json     the user's own seed
 *      <system>/configs/portals.json               shared seed (ships empty)
 *   3. <workspace>/data/companies/index.json       the emergent company index:
 *      an entry tagged ats === <ats>, or one holding a URL on that ATS host
 *
 * A seed entry is a slug string or { slug, name }. Some of these feeds expose
 * no company name at all, and a guessed slug can belong to an unrelated
 * company, so a pinned name beats one derived from the slug. The first name
 * seen for a slug wins, in the order above.
 *
 * This file lives in lib/ on purpose: every .js under collectors/sources/
 * registers as a source plugin.
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot, getSystemRoot } = require('./config');
const { atsFromUrl } = require('./slug-harvest');

// A slug is interpolated into a hostname or a URL path by the callers, and it
// can originate from harvested search results, so anything that is not a plain
// label is refused here.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Display name of last resort: "acme-health" -> "Acme Health".
function prettify(slug) {
  return String(slug || '').replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * @param {object} ctx  discovery context (only ctx.filters.atsSlugs is read)
 * @param {string} ats  'workable' | 'recruitee' | 'breezy' | 'bamboohr' | 'personio'
 * @returns {{ slug: string, name: string|null }[]}  name is null when unknown
 */
function loadTenants(ctx, ats) {
  const byslug = new Map();
  const add = (rawSlug, rawName) => {
    const slug = String(rawSlug || '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return;
    const name = typeof rawName === 'string' && rawName.trim() && rawName.trim() !== slug
      ? rawName.trim() : null;
    if (!byslug.has(slug) || (name && !byslug.get(slug))) byslug.set(slug, name);
  };
  const addEntry = (e) => {
    if (typeof e === 'string') add(e);
    else if (e && typeof e === 'object') add(e.slug || e.sub, e.name || e.company);
  };

  const explicit = ctx && ctx.filters && ctx.filters.atsSlugs && ctx.filters.atsSlugs[ats];
  for (const e of Array.isArray(explicit) ? explicit : []) addEntry(e);

  for (const file of [
    path.join(getProjectRoot(), 'data', 'companies', 'portals.json'),
    path.join(getSystemRoot(), 'configs', 'portals.json'),
  ]) {
    const portals = readJson(file);
    // Keyed form { "<ats>": [...] }, or the older flat array of { ats, slug }.
    const list = Array.isArray(portals) ? portals.filter(e => e && e.ats === ats) : (portals && portals[ats]);
    for (const e of Array.isArray(list) ? list : []) addEntry(e);
  }

  const idx = readJson(path.join(getProjectRoot(), 'data', 'companies', 'index.json'));
  if (idx && typeof idx === 'object' && !Array.isArray(idx)) {
    for (const [key, meta] of Object.entries(idx)) {
      if (!meta || typeof meta !== 'object') continue;
      let slug = meta.ats === ats ? (meta[`${ats}Sub`] || key) : null;
      // A URL on the ATS host names the real tenant, which can differ from the
      // index key (the key is a company slug when an aggregator found it first).
      for (const u of Array.isArray(meta.urls) ? meta.urls : []) {
        const hit = atsFromUrl(u);
        if (hit && hit.ats === ats) slug = hit.slug;
      }
      // Slug harvest stores the key itself as a placeholder name; not a name.
      if (slug) add(slug, meta.name === key ? null : meta.name);
    }
  }

  return [...byslug].map(([slug, name]) => ({ slug, name }));
}

module.exports = { loadTenants, prettify };
