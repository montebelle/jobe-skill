#!/usr/bin/env node
/**
 * Convert a resume DOCX to a text-based PDF that PRESERVES the reviewed DOCX
 * layout (selectable text, single column, no header/footer). It does NOT
 * re-typeset: it renders the exact DOCX the human reviewed, through headless
 * LibreOffice in an isolated temporary profile.
 *
 * Usage:
 *   node scripts/docx-to-pdf.js <resume.docx> [--name Firstname_Lastname_Company_Role] [--outdir dir]
 *
 * Verifies: PDF text is selectable (pdftotext extracts real text), the section
 * headings the resume renderer always emits read in order (Summary ->
 * Experience -> Skills -> Education, or the user's own words for them), and the file stays under 2.5 MB (a
 * common ATS upload parse limit). Prints a JSON report; exits 1 if any check
 * fails, 2 on a usage error or when soffice (LibreOffice) is not installed.
 * Without pdftotext (poppler) selectable text cannot be confirmed, so the
 * report says selectable: false and the script exits 1.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const nameIdx = args.indexOf('--name');
const outIdx = args.indexOf('--outdir');
const wantName = nameIdx >= 0 ? args[nameIdx + 1] : null;
const outDir = outIdx >= 0 ? args[outIdx + 1] : (input ? path.dirname(input) : '.');

if (!input || !fs.existsSync(input)) {
  console.error('Usage: node scripts/docx-to-pdf.js <resume.docx> [--name <basename>] [--outdir <dir>]');
  process.exit(2);
}

function findCommand(name) {
  const depRoot = path.dirname(path.dirname(path.dirname(process.execPath)));
  const bundled = path.join(depRoot, 'bin', 'override', name);
  if (fs.existsSync(bundled)) return bundled;
  try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { return null; }
}
const soffice = findCommand('soffice');
const pdftotext = findCommand('pdftotext');
if (!soffice) { console.error('soffice not found (install LibreOffice to convert a DOCX to PDF)'); process.exit(2); }

const tmpRoot = process.platform === 'darwin' && fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpRoot, 'jobe-pdf-'));
const profile = path.join(tmp, 'lo-profile');
fs.mkdirSync(path.join(profile, 'xdg_config'), { recursive: true });
fs.mkdirSync(path.join(profile, 'xdg_cache'), { recursive: true });

try {
  execFileSync(soffice, [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    '--invisible', '--headless', '--norestore',
    '--convert-to', 'pdf', '--outdir', tmp, path.resolve(input),
  ], {
    stdio: 'pipe',
    env: {
      ...process.env, HOME: profile,
      XDG_CONFIG_HOME: path.join(profile, 'xdg_config'),
      XDG_CACHE_HOME: path.join(profile, 'xdg_cache'),
      TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot,
    },
  });
  const producedPdf = path.join(tmp, path.basename(input, path.extname(input)) + '.pdf');
  if (!fs.existsSync(producedPdf)) throw new Error('soffice did not produce a PDF');

  fs.mkdirSync(outDir, { recursive: true });
  const finalName = (wantName ? wantName.replace(/\.pdf$/i, '') : path.basename(input, path.extname(input))) + '.pdf';
  const finalPath = path.join(outDir, finalName);
  fs.copyFileSync(producedPdf, finalPath);

  const bytes = fs.statSync(finalPath).size;
  let textChars = 0, orderOk = null;
  if (pdftotext) {
    const text = execFileSync(pdftotext, ['-layout', finalPath, '-'], { encoding: 'utf8' });
    textChars = text.replace(/\s/g, '').length;
    // Headings render in capitals on a line of their own; matching the whole
    // line keeps a body sentence that says "skills" or "experience" from
    // being read as a heading.
    // The words are the ones the renderer wrote (output.sectionHeadings in
    // data/profile.json, else English).
    const { headingText } = require('./render-docx');
    const order = [['summary', 'Summary'], ['experience', 'Experience'], ['skills', 'Skills'], ['education', 'Education']]
      .map(([k, d]) => headingText(k, d).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    const positions = order.map((h) => text.search(new RegExp(`^\\s*${h}\\s*$`, 'm')));
    orderOk = positions.every((p) => p >= 0) && positions.slice(1).every((p, i) => p > positions[i]);
  }
  const sizeOk = bytes < 2.5 * 1024 * 1024;
  const textOk = textChars > 500;
  const ok = sizeOk && textOk && (orderOk !== false);
  console.log(JSON.stringify({ pdf: finalPath, bytes, mb: +(bytes / 1024 / 1024).toFixed(3), textChars, selectable: textOk, readingOrderOk: orderOk, sizeOk, ok }));
  if (!ok) process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
