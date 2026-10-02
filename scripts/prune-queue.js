#!/usr/bin/env node
'use strict';
// Prune stale rows from <workspace>/data/apply-queue.json.
//
// The queue only grows in practice: pushQueueEntry adds a row per generated
// resume, but nothing removes one when the job is never applied to, its report
// folder is archived or deleted, or it ages out. Rows that were never applied
// to therefore pile up across runs. This prunes the dead ones while PRESERVING
// all history. It removes queue rows only; it never deletes a report folder.
//
// KEEP (never pruned):
//   - applied history  (the cross run dedup in collectors/pipeline.js reads it)
//   - skipped history
//   - a row with a LIVE report folder in an actionable bucket
//     (queue / manual / verify / evaluate, or an older manual style bucket)
//   - a row this script cannot place (no slug, flat staging folder)
// PRUNE (rows that are not history):
//   - orphan         : no report folder anywhere
//   - archived       : the folder exists only under an archive
//   - title-excluded : the role matches the user's own discovery.titleExclude
//                      outside every titleKeep phrase (data/profile.json), the
//                      same rule discovery applies. With no title policy this
//                      rule never fires.
//
// A backup of the full prior queue is written next to it as
// apply-queue.json.bak before any row is removed.
//
// Usage: node scripts/prune-queue.js [--dry]

const path = require('path');
const { getProjectRoot } = require('../lib/config');
const { loadProfile, titlePolicy } = require('../lib/profile');
const { readQueue, writeQueue, atomicWrite, locateReportDir } = require('../lib/tracker-writer');
const { isRoleMatch } = require('../lib/rank');

// Buckets whose folders are still in flight. The last three are names older
// workspaces may still hold; a row parked there is live, never an orphan.
const ACTIONABLE = ['queue', 'manual', 'verify', 'evaluate', 'needs-manual', 'gated', 'non-gated'];

/**
 * Where a slug's report folder currently sits: a bucket name, 'flat' for
 * reports/<slug>/, 'archive' for an archive bucket or a dated archive under
 * any bucket, or null when there is no folder. Uses the shared locator so this
 * script and the apply harness agree on one bucket list.
 */
function folderBucket(slug, root = getProjectRoot()) {
  const dir = locateReportDir(root, slug);
  if (!dir) return null;
  const rel = path.relative(path.join(root, 'reports'), dir).split(path.sep);
  if (rel.length === 1) return 'flat';
  return rel[1] === 'archive' ? 'archive' : rel[0];
}

/**
 * The same test collectors/pipeline.js uses to treat a queue row as history,
 * widened to every way a row has ever recorded an outcome (a flag, a status in
 * any letter case, or a document path under the outcome bucket), so a row the
 * pipeline counts as history is never pruned.
 */
function historyState(e) {
  const status = String(e.status || '').toLowerCase();
  const paths = `${e.resumeDocx || ''} ${e.reportDir || ''}`;
  if (e.applied === true || status === 'applied' || /reports\/applied\//.test(paths)) return 'applied';
  if (e.skipped === true || status === 'skipped' || /reports\/skipped\//.test(paths)) return 'skipped';
  return null;
}

function context(root = getProjectRoot()) {
  return { root, policy: titlePolicy(loadProfile({ root })) };
}

function classify(e, ctx = context()) {
  const history = historyState(e);
  if (history) return { keep: true, reason: history };
  // The title rule reads the role only. A slug is not a title: hyphens make
  // every word in it a whole word, so a phrase would match by accident.
  // With no role tokens isRoleMatch is the title policy alone.
  if (e.role && !isRoleMatch(e.role, { titlePolicy: ctx.policy })) return { keep: false, reason: 'title-excluded' };
  if (!e.slug) return { keep: true, reason: 'other:no-slug' };
  const b = folderBucket(e.slug, ctx.root);
  if (b === null) return { keep: false, reason: 'orphan' };
  if (b === 'archive') return { keep: false, reason: 'archived' };
  if (ACTIONABLE.includes(b)) return { keep: true, reason: 'active:' + b };
  return { keep: true, reason: 'other:' + b };
}

function prune({ dry = false } = {}) {
  const q = readQueue();
  if (!Array.isArray(q)) {
    console.log('data/apply-queue.json is not a list; nothing pruned.');
    return { kept: [], pruned: [] };
  }
  const ctx = context();
  const kept = [], pruned = [];
  const tally = {};
  for (const e of q) {
    const c = classify(e, ctx);
    tally[c.reason] = (tally[c.reason] || 0) + 1;
    (c.keep ? kept : pruned).push({ e, reason: c.reason });
  }

  console.log(JSON.stringify({
    dry, total: q.length, kept: kept.length, pruned: pruned.length, byReason: tally,
  }, null, 2));
  if (pruned.length) {
    console.log('\npruned:');
    for (const { e, reason } of pruned) console.log(`  [${reason}] ${e.slug} (score ${e.score ?? '?'})`);
  }
  if (!dry && pruned.length) {
    const bak = path.join(ctx.root, 'data', 'apply-queue.json.bak');
    atomicWrite(bak, JSON.stringify(q, null, 2));
    writeQueue(kept.map((k) => k.e));
    console.log(`\nwrote ${kept.length} rows to data/apply-queue.json (backup: ${path.basename(bak)})`);
  }
  return { kept: kept.map((k) => k.e), pruned: pruned.map((p) => ({ ...p.e, _reason: p.reason })) };
}

// Only run when invoked directly; importing the module must NOT prune.
if (require.main === module) prune({ dry: process.argv.includes('--dry') });

module.exports = { classify, folderBucket, historyState, prune };
