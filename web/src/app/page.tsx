import {
  getPipelineStages,
  getQueuePending,
  getRecentActivity,
  getTracker,
  getArchetypeBreakdown,
  getCompanyIndexSize,
} from '@/lib/data';
import { Card, CardHeader } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { TypographicFunnel } from '@/components/pipeline/TypographicFunnel';
import { ActivityFeed } from '@/components/pipeline/ActivityFeed';
import { ArchetypeStrip } from '@/components/pipeline/ArchetypeStrip';
import { ScorePill } from '@/components/ui/Pill';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

export default function PipelineOverviewPage() {
  const stages = getPipelineStages();
  const pending = getQueuePending();
  const tracker = getTracker();
  const recent = getRecentActivity(8);
  const archetypes = getArchetypeBreakdown().slice(0, 8);
  const companyIndex = getCompanyIndexSize();

  // Key metrics
  const queueAvgScore =
    pending.length > 0
      ? Math.round(
          (pending.reduce((n, e) => n + (e.score || 0), 0) / pending.length) *
            10,
        ) / 10
      : 0;
  const applied = tracker.filter((r) => /applied/i.test(r.status)).length;
  const responded = tracker.filter((r) =>
    /respond|interview|offer|screen/i.test(r.status),
  ).length;
  const responseRate = applied > 0 ? Math.round((responded / applied) * 100) : 0;
  const interviews = tracker.filter((r) =>
    /interview|onsite|loop/i.test(r.status),
  ).length;
  const interviewRate = applied > 0 ? Math.round((interviews / applied) * 100) : 0;

  // Top of queue
  const topQueue = [...pending]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 6);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8">
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-4 rise rise-1">
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-[var(--color-faint)]">
          <span>Pipeline</span>
          <span className="h-px flex-1 bg-[var(--color-border)]" />
          <span>{new Date().toISOString().slice(0, 10)}</span>
        </div>
        <h1
          className="font-display text-[3.25rem] font-medium leading-[0.95] tracking-tight text-[var(--color-foreground)]"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
        >
          The funnel,
          <br />
          <span className="italic text-[var(--color-muted-foreground)]" style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 100" }}>
            in numerals.
          </span>
        </h1>
        <p className="max-w-2xl text-[13px] leading-relaxed text-[var(--color-muted-foreground)]">
          Every stage is a real count from your local pipeline. Each numeral's
          size is proportional to its share of the previous stage. The amber
          percentages show conversion. {companyIndex} companies in the
          emergent ATS index.
        </p>
      </header>

      {/* ── Metric strip ─────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4 rise rise-2">
        <Stat
          label="In queue"
          value={pending.length}
          caption="Pending application — awaiting your action"
          accent
        />
        <Stat
          label="Avg score"
          value={queueAvgScore}
          caption="Mean match score across pending"
        />
        <Stat
          label="Response rate"
          value={`${responseRate}%`}
          caption={`${responded} of ${applied} applications`}
        />
        <Stat
          label="Interview rate"
          value={`${interviewRate}%`}
          caption={`${interviews} interviews triggered`}
        />
      </section>

      {/* ── Funnel + side rail ───────────────────────────────────── */}
      <section className="grid gap-4 lg:grid-cols-[1.6fr_1fr] rise rise-3">
        <Card>
          <CardHeader
            eyebrow="Stage I"
            title="Conversion cascade"
            caption="From discovery to offer — counts and step-over rates."
          />
          <TypographicFunnel stages={stages} />
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader
              eyebrow="Stage II"
              title="Recent activity"
              right={
                <Link
                  href="/applied"
                  className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted-foreground)] hover:text-[var(--color-accent)]"
                >
                  All →
                </Link>
              }
            />
            <ActivityFeed items={recent} />
          </Card>

          <Card>
            <CardHeader
              eyebrow="Stage III"
              title="Archetype distribution"
              caption="Across pending + applied"
            />
            <ArchetypeStrip data={archetypes} />
          </Card>
        </div>
      </section>

      {/* ── Top of queue ─────────────────────────────────────────── */}
      <section className="rise rise-4">
        <Card>
          <CardHeader
            eyebrow="Stage IV"
            title="Top of queue"
            caption={`Highest-scoring pending applications — sorted by JD-aware match score.`}
            right={
              <Link
                href="/queue"
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-[var(--color-muted-foreground)] hover:text-[var(--color-accent)]"
              >
                Open queue <ArrowUpRight size={12} />
              </Link>
            }
          />
          {topQueue.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="font-display italic text-sm text-[var(--color-muted-foreground)]">
                Queue is empty. Run <code className="font-mono">/jobe find</code> to
                discover new postings.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]/60">
              {topQueue.map((e) => (
                <li
                  key={e.slug}
                  className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-[var(--color-card-elev)]"
                >
                  <ScorePill score={e.score} />
                  <div className="flex flex-1 items-baseline gap-3 overflow-hidden">
                    <Link
                      href={`/reports/${e.slug}`}
                      className="font-display text-base font-medium leading-tight text-[var(--color-foreground)] hover:text-[var(--color-accent)]"
                    >
                      {e.company}
                    </Link>
                    <span className="hidden h-3 w-px bg-[var(--color-border)] md:block" />
                    <span className="line-clamp-1 text-sm text-[var(--color-muted-foreground)]">
                      {e.role}
                    </span>
                  </div>
                  <span className="hidden text-[10px] uppercase tracking-[0.16em] text-[var(--color-faint)] md:inline">
                    {e.archetype || 'Unspecified'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
