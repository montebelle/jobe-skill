'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ListTodo,
  CheckCircle2,
  XCircle,
  BarChart3,
  Telescope,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/classes';

interface Route {
  href: string;
  label: string;
  numeral: string;
  icon: LucideIcon;
  hint?: string;
}

const ROUTES: Route[] = [
  { href: '/',          label: 'Pipeline',  numeral: 'I',    icon: LayoutDashboard },
  { href: '/queue',     label: 'Queue',     numeral: 'II',   icon: ListTodo },
  { href: '/applied',   label: 'Applied',   numeral: 'III',  icon: CheckCircle2 },
  { href: '/skipped',   label: 'Skipped',   numeral: 'IV',   icon: XCircle },
  { href: '/stats',     label: 'Stats',     numeral: 'V',    icon: BarChart3 },
  { href: '/discovery', label: 'Discovery', numeral: 'VI',   icon: Telescope },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-sidebar,oklch(8%_0.02_245))] md:flex">
      <div className="flex flex-col gap-0.5 px-5 pt-7 pb-4">
        <Link
          href="/"
          className="font-display text-[2rem] font-medium leading-none tracking-tight text-[var(--color-foreground)]"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
        >
          jobe<span className="text-[var(--color-accent)]">.</span>
        </Link>
        <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-faint)]">
          Career Intelligence
        </p>
      </div>

      <nav className="mt-2 flex flex-col gap-px px-3">
        {ROUTES.map((r) => {
          const active = r.href === '/' ? pathname === '/' : pathname.startsWith(r.href);
          const Icon = r.icon;
          return (
            <Link
              key={r.href}
              href={r.href}
              className={cn(
                'group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                active
                  ? 'bg-[var(--color-card)] text-[var(--color-foreground)]'
                  : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-card)]/60 hover:text-[var(--color-foreground)]',
              )}
            >
              <span
                className={cn(
                  'font-display text-xs uppercase tracking-[0.2em]',
                  active ? 'text-[var(--color-accent)]' : 'text-[var(--color-faint)]',
                )}
              >
                {r.numeral}
              </span>
              <Icon size={15} strokeWidth={1.6} className="opacity-80" />
              <span className="font-display italic" style={{ fontVariationSettings: "'opsz' 14, 'SOFT' 100" }}>
                {r.label}
              </span>
              {active && (
                <span className="ml-auto h-1 w-1 rounded-full bg-[var(--color-accent)]" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto px-5 pb-6">
        <div className="hairline mb-5" />
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-faint)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] pulse-dot" />
          Self-hosted · localhost
        </div>
        <p className="mt-3 font-display text-[11px] italic leading-relaxed text-[var(--color-muted-foreground)]">
          Every score traces to a citation in the code.
        </p>
      </div>
    </aside>
  );
}
