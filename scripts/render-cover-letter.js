#!/usr/bin/env node
/**
 * Generates a professionally formatted cover letter DOCX.
 * Matches the resume's design system (Calibri, navy accents, same margins).
 *
 * Usage: node scripts/render-cover-letter.js reports/resume-2026-04-10-company-role.json
 */

const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, convertInchesToTwip
} = require('docx');
const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/normalize');

const FONT = 'Calibri';
const NAVY = '1F3864';
const CHARCOAL = '333333';
const GRAY = '666666';
const BLACK = '1A1A1A';

function generate(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  // Derive the cover-letter filename from the basename, guaranteeing it never
  // collides with the resume docx (render-docx.js writes "<base>.docx"). If the
  // input follows the "resume-*.json" convention we swap the token; otherwise
  // we prefix "cover-letter-" so the two outputs are always distinct files.
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath).replace(/\.json$/, '');
  const clBase = base.includes('resume-') ? base.replace('resume-', 'cover-letter-') : `cover-letter-${base}`;
  const outputPath = path.join(dir, `${clBase}.docx`);

  if (!data.coverLetter) {
    console.error('JSON must contain a "coverLetter" field.');
    process.exit(1);
  }

  // Prose-register advisory (NON-fatal): nudge on validated AI-flourish words in
  // the cover letter (Kobak et al. Science Advances 2025). Advisory only — never
  // a gate and never an authorship verdict (detection is false-positive-prone;
  // Liang et al. 2023). Fix the wording by hand if flagged.
  try {
    const { auditProse } = require('../lib/tailor');
    const p = auditProse(data.coverLetter || '');
    if (p.advisory.length) {
      console.warn('[prose-advisory] cover letter:');
      p.advisory.forEach((a) => console.warn('  - ' + a));
    }
  } catch { /* advisory is optional */ }

  const contact = data.contact || {};
  const contactLine = [contact.phone, contact.email, contact.location, contact.linkedin, contact.github].filter(Boolean).join('  |  ');
  const paragraphs = normalize(data.coverLetter).split('\n\n').filter(Boolean);
  // A bare YYYY-MM-DD string parses as UTC midnight, which renders as the
  // previous day in negative-offset timezones. Anchor it to local noon.
  const rawDate = data.date || Date.now();
  const dateValue = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? new Date(`${rawDate}T12:00:00`)
    : new Date(rawDate);
  const dateStr = dateValue.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const children = [
    // Name - centered, matching resume header
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [
        new TextRun({
          text: (data.name || 'Your Name').toUpperCase(),
          font: FONT, size: 44, bold: true, color: NAVY, characterSpacing: 60
        })
      ]
    }),
    // Contact line - centered, matching resume
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({ text: contactLine, font: FONT, size: 20, color: CHARCOAL })
      ]
    }),
    // Date
    new Paragraph({
      spacing: { after: 200 },
      children: [
        new TextRun({ text: dateStr, font: FONT, size: 22, color: CHARCOAL })
      ]
    }),
    // Greeting
    new Paragraph({
      spacing: { after: 160 },
      children: [
        new TextRun({
          text: `Dear ${data.company || ''} Hiring Team,`,
          font: FONT, size: 22, color: BLACK
        })
      ]
    }),
    // Body paragraphs
    ...paragraphs.map(p => new Paragraph({
      spacing: { before: 80, after: 80, line: 300 },
      children: [
        new TextRun({ text: p.trim(), font: FONT, size: 22, color: CHARCOAL })
      ]
    })),
    // Closing
    new Paragraph({
      spacing: { before: 200, after: 40 },
      children: [
        new TextRun({ text: 'Sincerely,', font: FONT, size: 22, color: CHARCOAL })
      ]
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: data.name || 'Your Name',
          font: FONT, size: 22, bold: true, color: BLACK
        })
      ]
    })
  ];

  const doc = new Document({
    creator: 'Jobe Positioning Intelligence',
    title: `Cover Letter - ${data.name || 'Candidate'} - ${data.company || ''} ${data.role || ''}`,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 22, color: CHARCOAL }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: {
            top: convertInchesToTwip(1.0),
            bottom: convertInchesToTwip(1.0),
            left: convertInchesToTwip(1.0),
            right: convertInchesToTwip(1.0)
          }
        }
      },
      children
    }]
  });

  Packer.toBuffer(doc).then(buffer => {
    fs.writeFileSync(outputPath, buffer);
    console.log(`Cover letter saved: ${outputPath}`);
  });
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/render-cover-letter.js <resume-data.json>');
  process.exit(1);
}

generate(path.resolve(input));
