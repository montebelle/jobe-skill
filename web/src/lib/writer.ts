import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { JOBE_ROOT, paths, LIFECYCLE_BUCKETS, locateReportDir } from './paths';
import type { LifecycleBucket } from './paths';
import type { QueueEntry } from './types';

/**
 * Mirror of `<jobe>/lib/tracker-writer.js`. The dashboard ships its own copy
 * to keep the bundle clean — Turbopack refuses to resolve dynamic require()
 * across the workspace boundary, and mirroring the (small, stable) contract
 * is simpler than a runtime escape hatch.
 *
 * Atomic-write everything. Writes go to `target.tmp.<pid>.<ts>` then renamed.
 */

function atomicWrite(target: string, contents: string) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

// ── apply-queue.json ──────────────────────────────────────────────

export function readQueue(): QueueEntry[] {
  if (!fs.existsSync(paths.applyQueue)) return [];
  try {
    return JSON.parse(fs.readFileSync(paths.applyQueue, 'utf8')) as QueueEntry[];
  } catch {
    return [];
  }
}

export function writeQueue(entries: QueueEntry[]) {
  atomicWrite(paths.applyQueue, JSON.stringify(entries, null, 2));
}

export function updateQueueEntry(
  slug: string,
  patch: Partial<QueueEntry>,
): boolean {
  const q = readQueue();
  const i = q.findIndex((e) => e.slug === slug);
  if (i < 0) return false;
  q[i] = { ...q[i], ...patch };
  writeQueue(q);
  return true;
}

// ── tracker.md ────────────────────────────────────────────────────

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Relative paths are stored with forward slashes on every platform.
const relPosix = (abs: string) => path.relative(JOBE_ROOT, abs).split(path.sep).join('/');

/**
 * Set the Status column of the tracker row for a slug. The row is matched on
 * the folder's CURRENT location (whichever lifecycle bucket it sits in), then
 * on the slug as a path segment, so a row survives a folder move in either
 * order. Same matching as updateTrackerStatus in lib/tracker-writer.js.
 */
export function updateTrackerStatus({
  slug,
  newStatus,
}: {
  slug: string;
  newStatus: string;
}): boolean {
  if (!fs.existsSync(paths.tracker)) return false;
  const s = String(slug || '').trim();
  if (!s) return false;
  const needles: RegExp[] = [];
  const located = locateReportDir(s);
  if (located) needles.push(new RegExp(`^${escapeRe(relPosix(located))}(?:/|$)`));
  needles.push(new RegExp(`(?:^|/)${escapeRe(s)}(?:/|$)`));

  const lines = fs.readFileSync(paths.tracker, 'utf8').split('\n');
  for (const needle of needles) {
    for (let i = 0; i < lines.length; i++) {
      if (!/^\|\s*\d+\s*\|/.test(lines[i])) continue;
      const cols = lines[i].split('|');
      // Status is the 6th column, report path the 7th.
      if (cols.length < 9 || !needle.test(cols[7].trim())) continue;
      cols[6] = ` ${newStatus.replace(/\|/g, '/')} `;
      lines[i] = cols.join('|');
      atomicWrite(paths.tracker, lines.join('\n'));
      return true;
    }
  }
  return false;
}

// ── Move report folder ────────────────────────────────────────────

/**
 * Move a slug's report folder to reports/<bucket>/<slug>/ from wherever it
 * currently sits, and rewrite the queue entry (resumeDocx, coverLetterDocx,
 * reportDir) and every tracker.md reference to the old path. Returns false
 * when the folder is missing, already there, or the destination exists.
 */
export function moveReportFolder(slug: string, bucket: LifecycleBucket): boolean {
  if (!LIFECYCLE_BUCKETS.includes(bucket)) {
    throw new Error(`bucket must be one of ${LIFECYCLE_BUCKETS.join(', ')}, got: ${bucket}`);
  }
  const oldDir = locateReportDir(slug);
  if (!oldDir) return false;
  const newDir = path.join(paths.reports, bucket, path.basename(oldDir));
  if (path.resolve(oldDir) === path.resolve(newDir)) return false; // already there
  if (fs.existsSync(newDir)) return false;

  fs.mkdirSync(path.dirname(newDir), { recursive: true });
  fs.renameSync(oldDir, newDir);

  const oldRel = relPosix(oldDir);
  const newRel = relPosix(newDir);

  // Update queue paths
  const q = readQueue();
  const i = q.findIndex((e) => e.slug === slug);
  if (i >= 0) {
    const e = q[i];
    if (e.resumeDocx) e.resumeDocx = e.resumeDocx.split(`${oldRel}/`).join(`${newRel}/`);
    if (e.coverLetterDocx) e.coverLetterDocx = e.coverLetterDocx.split(`${oldRel}/`).join(`${newRel}/`);
    e.reportDir = `${newRel}/`;
    writeQueue(q);
  }

  // Rewrite tracker.md references to the old folder
  if (fs.existsSync(paths.tracker)) {
    const text = fs.readFileSync(paths.tracker, 'utf8');
    const updated = text.split(`${oldRel}/`).join(`${newRel}/`);
    if (updated !== text) atomicWrite(paths.tracker, updated);
  }
  return true;
}
