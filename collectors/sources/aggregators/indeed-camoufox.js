/**
 * Source: Indeed public logged-out search via Camoufox.
 *
 * Indeed does not expose a stable public search API. This collector drives the
 * same public search pages a logged-out visitor sees and extracts only listing
 * data. It never signs in, clicks Apply, follows /applystart links, or attempts
 * to pass a CAPTCHA / Cloudflare verification wall.
 *
 * OFF BY DEFAULT. This source launches a stealth browser against a site that
 * offers no public API, so it runs only when the user opts in:
 *   INDEED_CAMOUFOX_ENABLED=1
 * Once on it is low volume and runs as a normal /jobe find source. Queries are
 * the user's own seed roles. Run it alone with:
 *   INDEED_CAMOUFOX_ENABLED=1 node collectors/pipeline.js --source indeed-camoufox --no-enrich
 *
 * Optional controls:
 *   INDEED_CAMOUFOX_ENABLED=1       opt in (1/true/yes/on); anything else is off
 *   INDEED_CAMOUFOX_MAX_QUERIES=3   distinct ctx queries per run (1..20)
 *   INDEED_CAMOUFOX_PAGES=1         result pages per query (1..5; 10 jobs/page)
 *   INDEED_CAMOUFOX_DETAILS=5       detail panes hydrated per page (0..10)
 *   INDEED_CAMOUFOX_DELAY_MS=4000   delay between result pages (2000..30000)
 *   INDEED_CAMOUFOX_HEADLESS=1      set 0/false/no to watch the browser
 *
 * The host is indeed.com (the US site). The work mode facet and the location
 * come from the user's policy and seeds; nothing is assumed when they are unset.
 *
 * Selector policy: stable job keys, href semantics, accessible attributes, and
 * data-testid values come first. Generated CSS class names are fallbacks only.
 */

const { createPosting } = require('../../../lib/posting');
const { recencyDays } = require('../../../lib/profile');
// lib/apply/camoufox (and the browser behind it) is required lazily inside
// discover(), after the opt in and query gates, so loading this plugin for a
// dry run or with the source off never touches the browser stack.

const ID = 'indeed-camoufox';
const HOST = 'https://www.indeed.com';
const CHALLENGE = Symbol('indeed-challenge');

function boundedInt(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envBool(raw, fallback = true) {
  if (raw == null || raw === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// Opt in: only an explicit yes turns the source on.
function sourceEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.INDEED_CAMOUFOX_ENABLED || '').trim());
}

function cleanText(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function normalizePostedText(raw) {
  const text = cleanText(raw);
  const match = text.match(/\b(just posted|today|yesterday|\d+\+?\s+(?:minute|hour|day|week|month)s?\s+ago)\b/i);
  return match ? match[1] : null;
}

function indeedKey(rawUrl, dataJk) {
  if (dataJk && /^[a-z0-9_-]+$/i.test(dataJk)) return dataJk;
  try {
    const url = new URL(rawUrl, HOST);
    return url.searchParams.get('jk') || url.searchParams.get('vjk') || null;
  } catch {
    return null;
  }
}

function canonicalIndeedUrl(rawUrl, dataJk) {
  const jk = indeedKey(rawUrl, dataJk);
  if (!jk) return null;
  const out = new URL('/viewjob', HOST);
  out.searchParams.set('jk', jk);
  return out.toString();
}

function isDirectEmployerUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl, HOST);
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'indeed.com' || host.endsWith('.indeed.com') || host.endsWith('.indeedcdn.com')) return false;
    if (/\b(account|help|support|privacy|terms|legal)\b/i.test(url.pathname)) return false;
    return /(?:greenhouse\.io|lever\.co|ashbyhq\.com|workday\.com|smartrecruiters\.com|icims\.com|recruitee\.com|bamboohr\.com|workable\.com)$/i.test(host)
      || /\/(?:careers?|jobs?|positions?|openings?)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function chooseDirectEmployerUrl(urls) {
  return (urls || []).map(String).find(isDirectEmployerUrl) || null;
}

function isChallengePage(state) {
  const haystack = cleanText(`${state?.title || ''} ${state?.url || ''} ${state?.text || ''}`);
  return /security check|additional verification required|verify (?:that )?you are human|captcha|cf-chl|cloudflare|access denied|unusual traffic|ray id for this request/i.test(haystack);
}

// A seed with no location searches without one; no work mode is assumed.
function normalizeQuery(item) {
  if (typeof item === 'string') return { query: cleanText(item), location: '' };
  return {
    query: cleanText(item?.query || item?.keywords || ''),
    location: cleanText(item?.location || ''),
  };
}

function selectQueries(queries, limit) {
  const seen = new Set();
  const out = [];
  for (const item of queries || []) {
    const normalized = normalizeQuery(item);
    const key = normalized.query.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function buildSearchUrl(query, filters = {}, pageNumber = 0) {
  const days = recencyDays(filters);
  const maxAgeDays = days ? boundedInt(days, 30, 1, 120) : null;
  // The remote location and facet are sent only when the user's work mode
  // policy is exactly remote; otherwise the seed's own location, if it has one.
  const remoteOnly = filters?.remoteOnly === true;
  const where = remoteOnly ? 'Remote' : cleanText(query.location);
  const url = new URL('/jobs', HOST);
  url.searchParams.set('q', cleanText(query.query));
  if (where) url.searchParams.set('l', where);
  if (maxAgeDays) url.searchParams.set('fromage', String(maxAgeDays)); // null: no recency cut
  url.searchParams.set('sort', 'date');
  if (remoteOnly) url.searchParams.set('sc', '0kf:attr(DSQF7);');
  if (pageNumber > 0) url.searchParams.set('start', String(pageNumber * 10));
  return url.toString();
}

function normalizeCardRecord(raw) {
  const url = canonicalIndeedUrl(raw?.url, raw?.jk);
  if (!url) return null;
  const detailLocation = cleanText(raw.detailLocation);
  const location = detailLocation || cleanText(raw.location);
  const jdText = cleanText(raw.jdText).slice(0, 12000) || null;
  const detailExplicitlyRemote = raw.detailLoaded === true
    && (/\b(remote|work from home|wfh)\b/i.test(detailLocation)
      || /\b(this (?:role|position) is remote|fully remote|100% remote|remote-first)\b/i.test(jdText || ''));
  return {
    jk: indeedKey(url, raw.jk),
    title: cleanText(raw.detailTitle || raw.title),
    company: cleanText(raw.detailCompany || raw.company),
    location,
    postedDate: normalizePostedText(raw.postedDate),
    compensation: cleanText(raw.detailCompensation || raw.compensation) || null,
    jdText,
    indeedUrl: url,
    directUrl: chooseDirectEmployerUrl(raw.externalUrls),
    remoteVerified: detailExplicitlyRemote,
  };
}

function dedupeRecords(records) {
  const byKey = new Map();
  for (const raw of records || []) {
    const record = normalizeCardRecord(raw);
    if (!record || !record.title || !record.company) continue;
    const key = record.jk || record.indeedUrl;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, record);
      continue;
    }
    byKey.set(key, {
      ...prior,
      title: record.title || prior.title,
      company: record.company || prior.company,
      location: record.location || prior.location,
      postedDate: record.postedDate || prior.postedDate,
      compensation: record.compensation || prior.compensation,
      jdText: record.jdText || prior.jdText,
      directUrl: record.directUrl || prior.directUrl,
      remoteVerified: record.remoteVerified || prior.remoteVerified,
    });
  }
  return [...byKey.values()];
}

function recordToPosting(record, sourceUrl, sourceQuery) {
  const canonicalUrl = record.directUrl || record.indeedUrl;
  const p = createPosting({
    title: record.title,
    company: record.company,
    location: record.location,
    url: canonicalUrl,
    alternateUrls: canonicalUrl === record.indeedUrl ? [] : [record.indeedUrl],
    postedDate: record.postedDate,
    compensation: record.compensation,
    jdText: record.jdText,
    remoteVerified: record.remoteVerified,
    sourceUrl,
    sourceQuery,
  }, ID);
  return p;
}

async function pageState(page) {
  return {
    title: await page.title().catch(() => ''),
    url: page.url(),
    text: (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 12000),
  };
}

async function assertNoChallenge(page) {
  const state = await pageState(page);
  if (isChallengePage(state)) {
    const err = new Error('Indeed presented a verification/access-denied page; stopping this source');
    err.code = CHALLENGE;
    throw err;
  }
}

async function extractCards(page) {
  return page.evaluate(() => {
    const text = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const selectors = [
      'a[data-jk]:not([href*="apply"])',
      'a[href*="/viewjob?jk="]',
      'a[href*="/rc/clk?jk="]',
      'h2 a[href*="jk="]',
    ];
    const anchors = [...document.querySelectorAll(selectors.join(','))];
    const seen = new Set();
    const out = [];
    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute('href') || '';
      if (/\/apply(?:start)?(?:\?|\/|$)/i.test(href)) continue;
      let jk = anchor.getAttribute('data-jk');
      try {
        const url = new URL(href, location.href);
        jk ||= url.searchParams.get('jk') || url.searchParams.get('vjk');
      } catch { /* malformed links are ignored below */ }
      if (!jk || seen.has(jk)) continue;
      const card = anchor.closest('[data-testid="slider_item"], .job_seen_beacon, li') || anchor.parentElement;
      const find = (...candidates) => {
        for (const selector of candidates) {
          const value = text(card?.querySelector(selector));
          if (value) return value;
        }
        return '';
      };
      const title = anchor.getAttribute('aria-label')
        || anchor.querySelector('[title]')?.getAttribute('title')
        || text(anchor);
      const company = find('[data-testid="company-name"]', '[data-testid="companyName"]', '.companyName');
      const jobLocation = find('[data-testid="text-location"]', '[data-testid="job-location"]', '.companyLocation');
      const postedDate = find('[data-testid="myJobsStateDate"]', '[data-testid="date"]', '.date');
      const compensation = find('[data-testid="attribute_snippet_testid"]', '.salary-snippet-container', '[class*="salary"]');
      if (title && company) {
        seen.add(jk);
        out.push({ jk, url: href, title, company, location: jobLocation, postedDate, compensation });
      }
    }
    return out;
  });
}

async function extractVisibleDetail(page) {
  return page.evaluate(() => {
    const text = (selector) => {
      const node = document.querySelector(selector);
      return (node?.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const root = document.querySelector('#jobsearch-ViewjobPaneWrapper, [data-testid="jobsearch-ViewjobPaneWrapper"], main') || document;
    const externalUrls = [...root.querySelectorAll('a[href]')]
      .map(a => a.href)
      .filter(Boolean);
    return {
      detailLoaded: Boolean(document.querySelector('#jobDescriptionText, [data-testid="jobDescriptionText"]')),
      detailTitle: text('[data-testid="jobsearch-JobInfoHeader-title"]') || text('h1'),
      detailCompany: text('[data-testid="inlineHeader-companyName"]') || text('[data-company-name="true"]'),
      detailLocation: text('[data-testid="job-location"]') || text('[data-testid="jobsearch-JobInfoHeader-subtitle"]'),
      detailCompensation: text('#salaryInfoAndJobType') || text('[data-testid="jobsearch-JobMetadataHeader-item"]'),
      jdText: text('#jobDescriptionText') || text('[data-testid="jobDescriptionText"]'),
      externalUrls,
    };
  });
}

async function hydrateDetail(page, record, searchUrl) {
  const escapedJk = String(record.jk).replace(/[^a-z0-9_-]/gi, '');
  // Deliberately exclude /apply and generic jk links: only a search-result
  // title/view link may be clicked to populate the read-only detail pane.
  const locator = page.locator([
    `a[data-jk="${escapedJk}"]:not([href*="apply"])`,
    `a[href*="/viewjob?jk=${escapedJk}"]`,
    `a[href*="/rc/clk?jk=${escapedJk}"]`,
    `h2 a[href*="jk=${escapedJk}"]:not([href*="apply"])`,
  ].join(',')).first();
  if (!await locator.count()) return record;
  try {
    await locator.click({ timeout: 8000 });
    await page.locator('#jobDescriptionText, [data-testid="jobDescriptionText"]').first()
      .waitFor({ state: 'visible', timeout: 8000 });
    await assertNoChallenge(page);
    const detail = await extractVisibleDetail(page);
    const hydrated = { ...record, ...detail };
    if (!/\/jobs(?:\?|$)/.test(new URL(page.url()).pathname + new URL(page.url()).search)) {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await assertNoChallenge(page);
    }
    return hydrated;
  } catch (err) {
    if (err.code === CHALLENGE) throw err;
    // A verification wall may replace the page while we are waiting for the
    // detail pane; check again before treating a timeout as a harmless miss.
    await assertNoChallenge(page);
    return record;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function discover(ctx) {
  const logger = ctx?.logger || { info() {}, warn() {}, error() {} };
  if (!sourceEnabled()) {
    logger.info(`[${ID}] off by default (launches a browser); set INDEED_CAMOUFOX_ENABLED=1 to enable`);
    return [];
  }

  const maxQueries = boundedInt(process.env.INDEED_CAMOUFOX_MAX_QUERIES, 3, 1, 20);
  const pagesPerQuery = boundedInt(process.env.INDEED_CAMOUFOX_PAGES, 1, 1, 5);
  const detailsPerPage = boundedInt(process.env.INDEED_CAMOUFOX_DETAILS, 5, 0, 10);
  const delayMs = boundedInt(process.env.INDEED_CAMOUFOX_DELAY_MS, 4000, 2000, 30000);
  const headless = envBool(process.env.INDEED_CAMOUFOX_HEADLESS, true);
  const queries = selectQueries(ctx?.queries, maxQueries);
  if (!queries.length) {
    logger.info(`[${ID}] no seed roles; skipping`);
    return [];
  }

  let browserOrContext;
  let context;
  const collected = [];
  let challenged = false;
  try {
    const { launchCamoufox, newStealthPage } = require('../../../lib/apply/camoufox');
    browserOrContext = await launchCamoufox({ headless });
    const created = await newStealthPage(browserOrContext);
    context = created.context;
    const page = created.page;

    outer:
    for (const query of queries) {
      for (let pageNumber = 0; pageNumber < pagesPerQuery; pageNumber++) {
        const searchUrl = buildSearchUrl(query, ctx.filters, pageNumber);
        try {
          if (ctx?.limiter) await ctx.limiter.wait();
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await assertNoChallenge(page);
          await page.locator('a[data-jk], a[href*="/viewjob?jk="], a[href*="/rc/clk?jk="]')
            .first().waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
          await assertNoChallenge(page);

          const cards = await extractCards(page);
          if (!cards.length) {
            logger.warn(`[${ID}] "${query.query}" p${pageNumber + 1}: no public job cards found`);
            break;
          }
          const hydrated = [];
          for (let i = 0; i < cards.length; i++) {
            if (i < detailsPerPage) hydrated.push(await hydrateDetail(page, cards[i], searchUrl));
            else hydrated.push(cards[i]);
          }
          collected.push(...hydrated.map(raw => ({ raw, sourceUrl: searchUrl, sourceQuery: query.query })));
          logger.info(`[${ID}] "${query.query}" p${pageNumber + 1}: ${cards.length} cards, ${Math.min(cards.length, detailsPerPage)} detail attempts`);
          if (pageNumber + 1 < pagesPerQuery) await sleep(delayMs);
        } catch (err) {
          if (err.code === CHALLENGE) {
            challenged = true;
            logger.warn(`[${ID}] ${err.message}`);
            break outer;
          }
          logger.warn(`[${ID}] "${query.query}" p${pageNumber + 1} failed: ${err.message}`);
          break;
        }
      }
      await sleep(delayMs);
    }
  } catch (err) {
    logger.warn(`[${ID}] browser launch/run failed: ${err.message}`);
  } finally {
    if (context && context !== browserOrContext) await context.close().catch(() => {});
    if (browserOrContext) await browserOrContext.close().catch(() => {});
  }

  const normalized = dedupeRecords(collected.map(x => x.raw));
  const provenance = new Map();
  for (const item of collected) {
    const key = indeedKey(item.raw?.url, item.raw?.jk);
    if (key && !provenance.has(key)) provenance.set(key, item);
  }
  const out = normalized
    .map(record => {
      const source = provenance.get(record.jk) || {};
      return recordToPosting(record, source.sourceUrl || HOST, source.sourceQuery || null);
    })
    .filter(Boolean);
  logger.info(`[${ID}] ${out.length} unique listings${challenged ? ' before verification wall' : ''}`);
  return out;
}

module.exports = {
  id: ID,
  name: 'Indeed public search via Camoufox (logged out)',
  requires: ['INDEED_CAMOUFOX_ENABLED'], // opt in flag, not a key: off unless the user turns it on
  rateLimit: { rpm: 12 },
  discover,
  __test: {
    buildSearchUrl,
    canonicalIndeedUrl,
    chooseDirectEmployerUrl,
    dedupeRecords,
    envBool,
    isChallengePage,
    normalizeCardRecord,
    normalizePostedText,
    recordToPosting,
    selectQueries,
    sourceEnabled,
  },
};
