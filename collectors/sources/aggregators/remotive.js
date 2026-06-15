/**
 * Source: Remotive (remote-first job board, public JSON API).
 *
 * Endpoint: GET https://remotive.com/api/remote-jobs?search=<kw>&limit=100
 * Docs: https://github.com/remotive-com/remote-jobs-api
 * No API key required. Polite use requested by Remotive (do not hammer);
 * we run a handful of role-keyword queries per pipeline run with a delay.
 *
 * Every posting on Remotive is remote by construction, which matches the
 * default remote-only profile filter. US eligibility is classified from
 * `candidate_required_location` (e.g. "USA Only", "Worldwide", "Europe").
 *
 * Response shape: { jobs: [{ id, url, title, company_name, category,
 *   candidate_required_location, publication_date, salary, description }] }
 */

const { createPosting } = require('../../../lib/posting');

const ID = 'remotive';

// Compact role sweep. Remotive search is broad-match; a few umbrella terms
// out-recall many narrow ones and keep us polite on their API.
const ROLE_QUERIES = [
  'machine learning',
  'data scientist',
  'ai engineer',
];

// Remotive's `search` matches descriptions too (sales roles surface for
// "ai engineer"), so titles are re-filtered locally before normalization.
const TITLE_MATCH = /\b(machine[\s-]*learning|ml engineer|mlops|deep learning|llm|data scien|applied scientist|artificial intelligence|ai engineer|ai\/ml|ml\/ai)\b/i;

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function withinAge(iso, maxAgeDays) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) <= maxAgeDays * 86400000;
}

async function fetchJobs(search) {
  const qs = new URLSearchParams({ search, limit: '100' });
  const res = await fetch(`https://remotive.com/api/remote-jobs?${qs}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Remotive ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.jobs) ? data.jobs : [];
}

async function discover(ctx) {
  const { filters, logger } = ctx;
  const maxAgeDays = filters.maxAgeDays || 30;
  const all = [];

  for (const q of ROLE_QUERIES) {
    try {
      const jobs = await fetchJobs(q);
      let kept = 0;
      for (const j of jobs) {
        if (!TITLE_MATCH.test(j.title || '')) continue;
        if (!withinAge(j.publication_date, maxAgeDays)) continue;
        // candidate_required_location drives US classification downstream:
        // "Remote - USA Only" parses as remote+us; "Remote - Europe" gets
        // dropped by the US gate.
        const loc = j.candidate_required_location
          ? `Remote - ${j.candidate_required_location}`
          : 'Remote';
        const p = createPosting({
          title: j.title,
          company: j.company_name,
          location: loc,
          url: j.url,
          postedDate: j.publication_date,
          sourceUrl: `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}`,
          sourceQuery: q,
          jdText: stripHtml(j.description).slice(0, 4000),
          compensation: j.salary || null,
        }, ID);
        if (p) { all.push(p); kept++; }
      }
      logger.info(`[${ID}] "${q}" -> ${jobs.length} jobs, ${kept} within ${maxAgeDays}d`);
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      logger.warn(`[${ID}] query "${q}" failed: ${err.message}`);
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Remotive (remote-first board, public API)',
  requires: [],
  rateLimit: { rpm: 30 },
  discover,
};
