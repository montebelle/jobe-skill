'use strict';
// lib/normalize.js: dashes, smart quotes, and ATS illegal characters are
// always folded to safe ASCII; letters of every script are kept. Removing
// plain hyphens (output.stripHyphens) and folding everything to plain ASCII
// (output.asciiOnly) are per user choices in data/profile.json, off by
// default, and an explicit option always wins. JOBE_USER_ROOT temp workspaces
// only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function workspace(profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-lib-generation-normalize-'));
  if (profile) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'profile.json'), JSON.stringify(profile));
  }
  return root;
}

const DEFAULT_ROOT = workspace();
process.env.JOBE_USER_ROOT = DEFAULT_ROOT;
const { normalize } = require('../lib/normalize');

test('always: dashes, quotes, bullets, and ATS illegal characters become safe ASCII', () => {
  assert.equal(normalize('Charge nurse — nights'), 'Charge nurse - nights');
  assert.equal(normalize('2018–2022'), '2018-2022');
  assert.equal(normalize('“patient first” and ‘calm’'), "'patient first' and 'calm'");
  assert.equal(normalize('• item'), '- item');
  assert.equal(normalize('wait time <5 min, [stat] {now} "quoted" a\\b'), "wait time less than 5 min, (stat) (now) 'quoted' a/b");
  assert.equal(normalize('score >= 90 and <= 95'), 'score at least 90 and at most 95');
  assert.equal(normalize('Café résumé naïve Øre', { asciiOnly: true }), 'Cafe resume naive Ore');
  assert.equal(normalize('a\u00a0b\u200bc\u2026'), 'a bc...');
  assert.ok(/^[\x00-\x7F]*$/.test(normalize('—–“”•é€™ 中', { asciiOnly: true })));
  assert.ok(/^[\x00-\x7F]*$/.test(normalize('—–“”• <x> [y] {z} "q" \\')), 'the always list alone leaves ASCII');
});

test('default profile keeps the letters of every script and their accents', () => {
  // A nurse writing in Russian and German, an accountant in French and Japanese.
  const ru = 'Сократила время обхода на 20 процентов';
  assert.equal(normalize(ru), ru);
  assert.equal(normalize('Führte ein Übergabeprotokoll für 28 Betten ein — Straße 5, Köln'), 'Führte ein Übergabeprotokoll für 28 Betten ein - Straße 5, Köln');
  assert.equal(normalize('Clôture annuelle “sans réserve”'), "Clôture annuelle 'sans réserve'");
  assert.equal(normalize('田中太郎 税理士'), '田中太郎 税理士');
  assert.equal(normalize('Zoë Müller-Lüdenscheidt'), 'Zoë Müller-Lüdenscheidt');
  assert.equal(normalize('Held 37°C; dose 5 µg; ½ tablet; ±2%; €40k'), 'Held 37°C; dose 5 µg; ½ tablet; ±2%; €40k', 'symbols are kept as written');
  assert.equal(normalize('Cafe\u0301'), 'Café', 'composed form');
  assert.deepEqual(['Köln', 'Łódź'].map(normalize), ['Köln', 'Łódź']);
});

test('output.asciiOnly folds letters to ASCII and writes meaningful symbols out instead of deleting them', () => {
  const clinical = 'Held 37°C; dose 5 µg; ½ tablet; 3 × daily; ≥95% adherence; ±2%; ≤5';
  assert.equal(normalize(clinical, { asciiOnly: true, stripHyphens: false }),
    'Held 37 deg C; dose 5 ug; 1/2 tablet; 3 x daily; at least 95% adherence; plus or minus 2%; at most 5');
  assert.equal(normalize('Budget €2m, £1.5m, ¥300m, ₹40 lakh, ₩5bn', { asciiOnly: true }), 'Budget EUR2m, GBP1.5m, JPY300m, INR40 lakh, KRW5bn');
  assert.equal(normalize('Straße 5, Köln', { asciiOnly: true }), 'Strasse 5, Koln');
  assert.equal(normalize('Иван — RN', { asciiOnly: true }), ' - RN', 'another script has no ASCII form');
  // A real Greek mu goes with its script; only the micro sign is written out.
  assert.equal(normalize('\u039d\u03bf\u03c3\u03b7\u03bb\u03b5\u03cd\u03c4\u03c1\u03b9\u03b1 \u03bc\u03b5 \u03b5\u03bc\u03c0\u03b5\u03b9\u03c1\u03af\u03b1 (5 \u00b5g)', { asciiOnly: true }), ' (5 ug)');
  assert.equal(normalize('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 No 5', { asciiOnly: true }), ' No 5');
  assert.ok(/^[\x00-\x7F]*$/.test(normalize(clinical + ' Иван 田中 €', { asciiOnly: true })));
  // The profile turns it on for the render path; the explicit option still wins.
  process.env.JOBE_USER_ROOT = workspace({ output: { asciiOnly: true } });
  try {
    assert.equal(normalize('Übergabe für 28 Betten, 5 µg'), 'Ubergabe fur 28 Betten, 5 ug');
    assert.equal(normalize('Übergabe', { asciiOnly: false }), 'Übergabe');
  } finally {
    process.env.JOBE_USER_ROOT = DEFAULT_ROOT;
  }
  assert.equal(normalize('Übergabe'), 'Übergabe');
});

test('default profile keeps plain hyphens (names and terms stay intact)', () => {
  assert.equal(normalize('X-ray technician, follow-up care, Smith-Jones'), 'X-ray technician, follow-up care, Smith-Jones');
  assert.equal(normalize('year-end close - partnership returns'), 'year-end close - partnership returns');
});

test('an explicit boolean wins over the profile', () => {
  assert.equal(normalize('year-end close - partnership returns', { stripHyphens: true }), 'year end close, partnership returns');
  assert.equal(normalize('follow‑up — same day', { stripHyphens: true }), 'follow up, same day');
});

test('empty input and non string input are safe; normalize works as a map callback', () => {
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(2024), '2024');
  assert.deepEqual(['year-end', 'follow-up'].map(normalize), ['year-end', 'follow-up']);
  assert.equal(normalize('year-end', null), 'year-end');
});

test('output.stripHyphens in the profile turns hyphen removal on for the render path', () => {
  process.env.JOBE_USER_ROOT = workspace({ output: { stripHyphens: true } });
  try {
    assert.equal(normalize('year-end close - partnership returns'), 'year end close, partnership returns');
    assert.deepEqual(['year-end', 'follow-up'].map(normalize), ['year end', 'follow up']);
    // The explicit option still wins, in both directions.
    assert.equal(normalize('year-end', { stripHyphens: false }), 'year-end');
    assert.equal(normalize('year-end', { stripHyphens: true }), 'year end');
  } finally {
    process.env.JOBE_USER_ROOT = DEFAULT_ROOT;
  }
  assert.equal(normalize('year-end'), 'year-end');
});

test('default mode keeps letters but still cleans what a pasted PDF or word processor resume carries', () => {
  const D = { asciiOnly: false, stripHyphens: false };
  const rows = [
    ['peri­operative nursing', 'perioperative nursing'],                       // soft hyphen
    ['Improved eﬃciency of ﬁnancial close', 'Improved efficiency of financial close'], // ligatures
    [' Prepared 120 returns', '- Prepared 120 returns'],                      // symbol font bullet
    ['● Triage ▪ Intake', '- Triage - Intake'],                           // block bullets
    ['12 patients, 3 units, ward　B, a b', '12 patients, 3 units, ward B, a b'], // space variants
    ['Ship \u{1F680} fast ❤️', 'Ship fast '],                             // emoji, variation selector
    ['variance − 3%, year－end, a﹣b', 'variance - 3%, year-end, a-b'], // minus and dash variants
    ['‛quoted‟', "'quoted'"],                                             // reversed quotes
    ['A → B, ≥ 5', 'A to B, at least 5'],                                 // symbols written out
  ];
  for (const [input, expected] of rows) assert.equal(normalize(input, D), expected, JSON.stringify(input));
  // Kept on purpose: letters, marks, digits, punctuation of every script,
  // currency signs, and the degree, plus minus, times, divide signs.
  const kept = 'José Muñoz, ¿Qué? «bien» 東京、大阪。 37°C ± 2, 3 × 4, 5 µg, €40';
  assert.equal(normalize(kept, D), kept);
  // A joiner inside a word is spelling (Persian, Devanagari); the numero sign
  // stays. A joiner anywhere else, an emoji sequence included, is removed.
  for (const word of ['\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645', '\u0915\u094d\u200d\u0937', '\u0428\u043a\u043e\u043b\u0430 \u2116 5']) {
    assert.equal(normalize(word, D), word);
  }
  assert.equal(normalize('a\u200db \u200c x\u200d \u{1F469}\u200d\u2695\uFE0F nurse', D), 'ab x nurse');
  // No dash of any kind survives the no hyphen rule, in either mode.
  for (const asciiOnly of [false, true]) {
    assert.equal(normalize('year－end close', { stripHyphens: true, asciiOnly }), 'year end close');
    assert.equal(normalize('variance − 3%', { stripHyphens: true, asciiOnly }), 'variance, 3%');
  }
});

test('direction and inequality symbols are written out, never deleted; posting text is untouched', () => {
  const s = 'Readmissions ↓ 15%, satisfaction ↑ 8 points, cost ≠ budget';
  for (const asciiOnly of [false, true]) {
    assert.equal(normalize(s, { stripHyphens: false, asciiOnly }), 'Readmissions down 15%, satisfaction up 8 points, cost not equal to budget');
  }
  // The posting path (dedup keys) keeps its old output.
  assert.equal(normalize(s, { stripHyphens: true, asciiOnly: true, foldSymbols: false }), 'Readmissions 15%, satisfaction 8 points, cost = budget');
});

test('foldText: the matching fold lowercases and strips accents the way posting text is stored', () => {
  const { foldText } = require('../lib/normalize');
  const { textClean } = require('../lib/posting');
  for (const s of ['Éducateur spécialisé', 'Ärztin', 'Großhandelskaufmann', 'Pædagog', 'Łącznik', 'Sygeplejerske børn', 'Infirmière', 'Tax Accountant']) {
    assert.equal(foldText(s), textClean(s).toLowerCase(), s);
  }
  assert.equal(foldText('Старшая медсестра'), 'старшая медсестра', 'another script is kept, only lowercased');
  assert.equal(foldText(null), '');
});
