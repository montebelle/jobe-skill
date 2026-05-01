import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { getLatestDiscovery, getCompanyIndexSize } from '@/lib/data';
import { Card, CardHeader } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { ScorePill, ArchetypePill } from '@/components/ui/Pill';

export default function DiscoveryPage() {
  const { date, enriched, summary } = getLatestDiscovery();
  const companies = getCompanyIndexSize();

  if (!date || !summary) {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 rise rise-1">
        <header className="flex flex-col gap-3">
          <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-faint)]">
            Stage VI · Discovery
          </span>
          <h1
            className="font-display text-[2.75rem] font-medium leading-none tracking-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
          >
            No runs found.
          </h1>
          <p className="text-[13px] text-[var(--color-muted-foreground)]">
            Run <code className="font-mono">/jobe find</code> from the parent
            jobe directory and refresh.
          </p>
        </header>
      </div>
    );
  }

  // Top 30 by score
  const top = [...enriched]
    .sort(
      (a, b) =>
        (b.matchScore ?? b.quickScore ?? 0) - (a.matchScore ?? a.quickScore ?? 0),
    )
    .slice(0, 30);

  const total = (Object.values(summary.perSource ?? {}) as number[]).reduce((n, v) => n + v, 0);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8 rise rise-1">
      <header className="flex flex-col gap-3">
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-faint)]">
          Stage VI · Discovery
        </span>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1
            className="font-display text-[2.75rem] font-medium leading-none tracking-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
          >
            Run of <span className="text-[var(--color-accent)]">{date}</span>.
          </h1>
          <span className="font-mono text-[11px] tabular text-[var(--color-muted-foreground)]">
            {companies} companies in the emergent index
          </span>
        </div>
        <p className="max-w-2xl text-[13px] leading-relaxed text-[var(--color-muted-foreground)]">
          The pipeline runs in four phases — slug-harvest, parallel discovery,
          broad enrich + JD-driven scoring, agent fallback. Per-source counts
          and the funnel summary live below.
        </p>
      </header>

      {/* Funnel numbers */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4 rise rise-2">
        <Stat label="Total raw" value={summary.totalRaw} caption="Across all sources" />
        <Stat label="After dedup" value={summary.afterDedup} caption="URL exact + dedupKey + MinHash LSH" />
        <Stat label="After filter" value={summary.afterFilter} caption="Role / remote / US / recency" />
        <Stat
          label="Enriched"
          value={summary.enriched}
          caption={summary.needsAgentFallback ? 'Agent fallback recommended' : 'Recall sufficient'}
          accent={summary.needsAgentFallback}
        />
      </section>

      {/* Per-source */}
      <section className="grid gap-6 lg:grid-cols-2 rise rise-3">
        <Card>
          <CardHeader
            eyebrow="Sources"
            title="Per-source contribution"
            caption={`Total raw: ${total.toLocaleString()}`}
          />
          <ul className="flex flex-col gap-2.5 px-5 py-5 text-[12.5px]">
            {Object.entries(summary.perSource ?? {})
              .sort((a, b) => b[1] - a[1])
              .map(([source, count]) => {
                const pct = total > 0 ? (count / total) * 100 : 0;
                return (
                  <li key={source} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-[var(--color-foreground)]">
                        {source}
                      </span>
                      <span className="font-mono tabular text-[var(--color-muted-foreground)]">
                        {count.toLocaleString()}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-muted)]/40">
                      <div
                        className="h-full"
                        style={{
                          width: `${pct}%`,
                          background:
                            count > total / 4
                              ? 'var(--color-accent)'
                              : 'var(--color-primary)',
                          opacity: 0.85,
                        }}
                      />
                    </div>
                  </li>
                );
              })}
          </ul>
        </Card>

        <Card>
          <CardHeader eyebrow="Filter trace" title="Why postings dropped" />
          <ul className="flex flex-col gap-3 px-5 py-5 text-[13px]">
            {Object.entries(summary.rejected ?? {})
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => {
                const totalReject = (Object.values(summary.rejected ?? {}) as number[]).reduce(
                  (n, v) => n + v,
                  0,
                );
                const pct = totalReject > 0 ? (count / totalReject) * 100 : 0;
                return (
                  <li key={reason} className="flex items-center gap-3">
                    <span className="w-24 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
                      {reason}
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-muted)]/40">
                      <div
                        className="h-full bg-[var(--color-destructive)]"
                        style={{ width: `${pct}%`, opacity: 0.7 }}
                      />
                    </div>
                    <span className="w-12 text-right font-mono tabular text-[var(--color-muted-foreground)]">
                      {count.toLocaleString()}
                    </span>
                  </li>
                );
              })}
          </ul>
          {summary.fallbackReason && (
            <div className="border-t border-[var(--color-border)] bg-[var(--color-accent-soft)]/40 px-5 py-3 text-[12px] text-[var(--color-accent)]">
              <strong className="font-display font-medium not-italic">Agent fallback:</strong>{' '}
              {summary.fallbackReason}
            </div>
          )}
        </Card>
      </section>

      {/* Top 30 ranked */}
      <Card className="overflow-hidden rise rise-4">
        <CardHeader
          eyebrow="Ranked"
          title="Top 30 from this run"
          caption="JD-aware fullScore on enriched JD text"
        />
        <ul className="divide-y divide-[var(--color-border)]/60">
          {top.map((p, i) => (
            <li
              key={p.canonicalUrl}
              className="grid grid-cols-[2.25rem_3.25rem_1fr_auto] items-center gap-4 px-5 py-2.5 transition-colors hover:bg-[var(--color-card-elev)]"
            >
              <span className="font-mono text-[11px] tabular text-[var(--color-faint)]">
                {String(i + 1).padStart(2, '0')}
              </span>
              <ScorePill score={p.matchScore ?? p.quickScore ?? undefined} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-[14px] font-medium text-[var(--color-foreground)]">
                    {p.company}
                  </span>
                  {p.archetype && <ArchetypePill archetype={p.archetype} />}
                </div>
                <span className="line-clamp-1 text-[12.5px] text-[var(--color-muted-foreground)]">
                  {p.title}
                </span>
              </div>
              <a
                href={p.canonicalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[10.5px] uppercase text-[var(--color-muted-foreground)] hover:border-[var(--color-border-hover)] hover:text-[var(--color-foreground)]"
              >
                <ExternalLink size={12} /> Open
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
