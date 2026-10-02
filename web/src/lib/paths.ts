import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The dashboard lives at `<jobe>/web/`. The shared install root is the parent.
 * Personal data is per user: it lives in the ACTIVE workspace under
 * `users/<slug>/` (multi user). We resolve the active workspace the same way
 * lib/config.js does: an absolute JOBE_USER_ROOT, else JOBE_USER, else the
 * users/.active pointer, else the install root (single user). Set JOBE_USER to
 * view one person's dashboard: `JOBE_USER=<workspace> npm run dev`.
 */
const INSTALL_ROOT = path.resolve(process.cwd(), '..');

function sanitizeSlug(s: string | undefined | null): string | null {
  const slug = String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || null;
}

function activeUser(): string | null {
  if (process.env.JOBE_USER) return sanitizeSlug(process.env.JOBE_USER);
  try {
    const pointer = path.join(INSTALL_ROOT, 'users', '.active');
    if (fs.existsSync(pointer)) return sanitizeSlug(fs.readFileSync(pointer, 'utf8'));
  } catch { /* fall through to install root */ }
  return null;
}

// Same rule as lib/config.js userRootOverride(): the override beats the active
// user, and a relative value is an error instead of a silent fall through to a
// real workspace.
function rootOverride(): string | null {
  const v = process.env.JOBE_USER_ROOT;
  if (!v) return null;
  if (!path.isAbsolute(v)) throw new Error(`JOBE_USER_ROOT must be an absolute path (got "${v}")`);
  return path.normalize(v);
}

const _user = activeUser();
export const JOBE_ROOT =
  rootOverride() ?? (_user ? path.join(INSTALL_ROOT, 'users', _user) : INSTALL_ROOT);

export const paths = {
  applyQueue:   path.join(JOBE_ROOT, 'data', 'apply-queue.json'),
  tracker:      path.join(JOBE_ROOT, 'data', 'tracker.md'),
  storyBank:    path.join(JOBE_ROOT, 'data', 'story-bank.md'),
  followups:    path.join(JOBE_ROOT, 'data', 'followups.md'),
  contacts:     path.join(JOBE_ROOT, 'data', 'contacts.json'),
  companyIndex: path.join(JOBE_ROOT, 'data', 'companies', 'index.json'),
  reports:      path.join(JOBE_ROOT, 'reports'),
  signals:      path.join(JOBE_ROOT, 'signals', 'discovered'),
};

// Report folder lifecycle.
// Mirror of LIFECYCLE_BUCKETS and locateReportDir in `<jobe>/lib/tracker-writer.js`
// (test/data-templates-web.test.js fails when the two lists drift). A report
// folder lives at reports/<bucket>/<slug>/. This is the ONE bucket list in the
// dashboard: data.ts and writer.ts both resolve folders through locateReportDir.
export const LIFECYCLE_BUCKETS = ['verify', 'evaluate', 'queue', 'manual', 'applied', 'skipped', 'archive', 'audit'] as const;
export type LifecycleBucket = (typeof LIFECYCLE_BUCKETS)[number];
// Bucket names older workspaces may still hold. Read only.
const LEGACY_BUCKETS = ['needs-manual', 'gated', 'non-gated'];
const RESERVED = new Set<string>([...LIFECYCLE_BUCKETS, ...LEGACY_BUCKETS]);

function isRealDir(d: string): boolean {
  try { return fs.lstatSync(d).isDirectory(); } catch { return false; }
}

/**
 * Find a slug's current report folder anywhere under the workspace reports/:
 * flat reports/<slug>/ (older layout), then each lifecycle bucket in stage
 * order, then the legacy buckets, then reports/<bucket>/archive/<date>/<slug>/
 * (newest date first). The slug must be one plain path segment and never a
 * bucket name, so a request can not climb out of reports/.
 */
export function locateReportDir(slug: string): string | null {
  const s = String(slug || '').trim();
  if (!s || /[\\/]/.test(s) || s === '.' || s === '..' || RESERVED.has(s)) return null;
  const flat = [paths.reports, ...[...LIFECYCLE_BUCKETS, ...LEGACY_BUCKETS].map((b) => path.join(paths.reports, b))]
    .map((dir) => path.join(dir, s))
    .find(isRealDir);
  if (flat) return flat;
  for (const b of LIFECYCLE_BUCKETS) {
    const ar = path.join(paths.reports, b, 'archive');
    let dates: string[];
    try { dates = fs.readdirSync(ar).sort().reverse(); } catch { continue; }
    for (const date of dates) {
      const d = path.join(ar, date, s);
      if (isRealDir(d)) return d;
    }
  }
  return null;
}
