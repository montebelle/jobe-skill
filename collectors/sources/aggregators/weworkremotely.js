/**
 * Source: We Work Remotely (remote-first job board, public RSS).
 *
 * Feeds (no key required):
 *   https://weworkremotely.com/remote-jobs.rss   (catch-all, 100 newest)
 *   https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss
 *   https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss
 * (The old remote-data-analysis-jobs category 301s; the catch-all covers it
 * and the title filter keeps only ML/AI/DS roles.)
 *
 * Item shape: <item><title>Company: Job Title</title><link/>
 *   <pubDate>RFC822</pubDate><description>HTML</description>
 *   <region>Anywhere in the World | USA Only | ...</region></item>
 *
 * Parsed with regex (no XML dependency). Role relevance is filtered by
 * keyword against the title since the programming categories carry plenty
 * of non-ML roles.
 */

const { createPosting } = require('../../../lib/posting');

const ID = 'weworkremotely';

const FEEDS = [
  'https://weworkremotely.com/remote-jobs.rss',
  'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
];

const ROLE_MATCH = /\b(machine[\s-]*learning|ml engineer|mlops|deep learning|llm|data scien|applied scientist|artificial intelligence|ai engineer|ai\/ml|ml\/ai|data engineer)\b/i;

function decodeEntities(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function tag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

function withinAge(rfc822, maxAgeDays) {
  const t = Date.parse(rfc822 || '');
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) <= maxAgeDays * 86400000;
}

async function discover(ctx) {
  const { filters, logger } = ctx;
  const maxAgeDays = filters.maxAgeDays || 30;
  const all = [];

  for (const feedUrl of FEEDS) {
    try {
      const res = await fetch(feedUrl, {
        headers: { 'Accept': 'application/rss+xml, application/xml', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`WWR ${res.status}`);
      const xml = await res.text();
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      let kept = 0;
      for (const item of items) {
        const rawTitle = tag(item, 'title');               // "Company: Job Title"
        const link = tag(item, 'link');
        const pubDate = tag(item, 'pubDate');
        const region = tag(item, 'region');
        const sep = rawTitle.indexOf(':');
        const company = sep > 0 ? rawTitle.slice(0, sep).trim() : '';
        const title = sep > 0 ? rawTitle.slice(sep + 1).trim() : rawTitle;
        if (!ROLE_MATCH.test(title)) continue;
        if (!withinAge(pubDate, maxAgeDays)) continue;
        const p = createPosting({
          title,
          company,
          location: region ? `Remote - ${region}` : 'Remote',
          url: link,
          postedDate: pubDate,
          sourceUrl: feedUrl,
          sourceQuery: 'rss:category-feed',
          jdText: stripHtml(tag(item, 'description')).slice(0, 4000),
        }, ID);
        if (p) { all.push(p); kept++; }
      }
      logger.info(`[${ID}] ${feedUrl.split('/').pop()} -> ${items.length} items, ${kept} ML/AI/DS within ${maxAgeDays}d`);
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      logger.warn(`[${ID}] feed failed (${feedUrl}): ${err.message}`);
    }
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'We Work Remotely (remote-first board, RSS)',
  requires: [],
  rateLimit: { rpm: 10 },
  discover,
};
