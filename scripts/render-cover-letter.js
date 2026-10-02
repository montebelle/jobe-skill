#!/usr/bin/env node
/**
 * Generates a professionally formatted cover letter DOCX.
 * Matches the resume's design system (Calibri, navy accents, same margins).
 * Runs in a fresh clone: data/profile.json is optional.
 *
 * Usage: node scripts/render-cover-letter.js [--strict] <resume-data.json>
 *   e.g. reports/queue/<slug>/resume-<date>-<slug>.json (reads its coverLetter)
 *
 * Gates run before anything is written:
 *   - forbidden terms (output.forbiddenTerms in data/profile.json): always fatal
 *   - positioning vocabulary (the modes' internal framework words): always fatal
 *   - substance bar (measurable outcome, leadership or scope signal, decision
 *     grade outcome): warns by default, blocks under --strict or
 *     JOBE_STRICT_AUDIT=1
 */

const {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, convertInchesToTwip
} = require('docx');
const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/normalize');
const { pageSetup, loadProfile } = require('../lib/profile');
const { pageSize, contactLine, clean } = require('./render-docx');

const FONT = 'Calibri';
const NAVY = '1F3864';
const CHARCOAL = '333333';
const GRAY = '666666';
const BLACK = '1A1A1A';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Regex source that matches the candidate's own name as a signature line:
// first token, up to two optional middle tokens or initials, last token. Built
// from the normalized name so it matches the normalized letter text.
function namePattern(name) {
  const toks = normalize(name || '').split(/\s+/).filter(Boolean).map((t) => escapeRe(t.replace(/\.$/, '')));
  if (!toks.length) return null;
  if (toks.length === 1) return `${toks[0]}\\.?`;
  return `${toks[0]}\\.?(?:\\s+\\S{1,20}){0,2}\\s+${toks[toks.length - 1]}\\.?`;
}

// Sign offs in the English variants (US, UK, informal). Any other language is
// recognized by shape: a short final line followed by the candidate's name.
const CLOSE = '(?:yours (?:sincerely|faithfully|truly|respectfully)|(?:sincerely|faithfully|respectfully|cordially|very truly) yours|sincerely|faithfully|(?:with )?(?:best|kind|warm|kindest|warmest) (?:regards|wishes)|regards|respectfully|cordially|warmly|best|all the best|many thanks|thanks|thank you|with (?:thanks|gratitude|appreciation))[,.!]?';
const ENGLISH_GREETING = /^(?:dear|hello|hi|greetings|good (?:morning|afternoon|evening|day)|to whom)\b/i;
const SUBJECT_LINE = /^(?:re|subject|betreff|objet|asunto|oggetto|onderwerp)\s*:/i;
const ENGLISH_WORDS = new Set(['the', 'and', 'to', 'my', 'with', 'for', 'that', 'of']);

// A line short enough to be a sign off: no sentence inside it and no sentence
// end either (a sign off ends in a comma or in nothing), so a short last body
// sentence followed by the name stays in the body.
// A postscript: "P.S.", "PS:", "P.-S." or the Spanish "P.D." opening a paragraph.
// The boundary is Unicode aware, so a surname such as "P. S\u00e1nchez" is not one.
const POSTSCRIPT = /^(?:P\.?\s?-?S(?![\p{L}\p{N}_])|P\.?\s?D\s?[.:])/iu;
const shortLine = (l) => /^[^.?!\u3002\uFF01\uFF1F\n]{1,60}$/.test(l) && l.split(/\s+/).length <= 6;

// Split the letter into body paragraphs and lift out the greeting and the
// sign off the text already carries, so the rendered letter shows each once,
// in the writer's own words. The defaults ("Dear <company> Hiring Team," and
// "Sincerely,") are returned only for a letter that has none and is written
// in English; a letter in another language gets '' (nothing is added).
// ponytail: English is told apart by an English greeting or sign off, else by
// the share of eight English function words plus a share of "the" and "and",
// which no neighbouring language shares (30 words or more; a single English
// job title does not reach it), else by the absence of
// non ASCII letters and of a greeting line. Upgrade path: a
// language key in the profile.
function prepareCoverLetter(rawText, company, name) {
  const parts = normalize(rawText)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  // Greeting by shape: one short line that ends in a comma or colon and is
  // followed by a body ("Dear Dr. Okafor,", a salutation in any language).
  // A subject line ("Re: ...") or a list intro is not a greeting: an unknown
  // salutation is at most 6 words, and never opens with a subject marker.
  let greeting = null;
  if (parts.length > 1 && /^[^\n]{1,140}[,:，：、]$/.test(parts[0]) && !SUBJECT_LINE.test(parts[0])
    && parts[0].split(/\s+/).length <= (ENGLISH_GREETING.test(parts[0]) ? 12 : 6)) {
    greeting = parts.shift();
  }
  // English by its words, the employer's name aside (it is in no language).
  const co = normalize(company || '').trim();
  const englishText = (text) => {
    const words = (co ? text.split(co).join(' ') : text).toLowerCase().match(/[\p{L}']+/gu) || [];
    if (words.length < 30) return !(/[^\x00-\x7F]/.test(text) || greeting !== null);
    return words.filter((w) => ENGLISH_WORDS.has(w)).length / words.length >= 0.04
      && words.filter((w) => w === 'the' || w === 'and').length >= Math.max(2, 0.025 * words.length);
  };
  const englishLetter = (greeting !== null && ENGLISH_GREETING.test(greeting)) || englishText(parts.join(' '));

  const nm = namePattern(name);
  const closeOnly = new RegExp(`^${CLOSE}$`, 'i');
  // The name alone, or followed by comma separated credentials ("RN, BSN").
  const nameOnly = nm && new RegExp(`^${nm}(?:,\\s*[A-Za-z.-]{2,8}){0,4}[.!]?$`, 'i');

  // A postscript follows the signature, so it is set aside before the sign
  // off is looked for and printed after the name.
  const postscript = [];
  // The candidate's own name is never a postscript (initials "P. S.", "P. D.").
  const isPostscript = (x) => POSTSCRIPT.test(x) && !(nameOnly && nameOnly.test(x));
  // A postscript on the line right after the name (no blank line) is split
  // off the last block first; only short lines (a signature) may precede it,
  // so a hard wrapped body paragraph is never cut.
  if (parts.length) {
    const lines = parts[parts.length - 1].split(/\s*\n\s*/);
    const at = lines.findIndex((l, i) => i > 0 && isPostscript(l));
    if (at > 0 && lines.slice(0, at).every((l) => l.split(/\s+/).length <= 6)) parts.splice(-1, 1, lines.slice(0, at).join('\n'), lines.slice(at).join('\n'));
  }
  while (parts.length > 1 && isPostscript(parts[parts.length - 1])) postscript.unshift(parts.pop());

  let closing = null;
  let sawName = false;
  while (parts.length) {
    const tail = parts[parts.length - 1];
    if (nameOnly && nameOnly.test(tail)) { sawName = true; parts.pop(); continue; }
    const lines = tail.split(/\s*\n\s*/);
    const named = lines.length === 2 && nameOnly && nameOnly.test(lines[1]);
    if (named) sawName = true;
    const known = (lines.length === 1 || named) && closeOnly.test(lines[0]);
    // An unknown sign off needs the name after it or a closing comma, and a
    // body before it, so a letter never loses its last paragraph to it.
    // In an English letter the name alone does not make the line before it a
    // sign off ("References available on request"): it needs the comma.
    const shaped = closing === null && parts.length > 1 && shortLine(lines[0]) && (named || lines.length === 1)
      && (/[,，]$/.test(lines[0]) || (!englishLetter && (named || sawName)));
    if (!known && !shaped) break;
    // The line nearest the name is the sign off; an earlier one is dropped.
    if (closing === null) closing = lines[0];
    parts.pop();
  }

  const english = (greeting !== null && ENGLISH_GREETING.test(greeting))
    || (closing !== null && closeOnly.test(closing))
    || englishText(parts.join(' '));
  if (greeting === null) greeting = english ? ['Dear', clean(company), 'Hiring Team,'].filter(Boolean).join(' ') : '';
  if (closing === null) closing = english ? 'Sincerely,' : '';

  return { greeting, paragraphs: parts, closing, ...(postscript.length ? { postscript } : {}) };
}

// Render-path gates. Exits the process when a gate blocks.
function runGates(coverLetter, strict, company) {
  // Loaded OUTSIDE the advisory try on purpose: if lib/tailor.js cannot load,
  // the two fatal scans could not run, and an unchecked letter must never be
  // written.
  const { auditProse, auditCoverLetter, scanCodenames, scanPositioningVocab } = require('../lib/tailor');

  // Forbidden term gate (FATAL): a name the user listed in output.forbiddenTerms
  // (data/profile.json) must never reach rendered text. Empty list: no-op.
  const forbidden = scanCodenames(coverLetter);
  if (forbidden.length) {
    console.error(`[forbidden-terms-gate] FATAL: cover letter contains term(s) from your forbidden list: ${forbidden.join(', ')}. Describe the work by function. Not rendering.`);
    process.exit(1);
  }
  // Positioning vocabulary gate (FATAL): the reasoning frameworks the modes use
  // internally must never appear as words in output (modes/_shared.md).
  const jargon = scanPositioningVocab(coverLetter);
  if (jargon.length) {
    console.error(`[positioning-vocab-gate] FATAL: cover letter contains internal positioning vocabulary: ${jargon.join(', ')}. The reasoning frameworks must never appear as words. Not rendering.`);
    process.exit(1);
  }

  // The substance bar warns by default and blocks under --strict. The prose
  // register advisory is never a gate and never an authorship verdict
  // (document-level AI detection is false-positive-prone: Kobak et al., Science
  // Advances 2025; Liang et al. 2023). Fix the wording by hand if flagged.
  try {
    // For a letter not in English the bar checks what it can (a figure, the
    // length, the employer named) and reports the rest as not checked.
    const cl = auditCoverLetter(coverLetter, { company });
    if ((cl.skipped || []).length) console.warn(`[cover-letter-audit] not checked for a letter not in English, verify by hand: ${cl.skipped.join('; ')}`);
    if (!cl.ok) {
      console.warn(`[cover-letter-audit] ${cl.issues.length} missing required element(s):`);
      cl.issues.forEach((i) => console.warn('  - ' + i));
      if (strict) process.exit(1);
    }
    const p = auditProse(coverLetter);
    if (p.advisory.length) {
      console.warn('[prose-advisory] cover letter:');
      p.advisory.forEach((a) => console.warn('  - ' + a));
    }
  } catch (e) {
    const msg = e && e.message ? e.message : e;
    if (strict) { console.error('[cover-letter-audit] failed to run:', msg); process.exit(1); }
    console.warn('[cover-letter-audit] skipped (advisory, could not run):', msg);
  }
}

function generate(inputPath, strict = false) {
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

  runGates(String(data.coverLetter), strict, data.company);

  const contactText = contactLine(data.contact || {});
  // Same rule as the resume header: folded with the rest under
  // output.asciiOnly, hyphens kept, and never replaced by a placeholder.
  const name = clean(data.name) || (typeof data.name === 'string' ? data.name.trim() : '');
  const prepared = prepareCoverLetter(data.coverLetter, data.company, name);
  const paragraphs = prepared.paragraphs;
  // A bare YYYY-MM-DD string parses as UTC midnight, which renders as the
  // previous day in negative-offset timezones. Anchor it to local noon.
  const rawDate = data.date || Date.now();
  const dateValue = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? new Date(`${rawDate}T12:00:00`)
    : new Date(rawDate);
  // Date order and month names follow output.dateLocale in data/profile.json.
  // A tag the runtime rejects (RangeError) falls back to en-US.
  const dateParts = { year: 'numeric', month: 'long', day: 'numeric' };
  let dateStr;
  try { dateStr = dateValue.toLocaleDateString(pageSetup(loadProfile()).dateLocale, dateParts); }
  catch { dateStr = dateValue.toLocaleDateString('en-US', dateParts); }

  const children = [
    // Name - centered, matching resume header
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [
        new TextRun({
          text: (name || 'Your Name').toUpperCase(),
          font: FONT, size: 44, bold: true, color: NAVY, characterSpacing: 60
        })
      ]
    }),
    // Contact line - centered, matching resume
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({ text: contactText, font: FONT, size: 20, color: CHARCOAL })
      ]
    }),
    // Date
    new Paragraph({
      spacing: { after: 200 },
      children: [
        new TextRun({ text: clean(dateStr), font: FONT, size: 22, color: CHARCOAL })
      ]
    }),
    // Greeting (the letter's own, or the English default; none for a letter
    // in another language that carries none)
    ...(prepared.greeting ? [new Paragraph({
      spacing: { after: 160 },
      children: [
        new TextRun({
          text: prepared.greeting,
          font: FONT, size: 22, color: BLACK
        })
      ]
    })] : []),
    // Body paragraphs
    ...paragraphs.map(p => new Paragraph({
      spacing: { before: 80, after: 80, line: 300 },
      children: [
        new TextRun({ text: p.trim(), font: FONT, size: 22, color: CHARCOAL })
      ]
    })),
    // Closing (same rule as the greeting), then the name
    ...(prepared.closing ? [new Paragraph({
      spacing: { before: 200, after: 40 },
      children: [
        new TextRun({ text: prepared.closing, font: FONT, size: 22, color: CHARCOAL })
      ]
    })] : []),
    new Paragraph({
      spacing: prepared.closing ? undefined : { before: 200 },
      children: [
        new TextRun({
          text: name || 'Your Name',
          font: FONT, size: 22, bold: true, color: BLACK
        })
      ]
    }),
    // Postscript, after the signature where the writer put it
    ...(prepared.postscript || []).map((p) => new Paragraph({
      spacing: { before: 200, line: 300 },
      children: [
        new TextRun({ text: p, font: FONT, size: 22, color: CHARCOAL })
      ]
    }))
  ];

  const doc = new Document({
    // Blank author metadata: a submitted file should not announce the tool
    // that produced it.
    creator: '',
    lastModifiedBy: '',
    title: `Cover Letter - ${name || 'Candidate'} - ${clean(data.company)} ${clean(data.role)}`,
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
          size: pageSize(),
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

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict') || process.env.JOBE_STRICT_AUDIT === '1';
  const input = args.find((a) => a !== '--strict');
  if (!input) {
    console.error('Usage: node scripts/render-cover-letter.js [--strict] <resume-data.json>');
    process.exit(1);
  }
  generate(path.resolve(input), strict);
}

if (require.main === module) main();

module.exports = { prepareCoverLetter, generate };
