/**
 * JD archetype detection — optional, user-defined, field-agnostic.
 *
 * Archetypes are emphasis buckets that bias which evidence a resume leads with.
 * They are OPTIONAL. Jobe ships NO taxonomy and defaults everything to
 * 'General'. A user (or `/jobe onboard`) may define their own buckets in
 * data/archetypes.json in their workspace:
 *   { "Bucket Name": { "keywords": ["..."], "portfolioDomains": ["A1"] }, ... }
 * Lookup order: <workspace>/data/archetypes.json (canonical, carried by a
 * workspace migrate), then <workspace>/configs/archetypes.json (older
 * location), then <system>/configs/archetypes.json (an install wide default).
 * The first file that exists wins. With no file, detectArchetype returns
 * 'General' and downstream evidence selection ranks purely by JD-keyword
 * overlap (no field assumptions).
 */

const fs = require('fs');
const path = require('path');
const { getUserRoot, getSystemRoot } = require('./config');

function loadTaxonomy(root = getUserRoot()) {
  try {
    const p = [
      path.join(root, 'data/archetypes.json'),
      path.join(root, 'configs/archetypes.json'),
      path.join(getSystemRoot(), 'configs/archetypes.json'),
    ].find((c) => fs.existsSync(c));
    if (p) {
      const t = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (t && typeof t === 'object' && !Array.isArray(t)) {
        // A bucket is an object; "$comment" style notes and stray scalars are not.
        return Object.fromEntries(Object.entries(t).filter(([k, v]) =>
          !k.startsWith('$') && !k.startsWith('_') && v && typeof v === 'object' && !Array.isArray(v)));
      }
    }
  } catch { /* fall through to General */ }
  return {};
}

const ARCHETYPES = loadTaxonomy();

const GENERAL = () => ({
  primary: 'General', primaryScore: 0, secondary: null, secondaryScore: 0,
  portfolioDomains: [], allScores: {},
});

function detectArchetype(jdText) {
  const names = Object.keys(ARCHETYPES);
  if (!names.length) return GENERAL();

  const lower = (jdText || '').toLowerCase();
  const scores = {};
  for (const [name, config] of Object.entries(ARCHETYPES)) {
    let count = 0;
    for (const kw of (config.keywords || [])) {
      const regex = new RegExp(String(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const m = lower.match(regex);
      if (m) count += m.length;
    }
    scores[name] = count;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const primary = sorted[0];
  if (!primary || primary[1] === 0) return { ...GENERAL(), allScores: Object.fromEntries(sorted) };
  const secondary = sorted[1] && sorted[1][1] > 0 ? sorted[1] : null;
  return {
    primary: primary[0],
    primaryScore: primary[1],
    secondary: secondary ? secondary[0] : null,
    secondaryScore: secondary ? secondary[1] : 0,
    portfolioDomains: ARCHETYPES[primary[0]].portfolioDomains || [],
    allScores: Object.fromEntries(sorted),
  };
}

// CLI mode
if (require.main === module) {
  const text = process.argv[2] || '';
  if (!text) { console.error('Usage: node lib/archetypes.js "JD text here"'); process.exit(1); }
  console.log(JSON.stringify(detectArchetype(text), null, 2));
}

module.exports = { ARCHETYPES, detectArchetype, loadTaxonomy };
