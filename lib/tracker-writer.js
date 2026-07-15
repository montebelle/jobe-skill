/**
 * Unified writer for data/tracker.md and data/apply-queue.json.
 *
 * Before this module, find.md, evaluate.md, and apply-all.md each wrote
 * to these files directly. Three writers with no locking = race condition
 * on concurrent runs, inconsistent column ordering, and silent data loss.
 *
 * All writes now funnel through {appendTrackerRow, updateQueueEntry,
 * pushQueueEntry}. Every write uses atomic-rename (write to .tmp, rename
 * to final) so a concurrent read sees either the pre- or post-state, never
 * a half-written file.
 */

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');

const TRACKER_PATH = () => path.join(getProjectRoot(), 'data', 'tracker.md');
const QUEUE_PATH = () => path.join(getProjectRoot(), 'data', 'apply-queue.json');

function atomicWrite(target, contents) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

// ── tracker.md row append ───────────────────────────────────

function parseLastRowNum(text) {
  const m = text.match(/^\|\s*(\d+)\s*\|/gm);
  if (!m) return 0;
  return m.reduce((best, s) => {
    const n = parseInt(s.match(/\d+/)[0], 10);
    return Math.max(best, n);
  }, 0);
}

/**
 * Append a row to data/tracker.md.
 *
 * @param {object} row
 * @param {string} row.date        ISO yyyy-mm-dd
 * @param {string} row.company
 * @param {string} row.role
 * @param {number} row.score
 * @param {string} row.status      Discovered | Evaluated | Applied | Responded | Interviewing | Offer | Rejected | Skipped
 * @param {string} row.reportDir   e.g. reports/stripe-assistant-mle/
 * @param {string} row.notes
 */
// Markdown table cells cannot contain a raw '|' (it would shift every column
// for the split-based parsers in this file, web/src/lib/data.ts, and
// tracker-stats.js). Role/company/JD-derived titles frequently contain " | "
// (e.g. "Staff MLE | Ads | Remote"), so sanitize every cell on write: map '|'
// to '/' and flatten newlines. This keeps each row exactly 8 columns.
function cell(v) {
  return String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
}

function appendTrackerRow(row) {
  const file = TRACKER_PATH();
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Application Tracker\n\n| # | Date | Company | Role | Score | Status | Resume | Notes |\n|---|------|---------|------|-------|--------|--------|-------|\n';
  const n = parseLastRowNum(text) + 1;
  const line = `| ${n} | ${cell(row.date)} | ${cell(row.company)} | ${cell(row.role)} | ${cell(row.score ?? '')} | ${cell(row.status)} | ${cell(row.reportDir || '')} | ${cell(row.notes || '')} |`;
  atomicWrite(file, text.replace(/\n*$/, '') + '\n' + line + '\n');
  return n;
}

/**
 * Update the Status column of an existing row matched by reportDir or slug.
 */
function updateTrackerStatus({ reportDir, slug, newStatus, notesAppend }) {
  const file = TRACKER_PATH();
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const needle = reportDir || (slug ? `reports/${slug}/` : null);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\|[^\\n]*)(\\| [^|]+) (\\| ${escaped}[^\\n]*)$`, 'm');
  const updated = text.replace(re, (line) => {
    // Status is the 6th column. Simplest: replace the text between col5 and col6 markers
    const cols = line.split('|');
    if (cols.length < 9) return line;
    cols[6] = ` ${cell(newStatus)} `;
    if (notesAppend) cols[8] = ` ${cols[8].trim()}; ${cell(notesAppend)} `;
    return cols.join('|');
  });
  if (updated === text) return false;
  atomicWrite(file, updated);
  return true;
}

// ── apply-queue.json ────────────────────────────────────────

function readQueue() {
  const file = QUEUE_PATH();
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function writeQueue(entries) {
  atomicWrite(QUEUE_PATH(), JSON.stringify(entries, null, 2));
}

function pushQueueEntry(entry) {
  const q = readQueue();
  // dedup on slug
  const existing = q.findIndex(e => e.slug === entry.slug);
  if (existing >= 0) {
    q[existing] = { ...q[existing], ...entry };
  } else {
    q.push(entry);
  }
  writeQueue(q);
  return entry.slug;
}

function updateQueueEntry(slug, patch) {
  const q = readQueue();
  const i = q.findIndex(e => e.slug === slug);
  if (i < 0) return false;
  q[i] = { ...q[i], ...patch };
  writeQueue(q);
  return true;
}

/**
 * Move a posting's report folder into reports/applied/{slug} or
 * reports/skipped/{slug} after the apply step. Updates the queue entry's
 * resumeDocx + coverLetterDocx paths and rewrites tracker.md reportDir
 * column so cross-references stay consistent.
 *
 * @param {string} slug
 * @param {'applied'|'skipped'|'needs-manual'} bucket
 * @returns {boolean} true if moved, false if no-op (folder missing or already moved)
 */
function moveReportFolder(slug, bucket) {
  // 'needs-manual' collects jobs whose resume is built but whose ATS blocks the
  // automated submit (e.g. a bot-detection wall) — they await a human apply.
  if (!['applied', 'skipped', 'needs-manual'].includes(bucket)) {
    throw new Error(`bucket must be 'applied', 'skipped', or 'needs-manual', got: ${bucket}`);
  }
  const root = getProjectRoot();
  const oldDir = path.join(root, 'reports', slug);
  const newDir = path.join(root, 'reports', bucket, slug);
  if (!fs.existsSync(oldDir)) return false;
  if (fs.existsSync(newDir)) return false;

  fs.mkdirSync(path.join(root, 'reports', bucket), { recursive: true });
  fs.renameSync(oldDir, newDir);

  // Update queue paths
  const q = readQueue();
  const i = q.findIndex(e => e.slug === slug);
  if (i >= 0) {
    const oldPrefix = `reports/${slug}`;
    const newPrefix = `reports/${bucket}/${slug}`;
    if (q[i].resumeDocx) q[i].resumeDocx = q[i].resumeDocx.replace(oldPrefix, newPrefix);
    if (q[i].coverLetterDocx) q[i].coverLetterDocx = q[i].coverLetterDocx.replace(oldPrefix, newPrefix);
    writeQueue(q);
  }

  // Rewrite tracker.md reportDir for this slug
  const trackerFile = TRACKER_PATH();
  if (fs.existsSync(trackerFile)) {
    const oldPath = `reports/${slug}/`;
    const newPath = `reports/${bucket}/${slug}/`;
    const escaped = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const text = fs.readFileSync(trackerFile, 'utf8');
    const updated = text.replace(new RegExp(escaped, 'g'), newPath);
    if (updated !== text) atomicWrite(trackerFile, updated);
  }
  return true;
}

module.exports = {
  appendTrackerRow,
  updateTrackerStatus,
  readQueue,
  writeQueue,
  pushQueueEntry,
  updateQueueEntry,
  moveReportFolder,
  atomicWrite,
};
