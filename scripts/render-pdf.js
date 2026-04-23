#!/usr/bin/env node
/**
 * Converts a tailored resume markdown to a clean, ATS-optimized PDF.
 * Usage: node scripts/render-pdf.js reports/resume-2026-04-10-stripe-senior-ml-engineer.md
 */

const { mdToPdf } = require('md-to-pdf');
const path = require('path');
const fs = require('fs');

async function render(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const outputPath = inputPath.replace(/\.md$/, '.pdf');

  const pdf = await mdToPdf(
    { path: inputPath },
    {
      stylesheet: [],
      css: `
        body {
          font-family: Calibri, 'Helvetica Neue', Arial, sans-serif;
          font-size: 10.5pt;
          line-height: 1.4;
          color: #1a1a1a;
          max-width: 100%;
          margin: 0;
          padding: 30px 40px;
        }
        h1 {
          font-size: 22pt;
          font-weight: 700;
          color: #1a1a1a;
          border-bottom: 2px solid #1a1a1a;
          padding-bottom: 4px;
          margin-top: 0;
          margin-bottom: 4px;
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        h1 + p {
          font-size: 9.5pt;
          color: #444;
          margin-top: 2px;
          margin-bottom: 12px;
        }
        h2 {
          font-size: 12pt;
          font-weight: 700;
          color: #1a1a1a;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-top: 16px;
          margin-bottom: 6px;
          border-bottom: 1px solid #999;
          padding-bottom: 2px;
        }
        h3 {
          font-size: 11pt;
          font-weight: 700;
          color: #1a1a1a;
          margin-top: 10px;
          margin-bottom: 2px;
        }
        h3 + strong, h3 + p > strong:first-child {
          font-size: 9.5pt;
          color: #555;
        }
        p {
          margin: 2px 0;
        }
        ul {
          padding-left: 18px;
          margin: 2px 0;
        }
        li {
          margin-bottom: 3px;
          font-size: 10.5pt;
          line-height: 1.35;
        }
        strong {
          color: #1a1a1a;
        }
        hr {
          border: none;
          border-top: 1px solid #ccc;
          margin: 10px 0;
        }
        /* Skills section compact formatting */
        h2 + p {
          margin: 2px 0;
        }
      `,
      pdf_options: {
        format: 'Letter',
        margin: { top: '15mm', bottom: '15mm', left: '18mm', right: '18mm' },
        printBackground: true,
        displayHeaderFooter: false
      }
    }
  );

  if (pdf) {
    fs.writeFileSync(outputPath, pdf.content);
    console.log(`PDF saved: ${outputPath}`);
    return outputPath;
  } else {
    console.error('PDF generation failed');
    process.exit(1);
  }
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/render-pdf.js <report.md>');
  process.exit(1);
}

render(path.resolve(input)).catch(err => {
  console.error('PDF render failed:', err.message);
  process.exit(1);
});
