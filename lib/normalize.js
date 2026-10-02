/**
 * ATS character normalization.
 * Converts typographic punctuation and ATS-illegal ASCII characters to safe
 * equivalents. Called before DOCX generation (in render-docx.js +
 * render-cover-letter.js) to prevent ATS parser failures.
 *
 * ATS-illegal ASCII characters that break Workday / Greenhouse / Lever / Ashby
 * upload validators: < > [ ] { } " \
 * These get interpreted as control / markup. Replace with safe equivalents.
 *
 * Always done: every dash and bullet glyph folds to an ASCII hyphen, smart
 * quotes to a straight quote, ATS-illegal characters to safe equivalents,
 * and invisible characters, private use glyphs and emoji are removed.
 * Letters of every script, accents included, are kept as written.
 *
 * Opt in, both off unless the user sets them in data/profile.json:
 *   output.stripHyphens  remove plain hyphens altogether ("end-to-end" ->
 *                        "end to end"). A personal style rule, not an ATS
 *                        requirement; it damages hyphenated names and terms.
 *   output.asciiOnly     plain ASCII output: accented letters fold to their
 *                        base letter, symbols that carry meaning (micro sign,
 *                        degree, plus minus, currency signs) are written out,
 *                        and everything else outside ASCII, other scripts
 *                        included, is removed.
 *
 *   normalize(text)                          // follows the user's profile
 *   normalize(text, { stripHyphens: true })  // explicit boolean wins
 *   normalize(text, { asciiOnly: true })     // explicit boolean wins
 */

const { loadProfile } = require('./profile');

// Letters that do NOT decompose under NFKD but still must become ASCII.
const LETTER_FOLD = {
  '\u00f8': 'o', '\u00d8': 'O', '\u0142': 'l', '\u0141': 'L', '\u0111': 'd', '\u0110': 'D',
  '\u0131': 'i', '\u00f0': 'd', '\u00d0': 'D', '\u00fe': 'th', '\u00de': 'Th',
  '\u00e6': 'ae', '\u00c6': 'AE', '\u0153': 'oe', '\u0152': 'OE', '\u00df': 'ss',
  '\u20ac': 'EUR', '\u00a3': 'GBP', '\u00a5': 'JPY', '\u20b9': 'INR', '\u00a9': '(c)', '\u00ae': '(r)', '\u2122': '(tm)',
};

// Symbols that carry meaning: written out under asciiOnly, never just deleted
// (a dose of 5 micrograms must not render as 5 g). Keys are the forms left
// after NFKD: a vulgar fraction arrives as digit, fraction slash, digit. The
// micro sign is folded before NFKD (which turns it into Greek mu), so a real
// mu goes with the rest of its script. "plus or minus" is spelled out so the
// result holds no hyphen for a stripHyphens user.
const SYMBOL_FOLD = {
  '\u00d7': 'x', '\u2044': '/', '\u00f7': '/', '\u00b0': ' deg ',
  '\u00b1': ' plus or minus ', '\u2265': ' at least ', '\u2264': ' at most ', '\u2248': ' about ',
  '\u00a2': ' cents ', '\u20a9': 'KRW', '\u20bd': 'RUB', '\u20ba': 'TRY', '\u20aa': 'ILS',
  '\u20ab': 'VND', '\u20b1': 'PHP', '\u20a6': 'NGN', '\u20b4': 'UAH', '\u0e3f': 'THB',
  '\u2192': ' to ', '\u2191': ' up ', '\u2193': ' down ', '\u2260': ' not equal to ',
};

function normalize(text, opts) {
  if (!text) return '';
  // `opts` may be a map() index when normalize is passed as a callback, so only
  // an explicit boolean counts as an override.
  const stripHyphens = opts && typeof opts.stripHyphens === 'boolean'
    ? opts.stripHyphens
    : loadProfile().output.stripHyphens === true;
  const asciiOnly = opts && typeof opts.asciiOnly === 'boolean'
    ? opts.asciiOnly
    : loadProfile().output.asciiOnly === true;
  // Posting text (dedup keys) passes foldSymbols false so its keys never change.
  const symbols = opts && opts.foldSymbols === false ? {} : SYMBOL_FOLD;
  // A zero width joiner or non joiner inside a word is part of its spelling
  // in Persian and the Indic scripts; rendered text keeps it there.
  const joiners = !asciiOnly && symbols === SYMBOL_FOLD
    ? /(?<![\p{L}\p{M}])[\u200c\u200d]|[\u200c\u200d](?![\p{L}\p{M}])|(?<=[a-z])[\u200c\u200d]|[\u200c\u200d](?=[a-z])/giu
    : /[\u200c\u200d]/g;
  let out = String(text)
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
    .replace(joiners, '')  // zero-width non-joiner, zero-width joiner
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
    .replace(/\\/g, '/');

  // Rendered text keeps letters by default, so the cleanup that dropping
  // everything outside ASCII used to give for free is done by kind: every
  // other dash and the minus sign fold to '-' (before the stripHyphens pass,
  // so none survives it), the reversed quotes to ', the block and symbol font
  // bullets pasted from a PDF or a word processor to '-', every space variant
  // and line separator to a space, a Latin ligature to its letters. Posting
  // text skips this, so its keys never change.
  if (symbols === SYMBOL_FOLD) {
    out = out
      .replace(/[\p{Pd}\u2212]/gu, '-')
      .replace(/[\u201b\u201f]/g, "'")
      .replace(/[\u25cf\u25aa\u25a0\u2219\uf0b7\uf0a7]/g, '-')
      .replace(/[\p{Zs}\u2028\u2029]/gu, ' ')
      .replace(/[\ufb00-\ufb06]/g, (ch) => ch.normalize('NFKC'));
  }

  // Optional (output.stripHyphens): no hyphen or dash at all in rendered text.
  // Every dash + bullet variant above was already folded to an ASCII '-'. A
  // spaced ' - ' used as a parenthetical dash becomes a comma; every other
  // hyphen becomes a space ("end-to-end" -> "end to end", "real-time" ->
  // "real time"). Spaced separators first, then all remaining.
  if (stripHyphens) out = out.replace(/\s+-+\s+/g, ', ').replace(/-/g, ' ');

  // Default: the user's letters stay, in whatever script they write, with
  // their marks, digits, punctuation and currency signs, plus the four
  // Latin-1 signs every font and parser carries (degree, plus minus, times,
  // divide), the numero sign, and a joiner inside a word. Everything else outside ASCII goes: invisible format characters
  // (soft hyphen, direction marks), private use glyphs, variation selectors,
  // emoji and pictographs; a symbol with a written form is written out.
  if (!asciiOnly) {
    return out
      .replace(/[\ufe00-\ufe0f]/g, '')
      .replace(/[^\x00-\x7F\p{L}\p{M}\p{N}\p{Sc}\p{P}\u00b0\u00b1\u00d7\u00f7\u2116\u200c\u200d]/gu, (ch) => LETTER_FOLD[ch] ?? symbols[ch] ?? '')
      .normalize('NFC').replace(/  +/g, ' ');
  }

  // output.asciiOnly: fold extended-Latin letters to ASCII ("role" with a
  // circumflex, "naive" with a diaeresis) and drop what has no ASCII form.
  // 1) NFKD splits a letter into base + combining mark; drop the marks.
  // The not equal sign too: NFKD would leave a bare '='.
  if (symbols === SYMBOL_FOLD) out = out.replace(/\u00b5/g, 'u').replace(/\u2260/g, ' not equal to ');
  out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // 2) Map letters/symbols that do not decompose.
  out = out.replace(/[^\x00-\x7F]/g, (ch) => LETTER_FOLD[ch] ?? symbols[ch] ?? '');

  // Collapse double-spaces from any of the swaps above
  return out.replace(/  +/g, ' ');
}

// Fold for MATCHING only, never for rendering: lowercase, accents stripped,
// and the Latin letters that do not decompose mapped as posting text maps them
// (sharp s -> ss, o with stroke -> o). Posting text is stored ASCII folded, so
// user words (seeds, title policy, skills, regions) and posting text both go
// through this wherever they are compared. Letters of other scripts are kept.
function foldText(s) {
  return String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x00-\x7F]/g, (ch) => (/\p{L}/u.test(ch) && LETTER_FOLD[ch]) || ch)
    .toLowerCase();
}

module.exports = { normalize, foldText };
