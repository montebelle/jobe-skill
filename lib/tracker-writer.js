/**
 * Unified writer for data/tracker.md and data/apply-queue.json.
 *
 * Before this module, find.md, evaluate.md, and apply-all.md each wrote
 * to these files directly. Three writers with no locking = race condition
 * on concurrent runs, inconsistent column ordering, and silent data loss.
 *
 * All writes now funnel through {appendTrackerRow, upsertTrackerRow,
 * updateTrackerStatus, updateQueueEntry, pushQueueEntry, moveReportFolder}.
 * Every write uses atomic-rename (write to .tmp, rename to final) so a
 * concurrent read sees either the pre- or post-state, never a half-written
 * file.
 *
 * Every path is resolved per call through getProjectRoot(), so the workspace
 * in effect at call time decides (JOBE_USER / JOBE_USER_ROOT).
 *
 * This module also owns the report-folder lifecycle (LIFECYCLE_BUCKETS,
 * locateReportDir, moveReportFolder). Other code that needs a slug's folder
 * (lib/apply/answers.js, the dashboard) must use locateReportDir instead of
 * keeping its own bucket list.
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

const TRACKER_HEADER = '# Application Tracker\n\n| # | Date | Company | Role | Score | Status | Resume | Notes |\n|---|------|---------|------|-------|--------|--------|-------|\n';
const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Relative paths are stored with forward slashes on every platform.
const relPosix = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

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
 * @param {string} row.reportDir   e.g. reports/queue/acme-health-staff-nurse/
 * @param {string} row.notes
 */
// Markdown table cells cannot contain a raw '|' (it would shift every column
// for the split-based parsers in this file, web/src/lib/data.ts, and
// tracker-stats.js). Role/company/JD-derived titles frequently contain " | "
// (e.g. "Staff Nurse | ICU | Nights"), so sanitize every cell on write: map '|'
// to '/' and flatten newlines. This keeps each row exactly 8 columns.
function cell(v) {
  return String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
}

function appendTrackerRow(row) {
  const file = TRACKER_PATH();
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : TRACKER_HEADER;
  const n = parseLastRowNum(text) + 1;
  const line = `| ${n} | ${cell(row.date)} | ${cell(row.company)} | ${cell(row.role)} | ${cell(row.score ?? '')} | ${cell(row.status)} | ${cell(row.reportDir || '')} | ${cell(row.notes || '')} |`;
  atomicWrite(file, text.replace(/\n*$/, '') + '\n' + line + '\n');
  return n;
}

/**
 * Insert or replace one tracker row identified by report slug.
 *
 * Unlike appendTrackerRow(), this is safe for resumable evaluation runs: a
 * report that moved between lifecycle buckets (for example skipped -> queue)
 * keeps its row number and gets its current paths instead of creating a
 * duplicate row. If historical duplicates already exist for the same slug,
 * the first row is updated and the later duplicates are removed.
 *
 * @param {object} row  Same shape as appendTrackerRow().
 * @param {string} slug Stable report/application slug.
 * @returns {{rowNumber: number, inserted: boolean, removedDuplicates: number}}
 */
function upsertTrackerRow(row, slug) {
  if (!slug || !String(slug).trim()) throw new Error('slug is required');
  const file = TRACKER_PATH();
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : TRACKER_HEADER;
  const lines = text.replace(/\n*$/, '').split('\n');
  const reportRe = new RegExp(`(?:^|/)${escapeRe(String(slug).trim())}/?$`);
  const matches = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^\|\s*\d+\s*\|/.test(lines[i])) continue;
    const cols = lines[i].split('|');
    const reportDir = (cols[7] || '').trim();
    if (reportRe.test(reportDir)) matches.push({ index: i, rowNumber: Number((cols[1] || '').trim()) });
  }

  const inserted = matches.length === 0;
  const rowNumber = inserted ? parseLastRowNum(text) + 1 : matches[0].rowNumber;
  const replacement = `| ${rowNumber} | ${cell(row.date)} | ${cell(row.company)} | ${cell(row.role)} | ${cell(row.score ?? '')} | ${cell(row.status)} | ${cell(row.reportDir || '')} | ${cell(row.notes || '')} |`;

  if (inserted) {
    lines.push(replacement);
  } else {
    lines[matches[0].index] = replacement;
    for (let i = matches.length - 1; i >= 1; i--) lines.splice(matches[i].index, 1);
  }

  atomicWrite(file, lines.join('\n') + '\n');
  return { rowNumber, inserted, removedDuplicates: Math.max(0, matches.length - 1) };
}

/**
 * Update the Status column of an existing row matched by reportDir or slug.
 *
 * With a slug, the row is found through the lifecycle locator: the folder's
 * CURRENT location (reports/<bucket>/<slug>/, wherever it sits) is the needle,
 * so a folder that moved between buckets still matches. A row whose path is
 * stale (folder moved by hand, or gone) still matches on the slug path
 * segment. The first matching row is updated.
 */
function updateTrackerStatus({ reportDir, slug, newStatus, notesAppend }) {
  const file = TRACKER_PATH();
  if (!fs.existsSync(file)) return false;
  const needles = [];
  if (reportDir) needles.push(new RegExp(`^${escapeRe(reportDir)}`));
  else if (slug) {
    const root = getProjectRoot();
    const located = locateReportDir(root, slug);
    if (located) needles.push(new RegExp(`^${escapeRe(relPosix(root, located))}(?:/|$)`));
    needles.push(new RegExp(`(?:^|/)${escapeRe(String(slug).trim())}(?:/|$)`));
  }
  if (!needles.length) return false;

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const needle of needles) {
    for (let i = 0; i < lines.length; i++) {
      if (!/^\|\s*\d+\s*\|/.test(lines[i])) continue;
      const cols = lines[i].split('|');
      // Status is the 6th column, report path the 7th, notes the 8th.
      if (cols.length < 9 || !needle.test(cols[7].trim())) continue;
      cols[6] = ` ${cell(newStatus)} `;
      if (notesAppend) cols[8] = ` ${cols[8].trim()}; ${cell(notesAppend)} `;
      lines[i] = cols.join('|');
      atomicWrite(file, lines.join('\n'));
      return true;
    }
  }
  return false;
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

// ── report-folder lifecycle ─────────────────────────────────
//
// A report folder lives at reports/<bucket>/<slug>/ and moves through:
//   verify   resume generated, verification pending or failed
//   evaluate scored and verified, decision pending
//   queue    ready to apply (listed in apply-queue.json)
//   manual   a human must finish it (the form has gates the harness cannot
//            register, or the site blocks an automated submit). An ACTIVE
//            parking bucket the user still submits from, so it files flat.
//   applied | skipped   outcome
//   archive  aged out
//   audit    audit reports (a sibling, not a stage)
const LIFECYCLE_BUCKETS = ['verify', 'evaluate', 'queue', 'manual', 'applied', 'skipped', 'archive', 'audit'];
// Bucket names older workspaces may still hold. Read only: the locator finds
// folders there so they can be moved on; nothing is ever moved INTO them.
const LEGACY_BUCKETS = ['needs-manual', 'gated', 'non-gated'];
const RESERVED = new Set([...LIFECYCLE_BUCKETS, ...LEGACY_BUCKETS]);

function isRealDir(d) {
  try { return fs.lstatSync(d).isDirectory(); } catch { return false; }
}

/**
 * Find a slug's current report folder anywhere under <root>/reports:
 *   1. legacy flat staging      reports/<slug>/
 *   2. a lifecycle bucket       reports/<bucket>/<slug>/   (stage order)
 *   3. a legacy bucket          reports/needs-manual/<slug>/ and the like
 *   4. a legacy dated archive   reports/<bucket>/archive/<date>/<slug>/  (newest date first)
 *
 * @param {string} root workspace root (getProjectRoot())
 * @param {string} slug report slug: one path segment, never a bucket name
 * @returns {string|null} absolute folder path, or null when not found
 */
function locateReportDir(root, slug) {
  const s = String(slug || '').trim();
  // One plain path segment only: a slug can never climb out of reports/ or
  // name a bucket folder itself.
  if (!s || /[\\/]/.test(s) || s === '.' || s === '..' || RESERVED.has(s)) return null;
  const reports = path.join(root, 'reports');
  const flat = [reports, ...[...LIFECYCLE_BUCKETS, ...LEGACY_BUCKETS].map((b) => path.join(reports, b))]
    .map((dir) => path.join(dir, s))
    .find(isRealDir);
  if (flat) return flat;
  for (const b of LIFECYCLE_BUCKETS) {
    const ar = path.join(reports, b, 'archive');
    let dates;
    try { dates = fs.readdirSync(ar).sort().reverse(); } catch { continue; }
    for (const date of dates) {
      const d = path.join(ar, date, s);
      if (isRealDir(d)) return d;
    }
  }
  return null;
}

/**
 * Move a posting's report folder to a lifecycle bucket (always flat:
 * reports/<bucket>/<slug>/) and keep the cross-references consistent: the
 * queue entry's resumeDocx + coverLetterDocx + reportDir and every tracker.md
 * reference to the old path are rewritten, each through an atomic write. The
 * folder is found wherever it currently sits (locateReportDir).
 *
 * @param {string} slug
 * @param {'verify'|'evaluate'|'queue'|'manual'|'applied'|'skipped'|'archive'|'audit'} bucket
 * @returns {boolean} true if moved, false if no-op (folder missing, already there, or destination taken)
 */
function moveReportFolder(slug, bucket) {
  // Older callers named the human-finishes-it bucket 'needs-manual'.
  if (bucket === 'needs-manual') bucket = 'manual';
  if (!LIFECYCLE_BUCKETS.includes(bucket)) {
    throw new Error(`bucket must be one of ${LIFECYCLE_BUCKETS.join(', ')}, got: ${bucket}`);
  }
  const root = getProjectRoot();
  const oldDir = locateReportDir(root, slug);
  if (!oldDir) return false;

  const newDir = path.join(root, 'reports', bucket, path.basename(oldDir));
  if (path.resolve(oldDir) === path.resolve(newDir)) return false; // already there
  if (fs.existsSync(newDir)) return false;

  fs.mkdirSync(path.dirname(newDir), { recursive: true });
  fs.renameSync(oldDir, newDir);

  const oldRel = relPosix(root, oldDir);
  const newRel = relPosix(root, newDir);

  // Update queue paths
  const q = readQueue();
  const i = q.findIndex(e => e.slug === slug);
  if (i >= 0) {
    if (q[i].resumeDocx) q[i].resumeDocx = q[i].resumeDocx.split(`${oldRel}/`).join(`${newRel}/`);
    if (q[i].coverLetterDocx) q[i].coverLetterDocx = q[i].coverLetterDocx.split(`${oldRel}/`).join(`${newRel}/`);
    q[i].reportDir = `${newRel}/`;
    writeQueue(q);
  }

  // Rewrite tracker.md reportDir for this slug
  const trackerFile = TRACKER_PATH();
  if (fs.existsSync(trackerFile)) {
    const text = fs.readFileSync(trackerFile, 'utf8');
    const updated = text.split(`${oldRel}/`).join(`${newRel}/`);
    if (updated !== text) atomicWrite(trackerFile, updated);
  }
  return true;
}

module.exports = {
  appendTrackerRow,
  upsertTrackerRow,
  updateTrackerStatus,
  readQueue,
  writeQueue,
  pushQueueEntry,
  updateQueueEntry,
  LIFECYCLE_BUCKETS,
  locateReportDir,
  moveReportFolder,
  atomicWrite,
};
