/**
 * ATS character normalization.
 * Converts non-ASCII characters to ATS-safe equivalents.
 * Called before DOCX generation to prevent parsing failures.
 */

function normalize(text) {
  if (!text) return '';
  return text
    // Em dash and en dash -> hyphen
    .replace(/\u2014/g, '-')    // em dash
    .replace(/\u2013/g, '-')    // en dash
    .replace(/\u2012/g, '-')    // figure dash
    .replace(/\u2015/g, '-')    // horizontal bar
    // Smart quotes -> straight quotes
    .replace(/\u2018/g, "'")    // left single quote
    .replace(/\u2019/g, "'")    // right single quote
    .replace(/\u201C/g, '"')    // left double quote
    .replace(/\u201D/g, '"')    // right double quote
    .replace(/\u201A/g, "'")    // single low-9 quote
    .replace(/\u201E/g, '"')    // double low-9 quote
    // Ellipsis -> three dots
    .replace(/\u2026/g, '...')
    // Bullet characters -> hyphen
    .replace(/\u2022/g, '-')    // bullet
    .replace(/\u2023/g, '-')    // triangular bullet
    .replace(/\u25E6/g, '-')    // white bullet
    .replace(/\u2043/g, '-')    // hyphen bullet
    // Zero-width characters -> removed
    .replace(/\u200B/g, '')     // zero-width space
    .replace(/\u200C/g, '')     // zero-width non-joiner
    .replace(/\u200D/g, '')     // zero-width joiner
    .replace(/\uFEFF/g, '')     // byte order mark
    // Non-breaking space -> regular space
    .replace(/\u00A0/g, ' ')
    // Misc
    .replace(/\u00B7/g, '-')    // middle dot
    .replace(/\u2010/g, '-')    // hyphen character
    .replace(/\u2011/g, '-');   // non-breaking hyphen
}

module.exports = { normalize };
