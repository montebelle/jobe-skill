/**
 * Source: Lever direct API (single-slug caller).
 *
 * Endpoint: https://api.lever.co/v0/postings/{slug}?mode=json
 * Reads slugs from ctx.filters.atsSlugs.lever, data/companies/index.json,
 * and portals.json (legacy seed).
 */

const path = require('path');
const fs = require('fs');
const { createPosting, stripHtml } = require('../../../lib/posting');
const { getProjectRoot, getSystemRoot } = require('../../../lib/config');
const { makeTitleMatcher } = require('../../../lib/role-queries');

const ID = 'lever-direct';

function loadSlugs(ctx) {
  const s = new Set();
  for (const slug of ctx.filters?.atsSlugs?.lever || []) s.add(slug);
  const p = path.join(getProjectRoot(), 'data/companies/index.json');
  if (fs.existsSync(p)) {
    try {
      const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const [slug, meta] of Object.entries(idx)) if (meta.ats === 'lever') s.add(slug);
    } catch {}
  }
  try {
    const portals = JSON.parse(fs.readFileSync(path.join(getSystemRoot(), 'configs/portals.json'), 'utf8'));
    const list = Array.isArray(portals) ? portals : (portals.lever || []);
    for (const e of list) {
      const ats = (e && e.ats) || 'lever';
      const slug = typeof e === 'string' ? e : e.slug;
      if (slug && ats === 'lever') s.add(slug);
    }
  } catch {}
  return [...s];
}

async function fetchBoard(slug) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  return res.json();
}

// Fold Lever's workplaceType ("remote"|"hybrid"|"on-site") into the location
// string so the canonical classifier sees the explicit signal.
function leverLocation(j) {
  const base = j.categories?.location || '';
  const wt = j.workplaceType || '';
  if (/hybrid/i.test(wt)) return base ? `${base} (Hybrid)` : 'Hybrid';
  if (/remote/i.test(wt)) return /remote/i.test(base) ? base : (base ? `${base} (Remote)` : 'Remote');
  return base;
}

async function discover(ctx) {
  const { logger } = ctx;
  const titleOk = makeTitleMatcher(ctx);
  const slugs = loadSlugs(ctx);
  logger.info(`[${ID}] scanning ${slugs.length} Lever boards`);

  const all = [];
  for (const slug of slugs) {
    try {
      const jobs = await fetchBoard(slug);
      if (!jobs || !Array.isArray(jobs)) continue;
      for (const j of jobs) {
        if (!titleOk(j.text)) continue;
        const p = createPosting({
          title: j.text,
          company: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          companySlug: slug,
          location: leverLocation(j),
          url: j.hostedUrl || j.applyUrl,
          department: j.categories?.team,
          postedDate: j.createdAt,
          jdText: stripHtml(j.description || j.descriptionPlain || '').slice(0, 8000),
          compensation: j.salaryRange ? { min: j.salaryRange.min, max: j.salaryRange.max, currency: j.salaryRange.currency || 'USD' } : null,
          sourceUrl: `https://api.lever.co/v0/postings/${slug}`,
          sourceQuery: `lever:${slug}`,
        }, ID);
        if (p) all.push(p);
      }
    } catch (err) {
      logger.warn(`[${ID}] ${slug}: ${err.message}`);
    }
  }
  return all;
}

module.exports = {
  id: ID,
  name: 'Lever Direct',
  requires: [],
  rateLimit: { rpm: 120 },
  discover,
};
