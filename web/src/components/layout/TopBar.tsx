import Link from 'next/link';
import { Menu } from 'lucide-react';
import {
  getQueueApplied,
  getQueuePending,
  getQueueSkipped,
} from '@/lib/data';

export function TopBar() {
  const pending = getQueuePending().length;
  const applied = getQueueApplied().length;
  const skipped = getQueueSkipped().length;
  return (
    <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-background)]/80 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-background)]/65">
      <div className="flex items-center gap-6 px-6 py-3 md:px-10 lg:px-14">
        <Link
          href="/"
          className="md:hidden font-display text-xl font-medium tracking-tight"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
        >
          jobe<span className="text-[var(--color-accent)]">.</span>
        </Link>

        <button
          aria-label="Toggle menu"
          className="md:hidden text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        >
          <Menu size={18} />
        </button>

        <nav className="ml-auto flex items-center gap-6 text-[11px] uppercase tracking-[0.16em] text-[var(--color-muted-foreground)]">
          <Stat label="Queued" value={pending} accent />
          <span className="h-3 w-px bg-[var(--color-border)]" />
          <Stat label="Applied" value={applied} />
          <span className="h-3 w-px bg-[var(--color-border)]" />
          <Stat label="Skipped" value={skipped} />
        </nav>
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span>{label}</span>
      <span
        className={`font-mono tabular text-sm normal-case tracking-normal ${
          accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-foreground)]'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
