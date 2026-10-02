#!/usr/bin/env node
'use strict';

/**
 * Work mode VERIFICATION step (discovery is not verification).
 *
 * Design rule: a source may ASSERT a work mode label (a search facet, a card
 * field); only this step may CONFIRM one. It fetches the real posting page and
 * derives the work mode again from what the page actually says, then stamps:
 *
 *   remoteVerified : true  -> the posting page itself says remote (trustworthy)
 *                    false -> the page says hybrid/onsite, or could not confirm
 *   verifyStatus   : 'remote' | 'not-remote' | 'unreachable' | 'inconclusive'
 *   verifiedLocation / verifiedWorkplace : what the page actually showed
 *
 * It never drops a posting. A posting that cannot be verified is simply never
 * treated as remote: scripts/final-list.js leaves it out when the user's work
 * modes ask for remote, and labels it unverified otherwise.
 *
 * LinkedIn URLs are read through the public logged out guest endpoint
 * (linkedin.com/jobs-guest/jobs/api/jobPosting/{id}) and through nothing else:
 * no login, no cookies, never the user's own session. Other URLs are fetched
 * directly.
 *
 *   node scripts/verify-remote.js [rankedFile] [--only-linkedin] [--limit N] [--write]
 *
 * rankedFile defaults to today's ranked-enriched.json in the active workspace.
 */

const fs = require('fs');
const path = require('path');
const { classifyRemote, parseLocation, HOME_BASED } = require('../lib/posting');
const { getProjectRoot } = require('../lib/config');

// The guest endpoint and most careers pages only answer a browser style agent.
// This is the same plain agent the linkedin-guest source sends: no identity.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DELAY_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
function linkedinJobId(url) {
  const m = String(url || '').match(/\/jobs\/view\/(?:[^/?]*-)?(\d{8,})/) || String(url || '').match(/currentJobId=(\d{8,})/);
  return m ? m[1] : null;
}

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok) return { ok: false, status: res.status, body: '' };
    return { ok: true, status: res.status, body: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, body: '', err: e.message };
  } finally { clearTimeout(t); }
}

/** Pull the workplace type + location the posting page actually displays. */
// ponytail: when the page has no workplace field, a bare "hybrid" anywhere in
// its text means hybrid (it also matches "hybrid cloud" or "hybrid schedule
// optional"). That errs toward NOT confirming remote, which is the safe side
// of "unverified is never remote". Upgrade path: phrase level patterns.
function extractSignals(html) {
  const out = { location: null, workplace: null, home: false };
  // LinkedIn guest JD: topcard flavors carry location + workplace type. The
  // first flavor is the employer name; the location is the first "bullet"
  // flavor, so that one is preferred when the page marks it.
  const clean = (m) => stripTags(m[1]);
  // A flavor that is nothing but home based wording is a work mode, not a place.
  const isHome = (f) => HOME_BASED.test(f) && !f.replace(HOME_BASED, '').replace(/[^A-Za-z0-9]+/g, '');
  const isPlace = (f) => /[A-Za-z]/.test(f) && !/^\d/.test(f) && !/^(remote|hybrid|on-?site)$/i.test(f) && !isHome(f);
  const flavors = [...String(html).matchAll(/topcard__flavor[^>]*>([\s\S]*?)<\//g)].map(clean).filter(Boolean);
  const bullets = [...String(html).matchAll(/topcard__flavor--bullet[^>]*>([\s\S]*?)<\//g)].map(clean).filter(Boolean);
  out.location = bullets.find(isPlace) || bullets.find(isHome) || null;
  for (const f of flavors) {
    if (/^(remote|hybrid|on-?site)$/i.test(f)) out.workplace = f.toLowerCase().replace('on-site', 'onsite');
    else if (isHome(f)) out.home = true;
    else if (!out.location && isPlace(f)) out.location = f;
  }
  const text = stripTags(html).slice(0, 60000);
  // Home wording is a remote workplace only as the caller confirms it against
  // the JD (verifyOne); it stands in for the field so the bare words below do
  // not overrule it.
  if (!out.workplace && !out.home) {
    if (/\bhybrid\b/i.test(text)) out.workplace = 'hybrid';
    else if (/\b(fully remote|100% remote|remote[- ](first|friendly|us|usa)|work from home|telecommute)\b/i.test(text)) out.workplace = 'remote';
    else if (/\b(on-?site|in-?office|in-?person)\b/i.test(text)) out.workplace = 'onsite';
  }
  return { ...out, text };
}

async function verifyOne(p) {
  const url = p.canonicalUrl || p.url || '';
  const liId = linkedinJobId(url);
  const target = liId ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${liId}` : url;

  const r = await fetchText(target);
  if (!r.ok || !r.body || r.body.length < 200) {
    return { verifyStatus: 'unreachable', remoteVerified: false, verifiedLocation: null, verifiedWorkplace: null, httpStatus: r.status };
  }
  const sig = extractSignals(r.body);
  // A home based flavor is remote unless the title or JD states hybrid (the
  // pipeline's phrase patterns), as a remote field does in verify-listing.js.
  if (sig.home && !sig.workplace) sig.workplace = classifyRemote('remote', p.title || '', sig.text || '') === 'hybrid' ? 'hybrid' : 'remote';
  // Derive from what the PAGE says, not what the source asserted.
  const locGuess = sig.location || (sig.workplace === 'remote' ? 'Remote' : '') || '';
  const parsed = parseLocation(locGuess);
  const remote = classifyRemote(parsed.remote, p.title || '', sig.text || '');

  let status;
  if (sig.workplace === 'hybrid' || sig.workplace === 'onsite') status = 'not-remote';
  else if (sig.workplace === 'remote' || remote === 'remote') status = 'remote';
  else status = 'inconclusive';

  return {
    verifyStatus: status,
    remoteVerified: status === 'remote',
    verifiedLocation: sig.location || null,
    verifiedWorkplace: sig.workplace || null,
    httpStatus: r.status,
  };
}

async function main(argv) {
  const limIdx = argv.indexOf('--limit');
  const limit = limIdx >= 0 ? parseInt(argv[limIdx + 1], 10) : Infinity;
  const fileArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--limit');
  const abs = fileArg ? path.resolve(fileArg)
    : path.join(getProjectRoot(), 'signals', 'discovered', new Date().toISOString().slice(0, 10), 'ranked-enriched.json');
  if (!fs.existsSync(abs)) { console.log(`no ranked list at ${abs}; run /jobe find first.`); return; }
  const onlyLinkedIn = argv.includes('--only-linkedin');
  const write = argv.includes('--write');

  // A ranked list is an array; a manual capture file is { ..., postings: [] }.
  // Either is accepted and written back in the shape it was read.
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const postings = Array.isArray(data) ? data : (data.postings || []);

  // Verify anything not already verified against a real posting page; LinkedIn
  // sourced postings always (they are the ones asserting an unverifiable label).
  let queue = postings.filter((p) => {
    const isLi = /linkedin\.com\/jobs/i.test(p.canonicalUrl || p.url || '');
    if (onlyLinkedIn) return isLi;
    return isLi || p.remoteVerified !== true;
  });
  queue = queue.slice(0, limit);

  console.error(`verifying ${queue.length} postings (of ${postings.length})...`);
  const tally = { remote: 0, 'not-remote': 0, unreachable: 0, inconclusive: 0 };
  let i = 0;
  for (const p of queue) {
    const v = await verifyOne(p);
    Object.assign(p, v);
    tally[v.verifyStatus]++;
    i++;
    if (i % 10 === 0) console.error(`  ${i}/${queue.length} ...`);
    await sleep(DELAY_MS);
  }

  if (write) {
    fs.writeFileSync(abs, JSON.stringify(data, null, 1));
    console.error(`wrote ${abs}`);
  }
  process.stdout.write(JSON.stringify({ verified: queue.length, tally }, null, 2) + '\n');
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });

module.exports = { extractSignals, linkedinJobId, verifyOne };
