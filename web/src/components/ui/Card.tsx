import { cn } from '@/lib/classes';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  elev?: boolean;
}

export function Card({ className, elev, ...props }: CardProps) {
  return (
    <div
      {...props}
      className={cn(
        'rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)] transition-all',
        elev && 'shadow-[var(--shadow-card-hover)] bg-[var(--color-card-elev)]',
        className,
      )}
    />
  );
}

export function CardHeader({
  eyebrow,
  title,
  caption,
  right,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  caption?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
      <div className="flex flex-col gap-1">
        {eyebrow && (
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-faint)]">
            {eyebrow}
          </span>
        )}
        <h2 className="font-display text-lg font-medium leading-tight text-[var(--color-foreground)]">
          {title}
        </h2>
        {caption && (
          <p className="text-xs text-[var(--color-muted-foreground)]">{caption}</p>
        )}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function CardBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...props} />;
}
