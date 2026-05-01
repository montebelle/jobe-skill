'use client';

import Link from 'next/link';
import { ExternalLink, FileText, Mail, Check, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import { ScorePill, ArchetypePill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/classes';
import type { QueueEntry } from '@/lib/types';

interface Props {
  entry: QueueEntry;
  selected: boolean;
  onSelect: () => void;
}

export function QueueRow({ entry: e, selected, onSelect }: Props) {
  const [busy, start] = useTransition();
  const [skipReason, setSkipReason] = useState('');
  const [showSkip, setShowSkip] = useState(false);

  const apply = () =>
    start(async () => {
      await fetch(`/api/queue/${encodeURIComponent(e.slug)}/apply`, {
        method: 'POST',
      });
      window.location.reload();
    });

  const skip = (reason: string) =>
    start(async () => {
      await fetch(`/api/queue/${encodeURIComponent(e.slug)}/skip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      window.location.reload();
    });

  return (
    <div
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group relative grid cursor-pointer grid-cols-[3.25rem_1fr_auto_auto] items-center gap-4 border-b border-[var(--color-border)]/60 px-5 py-3 transition-colors',
        'hover:bg-[var(--color-card-elev)]',
        selected && 'bg-[var(--color-card-elev)] ring-1 ring-[var(--color-accent)]/30',
      )}
      data-slug={e.slug}
      data-row="queue"
    >
      {/* Score */}
      <div className="flex items-center justify-start">
        <ScorePill score={e.score} />
      </div>

      {/* Company + role */}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <Link
            href={`/reports/${e.slug}`}
            className="font-display text-[15px] font-medium leading-tight text-[var(--color-foreground)] hover:text-[var(--color-accent)]"
            onClick={(ev) => ev.stopPropagation()}
          >
            {e.company}
          </Link>
          <ArchetypePill archetype={e.archetype} />
        </div>
        <span className="line-clamp-1 text-[13px] text-[var(--color-muted-foreground)]">
          {e.role}
        </span>
      </div>

      {/* Tailoring depth */}
      <div className="hidden md:block">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-faint)]">
          {e.tailoringDepth || 'unset'}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5" onClick={(ev) => ev.stopPropagation()}>
        {e.resumeDocx && (
          <Link
            href={`/api/docx/${e.resumeDocx}`}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[10.5px] uppercase tracking-wide text-[var(--color-muted-foreground)] transition-colors hover:border-[var(--color-border-hover)] hover:text-[var(--color-foreground)]"
            aria-label="Download resume"
          >
            <FileText size={12} /> Resume
          </Link>
        )}
        {e.coverLetterDocx && (
          <Link
            href={`/api/docx/${e.coverLetterDocx}`}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[10.5px] uppercase tracking-wide text-[var(--color-muted-foreground)] transition-colors hover:border-[var(--color-border-hover)] hover:text-[var(--color-foreground)]"
            aria-label="Download cover letter"
          >
            <Mail size={12} /> Cover
          </Link>
        )}
        <a
          href={e.primaryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 text-[10.5px] uppercase tracking-wide text-[var(--color-muted-foreground)] transition-colors hover:border-[var(--color-border-hover)] hover:text-[var(--color-foreground)]"
          aria-label="Open job posting"
        >
          <ExternalLink size={12} /> Open
        </a>
        <Button
          size="sm"
          variant="primary"
          onClick={apply}
          disabled={busy}
          aria-label={`Mark ${e.company} as applied`}
        >
          <Check size={13} /> Apply
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowSkip((v) => !v)}
          aria-label={`Skip ${e.company}`}
        >
          <X size={13} /> Skip
        </Button>
      </div>

      {/* Skip reason inline */}
      {showSkip && (
        <div className="col-span-4 flex items-center gap-2 pt-2" onClick={(ev) => ev.stopPropagation()}>
          <input
            value={skipReason}
            onChange={(ev) => setSkipReason(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') skip(skipReason || 'no reason');
            }}
            autoFocus
            placeholder="Skip reason (optional)"
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-[12px] text-[var(--color-foreground)] placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => skip(skipReason || 'no reason')}>
            Confirm skip
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowSkip(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
