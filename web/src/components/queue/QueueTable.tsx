'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { QueueRow } from './QueueRow';
import { archetypeShort } from '@/lib/format';
import type { QueueEntry } from '@/lib/types';
import { cn } from '@/lib/classes';

type Sort = 'score-desc' | 'score-asc' | 'company' | 'archetype';

export function QueueTable({ entries }: { entries: QueueEntry[] }) {
  const [filter, setFilter] = useState('');
  const [archFilter, setArchFilter] = useState<string>('all');
  const [minScore, setMinScore] = useState<number>(0);
  const [sort, setSort] = useState<Sort>('score-desc');
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const archetypes = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.archetype) set.add(archetypeShort(e.archetype));
    }
    return ['all', ...[...set].sort()];
  }, [entries]);

  const filtered = useMemo(() => {
    const lower = filter.toLowerCase();
    let out = entries.filter((e) => {
      if (minScore > 0 && (e.score ?? 0) < minScore) return false;
      if (archFilter !== 'all' && archetypeShort(e.archetype) !== archFilter)
        return false;
      if (!lower) return true;
      return (
        e.company.toLowerCase().includes(lower) ||
        e.role.toLowerCase().includes(lower) ||
        (e.archetype || '').toLowerCase().includes(lower)
      );
    });
    out = [...out].sort((a, b) => {
      switch (sort) {
        case 'score-desc': return (b.score ?? -1) - (a.score ?? -1);
        case 'score-asc':  return (a.score ?? -1) - (b.score ?? -1);
        case 'company':    return a.company.localeCompare(b.company);
        case 'archetype':  return archetypeShort(a.archetype).localeCompare(archetypeShort(b.archetype));
      }
    });
    return out;
  }, [entries, filter, archFilter, minScore, sort]);

  // Keyboard: j/k navigate, a apply, s skip, Enter open report, / focus search
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      const inField = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if (ev.key === '/' && !inField) {
        ev.preventDefault();
        const input = containerRef.current?.querySelector<HTMLInputElement>('input[name="filter"]');
        input?.focus();
        return;
      }
      if (inField) return;
      if (ev.key === 'j') setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
      else if (ev.key === 'k') setActiveIdx((i) => Math.max(0, i - 1));
      else if (ev.key === 'a' || ev.key === 's') {
        const slug = filtered[activeIdx]?.slug;
        if (!slug) return;
        const row = containerRef.current?.querySelector<HTMLDivElement>(`[data-slug="${slug}"]`);
        if (!row) return;
        const btn = row.querySelector<HTMLButtonElement>(
          ev.key === 'a' ? 'button[aria-label^="Mark"]' : 'button[aria-label^="Skip"]',
        );
        btn?.click();
      } else if (ev.key === 'Enter') {
        const slug = filtered[activeIdx]?.slug;
        if (!slug) return;
        window.location.href = `/reports/${slug}`;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, activeIdx]);

  // Scroll active into view
  useEffect(() => {
    const slug = filtered[activeIdx]?.slug;
    if (!slug) return;
    containerRef.current
      ?.querySelector<HTMLDivElement>(`[data-slug="${slug}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, filtered]);

  return (
    <div ref={containerRef} className="flex flex-col">
      {/* ── Filter bar ─────────────────────────────────────────── */}
      <div className="sticky top-[3.25rem] z-10 flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 px-5 py-3 backdrop-blur">
        <label className="relative flex items-center">
          <Search size={14} className="pointer-events-none absolute left-2.5 text-[var(--color-faint)]" />
          <input
            name="filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter — company, role, archetype  (press / to focus)"
            className="h-8 w-[26rem] max-w-full rounded-md border border-[var(--color-border)] bg-[var(--color-card)] pl-8 pr-3 text-[12.5px] text-[var(--color-foreground)] placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)] focus:outline-none"
          />
        </label>
        <select
          aria-label="Filter by archetype"
          value={archFilter}
          onChange={(e) => setArchFilter(e.target.value)}
          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[12px] text-[var(--color-foreground)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          {archetypes.map((a) => (
            <option key={a} value={a}>
              {a === 'all' ? 'All archetypes' : a}
            </option>
          ))}
        </select>
        <select
          aria-label="Minimum score"
          value={minScore}
          onChange={(e) => setMinScore(parseInt(e.target.value, 10))}
          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[12px] text-[var(--color-foreground)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          <option value={0}>Any score</option>
          <option value={55}>≥ 55 stretch</option>
          <option value={60}>≥ 60</option>
          <option value={70}>≥ 70 good</option>
          <option value={80}>≥ 80 strong</option>
        </select>
        <select
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[12px] text-[var(--color-foreground)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          <option value="score-desc">Score ↓</option>
          <option value="score-asc">Score ↑</option>
          <option value="company">Company A-Z</option>
          <option value="archetype">Archetype</option>
        </select>

        <span className="ml-auto font-mono text-[11px] text-[var(--color-muted-foreground)] tabular">
          {filtered.length} of {entries.length}
        </span>
      </div>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="hidden grid-cols-[3.25rem_1fr_auto_auto] items-center gap-4 border-b border-[var(--color-border)] px-5 py-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-faint)] md:grid">
        <span>Score</span>
        <span>Company / Role</span>
        <span>Tailoring</span>
        <span>Actions</span>
      </div>

      {/* ── Rows ───────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-16 text-center">
          <p className="font-display italic text-base text-[var(--color-muted-foreground)]">
            Nothing matches.
          </p>
          <p className="text-xs text-[var(--color-faint)]">
            Try clearing filters, or run <code className="font-mono">/jobe find</code> to discover new postings.
          </p>
        </div>
      ) : (
        filtered.map((e, i) => (
          <QueueRow
            key={e.slug}
            entry={e}
            selected={i === activeIdx}
            onSelect={() => setActiveIdx(i)}
          />
        ))
      )}
    </div>
  );
}
