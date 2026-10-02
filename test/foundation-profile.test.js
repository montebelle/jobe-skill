'use strict';
// lib/profile.js: defaults, merge, malformed file, discoveryFilters mapping,
// titlePolicy, countryOk. Synthetic fixtures only (a registered nurse and a
// tax accountant), isolated through JOBE_USER_ROOT temp directories.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function workspace(profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-foundation-profile-'));
  if (profile !== undefined) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'data', 'profile.json'),
      typeof profile === 'string' ? profile : JSON.stringify(profile),
    );
  }
  return root;
}

process.env.JOBE_USER_ROOT = workspace();
const { DEFAULTS, loadProfile, discoveryFilters, titlePolicy, countryOk, regionOk, acceptedModes, modePass, recencyDays, withinAge, pageSetup } = require('../lib/profile');

const NURSE = {
  $comment: 'synthetic registered nurse',
  candidate: { yearsExperience: 6, degrees: ['BSN'] },
  discovery: {
    $comment: 'ignored note',
    workModes: ['onsite', 'hybrid'],
    countries: ['US'],
    titleExclude: ['travel', 'per diem', 'intern'],
    titleKeep: ['travel coordinator'],
  },
  skills: { levels: { 'wound care': 1, $comment: 'not a skill' } },
};

const ACCOUNTANT = {
  discovery: {
    workModes: ['Remote'],
    countries: ['CA'],
    maxAgeDays: 21,
    salaryFloor: 90000,
    salaryCurrency: 'cad',
    excludeStaffing: false,
    titleExclude: ['sr.'],
  },
  output: { forbiddenTerms: ['Project Ledgerline'], targetPages: 1 },
};

function captureWarnings(fn) {
  const original = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(' '));
  try { fn(); } finally { console.warn = original; }
  return seen;
}

test('missing file yields the permissive defaults, silently', () => {
  const warnings = captureWarnings(() => {
    const p = loadProfile();
    assert.deepEqual(p, DEFAULTS);
    assert.notEqual(p, DEFAULTS);
    assert.notEqual(p.discovery, DEFAULTS.discovery);
  });
  assert.equal(warnings.length, 0);
  assert.deepEqual(discoveryFilters(loadProfile()), {
    remoteOnly: false,
    usOnly: false,
    countries: [],
    regions: [],
    workModes: [],
    maxAgeDays: 30,
    seniorityExtensionDays: 0,
    salaryFloor: null,
    salaryCurrency: 'USD',
    excludeStaffing: true,
    minScore: null,
  });
  assert.deepEqual(titlePolicy(loadProfile()), { exclude: null, keep: null });
});

test('root defaults to the JOBE_USER_ROOT workspace', () => {
  const previous = process.env.JOBE_USER_ROOT;
  process.env.JOBE_USER_ROOT = workspace(NURSE);
  try {
    assert.equal(loadProfile().candidate.yearsExperience, 6);
  } finally {
    process.env.JOBE_USER_ROOT = previous;
  }
});

test('user values deep merge over the defaults', () => {
  const nurse = loadProfile({ root: workspace(NURSE) });
  assert.deepEqual(nurse.candidate, { yearsExperience: 6, degrees: ['BSN'], clearance: null });
  assert.deepEqual(nurse.discovery.workModes, ['onsite', 'hybrid']);
  assert.equal(nurse.discovery.maxAgeDays, 30);
  assert.equal(nurse.discovery.excludeStaffing, true);
  assert.deepEqual(nurse.output, DEFAULTS.output);
  assert.deepEqual(nurse.evidence, DEFAULTS.evidence);
  // "$" keys are notes, never data.
  assert.equal('$comment' in nurse, false);
  assert.equal('$comment' in nurse.discovery, false);
  assert.deepEqual(nurse.skills.levels, { 'wound care': 1 });

  const accountant = loadProfile({ root: workspace(ACCOUNTANT) });
  assert.equal(accountant.discovery.maxAgeDays, 21);
  assert.deepEqual(accountant.output, { forbiddenTerms: ['Project Ledgerline'], targetPages: 1, stripHyphens: false, asciiOnly: false, pageSize: null, dateLocale: null });
  assert.deepEqual(accountant.candidate, DEFAULTS.candidate);

  // The shipped defaults are never mutated by a merge.
  assert.deepEqual(DEFAULTS.discovery.workModes, []);
  assert.deepEqual(DEFAULTS.output.forbiddenTerms, []);
});

test('a value of the wrong kind is ignored instead of breaking readers', () => {
  const p = loadProfile({ root: workspace({ discovery: { workModes: 'remote', maxAgeDays: 'soon' }, output: [] }) });
  assert.deepEqual(p.discovery.workModes, []);
  assert.deepEqual(p.output, DEFAULTS.output);
  assert.equal(discoveryFilters(p).maxAgeDays, 30);
});

test('malformed JSON never throws, warns once, and yields defaults', () => {
  for (const body of ['{ "discovery": { "workModes": [', '["not", "an", "object"]']) {
    const root = workspace(body);
    const warnings = captureWarnings(() => {
      assert.deepEqual(loadProfile({ root }), DEFAULTS);
      assert.deepEqual(loadProfile({ root }), DEFAULTS);
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /profile\.json/);
  }
});

test('the profile is cached per root', () => {
  const root = workspace(NURSE);
  const first = loadProfile({ root });
  fs.writeFileSync(path.join(root, 'data', 'profile.json'), JSON.stringify(ACCOUNTANT));
  assert.equal(loadProfile({ root }), first);
  assert.notEqual(loadProfile({ root: workspace(NURSE) }), first);
});

test('discoveryFilters maps work modes and countries onto the collector flags', () => {
  const nurse = discoveryFilters(loadProfile({ root: workspace(NURSE) }));
  assert.equal(nurse.remoteOnly, false);
  assert.equal(nurse.usOnly, true);
  assert.deepEqual(nurse.workModes, ['onsite', 'hybrid']);
  assert.deepEqual(nurse.countries, ['US']);

  const accountant = discoveryFilters(loadProfile({ root: workspace(ACCOUNTANT) }));
  assert.equal(accountant.remoteOnly, true);
  assert.equal(accountant.usOnly, false);
  assert.deepEqual(accountant.workModes, ['remote']);
  assert.deepEqual(accountant.countries, ['CA']);
  assert.equal(accountant.maxAgeDays, 21);
  assert.equal(accountant.salaryFloor, 90000);
  assert.equal(accountant.salaryCurrency, 'CAD');
  assert.equal(accountant.excludeStaffing, false);

  // Exactly one entry is required for either flag.
  assert.equal(discoveryFilters({ discovery: { workModes: ['remote', 'hybrid'] } }).remoteOnly, false);
  assert.equal(discoveryFilters({ discovery: { countries: ['US', 'CA'] } }).usOnly, false);
  assert.equal(discoveryFilters({ discovery: { countries: ['usa'] } }).usOnly, true);
  assert.equal(discoveryFilters({ discovery: { countries: ['United States'] } }).usOnly, true);
  // Safe with nothing at all.
  assert.equal(discoveryFilters().remoteOnly, false);
  assert.equal(discoveryFilters({}).maxAgeDays, 30);
  // A command line flag beats the profile.
  assert.equal({ ...accountant, ...{ maxAgeDays: 7 } }.maxAgeDays, 7);
});

test('titlePolicy compiles whole phrase, case insensitive patterns', () => {
  const nurse = titlePolicy(loadProfile({ root: workspace(NURSE) }));
  assert.ok(nurse.exclude.test('Travel Nurse RN'));
  assert.ok(nurse.exclude.test('Registered Nurse (PER  DIEM)'));
  assert.ok(nurse.keep.test('Travel Coordinator, Nursing'));
  assert.equal(nurse.exclude.test('Registered Nurse, Medical Surgical'), false);
  // Whole words only: "intern" must not drop "Internal".
  assert.equal(nurse.exclude.test('Internal Float Pool Nurse'), false);
  assert.equal(nurse.keep.test('Travel Nurse RN'), false);

  const accountant = titlePolicy(loadProfile({ root: workspace(ACCOUNTANT) }));
  assert.ok(accountant.exclude.test('Sr. Tax Accountant'));
  assert.equal(accountant.exclude.test('Tax Accountant'), false);
  assert.equal(accountant.keep, null);
  assert.deepEqual(titlePolicy(), { exclude: null, keep: null });
});

test('countryOk: no list keeps all, US uses the classifier, others match by name or code', () => {
  assert.equal(countryOk('Lyon, France', []), true);
  assert.equal(countryOk('Lyon, France', undefined), true);

  assert.equal(countryOk('Austin, TX', ['US']), true);
  assert.equal(countryOk('Berlin, Germany', ['US']), false);
  assert.equal(countryOk('', ['US']), true);
  assert.equal(countryOk('Remote', ['US']), true);
  assert.equal(countryOk(null, ['CA']), true);

  assert.equal(countryOk('Toronto, Canada', ['CA']), true);
  assert.equal(countryOk('Lyon, France', ['CA']), false);
  assert.equal(countryOk('Berlin, Germany', ['Germany']), true);
  assert.equal(countryOk('Remote', ['Germany']), true);

  assert.equal(countryOk('Toronto, Canada', ['US', 'CA']), true);
  assert.equal(countryOk('Austin, TX', ['US', 'CA']), true);
  assert.equal(countryOk('Lyon, France', ['US', 'CA']), false);
});

test('countryOk: a place it cannot put in a country is kept; only a named other country drops', () => {
  const CA = ['CA', 'Canada'];
  for (const loc of ['Toronto, ON', 'Toronto, Ontario', 'Toronto', 'Vancouver, BC', 'Vancouver, CAN', 'Toronto General Hospital', 'Remote - Canada']) {
    assert.equal(countryOk(loc, CA), true, loc);
  }
  for (const loc of ['Austin, TX', 'Seattle, Washington', 'Lyon, France', 'London, UK', 'Bengaluru, India']) {
    assert.equal(countryOk(loc, CA), false, loc);
  }
  // Everyday names of a listed country, whether the entry is a code or a name.
  const GB = ['GB', 'United Kingdom'];
  for (const loc of ['Remote - UK', 'Remote (UK)', 'London, England (Remote)', 'Remote - Great Britain', 'London, UK', 'London']) {
    assert.equal(countryOk(loc, GB), true, loc);
  }
  assert.equal(countryOk('Leeds, UK', ['United Kingdom']), true, 'a name entry resolves to its code and aliases');
  assert.equal(countryOk('Dublin, Ireland', GB), false);
  assert.equal(countryOk('New York, NY', GB), false);
  assert.equal(countryOk('Berlin', ['DE', 'Germany']), true, 'a city alone is unknown');
  assert.equal(countryOk('Remote - European Union', ['DE']), true, 'a union is not another country');
  // A list that holds the US keeps its classifier verdict.
  assert.equal(countryOk('London, UK', ['US']), false);
});

test('countryOk: a list that mixes the US with other countries accepts each listed country in its city and region forms', () => {
  for (const list of [['US', 'Canada'], ['US', 'CA'], ['US', 'CA', 'Canada'], ['usa', 'Canada']]) {
    for (const loc of ['Toronto, ON', 'Toronto', 'Toronto, Ontario', 'Vancouver, BC', 'Montreal, QC', 'Calgary, Alberta', 'Mississauga, ON', 'Austin, TX', 'Remote - Canada']) {
      assert.equal(countryOk(loc, list), true, `${loc} for ${list}`);
    }
    for (const loc of ['London, UK', 'Lyon, France', 'Bengaluru, India']) assert.equal(countryOk(loc, list), false, `${loc} for ${list}`);
  }
  // A nurse who can work in the UK or Ireland, an accountant in Germany or Austria.
  assert.equal(countryOk('Leeds, England', ['GB', 'IE']), true);
  assert.equal(countryOk('Cork', ['GB', 'IE']), true);
  assert.equal(countryOk('Graz, Austria', ['DE', 'Austria']), true);
  assert.equal(countryOk('Austin, TX', ['DE', 'Austria']), false);
});

test('countryOk: a three letter country code after a comma drops the posting unless it can stand for a listed country', () => {
  for (const list of [['US', 'Canada'], ['Canada'], ['US', 'CA']]) {
    assert.equal(countryOk('Bengaluru, IND', list), false, `Bengaluru, IND for ${list}`);
    assert.equal(countryOk('Madrid, ESP', list), false, `Madrid, ESP for ${list}`);
    assert.equal(countryOk('Toronto, CAN', list), true, `Toronto, CAN for ${list}`);
  }
  assert.equal(countryOk('Toronto, CAN', ['US', 'CAN']), true);
  assert.equal(countryOk('London, GBR', ['UK']), true);
  assert.equal(countryOk('Munich, DEU', ['Germany']), true);
  assert.equal(countryOk('Munich, DEU', ['DE']), true);
  assert.equal(countryOk('Dublin, IRL', ['Ireland']), true);
  assert.equal(countryOk('Bengaluru, IND', ['US', 'India']), true);
  // A bare city the tables do not know is still unknown and kept.
  assert.equal(countryOk('Lyon', ['US', 'Canada']), true);
});

test('countryOk: a bare city the US classifier marks as foreign stands for its country', () => {
  for (const list of [['US', 'Canada'], ['Canada'], ['US', 'CA']]) {
    for (const loc of ['London', 'London (Hybrid)', 'Belgrade', 'Hyderabad', 'Buenos Aires (Remote)', 'Bangalore HQ', 'Budapest', 'Amsterdam', 'Stockholm', 'S\u00e3o Paulo']) {
      assert.equal(countryOk(loc, list), false, `${loc} for ${list}`);
    }
    // The listed country's own cities, and a namesake beside its region, stay.
    for (const loc of ['Toronto', 'Toronto (Remote)', 'Vancouver (Hybrid)', 'Montreal', 'Ottawa', 'London, ON', 'London, Ontario', 'Sydney, NS']) {
      assert.equal(countryOk(loc, list), true, `${loc} for ${list}`);
    }
  }
  // Same verdict as a US only list gives for the foreign city; US rows untouched.
  assert.equal(countryOk('London', ['US']), false);
  for (const loc of ['Athens, GA', 'Manchester, NH', 'Dublin, OH', 'New York, London, Chicago']) assert.equal(countryOk(loc, ['US', 'Canada']), true, loc);
  // A nurse open to the UK and Ireland, a tax accountant open to India.
  assert.equal(countryOk('London (Hybrid)', ['GB', 'IE']), true);
  assert.equal(countryOk('Dublin', ['UK', 'Ireland']), true);
  assert.equal(countryOk('Toronto', ['GB', 'IE']), false);
  assert.equal(countryOk('Hyderabad', ['India']), true);
  assert.equal(countryOk('Hyderabad', ['US', 'IN']), true);
  assert.equal(countryOk('Pune', ['US', 'Canada']), true, 'a city outside the table is unknown and kept');
});

test('countryOk: a country name inside a longer place name is not that country', () => {
  // The US state New Mexico is in the US.
  for (const loc of ['New Mexico', 'Remote - New Mexico', 'Albuquerque, New Mexico', 'Santa Fe, NM']) {
    assert.equal(countryOk(loc, ['US']), true, loc);
    assert.equal(countryOk(loc, ['US', 'CA']), true, loc);
    assert.equal(countryOk(loc, ['MX', 'Mexico']), false, loc);
  }
  for (const loc of ['Guadalajara, Mexico', 'Mexico City', 'Remote - Mexico']) {
    assert.equal(countryOk(loc, ['MX', 'Mexico']), true, loc);
    assert.equal(countryOk(loc, ['US']), false, loc);
  }
  assert.equal(countryOk('Newark, New Jersey', ['JE', 'Jersey']), false);
  assert.equal(countryOk('Sydney, New South Wales', ['GB', 'Wales']), false);
  assert.equal(countryOk('Sydney, New South Wales', ['AU', 'Australia']), true);
  assert.equal(countryOk('Cardiff, Wales', ['GB']), true);
  assert.equal(countryOk('Belfast, Northern Ireland', ['IE', 'Ireland']), false);
  assert.equal(countryOk('Belfast, Northern Ireland', ['GB']), true);
  assert.equal(countryOk('Juba, South Sudan', ['SD', 'Sudan']), false);
  assert.equal(countryOk('Indianapolis, Indiana', ['IN', 'India']), false);
  // An everyday alias as the entry resolves to the same country.
  assert.equal(countryOk('London, United Kingdom', ['UK']), true);
  assert.equal(countryOk('Seoul, Korea', ['GB']), false);
});

test('regionOk: an empty list is no gate; a named place must match; no place is kept', () => {
  assert.equal(regionOk('Miami, FL', []), true);
  assert.equal(regionOk('Miami, FL', undefined), true);
  assert.equal(regionOk('Denver, CO', ['Denver', 'Colorado']), true);
  assert.equal(regionOk('Boulder, Colorado', ['Denver', 'Colorado']), true);
  assert.equal(regionOk('Miami, FL', ['Denver', 'Colorado']), false);
  assert.equal(regionOk('Leeds, England', ['Leeds', 'Yorkshire']), true);
  assert.equal(regionOk('Leedston, England', ['Leeds']), false, 'whole phrase, not a substring');
  assert.equal(regionOk('', ['Denver']), true);
  assert.equal(regionOk('Hybrid', ['Denver']), true);
  assert.equal(regionOk('Greater Denver Area', ['Denver']), true, 'a city matches any posting that names it');
  assert.equal(regionOk('Montreal, QC', ['Montr\u00e9al']), true, 'accents do not matter');
  assert.deepEqual(discoveryFilters({ discovery: { regions: ['Denver', ' ', 7] } }).regions, ['Denver']);
});

test('regionOk: a region given by name matches its standard code, and the reverse', () => {
  // US states, Canadian provinces and territories, Australian states, UK nations.
  const byName = [
    [['Denver', 'Colorado'], ['Aurora, CO', 'Lakewood, CO, United States', 'Fort Collins, CO', 'Boulder, Colorado', 'Denver CO']],
    [['Toronto', 'Ontario'], ['Mississauga, ON', 'North York, ON, Canada', 'Ottawa, Ontario', 'London, ON']],
    [['Northwest Territories'], ['Yellowknife, NT']],
    [['New South Wales'], ['Sydney NSW', 'Newcastle, NSW, Australia']],
    [['Scotland'], ['Glasgow, SCT', 'Glasgow, Scotland, United Kingdom']],
  ];
  for (const [regions, locs] of byName) for (const loc of locs) assert.equal(regionOk(loc, regions), true, `${loc} for ${regions}`);
  const byCode = [
    [['CO'], ['Aurora, CO', 'Boulder, Colorado']],
    [['ON'], ['Mississauga, ON', 'Ottawa, Ontario']],
    [['on'], ['Ottawa, Ontario'], 'a code typed in lower case is still that code'],
    [['QLD'], ['Brisbane, Queensland']],
    [['WLS'], ['Cardiff, Wales']],
  ];
  for (const [regions, locs] of byCode) for (const loc of locs) assert.equal(regionOk(loc, regions), true, `${loc} for ${regions}`);
  // A code matches in capitals only, never as an ordinary word.
  assert.equal(regionOk('Miami, FL (On-site)', ['Toronto', 'Ontario']), false);
  assert.equal(regionOk('Miami, FL (On site)', ['ON']), false);
  assert.equal(regionOk('MIAMI, FL (ON SITE)', ['Ontario']), false);
  assert.equal(regionOk('Remote or Austin, TX', ['OR']), false);
  // The same letters under another country are not the region; with no country named the code is trusted.
  assert.equal(regionOk('Medellin, CO, Colombia', ['Denver', 'Colorado']), false);
  assert.equal(regionOk('Aurora, CO, United States', ['Denver', 'Colorado']), true);
  assert.equal(regionOk('Ottawa, ON, Canada', ['Ontario']), true);
  assert.equal(regionOk('Perth, WA, Australia', ['Washington']), false);
  assert.equal(regionOk('Bogota, CO', ['Colorado']), true);
  // A country is a place: a country only location does not name the region.
  assert.equal(regionOk('Canada', ['Toronto', 'Ontario']), false);
  assert.equal(regionOk('Based in Leeds', ['IN']), false);
  assert.equal(regionOk('Hybrid in Chicago, IL', ['Indiana']), false);
  assert.equal(regionOk('Acme Co, Miami, FL', ['Colorado']), false);
  assert.equal(regionOk('Dallas, TX', ['Denver', 'Colorado']), false);
  // Anywhere else a region matches by name only, so the user lists both forms.
  assert.equal(regionOk('Munich, BY', ['Bavaria']), false);
  assert.equal(regionOk('Munich, BY', ['Bavaria', 'BY']), true);
  assert.equal(regionOk('Stand by, Munich', ['Bavaria', 'BY']), false, 'an unlisted code is matched in capitals only');
});

test('modePass: nothing accepted means everything passes; unknown waits for the strict stage', () => {
  assert.deepEqual(acceptedModes({ remoteOnly: true, workModes: [] }), ['remote']);
  assert.deepEqual(acceptedModes({ remoteOnly: false, workModes: ['remote'] }), [], 'the short form switched off lifts the list');
  const nurse = { workModes: ['onsite', 'hybrid'] };
  const accountant = { workModes: ['remote', 'hybrid'] };
  assert.equal(modePass({ remote: 'remote' }, {}, true), true);
  assert.equal(modePass({ remote: 'remote' }, nurse, false), false);
  assert.equal(modePass({ remote: 'unknown' }, nurse, true), true, 'says nothing: read as onsite');
  assert.equal(modePass({ remote: 'unknown' }, accountant, false), true);
  assert.equal(modePass({ remote: 'unknown' }, accountant, true), false);
  assert.equal(modePass({ remote: 'onsite' }, accountant, true), false);
  assert.equal(modePass({ remote: 'hybrid' }, accountant, true), true);
  // A city only listing reads as onsite but states no mode: it waits for
  // enrichment unless the policy is remote only.
  assert.equal(modePass({ remote: 'onsite' }, accountant, false), true);
  assert.equal(modePass({ remote: 'onsite' }, { workModes: ['hybrid'] }, false), true);
  assert.equal(modePass({ remote: 'onsite' }, { remoteOnly: true, workModes: ['remote'] }, false), false);
  assert.equal(modePass({ remote: 'hybrid' }, { remoteOnly: true, workModes: ['remote'] }, false), false);
  assert.equal(modePass({ remote: 'unknown' }, { remoteOnly: true, workModes: ['remote'] }, false), true);
  assert.equal(modePass({ remote: 'remote' }, { workModes: ['hybrid'] }, false), false, 'a stated mode the user excluded still drops early');
});

test('recencyDays and withinAge: 0 is off for every reader, a missing value is the default', () => {
  assert.equal(recencyDays({ maxAgeDays: 0 }), null);
  assert.equal(recencyDays({ maxAgeDays: 14 }), 14);
  assert.equal(recencyDays({}), DEFAULTS.discovery.maxAgeDays);
  assert.equal(recencyDays(undefined), DEFAULTS.discovery.maxAgeDays);
  assert.equal(recencyDays({ maxAgeDays: NaN }), DEFAULTS.discovery.maxAgeDays);
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  assert.equal(withinAge(old, 30), false);
  assert.equal(withinAge(old, 90), true);
  assert.equal(withinAge(old, null), true, 'cut off: kept');
  assert.equal(withinAge('', null), true, 'cut off: an undated row is kept too');
  assert.equal(withinAge('', 30), false);
  assert.equal(withinAge('not a date', 30), false);
  assert.equal(withinAge(Date.now() - 86400000, 30), true, 'epoch milliseconds');
  assert.equal(withinAge(0, 30), false);
});

test('pageSetup: Letter for an empty list and for the countries that use it, A4 for every other list, or what the user says', () => {
  assert.deepEqual(pageSetup(loadProfile({ root: workspace({}) })), { pageSize: 'letter', dateLocale: 'en-US' });
  assert.deepEqual(pageSetup(undefined), { pageSize: 'letter', dateLocale: 'en-US' });
  assert.equal(pageSetup({ discovery: { countries: ['GB', 'United Kingdom'] } }).pageSize, 'a4');
  assert.equal(pageSetup({ discovery: { countries: ['CA', 'usa'] } }).pageSize, 'letter');
  assert.equal(pageSetup({ discovery: { countries: ['US'] } }).pageSize, 'letter');
  for (const list of [['CA', 'Canada'], ['Canada'], ['ca'], ['MX', 'Mexico'], ['Mexico'], ['Philippines'], ['CL'], ['Colombia'], ['CR'], ['DO'], ['GT'], ['PA'], ['VE'], ['GB', 'CA']]) {
    assert.equal(pageSetup({ discovery: { countries: list } }).pageSize, 'letter', String(list));
  }
  for (const list of [['DE'], ['Germany'], ['UK'], ['India'], ['IN'], ['AU', 'Australia'], ['Atlantis']]) {
    assert.equal(pageSetup({ discovery: { countries: list } }).pageSize, 'a4', String(list));
  }
  assert.deepEqual(
    pageSetup({ discovery: { countries: ['US'] }, output: { pageSize: 'A4', dateLocale: 'en-GB' } }),
    { pageSize: 'a4', dateLocale: 'en-GB' },
  );
  assert.equal(pageSetup({ discovery: { countries: ['DE'] }, output: { pageSize: 'Letter' } }).pageSize, 'letter');
  assert.equal(pageSetup({ output: { pageSize: 'tabloid' } }).pageSize, 'letter', 'an unknown size falls back');
});

test('titleExcluded: a keep phrase shields only its own words', () => {
  const { titlePolicy, titleExcluded } = require('../lib/profile');
  const policy = titlePolicy({ discovery: { titleExclude: ['manager', 'travel'], titleKeep: ['case manager'] } });
  assert.equal(titleExcluded('Nurse Case Manager', policy), false);
  assert.equal(titleExcluded('Travel Nurse Case Manager', policy), true);
  assert.equal(titleExcluded('Tax Manager', policy), true);
  assert.equal(titleExcluded('Tax Accountant', policy), false);
  assert.equal(titleExcluded('Tax Manager', titlePolicy({})), false);
});

test('title policy: accents and hyphens in a phrase match the title as postings store it', () => {
  const { titleExcluded } = require('../lib/profile');
  const policy = titlePolicy({ discovery: {
    titleExclude: ['b\u00e9n\u00e9vole', '\u00e9l\u00e8ve', 'Aushilfskr\u00e4fte', 'Fu\u00dfpfleger', 'part-time', 'co-op', 'sr.', 'travel'],
    titleKeep: ['travel coordinator'],
  } });
  // Stored (ASCII folded, hyphen free) titles and raw ones alike.
  for (const title of ['Infirmier benevole', 'Infirmier b\u00e9n\u00e9vole', 'Eleve infirmier', '\u00c9l\u00e8ve infirmier', 'Aushilfskrafte Pflege',
    'Fusspfleger', 'Nurse (Part Time)', 'Part-Time Bookkeeper', 'Co op Student', 'Co-op Student', 'Sr. Tax Accountant', 'Travel Nurse']) {
    assert.equal(titleExcluded(title, policy), true, title);
  }
  for (const title of ['Infirmier', 'Registered Nurse', 'Tax Accountant', 'Travel Coordinator', 'Coop Bank Teller', 'Department Nurse', 'Srinagar Clinic Nurse']) {
    assert.equal(titleExcluded(title, policy), false, title);
  }
  // A phrase in another script still matches a raw title in that script.
  const ja = titlePolicy({ discovery: { titleExclude: ['\u770b\u8b77\u52a9\u624b'] } });
  assert.equal(titleExcluded('\u770b\u8b77\u52a9\u624b \u6771\u4eac', ja), true);
  assert.equal(titleExcluded('Registered Nurse', ja), false);
});

test('countryOk: everyday country names are recognized beside the runtime display names', () => {
  const { isoOf } = require('../lib/profile');
  assert.equal(countryOk('Istanbul, Turkey', ['DE']), false);
  assert.equal(countryOk('Istanbul, Turkiye', ['DE']), false);
  assert.equal(countryOk('Istanbul, T\u00fcrkiye', ['TR']), true);
  assert.equal(countryOk('Istanbul, Turkey', ['TR']), true);
  assert.equal(countryOk('Izmir, Turkey', ['T\u00fcrkiye']), true);
  assert.equal(countryOk('Hong Kong', ['DE']), false);
  assert.equal(countryOk('Hong Kong, China', ['HK']), true);
  assert.equal(countryOk('Sarajevo, Bosnia and Herzegovina', ['DE']), false);
  assert.equal(countryOk('Yangon, Myanmar', ['DE']), false);
  assert.equal(countryOk('Abidjan, Ivory Coast', ['DE']), false);
  assert.equal(countryOk("Abidjan, Cote d'Ivoire", ['CI']), true);
  assert.equal(countryOk('Port of Spain, Trinidad and Tobago', ['TT']), true);
  assert.equal(countryOk('Port of Spain', ['TT']), true);
  assert.equal(countryOk('Port of Spain', ['ES']), false);
  assert.equal(countryOk('Madrid, Spain', ['ES']), true);
  // Unchanged neighbors.
  assert.equal(countryOk('Santa Fe, New Mexico', ['MX']), false);
  assert.equal(countryOk('Belfast, Northern Ireland', ['IE']), false);
  assert.equal(countryOk('Remote', ['TT']), true);
  assert.equal(isoOf('Turkey'), 'TR');
  assert.equal(isoOf('Trinidad and Tobago'), 'TT');
  assert.equal(isoOf('Port of Spain'), null);
});

test('regionOk: a region written with accents or special letters matches the stored ASCII form', () => {
  assert.equal(regionOk('Lodz, Poland', ['\u0141\u00f3d\u017a']), true);
  assert.equal(regionOk('Giessen', ['Gie\u00dfen']), true);
  assert.equal(regionOk('Tromso, Norway', ['Troms\u00f8']), true);
  assert.equal(regionOk('Montreal, QC', ['Qu\u00e9bec']), true);
  assert.equal(regionOk('Leeds, England', ['Gie\u00dfen']), false);
  // Home based and telework wording names no place, so the region gate keeps it.
  assert.equal(regionOk('Home Based', ['Leeds']), true);
  assert.equal(regionOk('Remote/Telework', ['Denver']), true);
  assert.equal(regionOk('Nursing Home, Leeds', ['Denver']), false);
});

test('seniorTitle: senior, sr, principal and lead; staff is an entry grade in some fields', () => {
  const { seniorTitle } = require('../lib/profile');
  for (const t of ['Senior Accountant', 'Sr. Accountant', 'Sr Staff Nurse', 'Principal Auditor', 'Lead Nurse']) assert.equal(seniorTitle(t), true, t);
  for (const t of ['Staff Nurse', 'Staff Accountant', 'Junior Staff Accountant', 'Registered Nurse', '', undefined]) assert.equal(seniorTitle(t), false, String(t));
});
