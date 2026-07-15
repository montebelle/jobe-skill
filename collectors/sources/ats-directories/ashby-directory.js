/**
 * Source: Ashby directory discovery.
 *
 * Ashby does not publish a cross-customer job search, but the job-board API
 * per customer is public. We maintain a company index and expand it by
 * scraping the Ashby customers page on first run, then hitting each
 * customer's posting API.
 *
 * Endpoint per company:
 *   https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 *
 * The initial slug list is seeded from configs/portals.json and grown over
 * time by other sources (Google Jobs / site:) that surface Ashby-hosted roles.
 */

const path = require('path');
const fs = require('fs');
const { createPosting } = require('../../../lib/posting');
const { getProjectRoot, getSystemRoot } = require('../../../lib/config');
const { makeTitleMatcher } = require('../../../lib/role-queries');

const ID = 'ashby-directory';

function loadKnownSlugs() {
  // configs/portals.json is a SHARED system seed — read from the install root.
  try {
    const portals = JSON.parse(fs.readFileSync(path.join(getSystemRoot(), 'configs/portals.json'), 'utf8'));
    const list = Array.isArray(portals) ? portals : (portals.ashby || []);
    const slugs = list
      .filter(e => (typeof e === 'string') || e.ats === 'ashby')
      .map(e => typeof e === 'string' ? e : e.slug)
      .filter(Boolean);
    return new Set(slugs);
  } catch {
    return new Set();
  }
}

function loadCompanyIndex() {
  const p = path.join(getProjectRoot(), 'data/companies/index.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

async function fetchBoard(slug) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

// Fold Ashby's structured workplace signal into the location string so the
// canonical classifier (which keys off location/title text) classifies remote
// correctly instead of inferring from a bare city.
function ashbyLocation(j) {
  const base = j.location || '';
  const wt = j.workplaceType || '';
  if (/hybrid/i.test(wt)) return base ? `${base} (Hybrid)` : 'Hybrid';
  if (j.isRemote === true || /remote/i.test(wt)) {
    return /remote/i.test(base) ? base : (base ? `${base} (Remote)` : 'Remote');
  }
  return base;
}

async function discover(ctx) {
  const { logger } = ctx;
  const titleOk = makeTitleMatcher(ctx);
  const slugs = new Set([...loadKnownSlugs()]);

  // Merge slugs from the company index if present
  const idx = loadCompanyIndex();
  for (const [slug, meta] of Object.entries(idx)) {
    if (meta.ats === 'ashby') slugs.add(slug);
  }

  const all = [];
  logger.info(`[${ID}] scanning ${slugs.size} Ashby boards`);

  for (const slug of slugs) {
    try {
      const data = await fetchBoard(slug);
      if (!data || !data.jobs) continue;
      for (const j of data.jobs) {
        if (!titleOk(j.title)) continue;
        const comp = extractAshbyComp(j);
        const url = j.jobUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`;
        const p = createPosting({
          title: j.title,
          // Ashby's posting API exposes no org display name; title-case the
          // slug (Ashby slugs are usually a single word, so this reads cleanly).
          company: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          companySlug: slug,
          // workplaceType ("Remote"|"Hybrid"|"On-site") and isRemote are
          // authoritative here; fold them into the location string so the
          // canonical classifier sees them instead of guessing.
          location: ashbyLocation(j),
          url,
          department: j.department,
          postedDate: j.publishedDate || j.updatedAt,
          compensation: comp,
          sourceUrl: `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
          sourceQuery: `ashby:${slug}`,
          jdText: (j.descriptionPlain || j.description || '').replace(/<[^>]+>/g, ' ').slice(0, 8000),
        }, ID);
        if (p) all.push(p);
      }
    } catch (err) {
      logger.warn(`[${ID}] ${slug} failed: ${err.message}`);
    }
  }

  logger.info(`[${ID}] collected ${all.length} Ashby postings`);
  return all;
}

function extractAshbyComp(job) {
  const tier = job.compensation?.compensationTiers?.[0];
  const salary = tier?.components?.find(c => c.compensationType === 'Salary');
  if (!salary) return null;
  return {
    min: salary.minValue,
    max: salary.maxValue,
    currency: salary.currencyCode || 'USD',
  };
}

module.exports = {
  id: ID,
  name: 'Ashby Directory',
  requires: [],
  rateLimit: { rpm: 120 },
  discover,
};
