import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The dashboard lives at `<jobe>/web/`. The shared install root is the parent.
 * Personal data is per-user: it lives in the ACTIVE workspace under
 * `users/<slug>/` (multi-user). We resolve the active workspace the same way
 * lib/config.js does — JOBE_USER env, else the users/.active pointer, else the
 * install root (single-user / back-compat). Set JOBE_USER to view one person's
 * dashboard: `JOBE_USER=film npm run dev`.
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

const _user = activeUser();
export const JOBE_ROOT = _user ? path.join(INSTALL_ROOT, 'users', _user) : INSTALL_ROOT;

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
