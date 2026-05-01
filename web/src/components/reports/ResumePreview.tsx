import type { ResumeJSON } from '@/lib/types';

/**
 * Render the resume JSON as readable HTML — not pixel-perfect to the DOCX,
 * but recognizable. The DOCX download is the canonical artifact.
 */
export function ResumePreview({ data }: { data: ResumeJSON }) {
  return (
    <article className="flex flex-col gap-6 px-6 py-6 font-mono text-[13px] leading-relaxed text-[var(--color-foreground)]">
      {/* Header */}
      <header className="flex flex-col gap-1 border-b border-[var(--color-border)] pb-4">
        <h2
          className="font-display text-2xl font-medium tracking-tight text-[var(--color-foreground)]"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
        >
          {data.name}
        </h2>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-muted-foreground)]">
          {data.contact.location && <span>{data.contact.location}</span>}
          {data.contact.email && <span>· {data.contact.email}</span>}
          {data.contact.phone && <span>· {data.contact.phone}</span>}
          {data.contact.linkedin && <span>· {data.contact.linkedin}</span>}
          {data.contact.github && <span>· {data.contact.github}</span>}
        </div>
      </header>

      {/* Summary */}
      {data.summary && (
        <section>
          <SectionHeading>Summary</SectionHeading>
          <p className="font-sans text-[13px] leading-relaxed text-[var(--color-foreground)]/95">
            {data.summary}
          </p>
        </section>
      )}

      {/* Experience */}
      <section>
        <SectionHeading>Experience</SectionHeading>
        <div className="flex flex-col gap-5">
          {data.experience.map((exp, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="font-display text-[14.5px] font-medium text-[var(--color-foreground)]">
                  {exp.title} · <span className="text-[var(--color-accent)]">{exp.company}</span>
                </h4>
                <span className="font-mono text-[11px] text-[var(--color-muted-foreground)] tabular">
                  {exp.dates}
                </span>
              </div>
              {exp.subtitle && (
                <p className="text-[12px] italic text-[var(--color-muted-foreground)]">
                  {exp.subtitle}
                </p>
              )}
              {exp.bullets?.length > 0 && (
                <ul className="editorial-list flex flex-col gap-1.5 font-sans text-[12.5px] leading-snug">
                  {exp.bullets.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Selected projects */}
      {data.selectedProjects && data.selectedProjects.length > 0 && (
        <section>
          <SectionHeading>Selected projects</SectionHeading>
          <div className="flex flex-col gap-3">
            {data.selectedProjects.map((p, i) => (
              <div key={i} className="flex flex-col gap-1">
                <h4 className="font-display text-[13.5px] font-medium text-[var(--color-foreground)]">
                  {p.name}
                </h4>
                <p className="font-sans text-[12.5px] leading-snug text-[var(--color-muted-foreground)]">
                  {p.summary}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Education */}
      {data.education && data.education.length > 0 && (
        <section>
          <SectionHeading>Education</SectionHeading>
          <ul className="flex flex-col gap-1">
            {data.education.map((ed, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 text-[12.5px]">
                <span className="font-sans text-[var(--color-foreground)]">
                  <span className="font-medium">{ed.degree}</span>
                  {' · '}
                  <span className="text-[var(--color-muted-foreground)]">{ed.school}</span>
                </span>
                <span className="font-mono text-[11px] text-[var(--color-muted-foreground)] tabular">
                  {ed.dates}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Skills */}
      {data.skills && (
        <section>
          <SectionHeading>Skills</SectionHeading>
          <dl className="grid grid-cols-1 gap-1 font-sans text-[12.5px] sm:grid-cols-[10rem_1fr]">
            {Object.entries(data.skills).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-faint)]">
                  {k}
                </dt>
                <dd className="text-[var(--color-foreground)]/90">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </article>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 border-b border-[var(--color-border)] pb-1 font-display text-[10px] uppercase tracking-[0.22em] text-[var(--color-accent)]">
      {children}
    </h3>
  );
}
