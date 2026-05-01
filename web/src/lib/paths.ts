import 'server-only';
import path from 'node:path';

/**
 * The dashboard lives at `<jobe>/web/`. All filesystem reads target the
 * parent jobe repo. We compute the root once and export it.
 */
export const JOBE_ROOT = path.resolve(process.cwd(), '..');

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
