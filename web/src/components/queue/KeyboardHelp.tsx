export function KeyboardHelp() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-muted-foreground)]">
      <Hint k="j / k" label="navigate" />
      <Hint k="a" label="apply" />
      <Hint k="s" label="skip" />
      <Hint k="↵" label="open report" />
      <Hint k="/" label="focus filter" />
    </div>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-[var(--color-border-hover)] bg-[var(--color-card)] px-1.5 font-mono text-[10px] text-[var(--color-foreground)]">
        {k}
      </kbd>
      <span className="text-[var(--color-faint)]">{label}</span>
    </span>
  );
}
