#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const maxIndex = args.indexOf('--max');
const maxPages = maxIndex >= 0 ? Number(args[maxIndex + 1]) : 2;
const required = args.includes('--required');

if (!input || !fs.existsSync(input) || !Number.isFinite(maxPages)) {
  console.error('Usage: node scripts/check-docx-pages.js <resume.docx> [--max 2] [--min-fill 0.85] [--required]');
  process.exit(2);
}

function findCommand(name) {
  // Prefer a headless document runtime bundled alongside the current Node
  // (some sandboxed environments ship one) over a GUI install on the host.
  const dependenciesRoot = path.dirname(path.dirname(path.dirname(process.execPath)));
  const bundled = path.join(dependenciesRoot, 'bin', 'override', name);
  if (fs.existsSync(bundled)) return bundled;
  try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

const soffice = findCommand('soffice');
const pdfinfo = findCommand('pdfinfo');
const pdftotext = findCommand('pdftotext');
if (!soffice || !pdfinfo) {
  const msg = `page QA unavailable: ${!soffice ? 'soffice' : ''}${!soffice && !pdfinfo ? ' and ' : ''}${!pdfinfo ? 'pdfinfo' : ''} not found (install LibreOffice + poppler for the page-fill gate)`;
  if (required) { console.error(msg); process.exit(2); }
  console.warn(msg);
  process.exit(0);
}

// The real fill target is PAGES, not word count. Measure how far down the last
// page the actual text ink reaches (bottom of the lowest word / page height)
// via pdftotext -bbox-layout, which emits per-word y-coordinates in an XHTML doc.
const minFillIndex = args.indexOf('--min-fill');
const minFill = minFillIndex >= 0 ? Number(args[minFillIndex + 1]) : null;
function measureFill(pdf) {
  if (!pdftotext) return null;
  let xml;
  try { xml = execFileSync(pdftotext, ['-bbox-layout', pdf, '-'], { encoding: 'utf8' }); }
  catch { return null; }
  const fills = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let pm;
  while ((pm = pageRe.exec(xml))) {
    const height = Number(pm[2]);
    const body = pm[3];
    let maxY = 0;
    const wRe = /yMax="([\d.]+)"/g;
    let wm;
    while ((wm = wRe.exec(body))) { const y = Number(wm[1]); if (y > maxY) maxY = y; }
    fills.push(height > 0 ? Number((maxY / height).toFixed(3)) : 0);
  }
  return fills;
}

// LibreOffice on macOS can abort when its temporary profile is created under
// the per-user /var/folders tree; render into /private/tmp for the same reason.
const tmpRoot = process.platform === 'darwin' && fs.existsSync('/private/tmp')
  ? '/private/tmp'
  : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(tmpRoot, 'jobe-page-check-'));
const profile = path.join(tmp, 'lo-profile');
fs.mkdirSync(profile, { recursive: true });
const xdgConfig = path.join(profile, 'xdg_config');
const xdgCache = path.join(profile, 'xdg_cache');
fs.mkdirSync(xdgConfig, { recursive: true });
fs.mkdirSync(xdgCache, { recursive: true });

try {
  execFileSync(soffice, [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    '--invisible',
    '--headless',
    '--norestore',
    '--convert-to', 'pdf',
    '--outdir', tmp,
    path.resolve(input),
  ], {
    stdio: 'pipe',
    env: {
      ...process.env,
      HOME: profile,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      TMPDIR: tmpRoot,
      TEMP: tmpRoot,
      TMP: tmpRoot,
    },
  });
  const pdf = path.join(tmp, path.basename(input, path.extname(input)) + '.pdf');
  const info = execFileSync(pdfinfo, [pdf], { encoding: 'utf8' });
  const match = info.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error('pdfinfo did not report a page count');
  const pages = Number(match[1]);
  const fills = measureFill(pdf);
  const lastPageFill = fills && fills.length ? fills[fills.length - 1] : null;
  // A resume is correctly sized when it hits exactly maxPages AND the last page
  // is substantially full. A short last page (or fewer pages than the target)
  // is the "half-empty page 2" defect, invisible to any word-count check.
  const fillOk = minFill == null || (pages === maxPages && lastPageFill != null && lastPageFill >= minFill);
  const ok = pages <= maxPages && fillOk;
  console.log(JSON.stringify({
    file: path.resolve(input), pages, maxPages,
    pageFills: fills, lastPageFill, minFill: minFill == null ? undefined : minFill,
    ok,
  }));
  if (!ok) process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
