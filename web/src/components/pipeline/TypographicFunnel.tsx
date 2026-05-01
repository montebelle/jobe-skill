import type { PipelineStage } from '@/lib/types';

/**
 * The signature: numbers as monuments. Each stage's count is rendered as a
 * variable-weight serif numeral whose font-size scales with the stage's
 * conversion rate from the previous stage. The result reads as a typographic
 * waterfall — discovered at the top, offer at the base — with conversion
 * percentages whispered in mono on the right.
 */
export function TypographicFunnel({ stages }: { stages: PipelineStage[] }) {
  // Scale font-size from 6.5rem (top) to 2rem (bottom) based on count^0.4.
  const max = Math.max(...stages.map((s) => Math.max(1, s.count)));
  const sizeFor = (count: number) => {
    if (count === 0) return 1.5;
    const t = Math.pow(count / max, 0.4);
    return 1.75 + t * 4.75; // 1.75rem .. 6.5rem
  };

  return (
    <div className="relative flex flex-col gap-1 px-3 py-4">
      {stages.map((s, i) => {
        const fontSize = sizeFor(s.count);
        const isFirst = i === 0;
        const drop = s.conversionFromPrev !== undefined ? s.conversionFromPrev : 1;
        const dropPct = isFirst ? null : Math.round(drop * 100);
        return (
          <div
            key={s.key}
            className={`group flex items-baseline gap-5 border-b border-[var(--color-border)]/40 py-3 transition-colors hover:border-[var(--color-border-hover)] rise rise-${Math.min(i + 1, 5)}`}
          >
            {/* Stage label */}
            <span className="w-32 shrink-0 text-[10.5px] uppercase tracking-[0.22em] text-[var(--color-muted-foreground)]">
              {String(i + 1).padStart(2, '0')}{' · '}{s.label}
            </span>

            {/* The monument numeral */}
            <span
              className="font-display tabular leading-[0.9] text-[var(--color-foreground)] transition-all"
              style={{
                fontSize: `${fontSize}rem`,
                fontVariationSettings: `'opsz' 144, 'SOFT' ${i * 12}`,
                fontWeight: 400 + i * 30,
              }}
            >
              {s.count}
            </span>

            {/* Conversion whisper */}
            <span className="ml-auto self-end pb-2 font-mono text-[11px] tabular text-[var(--color-faint)]">
              {dropPct !== null && (
                <>
                  <span
                    className={
                      dropPct >= 60 ? 'text-[var(--color-accent)]'
                        : dropPct >= 30 ? 'text-[var(--color-foreground)]'
                        : 'text-[var(--color-muted-foreground)]'
                    }
                  >
                    {dropPct}%
                  </span>
                  <span className="ml-1 text-[var(--color-faint)]">
                    of {stages[i - 1].label.toLowerCase()}
                  </span>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
