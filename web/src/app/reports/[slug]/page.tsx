import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink, FileText, Mail, FileDown } from 'lucide-react';
import {
  loadResumeJSON,
  listReportFiles,
  findReportDir,
  getQueue,
} from '@/lib/data';
import { Card, CardHeader, CardBody } from '@/components/ui/Card';
import { ScorePill, ArchetypePill, StatusPill } from '@/components/ui/Pill';
import { ResumePreview } from '@/components/reports/ResumePreview';
import { CoverLetterPreview } from '@/components/reports/CoverLetterPreview';

export default async function ReportPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const resume = loadResumeJSON(slug);
  const files = listReportFiles(slug);
  const dir = findReportDir(slug);
  if (!resume || !dir) notFound();

  const queueEntry = getQueue().find((e) => e.slug === slug);
  const status =
    queueEntry?.applied ? 'Applied'
      : queueEntry?.skipped ? 'Skipped'
      : queueEntry ? 'Queued'
      : 'Archived';

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 rise rise-1">
      {/* Back link + breadcrumbs */}
      <Link
        href={
          status === 'Applied' ? '/applied'
            : status === 'Skipped' ? '/skipped'
            : '/queue'
        }
        className="inline-flex w-fit items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-muted-foreground)] hover:text-[var(--color-accent)]"
      >
        <ArrowLeft size={12} /> Back to {status === 'Queued' ? 'queue' : status.toLowerCase()}
      </Link>

      {/* Hero */}
      <header className="flex flex-col gap-4 border-b border-[var(--color-border)] pb-6">
        <div className="flex flex-wrap items-center gap-3">
          <ScorePill score={resume.matchScore} />
          <ArchetypePill archetype={resume.archetype} />
          <StatusPill status={status} />
          <span className="ml-auto font-mono text-[11px] tabular text-[var(--color-faint)]">
            {resume.date}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <h1
            className="font-display text-[2.75rem] font-medium leading-[1.05] tracking-tight text-[var(--color-foreground)]"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
          >
            {resume.company}
          </h1>
          <p
            className="font-display text-[1.25rem] italic leading-tight text-[var(--color-muted-foreground)]"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 100" }}
          >
            {resume.role}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {resume.postingUrl && (
            <a
              href={resume.postingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 text-[11px] uppercase tracking-wide text-[var(--color-accent)] hover:border-[var(--color-accent)]/60 hover:bg-[var(--color-accent-soft)]"
            >
              <ExternalLink size={13} /> Open posting
            </a>
          )}
          {files.resumeDocx && (
            <Link
              href={`/api/docx/${files.resumeDocx}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border-hover)] bg-[var(--color-card)] px-3 text-[11px] uppercase tracking-wide text-[var(--color-foreground)] hover:border-[var(--color-accent)]/40"
            >
              <FileDown size={13} /> Resume DOCX
            </Link>
          )}
          {files.coverLetterDocx && (
            <Link
              href={`/api/docx/${files.coverLetterDocx}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border-hover)] bg-[var(--color-card)] px-3 text-[11px] uppercase tracking-wide text-[var(--color-foreground)] hover:border-[var(--color-accent)]/40"
            >
              <Mail size={13} /> Cover DOCX
            </Link>
          )}
          {files.analysisMd && (
            <Link
              href={`/api/docx/${files.analysisMd}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border-hover)] bg-[var(--color-card)] px-3 text-[11px] uppercase tracking-wide text-[var(--color-foreground)] hover:border-[var(--color-accent)]/40"
            >
              <FileText size={13} /> Analysis
            </Link>
          )}
        </div>
      </header>

      {/* Resume + Cover letter, side by side on wide screens */}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="overflow-hidden rise rise-2">
          <CardHeader
            eyebrow="Block E"
            title="Tailored resume"
            caption="Per-JD bullet selection from your bullet library"
          />
          <CardBody className="p-0">
            <ResumePreview data={resume} />
          </CardBody>
        </Card>

        <Card className="overflow-hidden rise rise-3">
          <CardHeader
            eyebrow="Block E"
            title="Cover letter"
            caption="Reasoning-first; specific dollar amount + leadership signal + decision-grade outcome"
          />
          <CardBody className="p-0">
            <CoverLetterPreview text={resume.coverLetter} recipientCompany={resume.company} />
          </CardBody>
        </Card>
      </div>

      {/* Footer meta */}
      <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-faint)]">
        <span>Slug: <code className="font-mono normal-case tracking-normal text-[var(--color-muted-foreground)]">{slug}</code></span>
        {queueEntry?.tailoringDepth && (
          <span>Tailoring depth: <code className="font-mono normal-case tracking-normal text-[var(--color-muted-foreground)]">{queueEntry.tailoringDepth}</code></span>
        )}
      </footer>
    </div>
  );
}
