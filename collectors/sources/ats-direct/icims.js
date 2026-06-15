/**
 * Source: iCIMS direct (multi-tenant).
 *
 * iCIMS does not expose a stable public JSON API per customer, but almost
 * every customer-hosted board at careers-{co}.icims.com exposes a simple
 * HTML search page:
 *   GET https://{host}/jobs/search?ss=1&searchKeyword=<keywords>&pr=0
 * The result page contains anchor tags linking to the per-job page at
 *   https://{host}/jobs/{jobId}/{slug}/job
 * with the title in the anchor text and location in a nearby cell.
 *
 * Because iCIMS markup varies, this collector is best-effort: it parses the
 * anchor list and emits listing metadata only. Posting dates are usually not
 * in the listing HTML; enrich() will fetch the detail page later.
 */

const path = require('path');
const fs = require('fs');
const { createPosting, stripHtml } = require('../../../lib/posting');
const { getProjectRoot } = require('../../../lib/config');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');

const ID = 'icims';

function loadTenants() {
  const p = path.join(getProjectRoot(), 'data/companies/non-tech-seed.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data.icims || [];
  } catch {
    return [];
  }
}

async function fetchSearch(host, keyword) {
  const url = `https://${host}/jobs/search?ss=1&searchKeyword=${encodeURIComponent(keyword)}&pr=0`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (compatible; JobeDiscovery/1.0)'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) return null;
  return res.text();
}

function parseListings(html, host, titleOk) {
  // iCIMS listing anchors look like:
  //   <a href="/jobs/12345/some-title/job" ...>Some Title</a>
  // Location typically lives in the same table row (td.iCIMS_JobLocation) or
  // in a sibling span. A pure regex is fragile; we extract the anchors and
  // backfill location via a second regex on the surrounding HTML.
  const anchorRe = /<a[^>]+href="(\/jobs\/(\d+)\/[^"]+\/job[^"]*)"[^>]*>([^<]+)<\/a>/gi;
  const out = [];
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const hrefPath = m[1];
    const jobId = m[2];
    const title = stripHtml(m[3]).trim();
    if (!title || !titleOk(title)) continue;

    // Locate a nearby location string: scan +400 chars after the anchor
    const windowText = html.slice(m.index, m.index + 800);
    const locMatch =
      windowText.match(/class="[^"]*Location[^"]*"[^>]*>([^<]{2,80})</i) ||
      windowText.match(/iCIMS_JobHeadline[^>]*>[^<]*<[^>]*>([^<]{2,80})</i);
    const location = locMatch ? stripHtml(locMatch[1]).trim() : '';

    out.push({
      title,
      jobId,
      location,
      url: `https://${host}${hrefPath}`
    });
  }
  return out;
}

async function discover(ctx) {
  const { logger } = ctx;
  const tenants = loadTenants();
  if (tenants.length === 0) {
    logger.info(`[${ID}] no iCIMS tenants seeded; skipping`);
    return [];
  }
  const titleOk = makeTitleMatcher(ctx);
  const terms = roleStrings(ctx, { max: 3 });
  if (!terms.length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  logger.info(`[${ID}] scanning ${tenants.length} iCIMS tenants`);

  const all = [];
  const seen = new Set();
  for (const tenant of tenants) {
    let found = 0;
    for (const kw of terms) {
      try {
        const html = await fetchSearch(tenant.host, kw);
        if (!html) continue;
        const listings = parseListings(html, tenant.host, titleOk);
        for (const l of listings) {
          if (seen.has(l.url)) continue;
          seen.add(l.url);
          const slug = tenant.host.replace(/^careers[-.]?/, '').replace(/\.icims\.com.*$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
          const p = createPosting({
            title: l.title,
            company: tenant.company,
            companySlug: slug,
            location: l.location,
            url: l.url,
            sourceUrl: `https://${tenant.host}/jobs/search`,
            sourceQuery: `icims:${tenant.host}:${kw}`
          }, ID);
          if (p) { all.push(p); found++; }
        }
      } catch (err) {
        logger.warn(`[${ID}] ${tenant.host}/${kw}: ${err.message}`);
      }
    }
    if (found > 0) {
      logger.info(`[${ID}] ${tenant.host} (${tenant.industry || '?'}) -> ${found} roles`);
    }
  }
  return all;
}

module.exports = {
  id: ID,
  name: 'iCIMS Direct',
  requires: [],
  rateLimit: { rpm: 60 },
  discover
};
