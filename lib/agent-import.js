#!/usr/bin/env node
/**
 * Import postings discovered by the jobe-job-discovery agent (WebSearch path)
 * into the pipeline's outputs:
 *
 *   - extract ATS slug from each URL and merge into data/companies/index.json
 *     so future direct-ATS runs iterate the slug automatically
 *   - normalize each posting via lib/posting.createPosting
 *   - dedup against today's existing ranked-enriched.json (URL exact)
 *   - apply the same role / remote / US filters as the pipeline
 *   - append survivors to ranked-enriched.json (sorted by quickScore)
 *
 * Input: a JSON file at signals/discovered/{date}/agent-discovered.json
 *   with shape: { postings: [{url, company, title, location, postedDate, jdSnippet, score}] }
 *
 * Usage:
 *   node lib/agent-import.js                 # auto-detect today
 *   node lib/agent-import.js 2026-04-30      # explicit date
 */

const fs = require('fs');
const path = require('path');
const { createPosting } = require('./posting');
const { quickScore, fullScore, isRoleMatch } = require('./rank');
const { enrich } = require('./enrich');
const { atomicWrite } = require('./tracker-writer');
const { getProjectRoot } = require('./config');

const ROOT = getProjectRoot();

function extractSlug(url) {
  if (!url) return null;
  const gh = url.match(/(?:job-boards\.|boards\.)greenhouse\.io\/([^/?#]+)/i);
  if (gh) return { ats: 'greenhouse', slug: gh[1] };
  const lv = url.match(/jobs\.lever\.co\/([^/?#]+)/i);
  if (lv) return { ats: 'lever', slug: lv[1] };
  const ab = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i);
  if (ab) return { ats: 'ashby', slug: decodeURIComponent(ab[1]) };
  const wd = url.match(/^https?:\/\/([^./]+)\.wd\d+\.myworkdayjobs\.com/i);
  if (wd) return { ats: 'workday', slug: wd[1] };
  const sr = url.match(/jobs\.smartrecruiters\.com\/([^/?#]+)/i);
  if (sr) return { ats: 'smartrecruiters', slug: sr[1] };
  const ic = url.match(/^https?:\/\/(?:careers-)?([^./]+)\.icims\.com/i);
  if (ic) return { ats: 'icims', slug: ic[1] };
  return null;
}

function mergeSlugIntoIndex(idx, info, postingUrl, ts) {
  if (!info) return false;
  const key = info.slug;
  const entry = idx[key] || {};
  const wasNew = !idx[key] || !entry.ats;
  idx[key] = {
    name: entry.name || info.slug,
    ats: info.ats,
    lastSeen: ts,
    sources: [...new Set([...(entry.sources || []), 'jobe-job-discovery'])],
    urls: [...new Set([...(entry.urls || []), postingUrl])].slice(-20),
    postingCountByRun: entry.postingCountByRun || {},
    hiresPerPosting: entry.hiresPerPosting ?? null,
    recentLayoff: entry.recentLayoff ?? null,
    seededFrom: entry.seededFrom || 'agent',
  };
  return wasNew;
}

function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function applyAgentFilters(postings, opts = {}) {
  const usOnly = opts.usOnly !== false;
  const remoteOnly = opts.remoteOnly !== false;
  const out = [];
  const rej = { role: 0, location: 0, nonRemote: 0 };
  for (const p of postings) {
    if (!isRoleMatch(p.title)) { rej.role++; continue; }
    if (usOnly && p.us === false) { rej.location++; continue; }
    if (remoteOnly && p.remote !== 'remote') { rej.nonRemote++; continue; }
    out.push(p);
  }
  return { kept: out, rej };
}

async function importAgentDiscoveries(date = null) {
  const today = date || new Date().toISOString().slice(0, 10);
  const dir = path.join(ROOT, 'signals', 'discovered', today);
  const inFile = path.join(dir, 'agent-discovered.json');
  const rankedFile = path.join(dir, 'ranked-enriched.json');
  const idxFile = path.join(ROOT, 'data', 'companies', 'index.json');

  if (!fs.existsSync(inFile)) {
    return { ok: false, reason: `no agent-discovered.json at ${inFile}` };
  }
  const input = loadJson(inFile, { postings: [] });
  const incoming = (input.postings || []).filter(p => p && p.url);
  if (!incoming.length) return { ok: true, added: 0, newSlugs: 0, reason: 'agent returned 0 postings' };

  // Normalize each agent posting into the canonical Posting schema
  const ts = new Date().toISOString();
  const idx = loadJson(idxFile, {});
  let newSlugs = 0;
  const normalized = [];
  for (const p of incoming) {
    const post = createPosting({
      title: p.title || '',
      company: p.company || 'Unknown',
      location: p.location || '',
      url: p.url,
      postedDate: p.postedDate || null,
      sourceUrl: 'jobe-job-discovery-agent',
      sourceQuery: p.query || null,
      jdText: p.jdSnippet || '',
    }, 'jobe-job-discovery');
    if (!post) continue;
    normalized.push(post);
    const info = extractSlug(p.url);
    if (info && mergeSlugIntoIndex(idx, info, post.canonicalUrl, ts)) newSlugs++;
  }

  // Filter
  const { kept, rej } = applyAgentFilters(normalized);
  for (const p of kept) quickScore(p);

  // Enrich + fullScore so agent-imported postings get real JD-based scores,
  // not just the quickScore from title alone.
  await Promise.all(kept.map(p =>
    enrich(p).catch(() => p)
  ));
  for (const p of kept) {
    if (p.jdText) fullScore(p);
  }

  // Merge with today's ranked-enriched.json. For URLs already present, update
  // with the freshly-enriched + scored version (an agent re-run should refresh
  // matchScore for postings that previously imported with only quickScore).
  const existing = loadJson(rankedFile, []);
  const byUrl = new Map(existing.map(p => [p.canonicalUrl, p]));
  let updated = 0;
  for (const p of kept) {
    if (byUrl.has(p.canonicalUrl)) updated++;
    byUrl.set(p.canonicalUrl, p);
  }
  const fresh = kept.filter(p => !existing.some(e => e.canonicalUrl === p.canonicalUrl));
  const merged = [...byUrl.values()].sort(
    (a, b) => (b.matchScore || b.quickScore || 0) - (a.matchScore || a.quickScore || 0)
  );

  // Persist
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(rankedFile, JSON.stringify(merged, null, 2));
  const sortedIdx = Object.keys(idx).sort().reduce((a, k) => (a[k] = idx[k], a), {});
  atomicWrite(idxFile, JSON.stringify(sortedIdx, null, 2));

  return {
    ok: true,
    incoming: incoming.length,
    normalized: normalized.length,
    afterFilter: kept.length,
    rejected: rej,
    added: fresh.length,
    updated,
    rankedTotal: merged.length,
    newSlugs,
    indexSize: Object.keys(idx).length,
  };
}

if (require.main === module) {
  const date = process.argv[2] || null;
  importAgentDiscoveries(date).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }).catch(err => {
    console.error(err.stack || err);
    process.exit(1);
  });
}

module.exports = { importAgentDiscoveries, extractSlug };
