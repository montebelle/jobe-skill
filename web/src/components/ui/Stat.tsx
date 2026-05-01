import { cn } from '@/lib/classes';

interface StatProps {
  label: string;
  value: React.ReactNode;
  delta?: string;
  caption?: string;
  accent?: boolean;
  className?: string;
}

/**
 * The Stat is a primitive monument: huge variable-weight serif numeral on top
 * of a thin uppercase eyebrow. The accent variant glints amber.
 */
export function Stat({ label, value, delta, caption, accent, className }: StatProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5',
        accent && 'shadow-[var(--shadow-amber)]',
        className,
      )}
    >
      <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-muted-foreground)]">
        {label}
      </span>
      <div className="flex items-baseline gap-3">
        <span
          className={cn(
            'font-display text-[2.5rem] leading-none font-medium tabular',
            accent ? 'text-[var(--color-accent)] glint' : 'text-[var(--color-foreground)]',
          )}
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
        >
          {value}
        </span>
        {delta && (
          <span className="text-xs font-mono text-[var(--color-muted-foreground)]">
            {delta}
          </span>
        )}
      </div>
      {caption && (
        <p className="text-xs leading-snug text-[var(--color-muted-foreground)]">
          {caption}
        </p>
      )}
    </div>
  );
}
