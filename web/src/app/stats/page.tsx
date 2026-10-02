import {
  getArchetypeBreakdown,
  getScoreHistogram,
  getApplicationsByDate,
  getSourceAttribution,
  getTracker,
  getQueue,
} from '@/lib/data';
import { Card, CardHeader } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { StatsBar, StatsPie, StatsLine } from '@/components/stats/Charts';

export default function StatsPage() {
  const archetypes = getArchetypeBreakdown();
  const scores = getScoreHistogram(5);
  const apps = getApplicationsByDate();
  const sources = getSourceAttribution().slice(0, 12);
  const tracker = getTracker();
  const queue = getQueue();

  // Per-archetype conversion (applied / queued+applied per archetype)
  const perArchetypeConversion = archetypes.map(({ archetype }) => {
    const inArchetype = queue.filter(
      (e) => (e.archetype || '').split('/')[0].trim() === archetype,
    );
    const applied = inArchetype.filter((e) => e.applied).length;
    const total = inArchetype.length;
    return {
      archetype,
      total,
      applied,
      rate: total > 0 ? Math.round((applied / total) * 100) : 0,
    };
  });

  const appliedTotal = tracker.filter((r) => /applied/i.test(r.status)).length;
  const interviewTotal = tracker.filter((r) => /interview|onsite|loop/i.test(r.status)).length;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8 rise rise-1">
      <header className="flex flex-col gap-3">
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-faint)]">
          Stage V · Analytics
        </span>
        <h1
          className="font-display text-[2.75rem] font-medium leading-none tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
        >
          The shape of the search.
        </h1>
        <p className="max-w-2xl text-[13px] leading-relaxed text-[var(--color-muted-foreground)]">
          Distributions, time-series, and source attribution from your local
          run history. None of this is aggregated off your machine.
        </p>
      </header>

      {/* KPI strip */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4 rise rise-2">
        <Stat label="Total queue" value={queue.length} />
        <Stat label="Applied" value={appliedTotal} accent />
        <Stat label="Interviews" value={interviewTotal} caption={appliedTotal ? `${Math.round((interviewTotal/appliedTotal)*100)}% of applied` : undefined} />
        <Stat label="Archetypes covered" value={archetypes.length} />
      </section>

      {/* Charts row 1 */}
      <section className="grid gap-6 lg:grid-cols-2 rise rise-3">
        <Card>
          <CardHeader
            eyebrow="Distribution"
            title="Score histogram"
            caption="JD-aware match score across the queue (5-point bins)"
          />
          <div className="px-3 pb-4 pt-2">
            <StatsBar data={scores} xKey="band" />
          </div>
        </Card>
        <Card>
          <CardHeader
            eyebrow="Mix"
            title="Archetype breakdown"
            caption="Pending + applied combined"
          />
          <div className="px-3 pb-4 pt-2">
            <StatsPie data={archetypes} />
          </div>
        </Card>
      </section>

      {/* Charts row 2 */}
      <section className="grid gap-6 lg:grid-cols-[2fr_1fr] rise rise-4">
        <Card>
          <CardHeader
            eyebrow="Cadence"
            title="Applications per day"
            caption="From tracker.md — historical apply submissions"
          />
          <div className="px-3 pb-4 pt-2">
            {apps.length === 0 ? (
              <p className="px-4 py-12 text-center font-display italic text-sm text-[var(--color-muted-foreground)]">
                No applications recorded yet.
              </p>
            ) : (
              <StatsLine data={apps} />
            )}
          </div>
        </Card>
        <Card>
          <CardHeader
            eyebrow="Origin"
            title="Source attribution"
            caption="Which discovery source surfaced each posting"
          />
          <ul className="flex flex-col gap-2 px-5 py-4 text-[12px]">
            {sources.length === 0 && (
              <li className="font-display italic text-[var(--color-muted-foreground)]">
                No discovery run yet.
              </li>
            )}
            {sources.map((s, i) => {
              const max = sources[0]?.count || 1;
              return (
                <li key={s.source} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-[11.5px] text-[var(--color-foreground)]">
                      {s.source}
                    </span>
                    <span className="font-mono text-[11.5px] tabular text-[var(--color-muted-foreground)]">
                      {s.count}
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-muted)]/40">
                    <div
                      className="h-full"
                      style={{
                        width: `${(s.count / max) * 100}%`,
                        background:
                          i === 0
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
      </section>

      {/* Per-archetype conversion */}
      <section className="rise rise-5">
        <Card>
          <CardHeader
            eyebrow="Conversion"
            title="Apply rate by archetype"
            caption="What fraction of each archetype's queue has been actually submitted"
          />
          <div className="grid grid-cols-1 gap-3 px-5 py-5 sm:grid-cols-2 lg:grid-cols-3">
            {perArchetypeConversion.map((r) => (
              <div
                key={r.archetype}
                className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card-elev)] p-4"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-display text-[13.5px] font-medium leading-tight text-[var(--color-foreground)]">
                    {r.archetype}
                  </span>
                  <span
                    className={`font-mono text-[16px] tabular ${
                      r.rate >= 60
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--color-foreground)]'
                    }`}
                  >
                    {r.rate}%
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-muted)]/40">
                    <div
                      className="h-full bg-[var(--color-accent)]"
                      style={{ width: `${r.rate}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10.5px] tabular text-[var(--color-muted-foreground)]">
                    {r.applied} / {r.total}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </section>
    </div>
  );
}
