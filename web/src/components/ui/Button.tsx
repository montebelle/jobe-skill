'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/classes';

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type Size = 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary:
    'border border-[var(--color-accent)]/60 bg-[var(--color-accent)] text-[var(--color-accent-foreground)] hover:bg-[var(--color-accent-strong)] hover:border-[var(--color-accent-strong)]',
  secondary:
    'border border-[var(--color-border-hover)] bg-[var(--color-card-elev)] text-[var(--color-foreground)] hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-card)]',
  ghost:
    'border border-transparent bg-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-card)] hover:text-[var(--color-foreground)]',
  destructive:
    'border border-[var(--color-destructive)]/30 bg-[var(--color-destructive-soft)] text-[var(--color-destructive)] hover:border-[var(--color-destructive)]/60',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[11px] tracking-wide',
  md: 'h-9 px-3.5 text-[12px] tracking-wide',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ variant = 'secondary', size = 'md', className, ...props }, ref) {
    return (
      <button
        ref={ref}
        {...props}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md font-medium uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          variants[variant],
          sizes[size],
          className,
        )}
      />
    );
  },
);
