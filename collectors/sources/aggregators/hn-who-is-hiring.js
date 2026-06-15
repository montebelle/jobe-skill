/**
 * Source: Hacker News "Who is Hiring?" monthly thread.
 *
 * Uses Algolia HN Search API (no auth required). The 1st of every month
 * HN pins a "Ask HN: Who is hiring?" thread where founders post open roles,
 * often at early/growth-stage startups not yet on any ATS.
 *
 * Algolia search URL:
 *   https://hn.algolia.com/api/v1/search?tags=story&query=Who%20is%20hiring
 * Then fetch the latest thread and parse its comments for ML/AI roles.
 */

const { createPosting } = require('../../../lib/posting');
const { textClean } = require('../../../lib/posting');
const { makeTitleMatcher } = require('../../../lib/role-queries');

const ID = 'hn-who-is-hiring';
const AUTHOR = 'whoishiring';

async function findLatestThreads(maxThreads = 2) {
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story,author_${AUTHOR}&hitsPerPage=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN ${res.status}`);
  const data = await res.json();
  return (data.hits || [])
    .filter(h => /who is hiring/i.test(h.title || ''))
    .slice(0, maxThreads)
    .map(h => ({ objectID: h.objectID, title: h.title, createdAt: h.created_at_i }));
}

async function fetchThreadComments(threadId) {
  const url = `https://hn.algolia.com/api/v1/items/${threadId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN thread ${res.status}`);
  return res.json();
}

// ── Parse an HN hiring comment ─────────────────────────────

function parseComment(text, threadId) {
  if (!text) return null;
  const plain = textClean(text.replace(/<[^>]+>/g, '\n'));

  // Typical header: "Company | Role | Location | REMOTE | Salary | ..."
  const firstLine = plain.split('\n').find(l => l.trim().length > 0) || '';
  const parts = firstLine.split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean);

  let company = null, title = null, location = 'Unknown';
  if (parts.length >= 2) {
    company = parts[0];
    title = parts[1];
    for (const p of parts.slice(2)) {
      if (/remote|hybrid|onsite/i.test(p) || /[A-Z][a-z]+,\s*[A-Z]{2}/.test(p) || /usa|united states|uk|canada|europe/i.test(p)) {
        location = p;
        break;
      }
    }
  } else {
    // No pipes - try to extract company and role from first sentence
    const m = plain.match(/^([A-Z][A-Za-z0-9 &.,-]{1,40})\s*[-:]\s*([A-Z][A-Za-z ,/]{3,80})/);
    if (m) { company = m[1].trim(); title = m[2].trim(); }
  }

  if (!company || !title) return null;

  // Extract apply URL
  const urlMatch = plain.match(/https?:\/\/[^\s)>\]]+/);
  if (!urlMatch) return null;

  return {
    company, title, location,
    url: urlMatch[0],
    jdText: plain.slice(0, 4000),
    sourceUrl: `https://news.ycombinator.com/item?id=${threadId}`,
  };
}

// ── discover ────────────────────────────────────────────────

async function discover(ctx) {
  const { logger } = ctx;
  // Match each free-form HN comment (title + body) against the user's target
  // roles. Permissive when unconfigured.
  const titleOk = makeTitleMatcher(ctx);

  const all = [];
  try {
    const threads = await findLatestThreads(2);
    logger.info(`[${ID}] found ${threads.length} recent "Who is hiring" threads`);

    for (const thread of threads) {
      try {
        const full = await fetchThreadComments(thread.objectID);
        const walk = (node) => {
          if (!node) return;
          if (node.text) {
            const parsed = parseComment(node.text, thread.objectID);
            if (parsed && titleOk(`${parsed.title} ${parsed.jdText}`)) {
              const posting = createPosting({
                ...parsed,
                postedDate: new Date(thread.createdAt * 1000).toISOString(),
                sourceQuery: thread.title,
              }, ID);
              if (posting) all.push(posting);
            }
          }
          for (const child of node.children || []) walk(child);
        };
        walk(full);
        logger.info(`[${ID}] thread ${thread.objectID}: ${all.length} matches so far`);
      } catch (err) {
        logger.warn(`[${ID}] thread ${thread.objectID} failed: ${err.message}`);
      }
    }
  } catch (err) {
    logger.warn(`[${ID}] discovery failed: ${err.message}`);
  }

  const seen = new Set();
  return all.filter(p => {
    if (seen.has(p.canonicalUrl)) return false;
    seen.add(p.canonicalUrl);
    return true;
  });
}

module.exports = {
  id: ID,
  name: 'Hacker News Who-is-hiring',
  requires: [],
  rateLimit: { rpm: 60 },
  discover,
};
