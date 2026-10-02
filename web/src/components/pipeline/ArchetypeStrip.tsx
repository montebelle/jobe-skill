/**
 * A horizontal stacked-bar shorthand for archetype distribution. No legend
 * cluttering things — the labels live inside each segment when they fit, or
 * below as muted captions otherwise.
 */
export function ArchetypeStrip({
  data,
}: {
  data: Array<{ archetype: string; count: number }>;
}) {
  const total = data.reduce((n, d) => n + d.count, 0) || 1;
  const palette = [
    'var(--color-chart-1)',
    'var(--color-chart-2)',
    'var(--color-chart-3)',
    'var(--color-chart-4)',
    'var(--color-chart-5)',
    'var(--color-chart-6)',
    'var(--color-chart-7)',
    'var(--color-chart-8)',
  ];

  return (
    <div className="flex flex-col gap-3 px-5 py-5">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--color-muted)]/40">
        {data.map((d, i) => (
          <div
            key={d.archetype}
            className="h-full transition-opacity hover:opacity-80"
            style={{
              width: `${(d.count / total) * 100}%`,
              background: palette[i % palette.length],
              opacity: 0.85,
            }}
            title={`${d.archetype}: ${d.count}`}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {data.map((d, i) => (
          <li key={d.archetype} className="flex items-center gap-2 text-[var(--color-muted-foreground)]">
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: palette[i % palette.length] }}
            />
            <span className="flex-1 truncate">{d.archetype}</span>
            <span className="font-mono tabular text-[var(--color-foreground)]">
              {d.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
