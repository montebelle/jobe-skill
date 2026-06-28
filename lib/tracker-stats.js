/**
 * Tracker-derived company statistics.
 *
 * Populates companyStats.hiresPerPosting for lib/ghost-score.js by reading
 * data/tracker.md and computing, per company:
 *   - postings: how many times we applied to this company
 *   - responses: how many got past "Applied" (Responded / Interviewing / Offer)
 *   - ratio: responses / postings (noisy proxy for hires/posting)
 *
 * This is a noisy proxy. The Revelio Labs 2024 number (0.5 baseline) is
 * industry-wide; the user's personal experience converts at a different rate.
 * For ghost-scoring purposes, what matters is the relative comparison
 * between companies: a company where the user has applied 5 times with 0
 * responses is more likely a ghost than one with 2/3 responses.
 *
 * Writes derived stats back into data/companies/index.json per-company
 * so pipeline.js can pick them up without recomputing.
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');
const { companySlug } = require('./posting');
const { atomicWrite } = require('./tracker-writer');

const TRACKER_PATH = () => path.join(getProjectRoot(), 'data', 'tracker.md');
const INDEX_PATH = () => path.join(getProjectRoot(), 'data', 'companies', 'index.json');

function parseTracker() {
  const file = TRACKER_PATH();
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*\d+\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]*)\|\s*([^|]+)\|/);
    if (!m) continue;
    rows.push({
      date: m[1].trim(),
      company: m[2].trim(),
      role: m[3].trim(),
      score: parseFloat(m[4].trim()) || null,
      status: m[5].trim(),
    });
  }
  return rows;
}

const RESPONDED_STATUSES = new Set(['Responded', 'Interviewing', 'Offer']);

function computeCompanyStats() {
  const rows = parseTracker();
  const byCompany = new Map();
  for (const r of rows) {
    const slug = companySlug(r.company);
    if (!slug) continue;
    if (!byCompany.has(slug)) byCompany.set(slug, { applications: 0, responses: 0, rejections: 0, evaluations: 0 });
    const stats = byCompany.get(slug);
    if (r.status === 'Applied') stats.applications++;
    else if (r.status === 'Evaluated') stats.evaluations++;
    else if (r.status === 'Rejected') stats.rejections++;
    else if (RESPONDED_STATUSES.has(r.status)) { stats.applications++; stats.responses++; }
  }
  const out = {};
  for (const [slug, stats] of byCompany) {
    out[slug] = {
      ...stats,
      // Require a meaningful sample before trusting the user's personal conversion
      // rate as a (weak, capped) ghost proxy. 3 was far too few -- one or two
      // unanswered applications would flag every posting at a company.
      hiresPerPosting: stats.applications >= 8 ? stats.responses / stats.applications : null,
    };
  }
  return out;
}

/**
 * Merge computed stats into data/companies/index.json.
 * Non-destructive: only adds hiresPerPosting and application/response counts;
 * preserves all other fields. Atomic write.
 */
function mergeIntoIndex() {
  const indexFile = INDEX_PATH();
  const idx = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  const stats = computeCompanyStats();
  for (const [slug, s] of Object.entries(stats)) {
    if (!idx[slug]) idx[slug] = {};
    idx[slug] = {
      ...idx[slug],
      applications: s.applications,
      responses: s.responses,
      rejections: s.rejections,
      hiresPerPosting: s.hiresPerPosting,
      statsUpdatedAt: new Date().toISOString(),
    };
  }
  const sorted = Object.keys(idx).sort().reduce((acc, k) => (acc[k] = idx[k], acc), {});
  atomicWrite(indexFile, JSON.stringify(sorted, null, 2));
  return Object.keys(stats).length;
}

module.exports = { parseTracker, computeCompanyStats, mergeIntoIndex };
