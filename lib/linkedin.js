/**
 * lib/linkedin.js — reusable helpers for the agent-driven LinkedIn logged-in
 * search sweep (modes/linkedin-search.md).
 *
 * WHY THIS LIVES IN A MODE, NOT collectors/pipeline.js:
 * The logged-in LinkedIn search is far richer than the logged-out guest
 * endpoint (collectors/sources/aggregators/linkedin-guest.js) — it surfaces
 * personalized + promoted listings from real companies the guest endpoint
 * never returns. But reaching it requires driving the user's authenticated
 * browser tab via the Chrome extension, which a headless Node source plugin
 * cannot do. So the DRIVE is agent-orchestrated (the mode), and the CODIFIABLE
 * parts — URL construction, accessibility-tree parsing, staffing-noise
 * filtering — live here so they are tested and reused.
 *
 * ACCOUNT-SAFETY (hard): this path drives the user's logged-in session, which
 * carries LinkedIn ToS / bot-detection risk. It is OPT-IN and user-present
 * only (the user explicitly invokes /jobe linkedin-search or /jobe find
 * --linkedin and watches it run). It is NEVER run unattended / headless / cron.
 * The default LinkedIn path remains the read-only linkedin-tab mode. Never
 * solve or bypass a CAPTCHA — if a visible challenge appears, stop.
 */

const fs = require('fs');
const path = require('path');
const { rawRoleStrings } = require('./role-queries');
const { loadProfile, discoveryFilters, titlePolicy, titleExcluded } = require('./profile');

const US_GEO_ID = '103644278';

const DATE_FILTERS = { any: '', day: 'r86400', week: 'r604800', month: 'r2592000' };
const WORKPLACE = { onsite: '1', remote: '2', hybrid: '3' };

/**
 * Default search queries derived from the user's target roles
 * (data/queries/seeds.json, written by `/jobe onboard`). The sweep runs each
 * query and paginates. There is NO hardcoded role vocabulary here — a nurse's
 * seeds produce nurse queries, an accountant's produce accountant queries.
 * A seed the user's own title policy excludes (a discovery.titleExclude phrase
 * outside every titleKeep phrase) is skipped: searching for a title that the pipeline
 * would drop only wastes page reads.
 * Returns [] when the user has no seeds yet; the mode then falls back to the
 * free-form query the user typed. Keep the effective list short and
 * high-signal — heavily overlapping queries waste page reads (dedup collapses
 * them anyway).
 */
function profileQueries({ root } = {}) {
  // An omitted root resolves to the active workspace, not the process CWD.
  root = root || require('./config').getUserRoot();
  let queries = [];
  try {
    queries = JSON.parse(fs.readFileSync(path.join(root, 'data/queries/seeds.json'), 'utf8')).queries || [];
  } catch { queries = []; }
  const policy = titlePolicy(loadProfile({ root }));
  return rawRoleStrings({ queries }).filter((q) => !titleExcluded(q, policy));
}

// The closest "date posted" preset to a recency window in days. A window wider
// than a month (or none) leaves the facet off; the pipeline's own recency gate
// does the exact cut afterwards.
function datePreset(maxAgeDays) {
  if (!(maxAgeDays > 0) || maxAgeDays > 30) return 'any';
  const days = { day: 1, week: 7, month: 30 };
  return Object.keys(days).reduce((best, k) => (Math.abs(days[k] - maxAgeDays) < Math.abs(days[best] - maxAgeDays) ? k : best));
}

/**
 * Build a LinkedIn jobs search URL from the user's discovery policy
 * (data/profile.json through lib/profile.js). With no policy there is no work
 * mode facet, no geo restriction, and the recency preset follows the default
 * window. An explicit argument always wins over the policy:
 *   remote      true forces the remote facet, false removes the work mode facet
 *   geoId       a LinkedIn geo id, or null for no geo restriction
 *   datePosted  one of the DATE_FILTERS keys
 *   filters     a ready filter object, in place of reading the profile
 * `start` paginates 25 per page.
 */
// ponytail: only the United States has a geo id here, so any other country
// list searches without a geo restriction and relies on the country gate
// downstream. Upgrade path: a geo id per country, or the `location` text param.
function buildSearchUrl({ keywords, geoId, remote, datePosted, start = 0, filters } = {}) {
  if (!keywords) throw new Error('buildSearchUrl: keywords required');
  const f = filters || discoveryFilters(loadProfile());
  const params = new URLSearchParams();
  params.set('keywords', keywords);
  if (geoId === undefined) geoId = f.usOnly ? US_GEO_ID : null;
  if (geoId) {
    params.set('geoId', geoId);
    params.set('distance', '25.0');
  }
  const modes = remote === true ? ['remote'] : remote === false ? [] : (f.workModes || []);
  const facets = modes.map((m) => WORKPLACE[m]).filter(Boolean);
  if (facets.length) params.set('f_WT', facets.join(','));
  const tpr = DATE_FILTERS[datePosted || datePreset(f.maxAgeDays)];
  if (tpr) params.set('f_TPR', tpr);
  if (start) params.set('start', String(start));
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

/**
 * Parse the Chrome extension's read_page (filter:"all") accessibility-tree
 * output for a LinkedIn jobs search results page into raw postings. Accepts
 * either the saved tool-result file content (a JSON array of {type,text}) or a
 * raw text dump. Robust to LinkedIn's duplicate-title nodes by keying company
 * off the card's "<Company> logo" image alt text.
 *
 * Returns: [{ title, company, location, postedDate, compensation, url }]
 */
function parseSearchCards(accessibilityText) {
  let txt = accessibilityText;
  try {
    const arr = JSON.parse(accessibilityText);
    if (Array.isArray(arr)) txt = arr.map(x => x.text || '').join('\n');
  } catch (_) { /* already plain text */ }

  const lines = txt.split('\n');
  const jobs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*listitem \[ref_\d+\]/.test(lines[i])) continue;
    const indent = lines[i].match(/^\s*/)[0].length;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const ind = lines[j].match(/^\s*/)[0].length;
      if (/^\s*listitem \[ref_\d+\]/.test(lines[j]) && ind <= indent) break;
      block.push(lines[j]);
    }
    const bt = block.join('\n');
    const link = bt.match(/link "(.+?)" \[ref_\d+\] href="(\/jobs\/view\/(\d+)\/[^"]*)"/);
    if (!link) continue;
    const logo = bt.match(/image "(.+?) logo"/);
    const title = link[1].replace(/ with verification$/, '');
    const company = logo ? logo[1] : '';
    let location = '';
    // ponytail: English workplace tags and a comma shape; a bare country name
    // with no tag is still missed. Upgrade path: take the generic that follows
    // the company node.
    for (const ln of block) {
      const g = ln.match(/generic "([^"]*(?:\((?:On-site|Hybrid|Remote)\)|Remote|United States|Area|, ?[A-Z])[^"]*)"/);
      if (g && ![title, link[1], company].includes(g[1])) { location = g[1]; break; }
    }
    // dollar, pound, euro, yen, rupee
    const comp = (bt.match(/generic "([^"]*[$\u00a3\u20ac\u00a5\u20b9][^"]+)"/) || [])[1] || '';
    let postedDate = '';
    const ageMatch = bt.match(/generic "([^"]*(?:ago|Reposted)[^"]*)"/);
    if (ageMatch) postedDate = ageMatch[1].replace(/Reposted\s*/, '');
    jobs.push({
      title,
      company,
      location,
      postedDate,
      compensation: comp || null,
      url: `https://www.linkedin.com/jobs/view/${link[3]}`,
    });
  }

  // de-dup by job id (LinkedIn repeats the active card in the detail pane)
  const seen = new Set();
  return jobs.filter(j => {
    const id = j.url.match(/jobs\/view\/(\d+)/)[1];
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

module.exports = {
  US_GEO_ID,
  DATE_FILTERS,
  WORKPLACE,
  profileQueries,
  datePreset,
  buildSearchUrl,
  parseSearchCards,
};
