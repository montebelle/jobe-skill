/**
 * Source: Personio direct (hosted job boards, one tenant per subdomain).
 *
 * Every Personio hosted careers board exposes a public XML feed used by its
 * own widget:
 *   GET https://{sub}.jobs.personio.com/xml
 * Response (root <workzag-jobs>), one <position> per opening:
 *   <position>
 *     <id>1234567</id>
 *     <subcompany>Example Division</subcompany>
 *     <office>Munich</office>
 *     <additionalOffices><office>Berlin</office>...</additionalOffices>
 *     <department>Finance &amp; Tax</department>
 *     <name>Tax Accountant (m/w/d)</name>
 *     <jobDescriptions>
 *       <jobDescription><name>..</name><value><![CDATA[<ul>..]]></value></jobDescription>
 *     </jobDescriptions>
 *     <createdAt>2024-11-13T14:10:41+00:00</createdAt>
 *   </position>
 * The public posting URL is https://{sub}.jobs.personio.com/job/{id}.
 *
 * A subdomain whose feed was disabled redirects to the vendor site, so
 * redirects are not followed and only a 200 XML body counts. Everything is
 * inline in the feed (no detail fetch per job).
 *
 * Tenants come from lib/ats-tenants.js (ctx.filters.atsSlugs.personio, the
 * portals seed files, the workspace company index). No tenant list ships. The
 * XML has no clean company field (<subcompany> is a division), so seed a
 * tenant as { "slug": ..., "name": ... } when the subdomain is not the company
 * name. Personio's customers are mostly European, so with a US country policy
 * most rows are dropped downstream, and for a user in Europe this is a strong
 * source. Keyless. Descriptions are frequently German.
 */

const { createPosting, stripHtml } = require('../../../lib/posting');
const { roleStrings, makeTitleMatcher } = require('../../../lib/role-queries');
const { loadTenants, prettify } = require('../../../lib/ats-tenants');

const ID = 'personio';

// Display name for a tenant with no pinned name: drop a trailing legal form.
function displayName(sub) {
  return prettify(sub.replace(/-(gmbh|ag|bv|se|inc|ltd|group)$/i, ''));
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

// Primary office = first <office> that is NOT inside <additionalOffices>.
function primaryOffice(block) {
  const trimmed = block.replace(/<additionalOffices>[\s\S]*?<\/additionalOffices>/i, '');
  return decodeEntities(tag(trimmed, 'office').trim());
}

function jobDescription(block) {
  const values = [...block.matchAll(/<value>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/value>/gi)]
    .map(m => m[1] || m[2] || '');
  return stripHtml(values.join('\n')).slice(0, 8000);
}

async function fetchFeed(sub) {
  const url = `https://${sub}.jobs.personio.com/xml`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/xml,text/xml', 'User-Agent': 'jobe-discovery/1.0 (personal job search)' },
    redirect: 'manual',               // a disabled feed redirects to the vendor site
    signal: AbortSignal.timeout(15000),
  });
  if (res.status !== 200) return null;
  return res.text();
}

async function discover(ctx) {
  const { logger } = ctx;
  if (!roleStrings(ctx, { max: 1 }).length) { logger.info(`[${ID}] no seed roles; skipping`); return []; }
  const tenants = loadTenants(ctx, ID);
  if (!tenants.length) { logger.info(`[${ID}] no tenants (seed "personio" in data/companies/portals.json or let the company index learn them); skipping`); return []; }
  // Role relevance is decided on the title alone (Personio <name>).
  const titleOk = makeTitleMatcher(ctx);
  logger.info(`[${ID}] scanning ${tenants.length} Personio boards`);

  const all = [];
  for (const t of tenants) {
    const sub = t.slug;
    const company = t.name || displayName(sub);
    let found = 0;
    try {
      const xml = await fetchFeed(sub);
      if (!xml) continue;
      for (const m of xml.matchAll(/<position>([\s\S]*?)<\/position>/gi)) {
        const block = m[1];
        const title = decodeEntities(tag(block, 'name').trim());
        if (!title || !titleOk(title)) continue;
        const id = tag(block, 'id').trim();
        if (!id) continue;
        const url = `https://${sub}.jobs.personio.com/job/${id}`;
        const p = createPosting({
          title,
          company,
          companySlug: sub,
          location: primaryOffice(block),
          url,
          department: decodeEntities(tag(block, 'department').trim()) || null,
          postedDate: tag(block, 'createdAt').trim(),
          jdText: jobDescription(block) || null,
          sourceUrl: `https://${sub}.jobs.personio.com/xml`,
          sourceQuery: `personio:${sub}`,
        }, ID);
        if (p) { all.push(p); found++; }
      }
    } catch (err) {
      logger.warn(`[${ID}] ${sub}: ${err.message}`);
    }
    if (found > 0) logger.info(`[${ID}] ${sub} (${company}) -> ${found} matching roles`);
  }

  const seen = new Set();
  return all.filter(p => !seen.has(p.canonicalUrl) && seen.add(p.canonicalUrl));
}

module.exports = {
  id: ID,
  name: 'Personio Direct (hosted boards)',
  requires: [],
  rateLimit: { rpm: 40 },
  discover,
};
