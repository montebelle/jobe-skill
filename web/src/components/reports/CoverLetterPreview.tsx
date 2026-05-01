/**
 * Render the cover letter as readable serif paragraphs. The DOCX has the
 * canonical layout; this is for at-a-glance review on the dashboard.
 */
export function CoverLetterPreview({
  text,
  recipientCompany,
}: {
  text?: string;
  recipientCompany?: string;
}) {
  if (!text) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <p className="font-display italic text-sm text-[var(--color-muted-foreground)]">
          No cover letter composed yet.
        </p>
        <p className="text-xs text-[var(--color-faint)]">
          Tailoring depth: <code className="font-mono">pending-cover-letter</code>
        </p>
      </div>
    );
  }
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <article className="flex flex-col gap-4 px-7 py-7">
      {recipientCompany && (
        <p
          className="font-display text-[15px] italic text-[var(--color-muted-foreground)]"
          style={{ fontVariationSettings: "'opsz' 14, 'SOFT' 80" }}
        >
          To the {recipientCompany} hiring team,
        </p>
      )}
      {paragraphs.map((p, i) => (
        <p
          key={i}
          className="font-display text-[15px] leading-[1.7] text-[var(--color-foreground)]/95"
          style={{ fontVariationSettings: "'opsz' 14, 'SOFT' 30" }}
        >
          {p}
        </p>
      ))}
      <footer className="mt-2 flex flex-col">
        <span
          className="font-display italic text-[14px] text-[var(--color-muted-foreground)]"
          style={{ fontVariationSettings: "'opsz' 14, 'SOFT' 100" }}
        >
          Sincerely,
        </span>
      </footer>
    </article>
  );
}
