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
const { stripHtml, parseLocation, classifyRemote, classifyUs } = require('./posting');
const { getProjectRoot } = require('./config');

// Re-derive remote/us/location from freshly-enriched data. The listing stage
// only saw a thin location string; the JD body (and a cleaner enriched
// location) frequently reveal that a "Remote"-labeled role is actually hybrid,
// or that an ambiguous "United States" role is genuinely remote.
function reclassify(posting, enrichedLocation) {
  const locStr = enrichedLocation || posting.location || '';
  const ploc = locStr ? parseLocation(locStr) : { remote: posting.remote, us: posting.us };
  posting.remote = classifyRemote(ploc.remote ?? posting.remote, posting.title, posting.jdText || '');
  // Re-derive US eligibility, but never let an enriched "United States" location
  // override a title that names a non-US region (e.g. "...- LATAM").
  const us = classifyUs(ploc.us != null ? ploc.us : posting.us, posting.title);
  if (us === false || ploc.us != null) posting.us = us;
  if (enrichedLocation && enrichedLocation.trim()) posting.location = enrichedLocation.trim();
}

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

async function extractWorkday(url) {
  // Workday posting URL patterns (with optional locale segment):
  //   https://{host}/{site}/job/{locationSlug}/{titleSlug}_{jobReqId}
  //   https://{host}/{locale}/{site}/job/{locationSlug}/{titleSlug}_{jobReqId}  (locale: en-US, fr-FR, etc.)
  // JD JSON endpoint:
  //   https://{host}/wday/cxs/{tenant}/{site}/job/{locationSlug}/{titleSlug}_{jobReqId}
  // Tenant is the first subdomain of {host} (e.g. nvidia.wd5.myworkdayjobs.com -> tenant=nvidia).
  const m = url.match(/^https?:\/\/([^./]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:([a-z]{2}-[A-Z]{2})\/)?([^/]+)\/job\/(.+)$/i);
  if (!m) return null;
  const [, tenant, wdver, _locale, site, restPath] = m;
  const host = `${tenant}.${wdver}.myworkdayjobs.com`;
  const api = `https://${host}/wday/cxs/${tenant}/${site}/job/${restPath}`;
  const res = await fetchWithTimeout(api, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const info = data.jobPostingInfo;
  if (!info) return null;
  const html = info.jobDescription || '';
  const text = stripHtml(html);
  const postedOn = info.postedOn || info.startDate || null;
  let postedDate = null;
  if (postedOn) {
    // "Posted 3 Days Ago" -> relative; pass through parseDate later in posting layer
    postedDate = typeof postedOn === 'string' && /^\d{4}-/.test(postedOn) ? postedOn : null;
  }
  return {
    jdHtml: html || null,
    jdText: text,
    department: info.jobFamily || null,
    location: info.location || (info.locationsText || null),
    postedDate,
    compensation: extractCompFromText(text),
  };
}

async function extractSmartRecruiters(url) {
  // https://jobs.smartrecruiters.com/{company}/{postingId}
  const m = url.match(/jobs\.smartrecruiters\.com\/([^/]+)\/([0-9a-f-]+)/i);
  if (!m) return null;
  const [, company, id] = m;
  const api = `https://api.smartrecruiters.com/v1/companies/${company}/postings/${id}`;
  const res = await fetchWithTimeout(api, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const sections = data.jobAd?.sections || {};
  const parts = [
    sections.companyDescription?.text,
    sections.jobDescription?.text,
    sections.qualifications?.text,
    sections.additionalInformation?.text,
  ].filter(Boolean);
  const text = stripHtml(parts.join('\n\n'));
  let comp = null;
  if (data.typeOfEmployment?.id && data.compensation) {
    const c = data.compensation;
    if (c.min && c.max) comp = { min: c.min, max: c.max, currency: c.currency || 'USD' };
  }
  return {
    jdHtml: parts.join('\n\n') || null,
    jdText: text,
    department: data.department?.label || null,
    location: data.location ? [data.location.city, data.location.region, data.location.country].filter(Boolean).join(', ') : null,
    postedDate: data.releasedDate || data.createdOn || null,
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
  if (/greenhouse\.io/i.test(url))            return extractGreenhouse(url);
  if (/jobs\.lever\.co/i.test(url))           return extractLever(url);
  if (/jobs\.ashbyhq\.com/i.test(url))        return extractAshby(url);
  if (/\.myworkdayjobs\.com/i.test(url))      return extractWorkday(url);
  if (/jobs\.smartrecruiters\.com/i.test(url)) return extractSmartRecruiters(url);
  return extractGeneric(url);
}

async function enrich(posting, { useCache = true, force = false } = {}) {
  // Short-circuit only if jdText is substantial (>= 1000 chars). Many sources
  // (Brave Search snippets, SerpAPI organic results, HN truncated descriptions)
  // pre-populate jdText with a 88-500 char teaser. Without this length check,
  // enrichment was skipped for those postings and they stayed at baseline
  // matchScore=50 for lack of signal density.
  const SUBSTANTIAL = 1000;
  if (posting.jdText && posting.jdText.length >= SUBSTANTIAL && !force) return posting;

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
        reclassify(posting, cached.location);
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
        reclassify(posting, data.location);
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
