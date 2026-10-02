#!/usr/bin/env node
'use strict';

/**
 * Resolve every LinkedIn sourced posting to its REAL ATS listing.
 *
 * Design rule: a LinkedIn guest result is a DISCOVERY lead only. It yields a
 * company name, a title, and a login walled URL whose apply target sits behind
 * an offsite redirect. Scraping that redirect is unreliable, so this resolves
 * forward instead: company name -> ATS board (lib/slug-resolve) -> match the
 * title on that board -> take the ATS posting as the source of truth.
 *
 * The ATS listing gives BOTH things the LinkedIn record cannot:
 *   1. a real apply URL (not a login walled link)
 *   2. an authoritative location and workplace type to verify against
 *
 * Stamps: atsResolved, canonicalUrl (rewritten to the ATS URL, the LinkedIn
 * link kept in alternateUrls and linkedinUrl), atsBoard, atsMatchScore, and
 * location / remote / us / remoteVerified / verifyStatus / verifiedLocation /
 * verifiedWorkplace from the ATS record. A posting that does not resolve is
 * left flagged (atsResolved=false plus atsResolveReason) and is never assumed
 * remote. Idempotent: a resolved posting no longer has a LinkedIn canonicalUrl.
 *
 * Keyless, read only GETs against public board APIs. No account is involved.
 *
 *   node scripts/resolve-linkedin-to-ats.js [rankedFile] [--write] [--limit N]
 *
 * rankedFile defaults to today's ranked-enriched.json in the active workspace.
 */

const fs = require('fs');
const path = require('path');
const { resolveAts } = require('../lib/slug-resolve');
const { classifyRemote, classifyUs, parseLocation } = require('../lib/posting');
const { getProjectRoot } = require('../lib/config');

const UA = 'jobe-discovery/1.0 (personal job search)';
const isLinkedIn = (p) => /linkedin\.com\/jobs/i.test(p.canonicalUrl || p.url || '');

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

/** Fetch a board's postings, normalized to {title, location, remoteFlag, url}. */
async function boardJobs(ats, slug) {
  if (ats === 'greenhouse') {
    const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return (j && j.jobs || []).map((x) => ({ title: x.title, location: (x.location && x.location.name) || '', remoteFlag: null, url: x.absolute_url }));
  }
  if (ats === 'ashby') {
    const j = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    // isRemote is also true on the board's Hybrid jobs; workplaceType states the mode.
    return (j && j.jobs || []).map((x) => ({ title: x.title, location: x.location || '', remoteFlag: x.isRemote === true ? true : (x.isRemote === false ? false : null), workplaceType: x.workplaceType || null, url: x.jobUrl }));
  }
  if (ats === 'lever') {
    const j = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return (j || []).map((x) => ({
      title: x.text,
      location: (x.categories && x.categories.location) || '',
      remoteFlag: x.workplaceType ? /remote/i.test(x.workplaceType) : null,
      workplaceType: x.workplaceType || null,
      url: x.hostedUrl,
    }));
  }
  return [];
}

const norm = (s) => String(s || '').toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(/\b(remote|hybrid|onsite|on-site|usa?|united states|full[- ]time|contract)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));

/** Jaccard over title tokens; require a decisive match so a posting is never linked to a different requisition. */
function bestMatch(title, jobs) {
  const a = toks(title);
  if (!a.size) return null;
  let best = null, bestScore = 0, runnerUp = 0;
  for (const j of jobs) {
    const b = toks(j.title);
    if (!b.size) continue;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const score = inter / new Set([...a, ...b]).size;
    if (score > bestScore) { runnerUp = bestScore; bestScore = score; best = j; }
    else if (score > runnerUp) runnerUp = score;
  }
  // Decisive: strong overlap AND clearly ahead of the runner-up.
  if (best && bestScore >= 0.5 && (bestScore - runnerUp) >= 0.08) return { job: best, score: +bestScore.toFixed(3) };
  if (best && bestScore >= 0.75) return { job: best, score: +bestScore.toFixed(3) };
  return null;
}

/**
 * Rewrite posting `p` in place from its matched ATS job. `board` is
 * {ats, slug}, `m` is a bestMatch() result. Returns the derived work mode.
 */
// The board list carries no JD text, so the ATS remote flag is trusted here;
// scripts/verify-listing.js rechecks it against the JD later.
function stampResolved(p, board, m) {
  const loc = m.job.location || '';
  const parsed = parseLocation(loc);
  let remote = classifyRemote(parsed.remote, m.job.title || '', '');
  if (m.job.remoteFlag === true && remote !== 'hybrid') remote = 'remote';
  if (m.job.remoteFlag === false && remote === 'remote') remote = parsed.remote === 'remote' ? 'remote' : 'onsite';
  if (m.job.workplaceType && /hybrid/i.test(m.job.workplaceType)) remote = 'hybrid';

  const linkedinUrl = p.canonicalUrl || p.url;
  p.alternateUrls = [...new Set([...(p.alternateUrls || []), linkedinUrl])];
  p.linkedinUrl = linkedinUrl;
  p.canonicalUrl = m.job.url;
  p.atsResolved = true;
  p.atsBoard = `${board.ats}:${board.slug}`;
  p.atsMatchScore = m.score;
  p.location = loc || p.location;
  p.hqLocation = p.hqLocation || null;
  p.remote = remote;
  // The country verdict follows the ATS location when that location decides
  // it. One that names no country ("Remote") leaves the earlier verdict alone.
  const us = loc ? classifyUs(parsed.us, m.job.title || p.title || '') : null;
  if (us !== null) p.us = us;
  p.remoteVerified = remote === 'remote';
  p.verifyStatus = remote === 'remote' ? 'remote' : (remote === 'unknown' ? 'inconclusive' : 'not-remote');
  p.verifiedLocation = loc || null;
  p.verifiedWorkplace = remote;
  return remote;
}

async function main(argv) {
  const fileArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--limit');
  const abs = fileArg ? path.resolve(fileArg)
    : path.join(getProjectRoot(), 'signals', 'discovered', new Date().toISOString().slice(0, 10), 'ranked-enriched.json');
  if (!fs.existsSync(abs)) { console.log(`no ranked list at ${abs}; run /jobe find first.`); return; }
  const write = argv.includes('--write');
  const li = argv.indexOf('--limit');
  const limit = li >= 0 ? parseInt(argv[li + 1], 10) : Infinity;

  // A ranked list is an array; a manual capture file is { ..., postings: [] }.
  // Either is accepted and written back in the shape it was read.
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const postings = Array.isArray(data) ? data : (data.postings || []);
  const targets = postings.filter(isLinkedIn).slice(0, limit);

  // Resolve each distinct company once.
  const companies = [...new Set(targets.map((p) => p.company).filter(Boolean))];
  console.error(`resolving ${companies.length} companies for ${targets.length} LinkedIn postings...`);
  const boardCache = new Map();
  let done = 0;
  for (const name of companies) {
    const hit = await resolveAts(name).catch(() => null);
    if (hit) boardCache.set(name, { ...hit, jobs: await boardJobs(hit.ats, hit.slug) });
    else boardCache.set(name, null);
    if (++done % 10 === 0) console.error(`  companies ${done}/${companies.length}`);
  }

  // ponytail: after canonicalUrl is rewritten the same requisition may already
  // be in the list from an ATS direct source; this does not dedup (the
  // pipeline's URL dedup ran earlier). The duplicate is visible, not harmful.
  // Upgrade path: rerun lib/dedup over the list after a --write.
  const tally = { resolved: 0, noBoard: 0, noTitleMatch: 0, remote: 0, notRemote: 0, unknown: 0 };
  for (const p of targets) {
    const b = boardCache.get(p.company);
    if (!b) { p.atsResolved = false; p.atsResolveReason = 'no-board'; tally.noBoard++; continue; }
    const m = bestMatch(p.title, b.jobs);
    if (!m) { p.atsResolved = false; p.atsResolveReason = 'no-title-match'; p.atsBoard = `${b.ats}:${b.slug}`; tally.noTitleMatch++; continue; }
    const remote = stampResolved(p, b, m);
    tally.resolved++;
    if (remote === 'remote') tally.remote++; else if (remote === 'unknown') tally.unknown++; else tally.notRemote++;
  }

  if (write) { fs.writeFileSync(abs, JSON.stringify(data, null, 1)); console.error(`wrote ${abs}`); }
  process.stdout.write(JSON.stringify({ targets: targets.length, companies: companies.length, tally }, null, 2) + '\n');
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });

module.exports = { bestMatch, norm, boardJobs, stampResolved };
