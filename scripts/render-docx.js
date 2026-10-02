#!/usr/bin/env node
/**
 * Generates a professionally formatted resume DOCX.
 *
 * The whole document is built with the docx package, section by section, so a
 * missing optional section (subtitle, projects, awards) leaves no empty line.
 * Runs in a fresh clone: every user file it consults (data/profile.json, the
 * resume baseline, data/evidence-depth.json, a jd.txt beside the input) is
 * optional.
 *
 * Usage: node scripts/render-docx.js [--strict] <resume-data.json>
 *   e.g. reports/queue/<slug>/resume-<date>-<slug>.json
 *
 * Gates run before anything is written:
 *   - forbidden terms (output.forbiddenTerms in data/profile.json): always fatal
 *   - positioning vocabulary (the modes' internal framework words): always fatal
 *   - resume audit (JD aware when jd.txt sits beside the JSON) and the method
 *     depth gate: warn by default, block under --strict or JOBE_STRICT_AUDIT=1
 *
 * Optional per-resume keys: `layout: "compact"` (tighter type and spacing),
 * `projectsHeading`, `awards`, and `pageBreakBefore` on an experience entry.
 *
 * Section headings are English unless output.sectionHeadings in
 * data/profile.json names its own (keys summary, projects, experience, skills,
 * education, awards), for a resume written in another language.
 */

const {
  Document, Packer, Paragraph, TextRun, Tab,
  AlignmentType, TabStopType, TabStopPosition, BorderStyle,
  LevelFormat, convertInchesToTwip
} = require('docx');
const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/normalize');
const { pageSetup, loadProfile } = require('../lib/profile');

// Paper size in twips, chosen by output.pageSize in data/profile.json (unset:
// see pageSetup in lib/profile.js). The cover letter renderer shares it.
const PAGE = { letter: { width: 12240, height: 15840 }, a4: { width: 11906, height: 16838 } };
const pageSize = () => PAGE[pageSetup(loadProfile()).pageSize];

// Identity and header fields (name, contact, employer, place, dates, school,
// skill labels, headings): the always on punctuation folding and
// output.asciiOnly apply, but a hyphen is never removed from them, whatever
// output.stripHyphens says (a hyphenated name, a phone number, a date range).
// A finite number (a phone or a year stored as a JSON number) prints as written.
const clean = (s) => normalize(typeof s === 'string' ? s : (typeof s === 'number' && Number.isFinite(s) ? String(s) : ''),
  { stripHyphens: false }).trim();

// Contact line shared with the cover letter: a website that is also the code
// host link prints once.
const contactLine = (contact) => [...new Set([contact.phone, contact.email, contact.location,
  contact.linkedin, contact.website, contact.github].map(clean).filter(Boolean))].join('  |  ');

// Text of one section heading: the user's own word from output.sectionHeadings
// in data/profile.json when set (read defensively, the key is optional), else
// the English default. scripts/docx-to-pdf.js checks reading order with it.
function headingText(key, fallback) {
  const own = ((loadProfile().output || {}).sectionHeadings || {})[key];
  return ((typeof own === 'string' && clean(own)) || fallback).toUpperCase();
}

// ── Design System ─────────────────────────────────────────────
const FONT = 'Calibri';
const NAVY = '1F3864';
const CHARCOAL = '333333';
const GRAY = '666666';
const BLACK = '1A1A1A';
const MARGIN_LR = convertInchesToTwip(0.45);
const MARGIN_TB = convertInchesToTwip(0.35);

// Adaptive layout: a resume JSON may set `layout: "compact"` to pull a render
// that spills just past the page target back onto it without cutting content.
const STANDARD_LAYOUT = {
  bodySize: 21,
  secondarySize: 20,
  smallSize: 19,
  line: 276,
  paragraphAfter: 40,
  sectionBefore: 140,
  sectionAfter: 40,
  jobBefore: 180,
};
const COMPACT_LAYOUT = {
  bodySize: 20,
  secondarySize: 19,
  smallSize: 18,
  line: 252,
  paragraphAfter: 20,
  sectionBefore: 100,
  sectionAfter: 30,
  jobBefore: 120,
};
let ACTIVE_LAYOUT = STANDARD_LAYOUT;

// Native Word list bullets: the glyph lives in numbering metadata, so an ATS
// parser reads each bullet as a list item and never as text that starts with a
// stray symbol.
const BULLETS = 'resume-bullets';

// `own` is a per resume heading (projectsHeading); it wins over the profile.
function sectionHeading(key, fallback, own) {
  return new Paragraph({
    keepNext: true,
    spacing: { before: ACTIVE_LAYOUT.sectionBefore, after: ACTIVE_LAYOUT.sectionAfter },
    border: {
      bottom: { color: NAVY, space: 1, style: BorderStyle.SINGLE, size: 6 }
    },
    children: [
      new TextRun({
        text: (typeof own === 'string' && clean(own).toUpperCase()) || headingText(key, fallback), font: FONT, size: 24, bold: true,
        color: NAVY, characterSpacing: 40
      })
    ]
  });
}

function buildExperience(jobs) {
  const paragraphs = [sectionHeading('experience', 'Experience')];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job.title) continue;

    // Title + Dates. keepNext binds the title to the lines below it so a job
    // header never orphans at the bottom of a page; pageBreakBefore honors an
    // optional per-entry flag (unset by default — never force a break unless a
    // caller deliberately sets it, which would leave a mid-page gap).
    paragraphs.push(new Paragraph({
      pageBreakBefore: Boolean(job.pageBreakBefore),
      keepNext: true,
      spacing: { before: i === 0 ? 60 : ACTIVE_LAYOUT.jobBefore, after: 20 },
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      children: [
        new TextRun({ text: job.title, font: FONT, size: ACTIVE_LAYOUT.bodySize + 1, bold: true, color: BLACK }),
        new TextRun({ children: [new Tab()] }),
        new TextRun({ text: job.dates || '', font: FONT, size: ACTIVE_LAYOUT.secondarySize, color: GRAY })
      ]
    }));

    // Company | Location
    if (job.company) {
      const line = [job.company, job.location].filter(Boolean).join('  |  ');
      paragraphs.push(new Paragraph({
        keepNext: true,
        spacing: { after: 10 },
        children: [
          new TextRun({ text: line, font: FONT, size: ACTIVE_LAYOUT.bodySize + 1, italics: true, color: CHARCOAL })
        ]
      }));
    }

    // Subtitle (only if present)
    if (job.subtitle) {
      paragraphs.push(new Paragraph({
        keepNext: true,
        spacing: { after: 30 },
        children: [
          new TextRun({ text: job.subtitle, font: FONT, size: ACTIVE_LAYOUT.smallSize, italics: true, color: GRAY })
        ]
      }));
    }

    // Bullets (only the ones that exist). keepLines keeps one bullet from
    // splitting across a page boundary.
    for (const bullet of (job.bullets || [])) {
      if (!bullet || !bullet.trim()) continue;
      paragraphs.push(new Paragraph({
        keepLines: true,
        numbering: { reference: BULLETS, level: 0 },
        spacing: { after: ACTIVE_LAYOUT.paragraphAfter, line: ACTIVE_LAYOUT.line },
        children: [
          new TextRun({ text: bullet, font: FONT, size: ACTIVE_LAYOUT.bodySize, color: CHARCOAL })
        ]
      }));
    }
  }

  return paragraphs;
}

function buildSkills(skills) {
  const paragraphs = [sectionHeading('skills', 'Skills')];

  for (const [label, value] of skills) {
    if (!value) continue;
    const valueStr = Array.isArray(value) ? value.join(', ') : value;
    const children = label
      ? [
          new TextRun({ text: `${label}: `, font: FONT, size: ACTIVE_LAYOUT.bodySize, bold: true, color: BLACK }),
          new TextRun({ text: valueStr, font: FONT, size: ACTIVE_LAYOUT.bodySize, color: CHARCOAL })
        ]
      : [new TextRun({ text: valueStr, font: FONT, size: ACTIVE_LAYOUT.bodySize, color: CHARCOAL })];
    paragraphs.push(new Paragraph({
      spacing: { after: ACTIVE_LAYOUT.paragraphAfter, line: ACTIVE_LAYOUT.line },
      children
    }));
  }

  return paragraphs;
}

function buildSelectedProjects(projects, heading) {
  if (!Array.isArray(projects) || projects.length === 0) return [];
  const paragraphs = [sectionHeading('projects', 'Selected Projects', heading)];
  for (const p of projects) {
    if (!p || !p.summary) continue;
    const titleText = p.name ? normalize(p.name) + ': ' : '';
    paragraphs.push(new Paragraph({
      keepLines: true,
      spacing: { before: 50, after: Math.max(10, ACTIVE_LAYOUT.paragraphAfter - 10), line: ACTIVE_LAYOUT.line },
      children: [
        new TextRun({ text: titleText, font: FONT, size: ACTIVE_LAYOUT.bodySize, bold: true, color: BLACK }),
        new TextRun({ text: normalize(p.summary), font: FONT, size: ACTIVE_LAYOUT.bodySize, color: CHARCOAL }),
      ],
    }));
  }
  return paragraphs;
}

function buildEducation(education) {
  const paragraphs = [sectionHeading('education', 'Education')];
  const list = Array.isArray(education) ? education : (education ? [education] : []);
  for (let i = 0; i < list.length; i++) {
    const edu = list[i];
    if (!edu || !(edu.degree || edu.school)) continue;
    paragraphs.push(new Paragraph({
      spacing: { before: i === 0 ? 80 : 60, after: 20 },
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      children: [
        new TextRun({ text: edu.degree || '', font: FONT, size: ACTIVE_LAYOUT.bodySize, bold: true, color: BLACK }),
        new TextRun({ text: edu.school ? `  |  ${edu.school}` : '', font: FONT, size: ACTIVE_LAYOUT.bodySize, color: CHARCOAL }),
        new TextRun({ text: edu.location ? `  |  ${edu.location}` : '', font: FONT, size: ACTIVE_LAYOUT.bodySize, color: GRAY }),
        new TextRun({ children: [new Tab()] }),
        new TextRun({ text: edu.dates || '', font: FONT, size: ACTIVE_LAYOUT.secondarySize, color: GRAY })
      ]
    }));
  }
  return paragraphs;
}

function buildAwards(awards) {
  if (!Array.isArray(awards) || awards.length === 0) return [];
  const paragraphs = [sectionHeading('awards', 'Awards')];
  for (const a of awards) {
    if (!a || typeof a !== 'string') continue;
    paragraphs.push(new Paragraph({
      keepLines: true,
      numbering: { reference: BULLETS, level: 0 },
      spacing: { after: Math.max(10, ACTIVE_LAYOUT.paragraphAfter - 10), line: ACTIVE_LAYOUT.line },
      children: [
        new TextRun({ text: normalize(a), font: FONT, size: ACTIVE_LAYOUT.bodySize, color: CHARCOAL })
      ]
    }));
  }
  return paragraphs;
}

function generate(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  ACTIVE_LAYOUT = raw.layout === 'compact' ? COMPACT_LAYOUT : STANDARD_LAYOUT;

  // ATS normalize all text fields
  raw.summary = normalize(raw.summary || '');
  // A name in a script output.asciiOnly removes entirely is kept as written:
  // a placeholder must never stand in for a name the user gave.
  raw.name = clean(raw.name) || (typeof raw.name === 'string' ? raw.name.trim() : '');
  for (const edu of (Array.isArray(raw.education) ? raw.education : [raw.education])) {
    if (!edu || typeof edu !== 'object') continue;
    for (const k of ['degree', 'school', 'location', 'dates']) edu[k] = clean(edu[k]);
  }
  for (const job of (raw.experience || [])) {
    for (const k of ['company', 'location', 'dates']) job[k] = clean(job[k]);
    job.title = normalize(job.title || '');
    job.subtitle = normalize(job.subtitle || '');
    job.bullets = (job.bullets || []).map(b => normalize(typeof b === 'string' ? b : (b && b.text) || ''));
  }
  // Handle skills as object, array, or plain string
  // Rows are [label, value] pairs keyed by the label as written, so two
  // labels that fold to the same text (or to nothing under output.asciiOnly)
  // never merge; a label that folds to nothing is kept as written, like a name.
  const rows = new Map();
  const row = (key, value) => rows.set(String(key).trim(), [clean(key) || String(key).trim(), value]);
  if (typeof raw.skills === 'string') {
    // Plain string: one row without a label
    row('', normalize(raw.skills));
  } else if (Array.isArray(raw.skills)) {
    for (const item of raw.skills) {
      if (typeof item === 'string') {
        const [k, ...v] = item.split(':');
        if (k && v.length) row(k, normalize(v.join(':').trim()));
      } else if (item && typeof item === 'object' && item.category) {
        row(item.category, normalize(item.skills || item.values || ''));
      }
    }
  } else {
    for (const [key, val] of Object.entries(raw.skills || {})) {
      row(key, normalize(typeof val === 'string' ? val : Array.isArray(val) ? val.join(', ') : String(val || '')));
    }
  }
  raw.skills = [...rows.values()];

  const contactText = contactLine(raw.contact || {});

  // Build the entire document programmatically for full control
  const children = [
    // Name - centered, navy, bold
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [
        new TextRun({
          text: (raw.name || 'Your Name').toUpperCase(),
          font: FONT, size: 44, bold: true, color: NAVY, characterSpacing: 60
        })
      ]
    }),
    // Contact - centered
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [
        new TextRun({ text: contactText, font: FONT, size: ACTIVE_LAYOUT.secondarySize, color: CHARCOAL })
      ]
    }),
    // Summary
    sectionHeading('summary', 'Summary'),
    new Paragraph({
      spacing: { before: 50, after: ACTIVE_LAYOUT.paragraphAfter, line: ACTIVE_LAYOUT.line },
      children: [
        new TextRun({ text: raw.summary || '', font: FONT, size: ACTIVE_LAYOUT.bodySize, color: CHARCOAL })
      ]
    }),
    // Selected Projects FIRST: independent work is often the most direct
    // evidence of ability, so it leads the body (only renders if the array is
    // present and non-empty). Optional per-resume `projectsHeading` overrides
    // the parser-standard "Selected Projects".
    ...buildSelectedProjects(raw.selectedProjects, raw.projectsHeading),
    // Experience
    ...buildExperience(raw.experience || []),
    // Skills
    ...buildSkills(raw.skills),
    // Education
    ...buildEducation(raw.education),
    // Awards
    ...buildAwards(raw.awards)
  ];

  const doc = new Document({
    // Blank author metadata: a submitted file should not announce the tool
    // that produced it.
    creator: '',
    lastModifiedBy: '',
    title: `Resume - ${raw.name || 'Candidate'} - ${clean(raw.company)} ${clean(raw.role)}`,
    numbering: {
      config: [{
        reference: BULLETS,
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '\u2022',
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.2) },
            },
          },
        }],
      }],
    },
    styles: {
      default: {
        document: {
          run: { font: FONT, size: ACTIVE_LAYOUT.bodySize, color: CHARCOAL }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: pageSize(),
          margin: { top: MARGIN_TB, bottom: MARGIN_TB, left: MARGIN_LR, right: MARGIN_LR }
        }
      },
      children
    }]
  });

  const outputPath = inputPath.replace(/\.json$/, '.docx');
  Packer.toBuffer(doc).then(buffer => {
    fs.writeFileSync(outputPath, buffer);
    console.log(`DOCX saved: ${outputPath}`);
  });
}

// Render-path gates. Returns nothing; exits the process when a gate blocks.
function runGates(inputPath, strict) {
  // Loaded and parsed OUTSIDE the advisory try on purpose: if lib/tailor.js
  // cannot load or the JSON cannot parse, the two fatal scans below could not
  // run, and an unchecked document must never be written.
  const {
    auditResume, auditProse, scanCodenames, scanPositioningVocab, renderedResumeText,
  } = require('../lib/tailor');
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  // contact.website renders in the contact line, so the fatal scans read it too.
  const text = [renderedResumeText(raw), (raw.contact || {}).website].filter(Boolean).join('\n');

  // Forbidden term gate (FATAL): a name the user listed in output.forbiddenTerms
  // (data/profile.json) must never reach a rendered field. Better no DOCX than
  // a leaked name. An empty list is a no-op.
  const forbidden = scanCodenames(text);
  if (forbidden.length) {
    console.error(`\n[forbidden-terms-gate] FATAL: rendered resume contains term(s) from your forbidden list: ${forbidden.join(', ')}. Describe the work by function. Not rendering.`);
    process.exit(1);
  }

  // Positioning vocabulary gate (FATAL): the reasoning frameworks the modes use
  // internally must never appear as words in output (modes/_shared.md).
  const jargon = scanPositioningVocab(text);
  if (jargon.length) {
    console.error(`\n[positioning-vocab-gate] FATAL: rendered resume contains internal positioning vocabulary: ${jargon.join(', ')}. The reasoning frameworks must never appear as words. Not rendering.`);
    process.exit(1);
  }

  // Quality + depth gates: warn by default, block under --strict.
  try {
    // JD aware audit: feed the sibling jd.txt so the JD coverage, requirement
    // to bullet, and lead evidence checks actually run at render time.
    let jdText = '';
    const jdPath = path.join(path.dirname(inputPath), 'jd.txt');
    if (fs.existsSync(jdPath)) jdText = fs.readFileSync(jdPath, 'utf8');
    const audit = auditResume(raw, jdText || undefined);
    if (!audit.ok) {
      console.warn(`\n[resume-audit] ${audit.issues.length} quality issue(s)${jdText ? '' : ' (no jd.txt beside the JSON, so the JD coverage checks were skipped)'} (words ${audit.wordCount}, summary ${audit.summaryWordCount}, projects ${audit.projectCount}, metric density ${audit.metricDensity}/bullet):`);
      audit.issues.forEach((i) => console.warn('  - ' + i));
      console.warn('');
      if (strict) process.exit(1);
    }

    // Depth gate: a body of work named at scale/outcome but never its method.
    // No data/evidence-depth.json means no configured items and nothing to flag.
    const { evaluate, flattenResume, loadSystems } = require('./check-evidence-depth');
    const shallow = evaluate(flattenResume(raw), loadSystems()).filter((r) => r.status === 'shallow');
    if (shallow.length) {
      console.warn(`[depth-gate] ${shallow.length} item(s) named without a method or mechanism: ${shallow.map((s) => s.id).join(', ')}. Reframe to say how the work was done.`);
      if (strict) process.exit(1);
    }

    // Prose-register advisory (NON-fatal, never a gate: document-level AI
    // detection is unreliable, Kobak et al., Science Advances 2025, so this
    // only nudges on validated flourish words and never judges authorship).
    const prose = auditProse(raw.summary || '');
    if (prose.advisory.length) {
      console.warn('[prose-advisory] summary:');
      prose.advisory.forEach((a) => console.warn('  - ' + a));
    }
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    if (strict) {
      console.error('[resume-audit] failed to run:', msg);
      process.exit(1);
    }
    console.warn('[resume-audit] skipped (advisory, could not run):', msg);
  }
}

function main() {
  const args = process.argv.slice(2);
  const strictAudit = args.includes('--strict') || process.env.JOBE_STRICT_AUDIT === '1';
  const input = args.find((a) => a !== '--strict');
  if (!input) {
    console.error('Usage: node scripts/render-docx.js [--strict] <resume-data.json>');
    process.exit(1);
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }
  runGates(inputPath, strictAudit);
  generate(inputPath);
}

if (require.main === module) main();

module.exports = { generate, runGates, pageSize, contactLine, clean, headingText };
