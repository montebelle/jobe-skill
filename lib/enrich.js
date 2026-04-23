/**
 * Per-posting enrichment.
 *
 * enrich(posting) attaches JD text, compensation, and liveness info to a
 * Posting. Uses a filesystem cache at signals/cache/jd/{hash}.json with a
 * 30-day TTL. Liveness checks share the same cache.
 *
 * Enrichment is idempotent and safe to re-run. A failed fetch leaves the
 * cache empty so the next run retries.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stripHtml } = require('./posting');
const { getProjectRoot } = require('./config');

const CONTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days for JD text
const LIVENESS_DEAD_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days for 404/403 marks
const LIVENESS_ALIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for alive marks without content
const TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (compatible; JobePositioningSkill/1.0)';

function cachePath(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  return path.join(getProjectRoot(), 'signals', 'cache', 'jd', `${h}.json`);
}

function readCache(url) {
  const p = cachePath(url);
  if (!fs.existsSync(p)) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(p, 'utf8'));
    const age = Date.now() - entry.cachedAt;
    // Tiered TTL: content lives 30 days; liveness marks expire faster so
    // re-opened reqs can be rediscovered.
    if (entry.jdText) {
      if (age > CONTENT_TTL_MS) return null;
    } else if (entry.alive === false) {
      if (age > LIVENESS_DEAD_TTL_MS) return null;
    } else {
      if (age > LIVENESS_ALIVE_TTL_MS) return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function writeCache(url, data) {
  const p = cachePath(url);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ url, cachedAt: Date.now(), ...data }, null, 2));
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── JD extraction per host ──────────────────────────────────

async function extractGreenhouse(url) {
  // Derive board API endpoint from URL
  // https://job-boards.greenhouse.io/{slug}/jobs/{id}
  // https://boards.greenhouse.io/{slug}/jobs/{id}
  const m = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=|embed\/)?([^/]+)(?:\/jobs\/|\?.*for=\1.*&job_id=|\/embed\/job_app\?for=\1.*&id=)(\d+)/);
  const m2 = url.match(/greenhouse\.io\/([^/?]+)\/jobs\/(\d+)/);
  const match = m || m2;
  if (!match) return null;
  const [, slug, id] = match;
  const api = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`;
  const res = await fetchWithTimeout(api);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    jdHtml: data.content || null,
    jdText: stripHtml(data.content || ''),
    department: (data.departments || []).map(d => d.name).join(', '),
    location: data.location?.name,
    postedDate: data.updated_at,
    compensation: extractCompFromText(stripHtml(data.content || '')),
  };
}

async function extractLever(url) {
  // https://jobs.lever.co/{slug}/{id}
  const m = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]+)/);
  if (!m) return null;
  const [, slug, id] = m;
  const api = `https://api.lever.co/v0/postings/${slug}/${id}`;
  const res = await fetchWithTimeout(api);
  if (!res.ok) return null;
  const data = await res.json();
  const text = [data.descriptionPlain || stripHtml(data.description || ''), ...(data.lists || []).map(l => `\n\n## ${l.text}\n${stripHtml(l.content || '')}`), data.additionalPlain || stripHtml(data.additional || '')].join('\n');
  return {
    jdHtml: data.description || null,
    jdText: text.trim(),
    department: data.categories?.team || null,
    location: data.categories?.location || null,
    postedDate: data.createdAt ? new Date(data.createdAt).toISOString() : null,
    compensation: data.salaryRange
      ? { min: data.salaryRange.min, max: data.salaryRange.max, currency: data.salaryRange.currency || 'USD' }
      : extractCompFromText(text),
  };
}

async function extractAshby(url) {
  // https://jobs.ashbyhq.com/{slug}/{id}
  const m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]+)/);
  if (!m) return null;
  const [, slug, id] = m;
  const api = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  const res = await fetchWithTimeout(api);
  if (!res.ok) return null;
  const data = await res.json();
  const job = (data.jobs || []).find(j => j.id === id);
  if (!job) return null;
  const text = stripHtml(job.description || job.descriptionPlain || '');
  let comp = null;
  const tier = job.compensation?.compensationTiers?.[0];
  const comp0 = tier?.components?.find(c => c.compensationType === 'Salary');
  if (comp0) comp = { min: comp0.minValue, max: comp0.maxValue, currency: comp0.currencyCode || 'USD' };
  return {
    jdHtml: job.description || null,
    jdText: text,
    department: job.department || null,
    location: job.location || null,
    postedDate: job.publishedDate || null,
    compensation: comp || extractCompFromText(text),
  };
}

async function extractGeneric(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const html = await res.text();
  return {
    jdHtml: html,
    jdText: stripHtml(html).slice(0, 15000),
    compensation: extractCompFromText(stripHtml(html)),
  };
}

// ── Compensation extraction ─────────────────────────────────

const COMP_PATTERNS = [
  /\$\s*(\d{2,3})[,.]?\d{3}\s*[-–to]{1,3}\s*\$?\s*(\d{2,3})[,.]?\d{3}/i,
  /\$\s*(\d{2,3})[kK]\s*[-–to]{1,3}\s*\$?\s*(\d{2,3})[kK]/i,
  /(\d{2,3})[,.]?\d{3}\s*USD\s*[-–to]{1,3}\s*(\d{2,3})[,.]?\d{3}\s*USD/i,
];

function extractCompFromText(text) {
  if (!text) return null;
  for (const re of COMP_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const minStr = m[1];
      const maxStr = m[2];
      let min = parseInt(minStr, 10);
      let max = parseInt(maxStr, 10);
      if (min < 1000) min *= 1000;
      if (max < 1000) max *= 1000;
      if (min > 0 && max >= min && max < 2_000_000) return { min, max, currency: 'USD' };
    }
  }
  return null;
}

// ── Dispatch ────────────────────────────────────────────────

async function fetchJd(url) {
  if (/greenhouse\.io/i.test(url))   return extractGreenhouse(url);
  if (/jobs\.lever\.co/i.test(url))  return extractLever(url);
  if (/jobs\.ashbyhq\.com/i.test(url)) return extractAshby(url);
  return extractGeneric(url);
}

async function enrich(posting, { useCache = true, force = false } = {}) {
  if (posting.jdText && !force) return posting;

  const urls = [posting.canonicalUrl, ...(posting.alternateUrls || [])];
  for (const url of urls) {
    if (useCache && !force) {
      const cached = readCache(url);
      if (cached && cached.jdText) {
        Object.assign(posting, {
          jdText: cached.jdText,
          jdHtml: cached.jdHtml || posting.jdHtml,
          compensation: posting.compensation || cached.compensation || null,
          department: posting.department || cached.department || null,
          alive: cached.alive !== false,
        });
        return posting;
      }
    }

    try {
      const data = await fetchJd(url);
      if (!data || data.error) { writeCache(url, { alive: false, error: data?.error || 'unknown' }); continue; }
      if (data.jdText && data.jdText.length > 100) {
        writeCache(url, { ...data, alive: true });
        Object.assign(posting, {
          jdText: data.jdText,
          jdHtml: data.jdHtml || posting.jdHtml,
          compensation: posting.compensation || data.compensation || null,
          department: posting.department || data.department || null,
          postedDate: posting.postedDate || data.postedDate || null,
          alive: true,
        });
        return posting;
      }
    } catch (err) {
      // try next URL
    }
  }

  posting.alive = false;
  return posting;
}

async function liveness(url) {
  const cached = readCache(url);
  if (cached && typeof cached.alive === 'boolean') return cached.alive;
  try {
    const res = await fetchWithTimeout(url, { method: 'HEAD', timeout: 8000 });
    const alive = res.status >= 200 && res.status < 400;
    writeCache(url, { alive });
    return alive;
  } catch {
    writeCache(url, { alive: false });
    return false;
  }
}

module.exports = { enrich, liveness, fetchJd, extractCompFromText, cachePath };
