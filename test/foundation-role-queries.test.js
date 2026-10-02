'use strict';
// lib/role-queries.js: inflection tolerant title matching. Synthetic seeds for
// a registered nurse and a tax accountant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-foundation-roles-'));
const {
  tokenize, rawRoleStrings, roleStrings, roleTokens, makeTitleMatcher, tokensMatch, tokenInSet,
} = require('../lib/role-queries');

const NURSE = { queries: [{ query: 'Registered Nurse', location: 'Columbus, OH' }, 'Senior Charge Nurse'] };
const ACCOUNTANT = { queries: [{ query: 'Tax Accountant' }, { query: 'tax accountant' }] };

test('tokensMatch tolerates inflection', () => {
  for (const [a, b] of [['nurse', 'nursing'], ['accountant', 'accounting'], ['scientist', 'science']]) {
    assert.equal(tokensMatch(a, b), true, `${a} / ${b}`);
    assert.equal(tokensMatch(b, a), true, `${b} / ${a}`);
  }
  assert.equal(tokensMatch('nurse', 'nurse'), true);
});

test('tokensMatch keeps unrelated words apart', () => {
  assert.equal(tokensMatch('nurse', 'number'), false);
  assert.equal(tokensMatch('number', 'nurse'), false);
  assert.equal(tokensMatch('tax', 'taxi'), false);       // shorter than the 4 character floor
  assert.equal(tokensMatch('rn', 'rna'), false);
  assert.equal(tokensMatch('accountant', 'accolade'), false);
});

test('tokenInSet accepts a Set or an array', () => {
  assert.equal(tokenInSet('nursing', new Set(['registered', 'nurse'])), true);
  assert.equal(tokenInSet('accounting', ['tax', 'accountant']), true);
  assert.equal(tokenInSet('number', new Set(['registered', 'nurse'])), false);
  assert.equal(tokenInSet('nurse', new Set()), false);
});

test('makeTitleMatcher matches inflected titles from the user seeds only', () => {
  const nurse = makeTitleMatcher(NURSE);
  assert.equal(nurse('Nursing Supervisor'), true);
  assert.equal(nurse('Registered Nurse, Medical Surgical'), true);
  assert.equal(nurse('Accounting Manager'), false);
  assert.equal(nurse('Number Theory Tutor'), false);

  const accountant = makeTitleMatcher(ACCOUNTANT);
  assert.equal(accountant('Senior Accounting Manager'), true);
  assert.equal(accountant('Tax Preparer'), true);
  assert.equal(accountant('Nursing Supervisor'), false);
});

test('no seeds means a permissive matcher', () => {
  for (const ctx of [undefined, {}, { queries: [] }]) {
    assert.equal(makeTitleMatcher(ctx)('Anything At All'), true);
  }
});

test('existing exports keep their behavior', () => {
  assert.deepEqual(rawRoleStrings(NURSE), ['Registered Nurse', 'Senior Charge Nurse']);
  assert.deepEqual(roleStrings(ACCOUNTANT), ['Tax Accountant']);
  assert.deepEqual(roleStrings(NURSE, { max: 1, quoted: true }), ['"Registered Nurse"']);
  assert.deepEqual([...roleTokens(NURSE)].sort(), ['charge', 'nurse', 'registered']);
  assert.deepEqual(tokenize('Senior Tax Accountant II (Remote)'), ['tax', 'accountant']);
});

test('an accented seed matches its own title as postings store it (folded to ASCII)', () => {
  const { textClean } = require('../lib/posting');
  const rq = require('../lib/role-queries');
  for (const seed of ['\u00c9ducateur sp\u00e9cialis\u00e9', '\u00c4rztin', 'M\u00e9dico de familia', 'Ing\u00e9nieur', '\u00dcbersetzer', 'Gro\u00dfhandelskaufmann', 'Infirmi\u00e8re', 'T\u00e9cnico contable']) {
    const match = rq.makeTitleMatcher({ queries: [{ query: seed }] });
    assert.equal(match(textClean(seed)), true, `${seed}: stored title`);
    assert.equal(match(seed), true, `${seed}: raw title`);
    assert.equal(match('Registered Nurse'), false, `${seed}: an unrelated title`);
  }
  assert.deepEqual(rq.tokenize('\u00c9ducateur sp\u00e9cialis\u00e9'), ['educateur', 'specialise']);
});

test('a hyphen in a seed or a title splits, as stored posting text has none', () => {
  const rq = require('../lib/role-queries');
  const match = rq.makeTitleMatcher({ queries: [{ query: 'E-commerce Bookkeeper' }, { query: 'Step-Down Nurse' }] });
  assert.equal(match('E commerce Bookkeeper'), true);
  assert.equal(match('Step Down RN'), true);
  assert.equal(match('Ecommerce Specialist'), false);
});

test('seedPlaces: the places each role is seeded in; remote, blank and country only rows are no place', () => {
  const rq = require('../lib/role-queries');
  const places = rq.seedPlaces({ queries: [
    { query: 'Registered Nurse', location: 'Denver, CO' }, { query: 'registered nurse', location: 'Colorado' },
    { query: 'Registered Nurse', location: 'denver, co' }, { query: 'Registered Nurse', location: 'Remote' },
    { query: 'Tax Accountant', location: 'United Kingdom' }, { query: 'Tax Accountant', location: 'Leeds' },
    { query: 'Charge Nurse', location: '' }, { query: 'Charge Nurse' }, 'Bookkeeper',
  ] });
  assert.deepEqual([...places], [['registered nurse', ['Denver, CO', 'Colorado']], ['tax accountant', ['Leeds']]]);
  assert.equal(rq.seedPlaces().size, 0);
});
