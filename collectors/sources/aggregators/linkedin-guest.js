/**
 * Source: LinkedIn Jobs guest search (NO LOGIN, no account risk).
 *
 * Uses the public guest endpoint that powers linkedin.com/jobs for
 * logged-out visitors:
 *   GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
 *     ?keywords=...&location=United%20States&f_WT=2&f_TPR=r<seconds>&start=0
 *
 * Params: f_WT=2 (remote work type), f_TPR=r<seconds> (posted within),
 * start (pagination, 25/page). Returns an HTML fragment of <li> job cards
 * parsed here with regex — no headless browser, no authenticated session,
 * no Camoufox. Design decision: the user's logged-in accounts are never
 * automated unattended; this endpoint is what any logged-out visitor sees.
 *
 * Fragility note: unofficial endpoint. May 429 under load or change markup.
 * All failures degrade to [] with a warning; the pipeline continues with
 * other sources. Politeness: ~2s between requests, capped pages per query.
 *
 * Card fields parsed: base-search-card__title (title), __subtitle (company),
 * job-search-card__location, <time datetime="YYYY-MM-DD">, base-card__full-link
 * (URL, tracking params stripped by canonicalizeUrl downstream).
 */

const { createPosting } = require('../../../lib/posting');
const { roleStrings } = require('../../../lib/role-queries');

const ID = 'linkedin-guest';

// Depth is env-overridable: LINKEDIN_GUEST_PAGES raises the cap for a "deep
// sweep" whose value is COMPANY DISCOVERY (growing the emergent company index
// in data/companies/index.json), not remote listings — the logged-out endpoint
// does not surface remote status (all cards show HQ cities even with f_WT=2).
const PAGES_PER_QUERY = Math.max(1, parseInt(process.env.LINKEDIN_GUEST_PAGES || '2', 10));
const DELAY_MS = 2200;
const MAX_ROLES = 4;         // politeness cap; roles come from the user's seeds

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decode(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function parseCards(html) {
  const cards = html.match(/<li>[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (const card of cards) {
    const title = decode((card.match(/base-search-card__title[^>]*>([\s\S]*?)<\//) || [])[1]);
    const company = decode((card.match(/base-search-card__subtitle[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1])
      || decode((card.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\//) || [])[1]);
    const location = decode((card.match(/job-search-card__location[^>]*>([\s\S]*?)<\//) || [])[1]);
    const datetime = (card.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1];
    const url = (card.match(/href="(https:\/\/[^"]*linkedin\.com\/jobs\/view\/[^"]+)"/) || [])[1];
    if (title && company && url) out.push({ title, company, location, datetime, url: decode(url) });
  }
  return out;
}

async function fetchPage(keywords, tprSeconds, remoteOnly, start) {
  const qs = new URLSearchParams({
    keywords,
    location: 'United States',
    f_TPR: `r${tprSeconds}`,
    start: String(start),
  });
  if (remoteOnly) qs.set('f_WT', '2');
  const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${qs}`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429) throw new Error('rate-limited (429) — backing off for this run');
  if (!res.ok) throw new Error(`LinkedIn guest ${res.status}`);
  return res.text();
}

async function discover(ctx) {
  const { filters, logger } = ctx;
  const maxAgeDays = filters.maxAgeDays || 30;
  const tprSeconds = maxAgeDays * 86400;
  const roles = roleStrings(ctx, { max: MAX_ROLES });
  if (!roles.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const all = [];

  outer:
  for (const q of roles) {
    for (let page = 0; page < PAGES_PER_QUERY; page++) {
      try {
        const html = await fetchPage(q, tprSeconds, filters.remoteOnly !== false, page * 25);
        const cards = parseCards(html);
        if (!cards.length) break; // no more results for this query
        for (const c of cards) {
          const p = createPosting({
            title: c.title,
            company: c.company,
            location: c.location || (filters.remoteOnly !== false ? 'Remote - United States' : ''),
            url: c.url,
            postedDate: c.datetime || null,
            sourceUrl: `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(q)}`,
            sourceQuery: q,
          }, ID);
          if (p) all.push(p);
        }
        logger.info(`[${ID}] "${q}" p${page} -> ${cards.length} cards`);
        await new Promise(r => setTimeout(r, DELAY_MS));
      } catch (err) {
        logger.warn(`[${ID}] "${q}" p${page} failed: ${err.message}`);
        if (/429/.test(err.message)) break outer; // stop entirely on rate-limit
        break; // next query on other errors
      }
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'LinkedIn Jobs guest search (no login)',
  requires: [],
  rateLimit: { rpm: 25 },
  discover,
};
