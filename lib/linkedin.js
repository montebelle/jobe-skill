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

const US_GEO_ID = '103644278';

const DATE_FILTERS = { any: '', day: 'r86400', week: 'r604800', month: 'r2592000' };
const WORKPLACE = { onsite: '1', remote: '2', hybrid: '3' };

/**
 * Default search queries derived from the user's target roles
 * (data/queries/seeds.json, written by `/jobe onboard`). The sweep runs each
 * query and paginates. There is NO hardcoded role vocabulary here — a nurse's
 * seeds produce nurse queries, an accountant's produce accountant queries.
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
  return rawRoleStrings({ queries });
}

/**
 * Build a LinkedIn jobs search URL with the user's hard filters baked in:
 * Remote (f_WT=2) + Past week (f_TPR=r604800, the closest preset to the 14-day
 * rule) + US geo (override via geoId). `start` paginates 25 per page.
 */
function buildSearchUrl({ keywords, geoId = US_GEO_ID, remote = true, datePosted = 'week', start = 0 } = {}) {
  if (!keywords) throw new Error('buildSearchUrl: keywords required');
  const params = new URLSearchParams();
  params.set('keywords', keywords);
  params.set('geoId', geoId);
  params.set('distance', '25.0');
  if (remote) params.set('f_WT', WORKPLACE.remote);
  const tpr = DATE_FILTERS[datePosted];
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
    let location = '';
    for (const ln of block) {
      const g = ln.match(/generic "([^"]*(?:Remote|United States|Area|, [A-Z]{2})[^"]*)"/);
      if (g) { location = g[1]; break; }
    }
    const comp = (bt.match(/generic "([^"]*\$[^"]+)"/) || [])[1] || '';
    let postedDate = '';
    const ageMatch = bt.match(/generic "([^"]*(?:ago|Reposted)[^"]*)"/);
    if (ageMatch) postedDate = ageMatch[1].replace(/Reposted\s*/, '');
    jobs.push({
      title: link[1].replace(/ with verification$/, ''),
      company: logo ? logo[1] : '',
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
  buildSearchUrl,
  parseSearchCards,
};
