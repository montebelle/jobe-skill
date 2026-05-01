import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { getQueueSkipped, getTracker } from '@/lib/data';
import { Card, CardHeader } from '@/components/ui/Card';
import { ScorePill, ArchetypePill } from '@/components/ui/Pill';

export default function SkippedPage() {
  const skipped = getQueueSkipped();
  const tracker = getTracker().filter((r) => /skip/i.test(r.status));

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 rise rise-1">
      <header className="flex flex-col gap-3">
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-faint)]">
          Stage IV · Skipped
        </span>
        <h1
          className="font-display text-[2.75rem] font-medium leading-none tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
        >
          <span className="tabular text-[var(--color-destructive)]">
            {skipped.length + tracker.length}
          </span>{' '}
          <span className="italic text-[var(--color-muted-foreground)]" style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 100" }}>
            chosen against
          </span>
        </h1>
        <p className="max-w-2xl text-[13px] leading-relaxed text-[var(--color-muted-foreground)]">
          Skip reasons live here for the audit trail — useful when patterns
          show up (consistently skipping a sector, a seniority band, or a
          location).
        </p>
      </header>

      <Card className="overflow-hidden rise rise-2">
        <CardHeader eyebrow="From queue" title="Active-queue skips" />
        {skipped.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="font-display italic text-sm text-[var(--color-muted-foreground)]">
              No skips yet.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]/60">
            {skipped.map((e) => (
              <li
                key={e.slug}
                className="grid grid-cols-[3.25rem_1fr_auto] gap-4 px-5 py-3 transition-colors hover:bg-[var(--color-card-elev)]"
              >
                <ScorePill score={e.score} />
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-baseline gap-2">
                    <Link
                      href={`/reports/${e.slug}`}
                      className="font-display text-[15px] font-medium text-[var(--color-foreground)] hover:text-[var(--color-accent)]"
                    >
                      {e.company}
                    </Link>
                    <ArchetypePill archetype={e.archetype} />
                  </div>
                  <span className="line-clamp-1 text-[13px] text-[var(--color-muted-foreground)]">
                    {e.role}
                  </span>
                  {e.skipReason && (
                    <span className="text-[12px] italic text-[var(--color-destructive)]">
                      {e.skipReason}
                    </span>
                  )}
                </div>
                <a
                  href={e.primaryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-7 items-center gap-1 self-center rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[10.5px] uppercase text-[var(--color-muted-foreground)] hover:border-[var(--color-border-hover)] hover:text-[var(--color-foreground)]"
                  aria-label="Re-open posting"
                >
                  <ExternalLink size={12} /> Open
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {tracker.length > 0 && (
        <Card className="overflow-hidden rise rise-3">
          <CardHeader eyebrow="From tracker" title="Historical skips" caption="Skips recorded directly in tracker.md" />
          <ul className="divide-y divide-[var(--color-border)]/60">
            {tracker.map((r) => (
              <li
                key={`${r.index}-${r.company}`}
                className="grid grid-cols-[3.25rem_1fr_8rem] gap-4 px-5 py-3"
              >
                <ScorePill score={r.score} />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-display text-[15px] font-medium text-[var(--color-foreground)]">
                    {r.company}
                  </span>
                  <span className="line-clamp-1 text-[13px] text-[var(--color-muted-foreground)]">
                    {r.role}
                  </span>
                  {r.notes && (
                    <span className="line-clamp-2 text-[12px] italic text-[var(--color-destructive)]">
                      {r.notes}
                    </span>
                  )}
                </div>
                <span className="self-center font-mono text-[11px] tabular text-[var(--color-muted-foreground)]">
                  {r.date}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
