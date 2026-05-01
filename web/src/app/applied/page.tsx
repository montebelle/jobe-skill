import Link from 'next/link';
import { ExternalLink, FileText, Mail } from 'lucide-react';
import { getQueueApplied, getTracker } from '@/lib/data';
import { Card, CardHeader } from '@/components/ui/Card';
import { ScorePill, ArchetypePill, StatusPill } from '@/components/ui/Pill';
import { formatDate, relativeDays } from '@/lib/format';

export default function AppliedPage() {
  const applied = getQueueApplied();
  const tracker = getTracker();
  const trackerByCompany = new Map<string, ReturnType<typeof getTracker>[number]>();
  for (const r of tracker) {
    const key = `${r.company}::${r.role}`.toLowerCase();
    if (!trackerByCompany.has(key)) trackerByCompany.set(key, r);
  }

  // Combine queue-applied + tracker-only entries (applies done before queue)
  const combined: Array<{
    slug?: string;
    company: string;
    role: string;
    score?: number;
    archetype?: string;
    appliedDate?: string;
    status: string;
    primaryUrl?: string;
    resumeDocx?: string;
    coverLetterDocx?: string;
    notes?: string;
  }> = [];

  for (const e of applied) {
    const tk = trackerByCompany.get(`${e.company}::${e.role}`.toLowerCase());
    combined.push({
      slug: e.slug,
      company: e.company,
      role: e.role,
      score: e.score,
      archetype: e.archetype,
      appliedDate: e.appliedDate || tk?.date,
      status: tk?.status || 'Applied',
      primaryUrl: e.primaryUrl,
      resumeDocx: e.resumeDocx,
      coverLetterDocx: e.coverLetterDocx,
      notes: tk?.notes,
    });
  }
  // Add tracker rows that aren't already in the queue
  const queueKeys = new Set(applied.map((e) => `${e.company}::${e.role}`.toLowerCase()));
  for (const r of tracker) {
    if (!/applied|respond|interview|offer/i.test(r.status)) continue;
    const key = `${r.company}::${r.role}`.toLowerCase();
    if (queueKeys.has(key)) continue;
    combined.push({
      company: r.company,
      role: r.role,
      score: r.score,
      appliedDate: r.date,
      status: r.status,
      notes: r.notes,
    });
  }

  combined.sort((a, b) => (a.appliedDate ?? '') < (b.appliedDate ?? '') ? 1 : -1);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 rise rise-1">
      <header className="flex flex-col gap-3">
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-faint)]">
          Stage III · Applied
        </span>
        <h1
          className="font-display text-[2.75rem] font-medium leading-none tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
        >
          <span className="tabular">{combined.length}</span>{' '}
          <span className="italic text-[var(--color-muted-foreground)]" style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 100" }}>
            applications submitted
          </span>
        </h1>
      </header>

      <Card className="overflow-hidden rise rise-2">
        <CardHeader eyebrow="Submitted" title="Application history" caption="Combined view of apply-queue.json + tracker.md" />
        {combined.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="font-display italic text-sm text-[var(--color-muted-foreground)]">
              No applications submitted yet.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]/60">
            {combined.map((row, i) => (
              <li
                key={`${row.slug || row.company}-${i}`}
                className="grid grid-cols-[3.25rem_1fr_auto] gap-4 px-5 py-3 transition-colors hover:bg-[var(--color-card-elev)] md:grid-cols-[3.25rem_1fr_8rem_auto]"
              >
                <ScorePill score={row.score} />
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-baseline gap-2">
                    {row.slug ? (
                      <Link
                        href={`/reports/${row.slug}`}
                        className="font-display text-[15px] font-medium text-[var(--color-foreground)] hover:text-[var(--color-accent)]"
                      >
                        {row.company}
                      </Link>
                    ) : (
                      <span className="font-display text-[15px] font-medium text-[var(--color-foreground)]">
                        {row.company}
                      </span>
                    )}
                    {row.archetype && <ArchetypePill archetype={row.archetype} />}
                  </div>
                  <span className="line-clamp-1 text-[13px] text-[var(--color-muted-foreground)]">
                    {row.role}
                  </span>
                  {row.notes && (
                    <span className="line-clamp-1 text-[11px] text-[var(--color-faint)]">
                      {row.notes}
                    </span>
                  )}
                </div>
                <div className="hidden flex-col items-start justify-center md:flex">
                  <span className="font-mono text-[11px] tabular text-[var(--color-foreground)]">
                    {formatDate(row.appliedDate)}
                  </span>
                  <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
                    {relativeDays(row.appliedDate) || '—'}
                  </span>
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  <StatusPill status={row.status} />
                  {row.resumeDocx && (
                    <Link
                      href={`/api/docx/${row.resumeDocx}`}
                      className="hidden h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[10.5px] uppercase text-[var(--color-muted-foreground)] hover:border-[var(--color-border-hover)] hover:text-[var(--color-foreground)] md:inline-flex"
                      aria-label="Download resume"
                    >
                      <FileText size={12} /> Resume
                    </Link>
                  )}
                  {row.coverLetterDocx && (
                    <Link
                      href={`/api/docx/${row.coverLetterDocx}`}
                      className="hidden h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[10.5px] uppercase text-[var(--color-muted-foreground)] hover:border-[var(--color-border-hover)] hover:text-[var(--color-foreground)] md:inline-flex"
                      aria-label="Download cover letter"
                    >
                      <Mail size={12} /> Cover
                    </Link>
                  )}
                  {row.primaryUrl && (
                    <a
                      href={row.primaryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[10.5px] uppercase text-[var(--color-muted-foreground)] hover:border-[var(--color-border-hover)] hover:text-[var(--color-foreground)]"
                      aria-label="Re-open posting"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
