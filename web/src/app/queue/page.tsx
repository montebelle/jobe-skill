import { getQueuePending } from '@/lib/data';
import { Card, CardHeader } from '@/components/ui/Card';
import { QueueTable } from '@/components/queue/QueueTable';
import { KeyboardHelp } from '@/components/queue/KeyboardHelp';

export default function QueuePage() {
  const pending = getQueuePending();

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 rise rise-1">
      {/* Hero */}
      <header className="flex flex-col gap-3">
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-faint)]">
          Stage II · Apply queue
        </span>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <h1
            className="font-display text-[2.75rem] font-medium leading-none tracking-tight"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
          >
            <span className="tabular text-[var(--color-accent)]">{pending.length}</span>{' '}
            <span className="italic text-[var(--color-muted-foreground)]" style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 100" }}>
              awaiting your action
            </span>
          </h1>
          <KeyboardHelp />
        </div>
        <p className="max-w-2xl text-[13px] leading-relaxed text-[var(--color-muted-foreground)]">
          Each row has a tailored resume + cover letter on disk. Apply opens
          the canonical posting; click "Apply" once you've submitted to mark
          the entry done. Skip captures a reason for the audit trail.
        </p>
      </header>

      <Card className="overflow-hidden rise rise-2">
        <CardHeader
          eyebrow="Pending"
          title="Active queue"
          caption="Sorted by JD-aware match score (fullScore, 0–100)"
        />
        <QueueTable entries={pending} />
      </Card>
    </div>
  );
}
