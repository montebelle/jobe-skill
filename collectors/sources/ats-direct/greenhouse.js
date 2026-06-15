/**
 * Source: Greenhouse direct board API (single-slug caller).
 *
 * Takes explicit company slugs via ctx.filters.atsSlugs.greenhouse (an array)
 * or reads from the company index. Does NOT iterate portals.json anymore.
 * Used when you know the exact board you want to scan (tactical).
 *
 * Endpoint: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 */

const path = require('path');
const fs = require('fs');
const { createPosting, stripHtml } = require('../../../lib/posting');
const { getProjectRoot } = require('../../../lib/config');

const ID = 'greenhouse-direct';
const ML_REGEX = /\b(machine learning|ml engineer|data scien|ai engineer|llm|genai|gen ai|deep learning|nlp|computer vision|causal|forecast|recommendation|applied scientist|research engineer|mlops|member of technical staff)\b/i;

function loadSlugs(ctx) {
  const s = new Set();
  for (const slug of ctx.filters?.atsSlugs?.greenhouse || []) s.add(slug);

  // Company index
  const p = path.join(getProjectRoot(), 'data/companies/index.json');
  if (fs.existsSync(p)) {
    try {
      const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const [slug, meta] of Object.entries(idx)) {
        if (meta.ats === 'greenhouse') s.add(slug);
      }
    } catch {}
  }

  // Legacy portals.json seed (flat array of { ats, slug })
  try {
    const portals = JSON.parse(fs.readFileSync(path.join(getProjectRoot(), 'configs/portals.json'), 'utf8'));
    const list = Array.isArray(portals) ? portals : (portals.greenhouse || []);
    for (const e of list) {
      const ats = (e && e.ats) || 'greenhouse';
      const slug = typeof e === 'string' ? e : e.slug;
      if (slug && ats === 'greenhouse') s.add(slug);
    }
  } catch {}

  return [...s];
}

async function fetchBoard(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  return res.json();
}

// The /jobs endpoint omits the board's display name. The board root endpoint
// returns the real, human company name (e.g. slug "grafanalabs" -> "Grafana
// Labs", "hs" -> "HubSpot"). Fetched lazily, only for boards that have a
// matching role, so we don't pay a request for empty boards.
async function fetchBoardName(slug) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const d = await res.json();
    return (d && typeof d.name === 'string' && d.name.trim()) ? d.name.trim() : null;
  } catch { return null; }
}

// Fallback only: title-case the slug when the board name is unavailable.
function slugFallbackName(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function discover(ctx) {
  const { logger } = ctx;
  const slugs = loadSlugs(ctx);
  logger.info(`[${ID}] scanning ${slugs.length} Greenhouse boards`);

  const all = [];
  for (const slug of slugs) {
    try {
      const data = await fetchBoard(slug);
      if (!data || !data.jobs) continue;
      const mlJobs = data.jobs.filter(j => ML_REGEX.test(j.title));
      if (!mlJobs.length) continue;
      const company = (await fetchBoardName(slug)) || slugFallbackName(slug);
      for (const j of mlJobs) {
        const p = createPosting({
          title: j.title,
          company,
          companySlug: slug,
          location: j.location?.name,
          url: j.absolute_url,
          department: (j.departments || []).map(d => d.name).join(', '),
          postedDate: j.updated_at,
          jdText: stripHtml(j.content || '').slice(0, 8000),
          sourceUrl: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
          sourceQuery: `greenhouse:${slug}`,
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
  name: 'Greenhouse Direct',
  requires: [],
  rateLimit: { rpm: 120 },
  discover,
};
