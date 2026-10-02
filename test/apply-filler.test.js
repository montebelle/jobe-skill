'use strict';
// lib/apply/filler.js: label routing (matchField), EEO option matching from the
// user's OWN values (eeoMatcher), the degree level fallback, and the two rules
// that keep a form honest: a blank answer is never guessed, and a demographic
// option is never picked on a partial word match. fillForm / fillQuestions run
// against a scripted page object, never a browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-apply-filler-'));
const {
  matchField, eeoSubtype, eeoMatcher, pickOption, gateOption, degreeLevelRe, fillForm, fillQuestions, SCAN_FN, detectAts,
} = require('../lib/apply/filler');

// The option lists the standard voluntary self identification forms render.
const RACE = [
  'American Indian or Alaska Native', 'Asian', 'Black or African American', 'Hispanic or Latino', 'White',
  'Native Hawaiian or Other Pacific Islander', 'Two or More Races', 'Decline To Self Identify',
];
const VETERAN = [
  'I am not a protected veteran',
  'I identify as one or more of the classifications of a protected veteran',
  "I don't wish to answer",
];
const DISABILITY = [
  'Yes, I have a disability, or have had one in the past',
  'No, I do not have a disability and have not had one in the past',
  'I do not want to answer',
];
const pick = (sub, value, options) => pickOption(options, eeoMatcher(sub, { [sub]: value }));

// Questions that mention a clearance or relocation but are not the one fact the
// key holds. Each must be left for the user, on every widget.
const OTHER_CLEARANCE_QS = [
  'Have you completed your occupational health clearance?',
  'Do you have an enhanced DBS clearance?',
  'Can you pass a background check and security clearance?',
  'Could you qualify for a security clearance?',
  'Have you previously held a security clearance?',
  'Have you held a security clearance in the past?',
  'Has your security clearance expired or lapsed?',
  'Do you have clearance from your current employer to interview?',
  // hold one OR can get one: a No from the "holds" key would be wrong
  'Do you currently hold a security clearance or can you acquire one?',
  'Do you have an active security clearance or are you clearable?',
  'Do you have a security clearance or could you be granted one?',
];
const OTHER_RELOCATION_QS = [
  'Will this role require you to relocate?',
  'Is relocation needed?',
  'Are you unwilling to relocate?',
  'Have you relocated for work before?',
  'Are you planning to relocate in the next 12 months?',
  // lives there OR willing to move: a No from the willingness key would be wrong
  'Are you located in or willing to relocate to the Denver metro area?',
  'Are you currently located in the Greater Toronto Area or willing to relocate?',
  'Do you live within commuting distance of our Leeds office, or are you willing to relocate?',
  'Are you based in Manchester or open to relocating there?',
  'Would you be open to relocating, or do you already live in the Chicago area?',
  'Are you based in Manchester / open to relocating there?',
  'Are you willing to work on-site in Austin five days a week (no relocation provided)?',
];

test('matchField routes each gate to its own answer key', () => {
  const key = (label) => { const m = matchField(label); return m ? (m.key || m.kind) : null; };
  assert.equal(key('Will you now or in the future require sponsorship for employment visa status?'), 'requireSponsorship');
  assert.equal(key('Do you require sponsorship for authorization to work?'), 'requireSponsorship');
  assert.equal(key('Are you legally authorized to work in the country where this role is based?'), 'workAuthorized');
  assert.equal(key('Visa status'), 'requireSponsorship');
  // the four citizenship style questions do not share one answer
  assert.equal(key('Are you a citizen of the country where this job is located?'), 'citizen');
  assert.equal(key('Are you a citizen or lawful permanent resident?'), 'citizenOrPermanentResident');
  assert.equal(key('Are you currently domiciled in the country of employment?'), 'domiciled');
  assert.equal(key('Are you eligible for federal employment?'), 'federalEligible');
  assert.equal(key('Are you subject to a non-compete or other restrictive covenant?'), 'nonCompete');
  assert.equal(key('Are you bound by a noncompetition agreement?'), 'nonCompete');
  assert.equal(key('Do you hold an active security clearance?'), 'clearance');
  assert.equal(key('Are you willing to relocate for this position?'), 'relocation');
  // contact fields
  assert.equal(key('First Name *'), 'firstName');
  assert.equal(key('Email (required)'), 'email');
  assert.equal(key('Country'), 'country');
  assert.equal(key('City'), 'city');
  for (const label of ['Zip Code', 'ZIP / Postal Code *', 'Postal Code', 'Postcode', 'Post code']) assert.equal(key(label), 'postalCode', label);
  assert.equal(key('Postal address'), null); // a street address, not the code
  for (const label of ['Zipcode', 'Zip-code', 'Zip code (city of residence)']) assert.equal(key(label), 'postalCode', label);
  assert.equal(key('City, State, Zip'), 'city'); // a combined field leads with the city
  // "zip" inside the name of a job board is not a postal code field
  assert.equal(key('ZipRecruiter profile URL'), null);
  assert.equal(key('How did you hear? (e.g. ZipRecruiter)'), null);
  // "Country/Region" asks for the country; a region field stays a region field
  assert.equal(key('Country/Region'), 'country');
  for (const label of ['State', 'State / Province', 'Region', 'Which region are you based in?']) assert.equal(key(label), 'state', label);
  assert.equal(key('Desired salary'), 'salaryExpectation');
  // present pay is a different question from expected pay: never answered
  for (const label of ['Current salary', 'Current salary (GBP)', 'What is your current notice period and salary?', 'Last drawn salary', 'Present hourly pay', 'Total compensation at your most recent role', 'What salary are you on currently?', 'Compensation at your last job', 'Current salary and minimum notice period']) assert.equal(key(label), null, label);
  for (const label of ['Expected salary', 'Salary expectations', 'What is your expected salary given our current range?', 'Please present your salary expectations', 'At present, what salary do you expect?']) assert.equal(key(label), 'salaryExpectation', label);
  // clearance and relocation keys answer one fact each (holds an active
  // clearance; willing to relocate). A different question is left for the user.
  for (const label of ['Do you hold an active security clearance?', 'Do you have an active Secret clearance?', 'Do you currently have a security clearance?', 'This position requires an active security clearance. Do you currently hold one?', 'Do you currently hold an active TS/SCI clearance?', 'Do you hold an active Secret clearance or higher?']) assert.equal(key(label), 'clearance', label);
  for (const label of ['Are you able to obtain a security clearance?', 'Are you willing to obtain a U.S. government security clearance if required?', 'Have you ever had a security clearance denied or revoked?', 'What level of clearance do you hold?', 'Are you eligible for a security clearance?', ...OTHER_CLEARANCE_QS]) assert.equal(matchField(label), null, label);
  for (const label of ['Are you willing to relocate?', 'Are you open to relocation?', 'Are you willing to relocate if required?', 'This role requires relocation to Leeds. Are you willing to relocate?', 'Are you willing to relocate for this position?', 'Would you consider relocating?', 'Are you open to relocating to one of our hub cities?', 'This position is based in Phoenix, AZ. Are you willing to relocate?']) assert.equal(key(label), 'relocation', label);
  for (const label of ['Do you require relocation assistance?', 'Will you need relocation support to take this role?', 'Would you require relocation?', 'Can you work from our office without relocating?', ...OTHER_RELOCATION_QS]) assert.equal(matchField(label), null, label);
  // demographic questions
  assert.equal(key('Gender'), 'eeo');
  assert.equal(key('Veteran Status'), 'eeo');
  // a long sentence that merely contains a field word is a custom question
  assert.equal(key('Tell us about a time you wrote for our clinical education blog and what the readers learned from it'), null);
  assert.equal(key('Describe how you reconciled a client ledger under a filing deadline'), null);
  assert.equal(key('Have you served in the National Guard?'), null);
  assert.equal(key(''), null);
});

test('eeoSubtype separates the demographic questions', () => {
  assert.equal(eeoSubtype('Do you identify as transgender?'), 'transgender');
  assert.equal(eeoSubtype('Gender'), 'gender');
  assert.equal(eeoSubtype('Gender pronouns'), 'pronouns');
  assert.equal(eeoSubtype('Sexual orientation'), 'orientation');
  assert.equal(eeoSubtype('Are you Hispanic/Latino?'), 'hispanic');
  assert.equal(eeoSubtype('Race / Ethnicity'), 'race');
  assert.equal(eeoSubtype('Veteran Status'), 'veteran');
  assert.equal(eeoSubtype('Disability Status'), 'disability');
  assert.equal(eeoSubtype('Age range'), null);
});

test('eeoMatcher: no value on file means no pattern, so the caller declines', () => {
  for (const values of [undefined, null, {}, { gender: '' }, { gender: '   ' }, { gender: [] }, { gender: null }, { gender: {} }]) {
    assert.equal(eeoMatcher('gender', values), null);
  }
  // a value that is itself "decline" leaves the choice to the decline path
  assert.equal(eeoMatcher('veteran', { veteran: "I don't wish to answer" }), null);
  assert.equal(eeoMatcher('race', { race: 'Decline to self identify' }), null);
});

test('eeoMatcher picks the whole phrase, never an option that shares a word', () => {
  // every standard race option selects itself, including the ones made of
  // several words that share "or", "American", "Native" with other options
  for (const option of RACE.slice(0, 7)) assert.equal(pick('race', option, RACE), option);
  assert.equal(pick('race', 'two or more races', RACE), 'Two or More Races');
  assert.equal(pick('race', 'White', ['Asian (Not Hispanic or Latino)', 'White (Not Hispanic or Latino)']), 'White (Not Hispanic or Latino)');
  // a value the form does not offer selects nothing
  assert.equal(pick('race', 'Middle Eastern or North African', RACE), null);
});

test('eeoMatcher: the connective between the parts of one choice is not part of the choice', () => {
  const value = 'Black or African American';
  for (const option of ['Black / African American', 'Black/African American', 'Black & African American', 'Black and/or African American']) {
    assert.equal(pick('race', value, ['Asian', option, 'White']), option);
  }
  assert.equal(pick('race', 'Black / African American', RACE), 'Black or African American');
  assert.equal(pick('race', 'Hispanic or Latino', ['Asian', 'Hispanic/Latino']), 'Hispanic/Latino');
  assert.equal(pick('race', 'American Indian or Alaska Native', ['American Indian / Alaska Native', 'Asian']), 'American Indian / Alaska Native');
  // every other word is still required
  assert.equal(pick('race', value, ['African American', 'Black']), null);
  assert.equal(pick('race', 'Middle Eastern or North African', ['Middle Eastern', 'North African']), null);
  // a value that is only connectives or separators names no choice: decline,
  // never the first option
  for (const empty of ['or', 'and', '&', '-', '/', ' or / and ']) assert.equal(eeoMatcher('race', { race: empty }), null, empty);
});

test('eeoMatcher: veteran and disability values land on the matching side', () => {
  assert.equal(pick('veteran', VETERAN[0], VETERAN), VETERAN[0]);
  assert.equal(pick('veteran', 'No', VETERAN), VETERAN[0]);
  assert.equal(pick('veteran', 'Protected veteran', VETERAN), VETERAN[1]);
  assert.equal(pick('veteran', VETERAN[0], ['Yes', 'No', 'Prefer not to say']), 'No');
  assert.equal(pick('veteran', 'No', ['Yes, I am a veteran', 'No, I am not a veteran']), 'No, I am not a veteran');

  assert.equal(pick('disability', 'No, I do not have a disability', DISABILITY), DISABILITY[1]);
  assert.equal(pick('disability', 'No', DISABILITY), DISABILITY[1]);
  assert.equal(pick('disability', "I don't have a disability", DISABILITY), DISABILITY[1]);
  assert.equal(pick('disability', 'Yes', DISABILITY), DISABILITY[0]);
  assert.equal(pick('disability', 'I have a disability', DISABILITY), DISABILITY[0]);
  assert.equal(pick('disability', 'No', ['Yes', 'No', 'I do not want to answer']), 'No');
});

test('eeoMatcher: gender words, lists of phrasings, and short yes/no questions', () => {
  assert.equal(pick('gender', 'Male', ['Man', 'Woman', 'Non-binary']), 'Man');
  assert.equal(pick('gender', 'Woman', ['Male', 'Female', 'Decline']), 'Female');
  assert.equal(pick('gender', 'Male', ['Female', 'Male']), 'Male'); // "Female" contains "male"
  assert.equal(pick('gender', ['Non-binary', 'Nonbinary'], ['Man', 'Woman', 'Non binary']), 'Non binary');
  assert.equal(pick('gender', 'Female', ['Man', 'Non-binary']), null);
  assert.equal(pick('hispanic', 'No', ['Yes', 'No', 'Decline']), 'No');
  assert.equal(pick('hispanic', 'No', ['Hispanic or Latino', 'Not Hispanic or Latino']), 'Not Hispanic or Latino');
  assert.equal(pick('transgender', 'No', ['Yes', 'No', 'I prefer not to say']), 'No');
  assert.equal(pick('pronouns', 'She/her', ['He/him', 'She/her', 'They/them']), 'She/her');
});

test('degreeLevelRe maps a degree to the level a dropdown lists', () => {
  const level = (degree, options) => pickOption(options, degreeLevelRe(degree));
  const LEVELS = ['High School', "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Doctorate'];
  assert.equal(level('B.S. Nursing', LEVELS), "Bachelor's Degree");
  assert.equal(level('Bachelor of Arts, History', LEVELS), "Bachelor's Degree");
  assert.equal(level('Master of Accountancy', LEVELS), "Master's Degree");
  assert.equal(level('MSN, Nursing Education', LEVELS), "Master's Degree");
  assert.equal(level('Doctor of Nursing Practice', LEVELS), 'Doctorate');
  assert.equal(level('Associate of Applied Science', LEVELS), "Associate's Degree");
  assert.equal(level('GED', LEVELS), 'High School');
  // no recognizable level: no fallback at all
  assert.equal(degreeLevelRe('Certificate in Bookkeeping'), null);
  assert.equal(degreeLevelRe(''), null);
  assert.equal(degreeLevelRe(undefined), null);
});

test('detectAts names the known hosts', () => {
  assert.equal(detectAts('https://job-boards.greenhouse.io/x/jobs/1'), 'greenhouse');
  assert.equal(detectAts('https://jobs.lever.co/x/1'), 'lever');
  assert.equal(detectAts('https://careers.example.org/1'), 'generic');
});

// ---- a scripted page ----
// fields: what the in-page scanner would return. A combobox field may carry
// `menu` (the options its dropdown renders when opened). Every action the
// filler performs is recorded in page.actions.
function scriptedPage(fields) {
  const actions = [];
  let menu = [];
  const locator = (sel) => {
    const m = /data-cfx="(\d+)"/.exec(sel);
    if (m) {
      const idx = Number(m[1]);
      const field = fields.find((f) => f.idx === idx) || {};
      return {
        click: async () => { menu = field.menu || []; actions.push(['click', idx]); },
        check: async () => { actions.push(['check', idx]); },
        fill: async (v) => { if (v !== '') actions.push(['fill', idx, v]); },
        type: async (v) => { actions.push(['type', idx, v]); },
        selectOption: async (o) => { actions.push(['select', idx, o.label]); },
        setInputFiles: async (file) => { actions.push(['upload', idx, file]); },
        scrollIntoViewIfNeeded: async () => {},
      };
    }
    // any other selector is "the options of the open dropdown" or a page level
    // control (consent buttons), of which this page has none
    const isMenu = /select__option|role="option"|_option_/.test(sel);
    const list = {
      count: async () => (isMenu ? menu.length : 0),
      nth: (i) => ({ innerText: async () => menu[i], click: async () => { actions.push(['pick', menu[i]]); } }),
      filter: () => list, first: () => list, last: () => list,
      isVisible: async () => false,
    };
    return list;
  };
  return {
    actions,
    evaluate: async (fn) => (fn === SCAN_FN ? fields.map(({ menu: _menu, ...f }) => f) : undefined),
    locator,
    waitForTimeout: async () => {},
    keyboard: { press: async () => {}, type: async () => {} },
  };
}
const select = (idx, label, options) => ({ idx, tag: 'select', type: 'select', name: '', required: true, label, option: null, options });
const radio = (idx, label, option) => ({ idx, tag: 'input', type: 'radio', name: '', required: true, label, option, options: null });
const combo = (idx, label, menu) => ({ idx, tag: 'input', type: 'combobox', name: '', required: true, label, option: null, options: null, menu });
const text = (idx, label) => ({ idx, tag: 'input', type: 'text', name: '', required: true, label, option: null, options: null });

const SPONSOR_Q = 'Will you now or in the future require sponsorship?';
const SPONSOR_OPTS = ['', 'Yes, I will require sponsorship now or in the future', 'No, I will not'];
const AUTH_Q = 'Are you legally authorized to work in this country?';
const CITIZEN_Q = 'Are you a citizen?';

test('a blank yes/no answer is surfaced as a question, never answered', async () => {
  for (const blank of ['', '   ', undefined, null]) {
    const page = scriptedPage([
      select(0, SPONSOR_Q, SPONSOR_OPTS),
      radio(1, AUTH_Q, 'Yes'), radio(2, AUTH_Q, 'No'),
      combo(3, CITIZEN_Q, ['Yes', 'No']),
    ]);
    const report = await fillForm(page, { requireSponsorship: blank, workAuthorized: blank, citizen: blank });
    assert.deepEqual(page.actions.filter(([a]) => a === 'select' || a === 'check' || a === 'pick'), [], `blank=${JSON.stringify(blank)}`);
    assert.deepEqual(report.filled, []);
    const byLabel = Object.fromEntries(report.questions.map((q) => [q.label, q]));
    assert.deepEqual(byLabel[SPONSOR_Q].options, SPONSOR_OPTS);
    assert.deepEqual(byLabel[AUTH_Q].options, ['Yes', 'No']);
    assert.deepEqual(byLabel[CITIZEN_Q].options, ['Yes', 'No']); // probed from the open dropdown
  }
});

test('a yes/no answer on file picks the option that says it', async () => {
  const page = scriptedPage([
    select(0, SPONSOR_Q, SPONSOR_OPTS),
    radio(1, AUTH_Q, 'Yes'), radio(2, AUTH_Q, 'No'),
    combo(3, CITIZEN_Q, ['Yes, I am', 'No, I am not']),
    select(4, 'Are you a citizen or permanent resident?', ['Select', 'Yes', 'No']),
  ]);
  const report = await fillForm(page, { requireSponsorship: 'No', workAuthorized: 'Yes', citizen: 'No', citizenOrPermanentResident: 'Yes' });
  // "No" must not land on the Yes option just because it contains "now"
  assert.deepEqual(page.actions.filter(([a]) => a === 'select'), [['select', 0, 'No, I will not'], ['select', 4, 'Yes']]);
  assert.deepEqual(page.actions.filter(([a]) => a === 'check'), [['check', 1]]);
  assert.deepEqual(page.actions.filter(([a]) => a === 'pick'), [['pick', 'No, I am not']]);
  assert.deepEqual(report.questions, []);
  assert.deepEqual(report.filled.map((x) => x.value), ['No, I will not', 'Yes', 'No, I am not', 'Yes']);
});

// One row per option list a real form renders: [answer key, question, options,
// the option a Yes selects, the option a No selects]. null = nothing is
// selected and the question is left for the glance. The same row is run
// through all four widgets.
const SPONSOR_LONG_Q = 'Will you now or in the future require sponsorship for employment visa status?';
const COVENANT_Q = 'Are you subject to a non-compete or other restrictive covenant?';
const CLEARANCE_Q = 'Do you hold an active security clearance?';
const RELOCATE_Q = 'Are you willing to relocate for this position?';
const GATE_TABLE = [
  ['workAuthorized', AUTH_Q, ['Yes', 'No'], 'Yes', 'No'],
  // a phrase that contains the words of its opposite
  ['workAuthorized', AUTH_Q, ['I am not authorized to work', 'I am authorized to work'], 'I am authorized to work', null],
  ['workAuthorized', AUTH_Q, ['Not authorized', 'Authorized'], 'Authorized', null],
  ['workAuthorized', AUTH_Q, ["I don't have authorization yet", 'I have authorization'], 'I have authorization', null],
  ['workAuthorized', AUTH_Q, ['I don\u2019t have authorization yet', 'I have authorization'], 'I have authorization', null],
  ['workAuthorized', AUTH_Q, ['I am unauthorized', 'I am authorized'], 'I am authorized', null],
  // long sentences, negated option first
  ['workAuthorized', AUTH_Q, ['No, I am not legally authorized to work in this country', 'Yes, I am legally authorized to work in this country without restriction'],
    'Yes, I am legally authorized to work in this country without restriction', 'No, I am not legally authorized to work in this country'],
  ['workAuthorized', AUTH_Q, ['Yes', 'No', 'Not sure, I would like to discuss my situation with the recruiting team before answering'], 'Yes', 'No'],
  // a double negative, and several options that could each be the Yes: no guess
  ['workAuthorized', AUTH_Q, ['It is not the case that I am not authorized to work', 'I am not authorized to work'], null, null],
  ['workAuthorized', 'What is your work authorization status?', ['I am authorized to work for any employer', 'I am authorized to work for my current employer only', 'I am not authorized to work'], null, null],
  ['workAuthorized', 'What is your work authorization status?', ['I am authorized to work and do not require sponsorship', 'I am not authorized to work without sponsorship'], null, null],
  // words that merely start with "no" or "yes"
  ['workAuthorized', AUTH_Q, ['Norway only', 'Yesterday expired', 'Nowhere'], null, null],
  // sponsorship reads the other way round: its Yes is "I require / need"
  ['requireSponsorship', SPONSOR_LONG_Q, ['Yes', 'No'], 'Yes', 'No'],
  ['requireSponsorship', SPONSOR_LONG_Q, ['Yes, I will require sponsorship now or in the future', 'No, I will not require sponsorship now or in the future'],
    'Yes, I will require sponsorship now or in the future', 'No, I will not require sponsorship now or in the future'],
  ['requireSponsorship', SPONSOR_LONG_Q, ['I do not require sponsorship', 'I require sponsorship'], 'I require sponsorship', 'I do not require sponsorship'],
  ['requireSponsorship', SPONSOR_LONG_Q, ['I am authorized to work without sponsorship', 'I will need sponsorship'], 'I will need sponsorship', null],
  ['requireSponsorship', SPONSOR_LONG_Q, ['Yes, now', 'Yes, in the future', 'No'], null, 'No'],
  ['requireSponsorship', SPONSOR_LONG_Q, ['No', 'No, but I will need it once my current permit expires', 'Yes'], 'Yes', 'No'],
  // an option that takes its No back is not the No; the one that does not, is
  ['requireSponsorship', SPONSOR_LONG_Q, ['I do not require sponsorship now but will in the future', 'I do not require sponsorship now or in the future', 'I require sponsorship now'], 'I require sponsorship now', 'I do not require sponsorship now or in the future'],
  ['requireSponsorship', SPONSOR_LONG_Q, ['I do not need sponsorship now but will in the future', 'I will never need sponsorship'], null, 'I will never need sponsorship'],
  ['requireSponsorship', SPONSOR_LONG_Q, ['Yes', 'No, but I will need it once my current permit expires', 'I would not require sponsorship'], 'Yes', 'I would not require sponsorship'],
  ['requireSponsorship', SPONSOR_LONG_Q, ['I do not need sponsorship now but will in the future', 'I need sponsorship now'], 'I need sponsorship now', null],
  ['requireSponsorship', SPONSOR_LONG_Q, ['No sponsorship needed', 'Sponsorship needed'], 'Sponsorship needed', 'No sponsorship needed'],
  // a leading "No <noun>" is not a No to the gate
  ['workAuthorized', AUTH_Q, ['No restrictions, authorized for any employer', 'Sponsorship needed'], null, null],
  ['workAuthorized', AUTH_Q, ['No - I am not authorized', 'Yes - I am authorized'], 'Yes - I am authorized', 'No - I am not authorized'],
  // "I have ..." / "I am ..." alone does not state the gate
  ['workAuthorized', AUTH_Q, ['I have a visa that requires sponsorship', 'US Citizen / Green Card holder'], null, null],
  ['clearance', CLEARANCE_Q, ['I have held one previously (inactive)', 'Active', 'None'], null, null],
  ['clearance', CLEARANCE_Q, ['I held a clearance previously', 'I have never held a clearance'], null, null],
  ['relocation', RELOCATE_Q, ['I am based nearby already', 'I have family obligations'], null, null],
  ['nonCompete', COVENANT_Q, ['I am a current employee of a competitor', 'I have signed nothing'], null, null],
  ['citizen', CITIZEN_Q, ['I am not a citizen', 'I am a citizen'], 'I am a citizen', null],
  ['citizen', CITIZEN_Q, ['I am a non-citizen', 'I am a citizen'], 'I am a citizen', null],
  // a permanent resident's Yes is not "a citizen"
  ['citizenOrPermanentResident', 'Are you a citizen or lawful permanent resident?', ['Yes, a citizen', 'Yes, a permanent resident', 'No, neither'], null, 'No, neither'],
  ['citizenOrPermanentResident', 'Are you a citizen or lawful permanent resident?', ['I am a citizen', 'I am a permanent resident', 'I am neither'], null, null],
  ['domiciled', 'Are you currently domiciled in the country of employment?', ['No, I am not', 'Yes, I am'], 'Yes, I am', 'No, I am not'],
  ['federalEligible', 'Are you eligible for federal employment?', ['I am ineligible', 'I am eligible'], 'I am eligible', null],
  ['nonCompete', COVENANT_Q, ['I have no such agreement', 'I have such an agreement'], 'I have such an agreement', null],
  ['nonCompete', COVENANT_Q, ['No, I am not subject to any agreement that would restrict my employment here', 'Yes, I am subject to an agreement that may restrict my employment here'],
    'Yes, I am subject to an agreement that may restrict my employment here', 'No, I am not subject to any agreement that would restrict my employment here'],
  ['clearance', CLEARANCE_Q, ['I have never held a clearance', 'I have an active clearance'], 'I have an active clearance', null],
  ['clearance', CLEARANCE_Q, ['None', 'Secret', 'Top Secret'], null, null],
  ['relocation', RELOCATE_Q, ['I am unable to relocate', 'I am open to relocating'], 'I am open to relocating', null],
  ['relocation', RELOCATE_Q, ['I cannot relocate', "I can't relocate right now but I am open to it later", 'Yes'], 'Yes', null],
  // an option that names the subject ("non-compete") is not negated by it
  ['nonCompete', COVENANT_Q, ['I am subject to a non-compete agreement', 'I am free of any such agreement'], null, null],
  ['nonCompete', COVENANT_Q, ['I am subject to a non-compete agreement', 'I am not subject to a non-compete agreement'], 'I am subject to a non-compete agreement', null],
  ['nonCompete', COVENANT_Q, ['I am bound by a non-solicitation covenant', 'I am not bound by any covenant'], 'I am bound by a non-solicitation covenant', null],
  // a qualified authorization (a visa, sponsorship, a requirement) is not the Yes on file
  ['workAuthorized', AUTH_Q, ['I am a citizen or permanent resident', 'I am authorized to work on a visa (H-1B, OPT, TN)', 'I will require sponsorship'], null, null],
  ['workAuthorized', AUTH_Q, ['I require sponsorship to be authorized to work', 'I am a citizen'], null, null],
  ['workAuthorized', AUTH_Q, ['Authorization required', 'I am a citizen'], null, null],
  ['workAuthorized', AUTH_Q, ['I will need authorization from my employer', 'I am a citizen or permanent resident'], null, null],
  ['workAuthorized', AUTH_Q, ['I am authorized to work with sponsorship', 'I am not authorized'], null, null],
  ['workAuthorized', AUTH_Q, ['I am authorized to work until my student permit expires', 'I am not authorized'], null, null],
  // "without sponsorship / restriction" qualifies nothing
  ['workAuthorized', AUTH_Q, ['I am authorized to work without sponsorship', 'I will require sponsorship'], 'I am authorized to work without sponsorship', null],
  ['workAuthorized', AUTH_Q, ['I am authorized to work for any employer without restriction', 'I am not authorized'], 'I am authorized to work for any employer without restriction', null],
];
const button = (idx, label, option) => ({ idx, tag: 'button', type: 'buttongroup', name: '', required: true, label, option, options: null });
const WIDGETS = {
  select: (label, options) => [select(0, label, ['Select...', ...options])],
  combobox: (label, options) => [combo(0, label, options)],
  radio: (label, options) => options.map((o, i) => radio(i, label, o)),
  buttongroup: (label, options) => options.map((o, i) => button(i, label, o)),
};
// the option the page ended up holding, whatever the widget
function selected(page, fields, widget) {
  const acts = page.actions.filter(([a]) => a === 'select' || a === 'check' || a === 'pick' || (a === 'click' && widget === 'buttongroup'));
  return acts.map(([a, x, label]) => (a === 'select' ? label : a === 'pick' ? x : fields[x].option));
}

test('gateOption: a Yes or a No selects the option that states it, never its opposite', () => {
  for (const [key, , options, yes, no] of GATE_TABLE) {
    const at = (want) => { const i = gateOption(options, key, want); return i >= 0 ? options[i] : null; };
    assert.equal(at('Yes'), yes, `Yes on ${JSON.stringify(options)}`);
    assert.equal(at('No'), no, `No on ${JSON.stringify(options)}`);
    assert.equal(at('yes'), yes);
  }
  assert.equal(gateOption([], 'citizen', 'Yes'), -1);
  assert.equal(gateOption(['', 'Select...'], 'citizen', 'No'), -1);
  assert.equal(gateOption(null, 'citizen', 'Yes'), -1);
});

test('every widget selects the same option for a gate, and the glance reports that option', async () => {
  for (const [key, label, options, yes, no] of GATE_TABLE) {
    for (const [want, expected] of [['Yes', yes], ['No', no], ['', null]]) {
      for (const widget of Object.keys(WIDGETS)) {
        const where = `${widget} ${key}=${want || 'blank'} ${JSON.stringify(options)}`;
        const fields = WIDGETS[widget](label, options);
        const page = scriptedPage(fields);
        const report = await fillForm(page, { [key]: want });
        assert.deepEqual(selected(page, fields, widget), expected ? [expected] : [], where);
        // what the glance shows is the option the form now holds
        assert.deepEqual(report.filled, expected ? [{ label, value: expected }] : [], where);
        // nothing selected: the question is reported, never dropped
        if (!expected) assert.equal(report.questions.length + report.unfilled.length > 0, true, where);
      }
    }
  }
});

test('a question the profile key does not answer is surfaced with its options, on every widget', async () => {
  const cases = [
    ['Are you able to obtain a security clearance?', { clearance: 'No' }],
    ['Are you willing to obtain a government security clearance if required?', { clearance: 'No' }],
    ['Have you ever had a security clearance denied or revoked?', { clearance: 'Yes' }],
    ['Do you require relocation assistance?', { relocation: 'Yes' }],
    ['Will you need relocation support to take this role?', { relocation: 'Yes' }],
    ['Can you work from our Leeds office without relocating?', { relocation: 'No' }],
    ['Current salary band', { salaryExpectation: '52000' }],
    ['Total compensation at your most recent role', { salaryExpectation: '52000' }],
    ['What salary are you on currently?', { salaryExpectation: '52000' }],
    ...OTHER_CLEARANCE_QS.map((q) => [q, { clearance: /expired/.test(q) ? 'Yes' : 'No' }]),
    ...OTHER_RELOCATION_QS.map((q) => [q, { relocation: 'Yes' }]),
  ];
  for (const [q, answers] of cases) {
    for (const widget of ['select', 'radio', 'combo', 'text']) {
      const fields = widget === 'select' ? [select(0, q, ['', 'Yes', 'No'])]
        : widget === 'radio' ? [radio(0, q, 'Yes'), radio(1, q, 'No')]
          : widget === 'combo' ? [combo(0, q, ['Yes', 'No'])] : [text(0, q)];
      const page = scriptedPage(fields);
      const report = await fillForm(page, answers);
      assert.deepEqual(page.actions.filter(([a]) => ['select', 'check', 'pick', 'type'].includes(a)), [], `${widget}: ${q}`);
      assert.deepEqual(report.filled, [], `${widget}: ${q}`);
      // an optional short text label is not a custom question (same rule as every other short text field)
      if (widget !== 'text' || q.length > 24) assert.deepEqual(report.questions.map((x) => x.label), [q], `${widget}: ${q}`);
      if (widget !== 'text') assert.deepEqual(report.questions[0].options.filter(Boolean), ['Yes', 'No'], `${widget}: ${q}`);
    }
  }
  // the question the key does answer is still answered, and expected pay is still typed
  const page = scriptedPage([
    radio(0, 'Do you hold an active security clearance?', 'Yes'), radio(1, 'Do you hold an active security clearance?', 'No'),
    select(2, 'Are you willing to relocate if required?', ['', 'Yes', 'No']),
    text(3, 'Expected salary'), text(4, 'Current salary'),
  ]);
  const report = await fillForm(page, { clearance: 'No', relocation: 'Yes', salaryExpectation: '95000' });
  assert.deepEqual(page.actions.filter(([a]) => ['select', 'check', 'type'].includes(a)), [['check', 1], ['select', 2, 'Yes'], ['type', 3, '95000']]);
  assert.deepEqual(report.questions.map((x) => x.label), ['Current salary']);
  // a label that asks for the expectation is still filled, whatever else it mentions
  for (const q of ['Please present your salary expectations', 'At present, what salary do you expect?', 'What was your last role and what compensation are you seeking?', 'What is your expected salary given our current range?', 'What are your current salary requirements?', 'Current salary requirements', 'Please provide your current compensation requirements', 'What is your minimum salary requirement currently?']) {
    const p2 = scriptedPage([text(0, q)]);
    const r2 = await fillForm(p2, { salaryExpectation: '95000' });
    assert.deepEqual(p2.actions.filter(([a]) => a === 'type'), [['type', 0, '95000']], q);
    assert.deepEqual(r2.filled, [{ label: q, value: '95000' }], q);
  }
});

test('a gate value that is the user\'s own wording is matched as written', async () => {
  const fields = WIDGETS.radio(CLEARANCE_Q, ['None', 'Secret', 'Top Secret']);
  const page = scriptedPage(fields);
  const report = await fillForm(page, { clearance: 'Secret' });
  assert.deepEqual(selected(page, fields, 'radio'), ['Secret']);
  assert.deepEqual(report.filled, [{ label: CLEARANCE_Q, value: 'Secret' }]);
});

test('a yes/no group with no option matching the answer on file is surfaced', async () => {
  const page = scriptedPage([radio(0, AUTH_Q, 'Authorized without restriction'), radio(1, AUTH_Q, 'Authorized with a time limit')]);
  const report = await fillForm(page, { workAuthorized: 'No' });
  assert.deepEqual(page.actions.filter(([a]) => a === 'check'), []);
  assert.deepEqual(report.questions.map((q) => q.options), [['Authorized without restriction', 'Authorized with a time limit']]);
});

test('EEO: declines by default, self identifies only from the user values', async () => {
  const fields = () => [
    select(0, 'Race / Ethnicity', RACE),
    combo(1, 'Veteran Status', VETERAN),
    radio(2, 'Disability Status', DISABILITY[0]), radio(3, 'Disability Status', DISABILITY[1]), radio(4, 'Disability Status', DISABILITY[2]),
    select(5, 'Gender', ['Male', 'Female', 'Decline To Self Identify']),
  ];
  const values = { race: 'Two or More Races', veteran: 'No', disability: 'No' };

  // not opted in: values on file are not used
  let page = scriptedPage(fields());
  await fillForm(page, { eeoSelfIdentify: false, eeoValues: values });
  assert.deepEqual(page.actions.filter(([a]) => a !== 'click'), [
    ['select', 0, 'Decline To Self Identify'], ['pick', "I don't wish to answer"], ['select', 5, 'Decline To Self Identify'],
  ]);

  // opted in: each question gets the user's own value; gender has none, so it declines
  page = scriptedPage(fields());
  await fillForm(page, { eeoSelfIdentify: true, eeoValues: values });
  assert.deepEqual(page.actions.filter(([a]) => a !== 'click'), [
    ['select', 0, 'Two or More Races'], ['pick', VETERAN[0]], ['check', 3], ['select', 5, 'Decline To Self Identify'],
  ]);
});

test('contact fields: a blank value is reported, a native select never takes its placeholder', async () => {
  const page = scriptedPage([
    text(0, 'First Name'),
    select(1, 'Country', ['', 'Canada', 'United States', 'Mexico']),
    select(2, 'Highest degree', ['Select one', 'High School', "Bachelor's Degree", "Master's Degree"]),
    select(3, 'How did you hear about us?', ['Select', 'Job board', 'Referral from a colleague', 'Other']),
  ]);
  const report = await fillForm(page, { firstName: 'Priya', country: '', degree: 'B.S. Nursing', howHeard: 'Referral from a colleague' });
  assert.deepEqual(page.actions.filter(([a]) => a === 'select'), [['select', 2, "Bachelor's Degree"], ['select', 3, 'Referral from a colleague']]);
  assert.deepEqual(page.actions.filter(([a]) => a === 'type'), [['type', 0, 'Priya']]);
  assert.deepEqual(report.unfilled, [{ label: 'Country', reason: 'no value for country' }]);
});

test('a postal code field takes the value on file and is reported when there is none', async () => {
  let page = scriptedPage([text(0, 'Postal Code'), text(1, 'Zip')]);
  let report = await fillForm(page, { postalCode: 'K1A 0B1' });
  assert.deepEqual(page.actions.filter(([a]) => a === 'type'), [['type', 0, 'K1A 0B1'], ['type', 1, 'K1A 0B1']]);
  assert.deepEqual(report.unfilled, []);

  page = scriptedPage([text(0, 'Postcode')]);
  report = await fillForm(page, { postalCode: '', city: 'Leeds' });
  assert.deepEqual(page.actions.filter(([a]) => a === 'type'), []);
  assert.deepEqual(report.unfilled, [{ label: 'Postcode', reason: 'no value for postalCode' }]);
});

test('file inputs: resume first, cover letter into the unlabelled second slot, never a portfolio slot', async () => {
  const file = (idx, label) => ({ idx, tag: 'input', type: 'file', name: '', required: false, label, option: null, options: null });
  const answers = { resumeDocx: '/tmp/resume.pdf', coverLetterDocx: '/tmp/cover.docx' };
  let page = scriptedPage([file(0, 'Autofill from resume'), file(1, 'Resume/CV'), file(2, '')]);
  let report = await fillForm(page, answers);
  assert.deepEqual(page.actions, [['upload', 1, '/tmp/resume.pdf'], ['upload', 2, '/tmp/cover.docx']]);
  assert.equal(report.resumeUploaded, true);

  page = scriptedPage([file(0, 'Resume'), file(1, 'Portfolio or work sample')]);
  report = await fillForm(page, answers);
  assert.deepEqual(page.actions, [['upload', 0, '/tmp/resume.pdf']]);

  page = scriptedPage([file(0, 'Resume'), file(1, 'Cover Letter')]);
  await fillForm(page, answers, { skipResume: true });
  assert.deepEqual(page.actions, []);
});

test('fillQuestions: text sent for a choice widget is applied as the option; a non array is a no-op', async () => {
  const page = scriptedPage([
    select(0, 'How did you hear about this role?', ['Select', 'Job board', 'Company website']),
    radio(1, 'Are you based in the region?', 'Yes'), radio(2, 'Are you based in the region?', 'No'),
    { idx: 3, tag: 'textarea', type: 'textarea', name: '', required: true, label: 'Why this clinic?', option: null, options: null },
  ]);
  const done = await fillQuestions(page, [
    { label: 'How did you hear about this role?', text: 'Company website' },
    { label: 'Are you based in the region?', text: 'No' },
    { label: 'Why this clinic?', text: 'Its night shift ratios match how I practice.' },
    { label: 'A question that is not on the form', text: 'x' },
  ]);
  assert.deepEqual(done.map((d) => d.ok), [true, true, true, false]);
  assert.deepEqual(page.actions, [
    ['select', 0, 'Company website'], ['check', 2], ['fill', 3, 'Its night shift ratios match how I practice.'],
  ]);
  assert.deepEqual(await fillQuestions(page, {}), []);
  assert.deepEqual(await fillQuestions(page, undefined), []);
});
