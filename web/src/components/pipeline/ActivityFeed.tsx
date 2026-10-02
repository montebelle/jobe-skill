import Link from 'next/link';
import { CheckCircle2, XCircle, ListTodo } from 'lucide-react';
import { relativeDays } from '@/lib/format';
import { ScorePill } from '@/components/ui/Pill';
import type { ActivityItem } from '@/lib/data';

const ICON = {
  applied: { I: CheckCircle2, color: 'text-[var(--color-success)]' },
  skipped: { I: XCircle, color: 'text-[var(--color-destructive)]' },
  queued:  { I: ListTodo, color: 'text-[var(--color-muted-foreground)]' },
} as const;

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (!items.length) {
    return (
      <div className="flex h-full min-h-[12rem] items-center justify-center px-5 py-8">
        <p className="font-display italic text-sm text-[var(--color-muted-foreground)]">
          No recent activity. Apply to something.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {items.map((it, i) => {
        const { I, color } = ICON[it.kind];
        return (
          <li
            key={i}
            className="group flex items-start gap-3 border-b border-[var(--color-border)]/50 px-5 py-3 last:border-b-0"
          >
            <I size={14} className={`${color} mt-1 shrink-0`} strokeWidth={1.6} />
            <div className="flex flex-1 flex-col gap-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-sm font-medium leading-tight text-[var(--color-foreground)]">
                  {it.company}
                </span>
                <ScorePill score={it.score} />
              </div>
              {it.slug ? (
                <Link
                  href={`/reports/${it.slug}`}
                  className="line-clamp-1 text-xs text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-accent)]"
                >
                  {it.role}
                </Link>
              ) : (
                <p className="line-clamp-1 text-xs text-[var(--color-muted-foreground)]">
                  {it.role}
                </p>
              )}
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-faint)]">
                <span>{it.kind}</span>
                <span>·</span>
                <span>{relativeDays(it.ts) || 'unknown'}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
