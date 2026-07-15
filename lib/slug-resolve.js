/**
 * Resolve a company NAME to its real ATS + slug by probing the public
 * Greenhouse / Lever / Ashby board APIs with a few slug variants.
 *
 * Why this exists: the LinkedIn guest source (and SerpAPI/Google-Jobs) surface
 * company NAMES with linkedin.com/jobs/view URLs, so updateCompanyIndex files
 * them as ats:'other' — which the ATS-direct plugins (greenhouse/lever/ashby)
 * NEVER iterate (they only pick meta.ats === 'greenhouse' etc.). Resolving the
 * name to a real board slug promotes the entry so future runs harvest that
 * company's actual (well-labeled, filter-surviving) reqs. A large fraction of
 * guest names resolve in practice.
 *
 * Keyless, read-only GETs. Polite: short timeout, no retries, caller controls
 * concurrency. A resolve miss just means "leave it as 'other'".
 */

const https = require('https');

function get(url) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 }, (res) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
        // Resolve as soon as we have enough to detect the board (the "jobs" key
        // is in the first bytes), THEN abort — so a multi-MB board body neither
        // downloads fully nor hangs the promise (the old destroy-mid-data killed
        // 'end' and hung on every real board).
        if (d.length > 4000) { done({ status: res.statusCode, body: d.slice(0, 4000) }); req.destroy(); }
      });
      res.on('end', () => done({ status: res.statusCode, body: d }));
      res.on('error', () => done({ status: res.statusCode || 0, body: d }));
    });
    req.on('error', () => done({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); done({ status: 0, body: '' }); });
  });
}

// Slug variants to try for a company name, most-likely first. Greenhouse/Ashby
// tokens are usually the name lowercased with separators removed; Lever often
// keeps hyphens; some prepend nothing. Keep this small — each variant is 1-3
// network calls.
function slugVariants(name) {
  const base = String(name || '').toLowerCase().trim();
  if (!base) return [];
  const alnum = base.replace(/[^a-z0-9]/g, '');
  const hyphen = base.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const noSuffix = base.replace(/\b(inc|llc|ltd|corp|corporation|technologies|technology|labs|ai|io|group|co)\b/g, '').replace(/[^a-z0-9]/g, '');
  const andForm = base.replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  return [...new Set([alnum, hyphen, andForm, noSuffix].filter((s) => s && s.length >= 2))];
}

async function tryGreenhouse(slug) {
  const r = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  return r.status === 200 && /"jobs"\s*:/.test(r.body) && !/"jobs"\s*:\s*\[\s*\]/.test(r.body);
}
async function tryLever(slug) {
  const r = await get(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`);
  return r.status === 200 && /^\s*\[/.test(r.body) && r.body.length > 5;
}
async function tryAshby(slug) {
  const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return r.status === 200 && /"jobs"\s*:/.test(r.body) && !/"jobs"\s*:\s*\[\s*\]/.test(r.body);
}

/**
 * @param {string} name company display name
 * @returns {Promise<{ats:string, slug:string}|null>}
 */
async function resolveAts(name) {
  for (const slug of slugVariants(name)) {
    if (await tryGreenhouse(slug)) return { ats: 'greenhouse', slug };
    if (await tryAshby(slug)) return { ats: 'ashby', slug };
    if (await tryLever(slug)) return { ats: 'lever', slug };
  }
  return null;
}

/** Resolve many names with bounded concurrency. onResult(name, hit) per item. */
async function resolveMany(names, { concurrency = 6, onResult } = {}) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < names.length) {
      const name = names[i++];
      const hit = await resolveAts(name).catch(() => null);
      out.push({ name, hit });
      if (onResult) onResult(name, hit);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return out;
}

module.exports = { resolveAts, resolveMany, slugVariants };
