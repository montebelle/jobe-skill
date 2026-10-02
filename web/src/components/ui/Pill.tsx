import { cn } from '@/lib/classes';
import { archetypeShort, scoreBand } from '@/lib/format';

export function ArchetypePill({ archetype }: { archetype?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/60 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">
      <span className="h-1 w-1 rounded-full bg-[var(--color-primary)]" />
      {archetypeShort(archetype)}
    </span>
  );
}

export function ScorePill({ score }: { score?: number }) {
  const band = scoreBand(score);
  const label = typeof score === 'number' ? Math.round(score) : '—';
  const color = {
    strong:  'text-[var(--color-accent)] border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]',
    good:    'text-[var(--color-accent)] border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]',
    stretch: 'text-[var(--color-foreground)] border-[var(--color-border-hover)] bg-[var(--color-card-elev)]',
    reach:   'text-[var(--color-muted-foreground)] border-[var(--color-border)] bg-[var(--color-card)]',
    unknown: 'text-[var(--color-muted-foreground)] border-[var(--color-border)] bg-[var(--color-card)]',
  }[band];
  return (
    <span
      className={cn(
        'inline-flex h-6 min-w-[2.25rem] items-center justify-center rounded-md border px-1.5 font-mono tabular text-[12px]',
        color,
      )}
    >
      {label}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone =
    /offer/.test(s) ? 'text-[var(--color-accent)] border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]'
      : /interview|onsite|loop/.test(s) ? 'text-[var(--color-success)] border-[var(--color-success)]/40 bg-[var(--color-success-soft)]'
      : /respond/.test(s) ? 'text-[var(--color-success)] border-[var(--color-success)]/30 bg-[var(--color-success-soft)]'
      : /applied/.test(s) ? 'text-[var(--color-foreground)] border-[var(--color-border-hover)] bg-[var(--color-card-elev)]'
      : /skip|reject/.test(s) ? 'text-[var(--color-destructive)] border-[var(--color-destructive)]/30 bg-[var(--color-destructive-soft)]'
      : 'text-[var(--color-muted-foreground)] border-[var(--color-border)] bg-[var(--color-card)]';
  return (
    <span className={cn('inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em]', tone)}>
      {status}
    </span>
  );
}
