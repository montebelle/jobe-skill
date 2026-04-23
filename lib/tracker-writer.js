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
function appendTrackerRow(row) {
  const file = TRACKER_PATH();
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Application Tracker\n\n| # | Date | Company | Role | Score | Status | Resume | Notes |\n|---|------|---------|------|-------|--------|--------|-------|\n';
  const n = parseLastRowNum(text) + 1;
  const line = `| ${n} | ${row.date} | ${row.company} | ${row.role} | ${row.score ?? ''} | ${row.status} | ${row.reportDir || ''} | ${row.notes || ''} |`;
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
    cols[6] = ` ${newStatus} `;
    if (notesAppend) cols[8] = ` ${cols[8].trim()}; ${notesAppend} `;
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

module.exports = {
  appendTrackerRow,
  updateTrackerStatus,
  readQueue,
  writeQueue,
  pushQueueEntry,
  updateQueueEntry,
  atomicWrite,
};
