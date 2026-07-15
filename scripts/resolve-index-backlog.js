/**
 * Resolve the inert ats:'other' backlog in data/companies/index.json to real
 * ATS slugs (lib/slug-resolve), promoting hits so the ATS-direct plugins
 * iterate them on the next `/jobe find`. These 'other' entries were collected
 * by the guest / SerpAPI / Google-Jobs sources over past runs with only a
 * company name and a non-ATS URL, so nothing has ever iterated them. Idempotent:
 * marks each probed entry atsChecked=TODAY so re-runs skip already-probed names.
 *
 * Keyless and read-only (it only GETs public board APIs). Safe to run anytime.
 *
 * Usage: [RESOLVE_LIMIT=700] node scripts/resolve-index-backlog.js
 */
const fs = require('fs');
const path = require('path');
const { resolveMany } = require('../lib/slug-resolve');
const { getUserRoot } = require('../lib/config');

// The company index is per-user (each workspace grows its own from its runs).
const INDEX = path.join(getUserRoot(), 'data', 'companies', 'index.json');
const TODAY = new Date().toISOString().slice(0, 10);
const isReal = (v) => ['greenhouse', 'lever', 'ashby'].includes(v && v.ats);

(async () => {
  if (!fs.existsSync(INDEX)) {
    console.log('no data/companies/index.json yet — run `/jobe find` first to build the company index.');
    return;
  }
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const targets = Object.entries(idx).filter(([, v]) => v.ats === 'other' && v.name && v.atsChecked !== TODAY);
  const LIMIT = parseInt(process.env.RESOLVE_LIMIT || '700', 10);
  const slice = targets.slice(0, LIMIT);
  console.log(`resolving ${slice.length} of ${targets.length} 'other' backlog entries (concurrency 6)...`);

  const names = slice.map(([, v]) => v.name);
  let done = 0;
  const res = await resolveMany(names, {
    concurrency: 6,
    onResult: () => { done++; if (done % 50 === 0) process.stdout.write(` ${done}/${slice.length}`); },
  });

  const byAts = {};
  let added = 0;
  res.forEach(({ hit }, i) => {
    const [oldKey, oldVal] = slice[i];
    idx[oldKey].atsChecked = TODAY;
    if (!hit) return;
    byAts[hit.ats] = (byAts[hit.ats] || 0) + 1;
    idx[oldKey].resolvedTo = hit.slug;
    if (!isReal(idx[hit.slug])) {
      const prev = idx[hit.slug] || {};
      idx[hit.slug] = {
        name: oldVal.name,
        ats: hit.ats,
        lastSeen: new Date().toISOString(),
        sources: [...new Set([...(prev.sources || []), 'backlog-resolve'])],
        urls: prev.urls || [],
        postingCountByRun: prev.postingCountByRun || {},
        hiresPerPosting: prev.hiresPerPosting ?? null,
        recentLayoff: prev.recentLayoff ?? null,
      };
      added++;
    }
  });
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2) + '\n');

  const hits = res.filter((r) => r.hit).length;
  console.log(`\n\nRESOLVED ${hits}/${slice.length} backlog names | ADDED ${added} new iterable companies | by ATS: ${JSON.stringify(byAts)}`);
  console.log('sample:', res.filter((r) => r.hit).slice(0, 15).map((r) => r.hit.ats + ':' + r.hit.slug).join(', '));
  const totals = {};
  for (const v of Object.values(idx)) totals[v.ats || 'nostat'] = (totals[v.ats || 'nostat'] || 0) + 1;
  console.log('index ats totals now:', JSON.stringify(totals));
})().catch((e) => { console.error('backlog resolve error:', e.message); process.exit(1); });
