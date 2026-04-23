#!/usr/bin/env node
/**
 * Generates a professionally formatted resume DOCX.
 *
 * Hybrid approach: uses docxtemplater for static sections (name, contact,
 * summary, education) and the docx package to build dynamic sections
 * (experience, skills) so no empty placeholder lines appear.
 *
 * Usage: node scripts/render-docx.js reports/resume-2026-04-10-company-role.json
 */

const {
  Document, Packer, Paragraph, TextRun, Tab,
  AlignmentType, TabStopType, TabStopPosition, BorderStyle,
  convertInchesToTwip
} = require('docx');
const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/normalize');

// ── Design System ─────────────────────────────────────────────
const FONT = 'Calibri';
const NAVY = '1F3864';
const CHARCOAL = '333333';
const GRAY = '666666';
const BLACK = '1A1A1A';
const MARGIN_LR = convertInchesToTwip(0.45);
const MARGIN_TB = convertInchesToTwip(0.35);

function sectionHeading(text) {
  return new Paragraph({
    spacing: { before: 140, after: 40 },
    border: {
      bottom: { color: NAVY, space: 1, style: BorderStyle.SINGLE, size: 6 }
    },
    children: [
      new TextRun({
        text: text.toUpperCase(), font: FONT, size: 24, bold: true,
        color: NAVY, characterSpacing: 40
      })
    ]
  });
}

function buildExperience(jobs) {
  const paragraphs = [sectionHeading('Experience')];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job.title) continue;

    // Title + Dates
    paragraphs.push(new Paragraph({
      spacing: { before: i === 0 ? 80 : 180, after: 20 },
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      children: [
        new TextRun({ text: job.title, font: FONT, size: 22, bold: true, color: BLACK }),
        new TextRun({ children: [new Tab()] }),
        new TextRun({ text: job.dates || '', font: FONT, size: 20, color: GRAY })
      ]
    }));

    // Company | Location
    if (job.company) {
      const line = [job.company, job.location].filter(Boolean).join('  |  ');
      paragraphs.push(new Paragraph({
        spacing: { after: 10 },
        children: [
          new TextRun({ text: line, font: FONT, size: 22, italics: true, color: CHARCOAL })
        ]
      }));
    }

    // Subtitle (only if present)
    if (job.subtitle) {
      paragraphs.push(new Paragraph({
        spacing: { after: 30 },
        children: [
          new TextRun({ text: job.subtitle, font: FONT, size: 19, italics: true, color: GRAY })
        ]
      }));
    }

    // Bullets (only the ones that exist)
    for (const bullet of (job.bullets || [])) {
      if (!bullet || !bullet.trim()) continue;
      paragraphs.push(new Paragraph({
        spacing: { after: 40, line: 276 },
        indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.2) },
        children: [
          new TextRun({ text: '\u2022  ', font: FONT, size: 16, color: CHARCOAL }),
          new TextRun({ text: bullet, font: FONT, size: 21, color: CHARCOAL })
        ]
      }));
    }
  }

  return paragraphs;
}

function buildSkills(skills) {
  const paragraphs = [sectionHeading('Skills')];

  for (const [label, value] of Object.entries(skills)) {
    if (!value) continue;
    const valueStr = Array.isArray(value) ? value.join(', ') : value;
    const children = label
      ? [
          new TextRun({ text: `${label}: `, font: FONT, size: 21, bold: true, color: BLACK }),
          new TextRun({ text: valueStr, font: FONT, size: 21, color: CHARCOAL })
        ]
      : [new TextRun({ text: valueStr, font: FONT, size: 21, color: CHARCOAL })];
    paragraphs.push(new Paragraph({
      spacing: { after: 40, line: 276 },
      children
    }));
  }

  return paragraphs;
}

function buildEducation(education) {
  const paragraphs = [sectionHeading('Education')];
  const edu = Array.isArray(education) ? education[0] : education;
  if (!edu) return paragraphs;

  paragraphs.push(new Paragraph({
    spacing: { before: 80, after: 20 },
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    children: [
      new TextRun({ text: edu.degree || '', font: FONT, size: 21, bold: true, color: BLACK }),
      new TextRun({ text: edu.school ? `  |  ${edu.school}` : '', font: FONT, size: 21, color: CHARCOAL }),
      new TextRun({ text: edu.location ? `  |  ${edu.location}` : '', font: FONT, size: 21, color: GRAY }),
      new TextRun({ children: [new Tab()] }),
      new TextRun({ text: edu.dates || '', font: FONT, size: 20, color: GRAY })
    ]
  }));

  return paragraphs;
}

function generate(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  // ATS normalize all text fields
  raw.summary = normalize(raw.summary || '');
  for (const job of (raw.experience || [])) {
    job.title = normalize(job.title || '');
    job.subtitle = normalize(job.subtitle || '');
    job.bullets = (job.bullets || []).map(b => normalize(b));
  }
  // Handle skills as object, array, or plain string
  if (typeof raw.skills === 'string') {
    // Plain string: wrap in a single-key object so buildSkills renders one line
    raw.skills = { '': normalize(raw.skills) };
  } else if (Array.isArray(raw.skills)) {
    const obj = {};
    for (const item of raw.skills) {
      if (typeof item === 'string') {
        const [k, ...v] = item.split(':');
        if (k && v.length) obj[k.trim()] = normalize(v.join(':').trim());
      } else if (typeof item === 'object' && item.category) {
        obj[item.category] = normalize(item.skills || item.values || '');
      }
    }
    raw.skills = obj;
  } else {
    for (const [key, val] of Object.entries(raw.skills || {})) {
      raw.skills[key] = normalize(typeof val === 'string' ? val : Array.isArray(val) ? val.join(', ') : String(val || ''));
    }
  }

  const contact = raw.contact || {};
  const contactLine = [contact.phone, contact.email, contact.location, contact.linkedin].filter(Boolean).join('  |  ');

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
        new TextRun({ text: contactLine, font: FONT, size: 20, color: CHARCOAL })
      ]
    }),
    // Summary
    sectionHeading('Summary'),
    new Paragraph({
      spacing: { before: 60, after: 40, line: 276 },
      children: [
        new TextRun({ text: raw.summary || '', font: FONT, size: 21, color: CHARCOAL })
      ]
    }),
    // Experience
    ...buildExperience(raw.experience || []),
    // Skills
    ...buildSkills(raw.skills || {}),
    // Education
    ...buildEducation(raw.education)
  ];

  const doc = new Document({
    creator: 'Jobe Positioning Intelligence',
    title: `Resume - ${raw.name || 'Your Name'} - ${raw.company || ''} ${raw.role || ''}`,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 21, color: CHARCOAL }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
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

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/render-docx.js <resume-data.json>');
  process.exit(1);
}

generate(path.resolve(input));
