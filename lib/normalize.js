/**
 * ATS character normalization.
 * Converts non-ASCII and ATS-illegal ASCII characters to safe equivalents.
 * Called before DOCX generation (in render-docx.js + render-cover-letter.js)
 * to prevent ATS parser failures.
 *
 * ATS-illegal ASCII characters that break Workday / Greenhouse / Lever / Ashby
 * upload validators: < > [ ] { } " \
 * These get interpreted as control / markup. Replace with safe equivalents.
 */

// Letters that do NOT decompose under NFKD but still must become ASCII.
const LETTER_FOLD = {
  'ø': 'o', 'Ø': 'O', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D',
  'ı': 'i', 'ð': 'd', 'Ð': 'D', 'þ': 'th', 'Þ': 'Th',
  'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ß': 'ss',
  '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '©': '(c)', '®': '(r)', '™': '(tm)',
};

function normalize(text) {
  if (!text) return '';
  let out = text
    // Em dash and en dash -> hyphen
    .replace(/—/g, '-')    // em dash
    .replace(/–/g, '-')    // en dash
    .replace(/‒/g, '-')    // figure dash
    .replace(/―/g, '-')    // horizontal bar
    // Smart quotes -> straight single quotes (further normalized to ' below)
    .replace(/‘/g, "'")    // left single quote
    .replace(/’/g, "'")    // right single quote
    .replace(/“/g, "'")    // left double quote (was ", now ' for ATS safety)
    .replace(/”/g, "'")    // right double quote
    .replace(/‚/g, "'")    // single low-9 quote
    .replace(/„/g, "'")    // double low-9 quote
    // Ellipsis -> three dots
    .replace(/…/g, '...')
    // Bullet characters -> hyphen
    .replace(/•/g, '-')    // bullet
    .replace(/‣/g, '-')    // triangular bullet
    .replace(/◦/g, '-')    // white bullet
    .replace(/⁃/g, '-')    // hyphen bullet
    // Zero-width characters -> removed
    .replace(/​/g, '')     // zero-width space
    .replace(/‌/g, '')     // zero-width non-joiner
    .replace(/‍/g, '')     // zero-width joiner
    .replace(/﻿/g, '')     // byte order mark
    // Non-breaking space -> regular space
    .replace(/ /g, ' ')
    // Misc
    .replace(/·/g, '-')    // middle dot
    .replace(/‐/g, '-')    // hyphen character
    .replace(/‑/g, '-')    // non-breaking hyphen
    // ATS-illegal ASCII characters: < > [ ] { } " \
    // Some ATS upload validators reject any document containing these,
    // since they appear as XML control / markup tokens in DOCX XML.
    // Replace with safe equivalents that preserve readability.
    // Order matters: handle "<=" / ">=" first so they become "at most" / "at least"
    .replace(/<=/g, ' at most ')
    .replace(/>=/g, ' at least ')
    .replace(/</g, ' less than ')
    .replace(/>/g, ' greater than ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/"/g, "'")
    .replace(/\\/g, '/')
    // Hyphens and dashes: HARD preference is NONE in any resume / cover
    // letter / application text. Every dash + bullet variant above was already
    // folded to an ASCII '-'; strip them now. A spaced ' - ' used as a
    // parenthetical dash becomes a comma; every other hyphen becomes a space
    // ("end-to-end" -> "end to end", "real-time" -> "real time").
    // Run once for spaced separators, then nuke all remaining.
    .replace(/\s+-+\s+/g, ', ')
    .replace(/-/g, ' ');

  // Fold remaining extended-Latin letters to ASCII. "Plain ASCII only" is the
  // stated guarantee, but the swaps above only handle punctuation -- accented
  // letters ("Oura" with a macron, "fiance" with an accent, "Zoe" with a
  // diaeresis) would otherwise survive into the DOCX and can trip ATS parsers.
  // 1) NFKD splits a letter into base + combining mark; drop the marks.
  out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // 2) Map letters/symbols that do not decompose.
  out = out.replace(/[^\x00-\x7F]/g, (ch) => LETTER_FOLD[ch] ?? '');

  // Collapse double-spaces from any of the swaps above
  return out.replace(/  +/g, ' ');
}

module.exports = { normalize };
