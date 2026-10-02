'use strict';
// lib/posting.js: schema fields added for verification, dedup key stability
// (independent of the user's render preference for hyphens), and country
// handling through lib/profile.countryOk. Synthetic fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The user keeps hyphens in rendered documents. Posting text must not follow
// that preference, or dedup keys would differ from one user to the next.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-discovery-posting-'));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'profile.json'), JSON.stringify({ output: { stripHyphens: false, asciiOnly: false } }));
process.env.JOBE_USER_ROOT = root;

const { createPosting, dedupKey, textClean, companySlug, parseLocation, stripHtml, US_STATE_NAMES } = require('../lib/posting');
const { dedup, place, reportSlug } = require('../lib/dedup');
const { countryOk } = require('../lib/profile');

const make = (raw) => createPosting({ url: 'https://example.org/jobs/1', ...raw }, 'test-source');

test('createPosting carries hqLocation and remoteVerified', () => {
  const bare = make({ title: 'Registered Nurse', company: 'Mercy West Health', location: 'Remote' });
  assert.equal(bare.hqLocation, null);
  assert.equal(bare.remoteVerified, false);

  const p = make({ title: 'Tax Accountant', company: 'Harbor Tax Partners', location: 'Remote', hqLocation: '  Austin,  TX ', remoteVerified: true });
  assert.equal(p.hqLocation, 'Austin, TX');
  assert.equal(p.remoteVerified, true);
  assert.equal(p.remote, 'remote');

  // Only a literal true counts: discovery may assert, only verification confirms.
  assert.equal(make({ title: 'Tax Accountant', company: 'Harbor Tax Partners', remoteVerified: 'true' }).remoteVerified, false);
  assert.equal(make({ title: '', company: 'Harbor Tax Partners' }), null);
});

test('dedup keys are stable and ignore the hyphen render preference', () => {
  // Expected values were produced by the hyphen stripping text cleaner that
  // every existing dedup key was built with.
  assert.equal(dedupKey({ company: 'Mercy-West Health, Inc.', title: 'Sr. Registered Nurse - ICU (Night-Shift)' }), '5e3ad2ca86e107ae');
  assert.equal(dedupKey({ company: 'Ledger & Finch LLP', title: 'Senior Tax Accountant \u2013 Corporate' }), '398578deff6d4e47');
  assert.equal(dedupKey({ company: 'Harbor - Tax Partners', title: 'Tax Accountant' }), 'a96817fdb9117f64');
  assert.equal(companySlug('Harbor - Tax Partners'), 'harbor-and-tax-partners');
  assert.equal(textClean('Sr. Registered Nurse - ICU (Night-Shift)'), 'Sr. Registered Nurse, ICU (Night Shift)');
  assert.equal(parseLocation('Austin, TX - On-Site').raw, 'Austin, TX, On Site');
  // Nor the ASCII render preference: posting text is always folded, and a
  // symbol is dropped exactly as before (never written out), so keys hold.
  assert.equal(textClean('Stra\u00dfe 5, K\u00f6ln'), 'Strasse 5, Koln');
  assert.equal(textClean('Infirmi\u00e8re dipl\u00f4m\u00e9e \u2013 Montr\u00e9al'), 'Infirmiere diplomee, Montreal');
  assert.equal(textClean('10\u00d7 \u22655 \u00b5g \u00b12 \u00b0C'), '10 5 g 2 C');
  assert.equal(dedupKey({ company: 'Cl\u00ednica K\u00f6ln GmbH', title: 'Pflegefachkraft \u2013 Intensivstation' }), dedupKey({ company: 'Clinica Koln GmbH', title: 'Pflegefachkraft, Intensivstation' }));
});

test('stripHtml removes markup before the ASCII cleanup, plain or entity encoded', () => {
  assert.equal(
    stripHtml('<p>Assess patients &amp; plan care.</p><ul><li>BSN required</li><li>3+ years</li></ul><script>if (a < b) {}</script>'),
    'Assess patients & plan care.\nBSN required\n3+ years',
  );
  assert.equal(
    stripHtml('&lt;p&gt;Prepare returns &amp;amp; reconcile ledgers.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;CPA preferred&lt;/li&gt;&lt;/ul&gt;'),
    'Prepare returns & reconcile ledgers.\nCPA preferred',
  );
  assert.equal(stripHtml('Line one<br/>Line two &#8217;quoted&#8217;'), "Line one\nLine two 'quoted'");
  // A literal comparison sign in prose is text, and is spelled out.
  assert.equal(stripHtml('Response time &lt; 5 minutes.'), 'Response time less than 5 minutes.');
  assert.equal(stripHtml(null), '');
});

test('one req listed in several locations shares a dedup key', () => {
  const a = make({ title: 'Charge Nurse', company: 'Mercy West Health', location: 'Austin, TX' });
  const b = make({ title: 'Charge Nurse', company: 'Mercy West Health', location: 'Dallas, TX', url: 'https://example.org/jobs/2' });
  assert.equal(a.dedupKey, b.dedupKey);
  assert.notEqual(a.dedupKey, make({ title: 'Staff Nurse', company: 'Mercy West Health' }).dedupKey);
});

test('dedup: one req in several cities collapses by default and stays apart when the city matters', () => {
  const rows = (pairs) => pairs.map(([location, id]) => make({
    title: 'Charge Nurse, Medical Surgical Unit', company: 'Mercy West Health', location, url: `https://example.org/jobs/c${id}`,
  }));
  const cities = rows([['Austin, TX', 1], ['Dallas, TX', 2]]);
  assert.equal(dedup(cities).length, 1, 'remote only reading: one req');
  assert.deepEqual(dedup(cities, { byLocation: true }).map((p) => p.location).sort(), ['Austin, TX', 'Dallas, TX']);
  // The same city written two ways by two sources is still one row.
  const sameCity = rows([['Toronto, ON', 3], ['Toronto, Ontario, Canada', 4]]);
  assert.equal(dedup(sameCity).length, 1);
  assert.equal(dedup(sameCity, { byLocation: true }).length, 1);
  assert.equal(place({ location: 'Toronto, Ontario, Canada' }), 'toronto');
  const ledgers = ['Leeds, England', 'Bristol, England'].map((location, i) => make({
    title: 'Senior Tax Accountant, Partnerships', company: 'Ledger and Finch', location, url: `https://example.org/jobs/t${i}`,
  }));
  assert.equal(dedup(ledgers, { byLocation: true }).length, 2);
});

test('dedup by location: every remote or country only wording is one posting; only real cities split', () => {
  const rows = (title, company, locations) => locations.map((location, i) => make({
    title, company, location, url: `https://example.org/jobs/${company.length}-${title.length}-${i}`,
  }));
  const count = (list) => dedup(list, { byLocation: true }).length;
  // One remote job seen by five sources.
  assert.equal(count(rows('Senior Tax Accountant, Partnerships', 'Ledger and Finch',
    ['Remote - US', 'United States (Remote)', 'Remote, USA', 'Remote (US)', 'US-Remote', 'Remote', '', 'United States', 'New York, New York (Remote)'])), 1);
  // The same, plus one card that shows a real city.
  assert.equal(count(rows('Registered Nurse, Telehealth', 'Mercy West Health', ['Remote - US', 'Chicago, IL', '', 'Remote - USA Only', 'Remote'])), 2);
  // Two wordings of one other country are one row, and never merge with the US row.
  const split = dedup(rows('Tax Accountant, Corporate Returns', 'Harbor Tax Partners',
    ['United States (Remote)', 'Canada (Remote)', 'Remote, Canada', 'Canada', 'Germany (Remote)']), { byLocation: true });
  assert.deepEqual(split.map(place).sort(), ['ca', 'de', 'remote']);
  // Real cities stay apart, however the work mode is written around them.
  assert.equal(count(rows('Charge Nurse, Medical Surgical Unit', 'Mercy West Health', ['Hybrid - Austin, TX', 'Dallas, TX (Hybrid)', 'Austin, TX'])), 2);
  assert.equal(count(rows('Staff Nurse, Community Care', 'Lakeside Trust', ['UK, London (Hybrid)', 'Leeds, England, United Kingdom', 'Leeds, UK'])), 2);
  for (const [location, want] of [['Remote - US', 'remote'], ['', 'remote'], ['Hybrid - Austin, TX', 'austin'], ['Denver, CO (Hybrid)', 'denver'],
    ['USA - Austin, TX', 'austin'], ['Pune, Maharashtra, India', 'pune'], ['UK', 'gb']]) {
    assert.equal(place({ location }), want, location);
  }
  // A no city row naming a country the US classifier has no word for is that
  // country's row, not the US remote row; a state code is never the city.
  for (const [location, want] of [['Remote, Costa Rica', 'cr'], ['Costa Rica', 'cr'], ['Ghana (Remote)', 'gh'], ['Remote, Canada', 'ca'],
    ['Remote - US or Canada', 'remote'], ['In-Office: Austin', 'austin'], ['US, CA, Santa Clara', 'santa clara']]) {
    assert.equal(place({ location }), want, location);
  }
  const kept = (locations) => dedup(rows('Tax Accountant, Corporate Returns', 'Harbor Tax Partners', locations), { byLocation: true });
  // A US town or state whose name is also a country is a real place: it never
  // falls into the remote row or into another town's row.
  for (const [locations, want] of [[['Lebanon, NH', 'Remote - United States'], 2], [['Lebanon, NH', 'Jamaica, NY'], 2],
    [['Georgia, United States', 'New Jersey, United States'], 2], [['Lebanon, NH', 'Peru, IL', 'Cuba, MO', 'Mexico, MO', 'Georgia, United States'], 5],
    [['Lebanon, NH (Hybrid)', 'Jamaica, NY (Hybrid)', 'Hybrid'], 3], [['New Mexico', 'Remote'], 2], [['New York, NY (Remote)', 'Remote, US'], 1],
    // A remote row the classifier does not place in the US is never the US remote row.
    [['Remote (US)', 'Remote (CAN)'], 2], [['United States (Remote)', 'Hong Kong (Remote)'], 2], [['Remote - United States', 'Calgary (Remote)'], 2],
    [['Paris (Remote)', 'Pune (Remote)', 'Hong Kong (Remote)', 'Remote, US'], 4], [['Remote - US', 'North America (Remote)', 'Europe (Remote)'], 3]]) {
    const out = kept(locations);
    assert.equal(out.length, want, locations.join(' + '));
    assert.equal(new Set(out.map((p) => reportSlug(p))).size, want, `one slug per row: ${locations.join(' + ')}`);
  }
  for (const [location, want] of [['Lebanon, NH', 'lebanon'], ['Jamaica, NY', 'jamaica'], ['Georgia, United States', 'georgia'],
    ['New Jersey, United States', 'new jersey'], ['Calgary (Remote)', 'calgary'], ['Remote (CAN)', 'can'], ['Remote (US)', 'remote'],
    ['Lebanon, NH (Remote)', 'remote'], ['New York, New York (Remote)', 'remote']]) {
    assert.equal(place({ location }), want, location);
  }
  // Whichever row comes first, the Calgary row is still there for a Canada user.
  for (const locations of [['Remote - United States', 'Calgary (Remote)'], ['Calgary (Remote)', 'Remote - United States']]) {
    assert.ok(kept(locations).some((p) => countryOk(p.location, ['Canada'], p.title)), locations.join(' + '));
  }
  const costaRica = kept(['Remote - United States', 'Remote, Costa Rica']);
  assert.equal(costaRica.length, 2);
  assert.ok(costaRica.some((p) => countryOk(p.location, ['CR'])), 'the Costa Rica row survives for a Costa Rica user');
  // A hybrid row with no city never absorbs the remote row, or the reverse.
  assert.deepEqual(kept(['United States (Hybrid)', 'United States (Remote)']).map((p) => p.remote).sort(), ['hybrid', 'remote']);
  assert.deepEqual(kept(['Hybrid', 'Remote']).map((p) => p.remote).sort(), ['hybrid', 'remote']);
  assert.equal(kept(['United States (Hybrid)', 'Hybrid - US']).length, 1);
  assert.notEqual(place({ location: 'Canada (Hybrid)' }), place({ location: 'Canada (Remote)' }));
});

test('reportSlug: one folder per row, so two cities of one title never share one', () => {
  const rn = (location) => ({ company: 'Example Health', title: 'Registered Nurse', location });
  assert.equal(reportSlug(rn('Denver, CO')), 'example-health-registered-nurse-denver');
  assert.equal(reportSlug(rn('Boulder, CO')), 'example-health-registered-nurse-boulder');
  assert.equal(reportSlug(rn('Denver, Colorado, United States')), reportSlug(rn('Denver, CO')), 'the same city written two ways is one folder');
  // A remote only policy has one row per title, and a remote row has no city.
  assert.equal(reportSlug(rn('Denver, CO'), { remoteOnly: true }), 'example-health-registered-nurse');
  assert.equal(reportSlug(rn('Remote - US')), 'example-health-registered-nurse');
  assert.equal(reportSlug(rn('')), 'example-health-registered-nurse');
  assert.equal(reportSlug({ company: 'Ledger & Finch LLP', role: 'Senior Tax Accountant', location: 'Leeds, England' }), 'ledger-finch-llp-senior-tax-accountant-leeds');
  // Every row the dedup keeps apart gets its own slug.
  const kept = dedup(['Austin, TX', 'Dallas, TX', 'Remote - US', 'Canada (Remote)'].map((location, i) => make({
    title: 'Tax Accountant', company: 'Harbor Tax Partners', location, url: `https://example.org/jobs/s${i}`,
  })), { byLocation: true });
  assert.equal(new Set(kept.map((p) => reportSlug(p))).size, kept.length);
});

test('the US state name set is exported for the final list', () => {
  assert.equal(US_STATE_NAMES.has('new york'), true);
  assert.equal(US_STATE_NAMES.has('ontario'), false);
});

test('country handling on a posting location', () => {
  const toronto = make({ title: 'Tax Accountant', company: 'Harbor Tax Partners', location: 'Toronto, Canada' });
  assert.equal(toronto.us, false);
  assert.equal(countryOk(toronto.location, [], toronto.title), true, 'no country list keeps everything');
  assert.equal(countryOk(toronto.location, ['US'], toronto.title), false);
  assert.equal(countryOk(toronto.location, ['CA', 'Canada'], toronto.title), true);

  const austin = make({ title: 'Registered Nurse', company: 'Mercy West Health', location: 'Austin, TX' });
  assert.equal(austin.us, true);
  assert.equal(austin.remote, 'onsite');
  assert.equal(countryOk(austin.location, ['US'], austin.title), true);

  // The US state New Mexico is not the country Mexico.
  for (const loc of ['New Mexico', 'Remote - New Mexico', 'NEW MEXICO']) assert.notEqual(parseLocation(loc).us, false, loc);
  assert.equal(parseLocation('Albuquerque, New Mexico').us, true);
  // A work mode word after a comma is not a foreign region.
  for (const loc of ['GEORGIA - VIRTUAL - GA01', 'Denver, Onsite']) assert.notEqual(parseLocation(loc).us, false, loc);
  assert.equal(parseLocation('Pune, Maharashtra').us, false);
  for (const loc of ['Mexico', 'Remote - Mexico', 'Mexico City', 'Guadalajara, Mexico']) assert.equal(parseLocation(loc).us, false, loc);
  assert.notEqual(make({ title: 'Registered Nurse - New Mexico', company: 'Mercy West Health', location: 'Remote' }).us, false);
  assert.equal(make({ title: 'Registered Nurse - Mexico', company: 'Mercy West Health', location: 'Remote' }).us, false);

  const anywhere = make({ title: 'Registered Nurse', company: 'Mercy West Health', location: 'Remote' });
  assert.equal(countryOk(anywhere.location, ['CA'], anywhere.title), true, 'a location that names no place is kept');
});

test('home based, homeworking and telework wording reads as remote; a job done in homes does not', () => {
  const { classifyRemote } = require('../lib/posting');
  const { modePass, namesNoCity } = require('../lib/profile');
  for (const loc of ['Home Based, UK', 'Home Based - UK', 'Home Based, United Kingdom', 'Homeworking, England', 'UK (Home based)', 'Working from home, UK', 'Telework', 'Remote/Telework']) {
    const p = make({ title: 'Tax Accountant', company: 'Harbor Tax Partners', location: loc });
    assert.equal(p.remote, 'remote', loc);
    assert.equal(modePass(p, { remoteOnly: true }, false), true, `${loc}: kept at the listing stage for a remote only user`);
    assert.equal(modePass(p, { remoteOnly: true }, true), true, `${loc}: kept at the strict stage`);
    assert.equal(namesNoCity(p.location), true, loc);
    assert.equal(place(p), place(make({ title: 'Tax Accountant', company: 'Harbor Tax Partners', location: /UK|England|Kingdom/.test(loc) ? 'Remote, United Kingdom' : 'Remote' })), `${loc}: one place with the plain remote wording`);
  }
  for (const loc of ['Leeds, UK', 'Homebase Store, Leeds', 'Nursing Home, Leeds', 'Washington, DC (Telework eligible)',
    // Telework or home based wording beside a duty station is an office job.
    'Partial Telework, Arlington, VA', 'Situational Telework, Fort Meade, MD', 'Washington, DC, Telework permitted',
    'Washington, DC, Telework 2 days per week', 'Ad hoc telework, Ogden, UT', 'Washington, DC (Telework)',
    'Home Based Primary Care, Denver, CO', 'Home-Based Care - Leeds']) {
    assert.equal(parseLocation(loc).remote, 'onsite', loc);
  }
  for (const loc of ['Partial Telework', 'Telework permitted']) {
    assert.equal(parseLocation(loc).remote, 'unknown', loc);
  }
  for (const loc of ['Telework, United States', 'Home based - Worldwide', 'Home Based (United Kingdom)']) {
    assert.equal(parseLocation(loc).remote, 'remote', loc);
  }
  // Title: only a closing tag, never part of the job itself.
  for (const title of ['Tax Accountant (Home Based)', 'Tax Accountant - Home Based', 'Tax Accountant - Home Based, UK', 'Registered Nurse (Telework)', 'Nurse Advisor (Working from Home)']) {
    assert.equal(make({ title, company: 'Harbor Tax Partners', location: '' }).remote, 'remote', title);
  }
  for (const title of ['Home Based Therapist', 'Home-Based Primary Care Nurse Practitioner', 'Registered Nurse - Home Based Primary Care', 'Care Home Based Support Worker', 'Telework Coordinator']) {
    assert.equal(make({ title, company: 'Mercy West Health', location: '' }).remote, 'unknown', title);
  }
  // A city in the location is never flipped by the title.
  assert.equal(make({ title: 'Tax Accountant (Home Based)', company: 'Harbor Tax Partners', location: 'Leeds, England' }).remote, 'onsite');
  // JD text: strict phrases only.
  for (const jd of ['This is a home based role.', 'Homeworking contract, 37 hours.', 'The position is fully home-based.', 'This is a telework position.', 'This role is home based.', 'The position is home based with quarterly office days.', 'This role is home based in the North West, and you will travel.', 'This position is telework.', 'This role is home based (UK).', 'This role is home based\nSalary: 30,000']) {
    assert.equal(classifyRemote('unknown', 'Tax Accountant', jd), 'remote', jd);
  }
  for (const jd of ['As a home-based therapist you visit clients.', 'This position is telework eligible.', 'Situational telework available.',
    'Our home based care team visits patients. The position is home based care coordinator.',
    'You will provide home-based nursing. This role is home based nursing in the community.']) {
    assert.equal(classifyRemote('unknown', 'Registered Nurse', jd), 'unknown', jd);
  }
});

test('reportSlug: names in any script give a stable non empty slug, and a raw name matches its stored form', () => {
  const stored = make({ title: 'Registered Nurse', company: 'Klinikum Beispiel S\u00fcd', location: 'M\u00fcnchen' });
  assert.equal(reportSlug(stored), 'klinikum-beispiel-sud-registered-nurse-munchen');
  assert.equal(reportSlug({ company: 'Klinikum Beispiel S\u00fcd', title: 'Registered Nurse', location: 'M\u00fcnchen' }), reportSlug(stored), 'read off the page or stored: one folder');
  assert.equal(reportSlug({ company: 'Soci\u00e9t\u00e9 Exemple', title: 'Infirmi\u00e8re', location: 'Montr\u00e9al, QC' }), 'societe-exemple-infirmiere-montreal');
  const ja = (title) => reportSlug({ company: 'Acme Health', title, location: '\u6771\u4eac' });
  assert.notEqual(ja('\u770b\u8b77\u5e2b'), ja('\u533b\u5e2b'), 'two titles in another script never share a folder');
  assert.equal(ja('\u770b\u8b77\u5e2b'), ja('\u770b\u8b77\u5e2b'), 'deterministic');
  const mixed = (title) => reportSlug({ company: 'Ledger and Finch', title });
  assert.notEqual(mixed('Tax\u30a2\u30ca\u30ea\u30b9\u30c8'), mixed('Tax\u30de\u30cd\u30fc\u30b8\u30e3\u30fc'), 'a shared Latin token does not merge two titles');
  for (const args of [{ company: '\u6771\u4eac\u75c5\u9662', title: '\u770b\u8b77\u5e2b', location: '\u6771\u4eac' }, { company: '\u0391\u03b8\u03ae\u03bd\u03b1 \u039a\u03bb\u03b9\u03bd\u03b9\u03ba\u03ae', title: '\u039d\u03bf\u03c3\u03b7\u03bb\u03b5\u03c5\u03c4\u03ae\u03c2' }]) {
    assert.match(reportSlug(args), /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(reportSlug({ ...args, company: `${args.company} ` }), reportSlug(args), 'stray spaces do not change it');
  }
  // ASCII names are unchanged.
  assert.equal(reportSlug({ company: 'Coca-Cola', title: 'Step-Down RN (Nights)', location: 'Remote' }), 'coca-cola-step-down-rn-nights');
});
