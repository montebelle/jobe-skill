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
const USER_AGENT = 'jobe-discovery/1.0 (personal job search)';

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
    // Recency must key on the ORIGINAL publish date, never updated_at (which
    // re-stamps on every repost/refresh and made stale reqs look new).
    postedDate: data.first_published || data.updated_at,
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
      // The stated pay period rides along, so a monthly band is never read as yearly.
      ? { min: data.salaryRange.min, max: data.salaryRange.max, currency: data.salaryRange.currency || null,
          ...(data.salaryRange.interval ? { period: String(data.salaryRange.interval).replace(/^per-/i, '').replace(/-(salary|wage)$/i, '') } : {}) }
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
  const job = (data.jobs || []).find(j => j.id === id || String(j.jobUrl || j.applyUrl || '').includes(id));
  if (!job) return null;
  const text = stripHtml(job.descriptionHtml || job.description || job.descriptionPlain || '');
  let comp = null;
  const tier = job.compensation?.compensationTiers?.[0];
  const comp0 = tier?.components?.find(c => c.compensationType === 'Salary');
  if (comp0) comp = { min: comp0.minValue, max: comp0.maxValue, currency: comp0.currencyCode || null,
    ...(comp0.interval ? { period: String(comp0.interval).replace(/^\d+\s*/, '').toLowerCase() } : {}) };
  return {
    jdHtml: job.descriptionHtml || job.description || null,
    jdText: text,
    department: job.department || null,
    location: job.location || null,
    // Ashby's field is publishedAt (publishedDate does not exist), so the old
    // code always got null here. This is the original publish date.
    postedDate: job.publishedAt || job.publishedDate || null,
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
    if (c.min && c.max) comp = { min: c.min, max: c.max, currency: c.currency || null };
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

// Every caller passes text that went through posting.stripHtml, which folds a
// hyphen or dash into ", " or a space. So a range separator is a dash, "to",
// OR (only when the second figure repeats the currency sign) a comma or bare
// whitespace: "$70,000 - $85,000" arrives here as "$70,000, $85,000".
// ponytail: yearly ranges in the listed currency codes and the dollar, pound,
// and euro signs. Anything else does not parse, which the pay floor reads as
// unknown (kept). Upgrade path: a currency and pay period field filled by the
// sources.
const CODE = String.raw`(?:USD|GBP|EUR|CAD|AUD|NZD|SGD|CHF)`;
// stripHtml turns the pound and euro signs into "GBP" / "EUR" glued to the figure
// The code needs a left word boundary: "fraud 40,000" is not an AUD figure.
const CUR = String.raw`(?:[A-Z]{0,2}[$£€]|(?<![A-Za-z])${CODE}\s*\$?)`;
const SEP = String.raw`(?:\s*(?:[-–]{1,2}|to)\s*(?:${CUR})?|\s*,?\s*${CUR})\s*`;
const COMP_PATTERNS = [
  new RegExp(String.raw`${CUR}\s*(\d{2,3})[,.]?\d{3}${SEP}(\d{2,3})[,.]?\d{3}(?!\d)`, 'i'),
  new RegExp(String.raw`${CUR}\s*(\d{2,3})[kK]${SEP}(\d{2,3})[kK]`, 'i'),
  new RegExp(String.raw`(\d{2,3})[,.]?\d{3}\s*${CODE}\s*(?:[-–,]|to)?\s*(\d{2,3})[,.]?\d{3}\s*${CODE}`, 'i'),
];
const CODE_RE = new RegExp(String.raw`(?<![A-Za-z])${CODE}(?![A-Za-z])`, 'i');

// The currency the text itself states, or null. A bare "$" is used by a
// dozen currencies, so it is never labeled here; the caller decides.
function currencyOf(s) {
  const code = s.match(CODE_RE);
  if (code) return code[0].toUpperCase();
  if (s.includes('£')) return 'GBP';
  if (s.includes('€')) return 'EUR';
  if (/\bUS\$/i.test(s)) return 'USD';
  if (/\bCA?\$/.test(s)) return 'CAD';
  if (/\bAU?\$/.test(s)) return 'AUD';
  if (/\bNZ\$/.test(s)) return 'NZD';
  return null;
}

// A pay period other than a year stated right after the band ("/mo",
// "per hour", "a week"), or any "/unit" suffix that is not a year.
const PERIOD_RE = /^\W*(?:[A-Z]{3}\W+)?(?:per|an?|each)?\W*(hourly|hour|hr|monthly|month|mo|bi-?weekly|weekly|week|wk|daily|day|fortnight|pay\s+period)\b|^\s*\/\s*(?!yr|year|ann|pa\b)([a-z]+)/i;

/**
 * First pay band in the text: { min, max, currency, period? }.
 * currency is the code the text states, or null for a bare "$". period is set
 * only when the text states a pay period other than a year; such a band is
 * not a yearly figure and the pay floor treats it as unknown.
 */
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
      if (min > 0 && max >= min && max < 2_000_000) {
        const end = m.index + m[0].length;
        const out = { min, max, currency: currencyOf(text.slice(Math.max(0, m.index - 4), end + 5)) };
        const period = text.slice(end, end + 24).match(PERIOD_RE);
        if (period) out.period = (period[1] || period[2]).toLowerCase();
        return out;
      }
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

// A URL whose ATS exposes an authoritative original-publish date via fetchJd
// (Greenhouse first_published, Ashby publishedAt, Lever createdAt, ...). For
// these, postedDate must come from the ATS, never from a merged aggregator row.
function isKnownAts(url) {
  return /greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|\.myworkdayjobs\.com|jobs\.smartrecruiters\.com/i.test(url || '');
}

async function enrich(posting, { useCache = true, force = false } = {}) {
  // Short-circuit only if jdText is substantial (>= 1000 chars). Many sources
  // (search snippets, organic results, truncated forum descriptions)
  // pre-populate jdText with a 88-500 char teaser. Without this length check,
  // enrichment was skipped for those postings and they stayed at the neutral
  // score for lack of signal density.
  // Non-ATS rows with a substantial JD can short-circuit. ATS rows must NOT:
  // their postedDate has to be re-derived from the authoritative ATS field,
  // because an aggregator merge can stamp a scrape/repost date onto a row that
  // resolved to an ATS URL, slipping a stale req past the recency gate. This
  // is the enrichment layer's job: verify recency.
  const SUBSTANTIAL = 1000;
  if (posting.jdText && posting.jdText.length >= SUBSTANTIAL && !force && !isKnownAts(posting.canonicalUrl)) return posting;

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
          // Authoritative ATS date wins over any pre-existing (aggregator) date.
          postedDate: (isKnownAts(url) ? cached.postedDate : null) || posting.postedDate || cached.postedDate || null,
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
          // Authoritative ATS date wins over any pre-existing (aggregator) date.
          postedDate: (isKnownAts(url) ? data.postedDate : null) || posting.postedDate || data.postedDate || null,
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

module.exports = { enrich, liveness, fetchJd, extractCompFromText, cachePath, isKnownAts };
