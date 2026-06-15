/**
 * Source: RemoteOK (remote-first job board, public JSON API).
 *
 * Endpoint: GET https://remoteok.com/api
 * Returns the full recent feed as a JSON array; element 0 is a legal notice
 * object ({ legal: "..." }) that must be skipped. RemoteOK asks that
 * consumers link back to the original posting URL (we always apply via the
 * original `url`) and set a descriptive User-Agent.
 *
 * Fields per job: { id, slug, position, company, location, tags[],
 *   date (ISO), url, apply_url, description (HTML),
 *   salary_min, salary_max }
 *
 * Filtering is local: the API has no search param, so we pull the feed once
 * and keep ML/AI/DS roles by title+tags, then apply the recency window.
 */

const { createPosting } = require('../../../lib/posting');

const ID = 'remoteok';

// Title-only filter. Tag-based inclusion was tried first and leaked broadly
// (RemoteOK tags "ai"/"ml" appear on HR and merchandising posts), so role
// relevance is decided on the position title alone.
const ROLE_MATCH = /\b(machine[\s-]*learning|ml engineer|mlops|deep learning|llm|data scien|applied scientist|artificial intelligence|ai engineer|ai\/ml|ml\/ai|data engineer)\b/i;

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function roleRelevant(job) {
  return ROLE_MATCH.test(job.position || '');
}

function withinAge(iso, maxAgeDays) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) <= maxAgeDays * 86400000;
}

function comp(job) {
  if (job.salary_min && job.salary_max) return `$${job.salary_min} - $${job.salary_max}`;
  if (job.salary_min) return `$${job.salary_min}+`;
  return null;
}

async function discover(ctx) {
  const { filters, logger } = ctx;
  const maxAgeDays = filters.maxAgeDays || 30;

  let feed;
  try {
    const res = await fetch('https://remoteok.com/api', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`RemoteOK ${res.status}`);
    feed = await res.json();
  } catch (err) {
    logger.warn(`[${ID}] feed fetch failed: ${err.message}`);
    return [];
  }
  if (!Array.isArray(feed)) { logger.warn(`[${ID}] unexpected feed shape`); return []; }

  const jobs = feed.filter(j => j && j.position && j.company);
  const all = [];
  for (const j of jobs) {
    if (!roleRelevant(j)) continue;
    if (!withinAge(j.date, maxAgeDays)) continue;
    // RemoteOK location strings look like "Remote", "🌏 Worldwide",
    // "🇺🇸 United States". Normalize to ASCII-ish for the classifier.
    const rawLoc = String(j.location || '').replace(/[^\x20-\x7E]/g, ' ').trim();
    const p = createPosting({
      title: j.position,
      company: j.company,
      location: rawLoc ? `Remote - ${rawLoc}` : 'Remote',
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug || j.id}`,
      postedDate: j.date,
      sourceUrl: 'https://remoteok.com/api',
      sourceQuery: 'feed:ml-ai-ds',
      jdText: stripHtml(j.description).slice(0, 4000),
      compensation: comp(j),
    }, ID);
    if (p) all.push(p);
  }
  logger.info(`[${ID}] feed ${jobs.length} jobs -> ${all.length} ML/AI/DS within ${maxAgeDays}d`);

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'RemoteOK (remote-first board, public feed)',
  requires: [],
  rateLimit: { rpm: 10 },
  discover,
};
