#!/usr/bin/env node
'use strict';
/**
 * Wide LinkedIn guest company discovery sweep.
 *
 * Breadth over depth: many role QUERIES x 1-2 pages each surfaces far more
 * distinct companies (and triggers fewer 429s) than deep pagination of a few
 * queries. Guest cards do not expose the work mode, so this yields COMPANY
 * coverage only: new names are resolved to real ATS slugs (lib/slug-resolve)
 * and promoted in <workspace>/data/companies/index.json so the next /jobe find
 * iterates those boards directly.
 *
 * The queries are the user's own target roles (data/queries/seeds.json through
 * lib/linkedin.profileQueries, which also skips any title the user's title
 * policy excludes). No role list ships with the code: with no seeds the script
 * says so and exits. The search location follows discovery.countries in
 * data/profile.json; with no country policy the search is not restricted.
 *
 * 429 resilient: on a rate limit it backs off once and continues (the pipeline
 * source aborts its run; a dedicated sweep should ride it out).
 *
 * Keyless. It only GETs LinkedIn's public logged out guest search and the
 * public ATS board APIs. It never logs in and never touches a user session.
 *
 * Usage: [LINKEDIN_GUEST_PAGES=2] [LINKEDIN_SWEEP_MAX_QUERIES=20] node scripts/linkedin-guest-sweep.js
 */
const fs = require('fs');
const path = require('path');
const { resolveMany } = require('../lib/slug-resolve');
const { getProjectRoot } = require('../lib/config');
const { profileQueries } = require('../lib/linkedin');
const { loadProfile, discoveryFilters } = require('../lib/profile');
const { atomicWrite } = require('../lib/tracker-writer');

const PAGES = Math.max(1, parseInt(process.env.LINKEDIN_GUEST_PAGES || '2', 10));
const MAX_QUERIES = Math.max(1, parseInt(process.env.LINKEDIN_SWEEP_MAX_QUERIES || '20', 10));
const BASE_DELAY = 4000;
const BACKOFF = 45000;
// The guest endpoint only answers a browser style agent. This is the same
// plain agent the linkedin-guest source sends: no identity.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function decode(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
}
function parseCompanies(html) {
  const cards = String(html || '').match(/<li>[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (const card of cards) {
    const company = decode((card.match(/base-search-card__subtitle[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1])
      || decode((card.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\//) || [])[1]);
    if (company) out.push(company);
  }
  return out;
}

/**
 * The guest search `location` text for a country list, or null for no
 * restriction. A two letter code becomes its English country name, so
 * ["CA", "Canada"] is one country.
 */
// ponytail: the guest search takes one location, so a list naming several
// countries searches without one. Upgrade path: one pass per country.
function searchLocation(countries) {
  const names = new Map();
  for (const raw of Array.isArray(countries) ? countries : []) {
    let name = String(raw || '').trim();
    if (!name) continue;
    if (/^[A-Za-z]{2}$/.test(name)) {
      try { name = new Intl.DisplayNames(['en'], { type: 'region' }).of(name.toUpperCase()) || name; } catch { /* keep the code */ }
    }
    names.set(name.toLowerCase(), name);
  }
  return names.size === 1 ? [...names.values()][0] : null;
}

async function fetchPage(keywords, start, location) {
  // f_TPR is a fixed 30 day window: this harvests companies, not postings, so
  // it does not follow the user's recency window.
  const qs = new URLSearchParams({ keywords, f_TPR: 'r2592000', start: String(start) });
  if (location) qs.set('location', location);
  try {
    const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${qs}`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, text: res.status === 200 ? await res.text() : '' };
  } catch { return { status: 0, text: '' }; }
}

const isReal = (v) => ['greenhouse', 'lever', 'ashby'].includes(v && v.ats);

/**
 * Promote resolved names into the index. `results` is resolveMany() output.
 * An entry already on a real ATS is left alone; any other previous entry is
 * merged, never overwritten, so its run history survives.
 */
function promote(idx, results, now = new Date().toISOString()) {
  let added = 0;
  const byAts = {};
  for (const { name, hit } of results) {
    if (!hit) continue;
    byAts[hit.ats] = (byAts[hit.ats] || 0) + 1;
    if (isReal(idx[hit.slug])) continue;
    const prev = idx[hit.slug] || {};
    idx[hit.slug] = {
      name,
      ats: hit.ats,
      lastSeen: now,
      sources: [...new Set([...(prev.sources || []), 'linkedin-guest-resolve'])],
      urls: prev.urls || [],
      postingCountByRun: prev.postingCountByRun || {},
      hiresPerPosting: prev.hiresPerPosting ?? null,
      recentLayoff: prev.recentLayoff ?? null,
    };
    added++;
  }
  return { added, byAts };
}

async function main() {
  const queries = profileQueries().slice(0, MAX_QUERIES);
  if (!queries.length) {
    console.log('no target roles configured; run /jobe onboard (it writes data/queries/seeds.json) first.');
    return;
  }
  const location = searchLocation(discoveryFilters(loadProfile()).countries);

  const names = new Set();
  let pages = 0, r429 = 0;
  for (const q of queries) {
    for (let p = 0; p < PAGES; p++) {
      let r = await fetchPage(q, p * 25, location);
      if (r.status === 429) { r429++; process.stdout.write('[429 backoff]'); await sleep(BACKOFF); r = await fetchPage(q, p * 25, location); }
      if (r.status !== 200) break;
      const cos = parseCompanies(r.text);
      if (!cos.length) break;
      cos.forEach((c) => names.add(c));
      pages++; process.stdout.write('.');
      await sleep(BASE_DELAY);
    }
  }
  console.log(`\nswept ${pages} pages across ${queries.length} queries (${r429} 429s ridden out, location: ${location || 'any'}) -> ${names.size} unique companies`);

  // The company index is per user. A first sweep may run before any find, so a
  // missing index starts empty. An index that exists but does not parse is an
  // error: writing over it would lose it.
  const INDEX = path.join(getProjectRoot(), 'data', 'companies', 'index.json');
  const idx = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : {};
  const realNames = new Set(Object.values(idx).filter(isReal).map((v) => (v.name || '').toLowerCase()));
  const TODAY = new Date().toISOString().slice(0, 10);
  // resolve names not already iterable and not already probed today
  const probedToday = new Set(Object.values(idx).filter((v) => v.atsChecked === TODAY).map((v) => (v.name || '').toLowerCase()));
  const toResolve = [...names].filter((n) => !realNames.has(n.toLowerCase()) && !probedToday.has(n.toLowerCase()));
  console.log(`resolving ${toResolve.length} new company names...`);

  let done = 0;
  const res = await resolveMany(toResolve, { concurrency: 6, onResult: () => { if (++done % 25 === 0) process.stdout.write(` ${done}/${toResolve.length}`); } });

  const { added, byAts } = promote(idx, res);
  if (added) atomicWrite(INDEX, JSON.stringify(idx, null, 2) + '\n');
  console.log(`\nRESOLVED ${res.filter((r) => r.hit).length}/${toResolve.length} | ADDED ${added} iterable | by ATS: ${JSON.stringify(byAts)}`);
  console.log('sample:', res.filter((r) => r.hit).slice(0, 15).map((r) => r.hit.ats + ':' + r.hit.slug).join(', '));
  const totals = {}; for (const v of Object.values(idx)) totals[v.ats || 'nostat'] = (totals[v.ats || 'nostat'] || 0) + 1;
  console.log('index totals:', JSON.stringify(totals));
}

if (require.main === module) main().catch((e) => { console.error('sweep error:', e.message); process.exit(1); });

module.exports = { parseCompanies, searchLocation, promote };
