/** Formatting utilities — pure functions, no fs. */

export function formatDate(s?: string): string {
  if (!s) return '';
  // Accept ISO date or ISO datetime; return YYYY-MM-DD
  return s.slice(0, 10);
}

export function relativeDays(s?: string): string {
  if (!s) return '';
  const now = new Date();
  const then = new Date(s);
  if (Number.isNaN(then.getTime())) return '';
  const diff = Math.floor(
    (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return `${diff} days ago`;
  if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
  if (diff < 365) return `${Math.floor(diff / 30)}mo ago`;
  return `${Math.floor(diff / 365)}y ago`;
}

export function scoreBand(
  score?: number,
): 'strong' | 'good' | 'stretch' | 'reach' | 'unknown' {
  if (typeof score !== 'number') return 'unknown';
  if (score >= 80) return 'strong';
  if (score >= 70) return 'good';
  if (score >= 55) return 'stretch';
  return 'reach';
}

export function archetypeShort(a?: string): string {
  if (!a) return '—';
  return a.split('/')[0].trim();
}

/** Coerce an absolute or repo-relative path to repo-relative for the docx route. */
export function repoRelative(p?: string): string | undefined {
  if (!p) return undefined;
  return p.replace(/^.*\/jobe\//, '').replace(/^\.\//, '');
}
