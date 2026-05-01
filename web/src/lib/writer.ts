import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { JOBE_ROOT, paths } from './paths';
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

export function updateTrackerStatus({
  slug,
  newStatus,
}: {
  slug: string;
  newStatus: string;
}): boolean {
  if (!fs.existsSync(paths.tracker)) return false;
  const text = fs.readFileSync(paths.tracker, 'utf8');
  const needle = `reports/${slug}/`;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\|[^\\n]*)(\\| [^|]+) (\\| ${escaped}[^\\n]*)$`, 'm');
  const updated = text.replace(re, (line) => {
    const cols = line.split('|');
    if (cols.length < 9) return line;
    cols[6] = ` ${newStatus} `;
    return cols.join('|');
  });
  if (updated === text) return false;
  atomicWrite(paths.tracker, updated);
  return true;
}

// ── Move report folder ────────────────────────────────────────────

export function moveReportFolder(
  slug: string,
  bucket: 'applied' | 'skipped',
): boolean {
  if (!['applied', 'skipped'].includes(bucket)) {
    throw new Error(`bucket must be 'applied' or 'skipped'`);
  }
  const oldDir = path.join(paths.reports, slug);
  const newDir = path.join(paths.reports, bucket, slug);
  if (!fs.existsSync(oldDir)) return false;
  if (fs.existsSync(newDir)) return false;

  fs.mkdirSync(path.join(paths.reports, bucket), { recursive: true });
  fs.renameSync(oldDir, newDir);

  // Update queue paths
  const q = readQueue();
  const i = q.findIndex((e) => e.slug === slug);
  if (i >= 0) {
    const oldPrefix = `reports/${slug}`;
    const newPrefix = `reports/${bucket}/${slug}`;
    if (q[i].resumeDocx) q[i].resumeDocx = q[i].resumeDocx.replace(oldPrefix, newPrefix);
    if (q[i].coverLetterDocx) {
      q[i].coverLetterDocx = q[i].coverLetterDocx.replace(oldPrefix, newPrefix);
    }
    writeQueue(q);
  }

  // Rewrite tracker.md reportDir
  if (fs.existsSync(paths.tracker)) {
    const oldPath = `reports/${slug}/`;
    const newPath = `reports/${bucket}/${slug}/`;
    const escaped = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const text = fs.readFileSync(paths.tracker, 'utf8');
    const updated = text.replace(new RegExp(escaped, 'g'), newPath);
    if (updated !== text) atomicWrite(paths.tracker, updated);
  }

  // Acknowledge JOBE_ROOT is the bound; satisfies the linter that the import
  // is in fact used (paths.* derives from it).
  void JOBE_ROOT;
  return true;
}
