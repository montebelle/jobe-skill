#!/usr/bin/env node
'use strict';
/**
 * Final presentation gate for a ranked list: what is left is safe to show the
 * user and to generate resumes for.
 *
 * Every rule reads the user's own policy (data/profile.json through
 * lib/profile.js, company lists through lib/exclusions.js). With no policy the
 * only thing removed is a listing verified as closed, and a staffing agency
 * (on unless discovery.excludeStaffing is false).
 *
 *   work mode   discovery.workModes, through the pipeline's own strict gate
 *               (lib/profile.js modePass) on the VERIFIED work mode: it must
 *               be in the list, and a posting that states no mode counts as
 *               onsite. Verified means: the employer's ATS record
 *               (scripts/verify-listing.js), else the posting page
 *               (scripts/verify-remote.js or the ATS resolution), else the
 *               pipeline's own label for a posting that did not come from
 *               LinkedIn, else a verdict verify-listing.js marked as a guess
 *               (remoteGuess: a coarse reading never overrides a label read
 *               from the JD). A LinkedIn label alone is an assertion and
 *               never counts as remote, under any policy.
 *   still open  a listing verify-listing.js found closed or gone is left out;
 *               one it could not reach is kept with a note.
 *   score       minScore argument, else discovery.minScore, else no floor.
 *   company     the user's negative list plus the staffing list.
 *   title       discovery.titleExclude outside every discovery.titleKeep
 *               phrase (the pipeline's rule, lib/rank.js isRoleMatch).
 *   country     discovery.countries. Exactly ["US"]: the location must be
 *               positively in the United States (an unplaceable location is
 *               listed as "country unverified"). Any other list: dropped only
 *               when the location names a country outside it (lib/profile.js
 *               countryOk); a city alone is unknown and kept.
 *   region      discovery.regions, for work that needs the candidate on site
 *               (any verified mode but remote): the location must name one of
 *               the regions; a location that names no place is kept.
 *
 * Compensation is printed on every row: the published band, else what
 * verify-listing.js read from the ATS, else the marker "salary: fetch band"
 * (read the band from the live listing, or give a clearly labeled estimate).
 *
 *   node scripts/final-list.js [rankedFile] [minScore] [outFile] [--allow-onsite] [--no-us-only]
 *
 * rankedFile defaults to today's ranked-enriched.json in the active workspace.
 * --allow-onsite lifts the work mode gate and --no-us-only lifts the country
 * gate for this run (the same flags collectors/pipeline.js takes).
 */
const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('../lib/config');
const { loadProfile, discoveryFilters, titlePolicy, countryOk, regionOk, modePass } = require('../lib/profile');
const { loadExclusions } = require('../lib/exclusions');
const { companySlug, parseLocation, classifyUs, US_STATE_NAMES } = require('../lib/posting');
const { isRoleMatch } = require('../lib/rank');

// A US place the classifier in lib/posting.js leaves unplaced: a bare state
// name or a city with no state after it ("New York", "Remote - California").
// Read under a US only policy, and only when the classifier has no verdict.
// ponytail: a fixed list of large cities, so a smaller town with no state
// stays "country unverified". Upgrade path: the country and region classifier
// named above lib/profile.js countryOk.
const US_CITIES = 'san francisco|new york|nyc|seattle|austin|boston|chicago|denver|atlanta|los angeles|san diego|san jose|columbus|pittsburgh|philadelphia|phoenix|portland|miami|nashville|detroit|minneapolis|salt lake|raleigh|durham|bay area|mountain view|sunnyvale|palo alto|santa clara|fort worth';
const US_PLACE = new RegExp(`\\b(u\\.?s\\.?a?\\b|united states|${[...US_STATE_NAMES].join('|')}|${US_CITIES})`, 'i');

const sc = (p) => p.matchScore || p.quickScore || 0;
const isLi = (p) => !!p.linkedinUrl || /linkedin\.com\/jobs/i.test(p.canonicalUrl || p.url || '');
const employer = (p) => p.employerCorrection || p.company;

/** The best verified work mode for a posting: remote | hybrid | onsite | unknown. */
function workMode(p) {
  const v = p.verify || {};
  // The pipeline's own label: page verified, or re-derived from the JD. For a
  // LinkedIn row only a NOT remote reading counts (the page verdict, else the
  // label): a LinkedIn remote label alone is an assertion, never a label.
  const shown = p.verifiedWorkplace || p.remote;
  const own = p.verifyStatus === 'remote' ? 'remote'
    : !isLi(p) ? (p.remote && p.remote !== 'unknown' ? p.remote : null)
      : (shown === 'hybrid' || shown === 'onsite' ? shown : null);
  // The employer record decides, unless its verdict is only a guess
  // (verify-listing.js remoteGuess) and the pipeline has a label. A guessed
  // remote never stands for a LinkedIn row the page check did not confirm.
  const weak = v.remoteGuess && (own || (v.remote === 'remote' && isLi(p)));
  if (v.remote && v.remote !== 'unknown' && !weak) return v.remote;
  return own || 'unknown';
}

/**
 * Split postings into { keep, drop }. keep is sorted by score. drop holds
 * { p, reason } rows worth showing the user (excluded company, title, country,
 * region);
 * a posting that fails the work mode, still open, or score test is left out of
 * both, as it was never a candidate for the list.
 *
 * opts.filters overrides discoveryFilters(profile) key by key; opts.minScore,
 * opts.excluded (a Set of company slugs) and opts.titlePolicy replace the
 * profile driven values.
 */
function select(postings, opts = {}) {
  const profile = loadProfile();
  const f = { ...discoveryFilters(profile), ...opts.filters };
  const modes = f.workModes || [];
  // Here the list is the policy; the short form modePass reads follows it.
  const modeFilter = { workModes: modes, remoteOnly: modes.length === 1 && modes[0] === 'remote' };
  const countries = f.countries || [];
  const usOnly = countries.length === 1 && countries[0] === 'US';
  const minScore = opts.minScore ?? f.minScore ?? 0;
  const excluded = opts.excluded || loadExclusions({ excludeStaffing: f.excludeStaffing }).all;
  const policy = opts.titlePolicy || titlePolicy(profile);

  const keep = [], drop = [];
  for (const p of postings) {
    const v = p.verify || {};
    // An unverified LinkedIn label is 'unknown' here, so it can pass only as
    // onsite, and only when the pipeline's gate accepts the label itself.
    const mode = workMode(p);
    if (!modePass({ remote: mode }, modeFilter, true) || (mode === 'unknown' && !modePass(p, modeFilter, true))) continue;
    if ((v.stillOpen ?? p.stillOpen) === false || sc(p) < minScore) continue;

    // A corrected employer has no stored slug; slug it the way the lists are written.
    const slug = p.employerCorrection ? companySlug(p.employerCorrection) : (p.companySlug || companySlug(p.company));
    if (excluded.has(slug)) { drop.push({ p, reason: 'excluded company' }); continue; }
    const title = p.title || '';
    // With no role tokens isRoleMatch is the title policy alone.
    if (title && !isRoleMatch(title, { titlePolicy: policy })) { drop.push({ p, reason: 'title excluded' }); continue; }

    const loc = String(v.location || p.location || '');
    if (countries.length) {
      // The verified location decides: the classifier, else a US place it
      // leaves unplaced, else the pipeline's verdict.
      const us = classifyUs(parseLocation(loc).us, title) ?? (US_PLACE.test(loc) || p.us);
      if (usOnly ? us === false : !countryOk(loc, countries, title)) { drop.push({ p, reason: `outside country (${loc.slice(0, 28)})` }); continue; }
      if (usOnly && us !== true) { drop.push({ p, reason: `country unverified (${loc.slice(0, 28)})` }); continue; }
    }
    if (mode !== 'remote' && !regionOk(loc, f.regions)) { drop.push({ p, reason: `outside region (${loc.slice(0, 28)})` }); continue; }
    keep.push(p);
  }
  keep.sort((a, b) => sc(b) - sc(a));
  drop.sort((a, b) => sc(b.p) - sc(a.p));
  return { keep, drop, minScore, filters: f };
}

/** Never blank: a published band, else the marker that tells the reader to fetch one. */
function money(c) {
  if (!c) return 'salary: fetch band';
  if (typeof c === 'string') return c;
  const lo = c.min || c.low || c.from, hi = c.max || c.high || c.to;
  const cur = c.currency && c.currency !== 'USD' ? `${c.currency} ` : '$';
  // A stated pay period other than a year is shown, so a monthly band never reads as yearly.
  const per = c.period && !/^(year|annual)/i.test(c.period) ? `/${c.period}` : '';
  return lo || hi ? `${cur}${lo || '?'}-${hi || '?'}${per}` : 'salary: fetch band';
}

function format({ keep, drop, minScore, filters }) {
  const lines = [];
  const modes = (filters.workModes || []).join(', ') || 'any';
  const countries = (filters.countries || []).join(', ') || 'any';
  lines.push(`FINAL LIST (work modes: ${modes}; countries: ${countries}; score >= ${minScore}): ${keep.length}`, '');
  keep.forEach((p, i) => {
    const v = p.verify || {};
    const d = String(v.postedDate || p.postedDate || '').slice(0, 10) || 'date?';
    const mode = workMode(p);
    const via = p.atsResolved ? `ATS ${p.atsBoard || 'employer listing'}` : 'ats-direct';
    lines.push(`${String(i + 1).padStart(2)}. [${sc(p)}] ${employer(p)} | ${p.title}`);
    lines.push(`    ${d} | ${String(v.location || p.location || 'location?').slice(0, 46)} | ${mode === 'unknown' ? 'work mode unverified' : mode} | ${via} | ${money(p.compensation || v.comp)}`);
    // A listing the check could not reach is kept, and said so.
    if (v.status && v.stillOpen == null) lines.push(`    listing not confirmed open (${v.status}${v.detail ? `: ${v.detail}` : ''}): check the page`);
    if (p.minimumsUnmet && p.minimumsUnmet.length) lines.push(`    stated minimums not met: ${p.minimumsUnmet.join('; ')}`);
    lines.push(`    ${p.canonicalUrl || p.url}`);
  });
  lines.push('', `--- excluded (${drop.length}) ---`);
  drop.forEach(({ p, reason }) => lines.push(`  ${sc(p)} ${String(employer(p)).slice(0, 24).padEnd(24)} ${reason}`));
  return lines.join('\n');
}

function main(argv) {
  const [fileArg, scoreArg, outFile] = argv.filter((a) => !a.startsWith('--'));
  const file = fileArg ? path.resolve(fileArg)
    : path.join(getProjectRoot(), 'signals', 'discovered', new Date().toISOString().slice(0, 10), 'ranked-enriched.json');
  if (!fs.existsSync(file)) { console.log(`no ranked list at ${file}; run /jobe find first.`); return; }
  const filters = {};
  if (argv.includes('--allow-onsite')) filters.workModes = [];
  if (argv.includes('--no-us-only')) filters.countries = [];
  const result = select(JSON.parse(fs.readFileSync(file, 'utf8')), {
    filters, minScore: scoreArg !== undefined ? Number(scoreArg) : undefined,
  });
  if (outFile) { fs.writeFileSync(path.resolve(outFile), JSON.stringify(result.keep, null, 1)); console.error(`wrote ${result.keep.length} -> ${outFile}`); }
  console.log(format(result));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { select, workMode, money, format };
