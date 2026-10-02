'use strict';
// lib/apply/answers.js: the answer map built from a report's resume JSON plus
// the optional apply profile, the report folder lookup across lifecycle
// buckets, and the pay band helpers. Every file lives in a JOBE_USER_ROOT temp
// workspace. Two synthetic candidates: a registered nurse and a tax accountant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const newRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-apply-answers-'));
process.env.JOBE_USER_ROOT = newRoot();
const { buildAnswers, findResumeJson, findResumeUpload, findDocx, fromBand, bandFromText } = require('../lib/apply/answers');

// answers.js resolves the workspace per call, so each test takes a fresh one.
function workspace() {
  const root = newRoot();
  process.env.JOBE_USER_ROOT = root;
  return root;
}
function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const NURSE = {
  name: 'Priya Raman',
  contact: { email: 'priya.raman@example.com', phone: '555-0101', location: 'Madison, WI', linkedin: 'linkedin.com/in/priya-raman-rn' },
  experience: [{ company: 'Lakeside Regional Hospital', title: 'Registered Nurse, Medical Surgical' }],
  education: [{ school: 'Prairie State College of Nursing', degree: 'B.S. Nursing', dates: '2011 - 2015' }],
  company: 'Northfield Clinic', role: 'Charge Nurse', postingUrl: 'https://jobs.example.org/northfield/1',
  coverLetter: 'Dear hiring team,', compensation: { min: 70000, max: 90000 },
};
const ACCOUNTANT = {
  name: 'Tomas Lindqvist',
  contact: { email: 'tomas.lindqvist@example.com', phone: '555-0102', location: 'Tucson, AZ', website: 'tomaslindqvist.example' },
  experience: [{ company: 'Harbor Ledger Tax Group', title: 'Senior Tax Accountant' }],
  education: [{ school: 'Mesa Verde University', degree: 'Master of Accountancy', dates: '2009' }],
  company: 'Copperline Advisors', role: 'Tax Manager',
};

const GATES = ['workAuthorized', 'requireSponsorship', 'citizen', 'citizenOrPermanentResident', 'domiciled', 'federalEligible', 'nonCompete', 'clearance', 'relocation'];

test('no report and no apply profile: every answer is blank and EEO declines', () => {
  workspace();
  const { answers, meta } = buildAnswers('northfield-charge-nurse');
  assert.equal(meta.hasReport, false);
  for (const k of GATES) assert.equal(answers[k], '', k);
  for (const k of ['fullName', 'firstName', 'lastName', 'email', 'phone', 'location', 'city', 'state', 'country', 'postalCode',
    'linkedin', 'github', 'website', 'currentCompany', 'currentTitle', 'school', 'degree', 'degreeLevel', 'gradYear', 'salaryExpectation']) {
    assert.equal(answers[k], '', k);
  }
  assert.equal(answers.eeoSelfIdentify, false);
  assert.deepEqual(answers.eeoValues, {});
  assert.equal(answers.salaryStrategy, 'midpoint');
  assert.equal(answers.resumeDocx, null);
  assert.equal(answers.coverLetterDocx, null);
});

test('identity comes from the resume JSON; the newest dated resume wins', () => {
  const root = workspace();
  const dir = 'reports/queue/northfield-charge-nurse';
  write(root, `${dir}/resume-2030-01-05-northfield-charge-nurse.json`, { ...NURSE, name: 'Old Draft' });
  write(root, `${dir}/resume-2030-02-11-northfield-charge-nurse.json`, NURSE);
  write(root, `${dir}/northfield-charge-nurse-resume.json`, { ...NURSE, name: 'Legacy Undated' });
  write(root, `${dir}/resume-2030-02-11.docx`, 'docx');
  write(root, `${dir}/cover-letter-2030-02-11.docx`, 'docx');

  assert.match(findResumeJson('northfield-charge-nurse'), /resume-2030-02-11-northfield-charge-nurse\.json$/);
  const { answers, meta } = buildAnswers('northfield-charge-nurse');
  assert.equal(answers.fullName, 'Priya Raman');
  assert.equal(answers.firstName, 'Priya');
  assert.equal(answers.lastName, 'Raman');
  assert.equal(answers.city, 'Madison');
  assert.equal(answers.state, ''); // no country on file: the region is not guessed
  assert.equal(answers.linkedin, 'https://linkedin.com/in/priya-raman-rn');
  assert.equal(answers.currentCompany, 'Lakeside Regional Hospital');
  assert.equal(answers.currentTitle, 'Registered Nurse, Medical Surgical');
  assert.equal(answers.degree, 'B.S. Nursing');
  assert.equal(answers.gradYear, '2015');
  assert.equal(answers.salaryExpectation, '80000'); // midpoint of the stored band
  assert.equal(answers.howHeard, 'Company careers page');
  assert.match(answers.resumeDocx, /resume-2030-02-11\.docx$/);
  assert.match(answers.coverLetterDocx, /cover-letter-2030-02-11\.docx$/);
  assert.deepEqual({ company: meta.company, role: meta.role, hasReport: meta.hasReport }, { company: 'Northfield Clinic', role: 'Charge Nurse', hasReport: true });
  // no apply profile on file: gates stay blank even with a full report
  for (const k of GATES) assert.equal(answers[k], '', k);

  // a PDF beats the DOCX as the upload
  write(root, `${dir}/resume-2030-02-11.pdf`, 'pdf');
  assert.match(findResumeUpload('northfield-charge-nurse'), /\.pdf$/);
  assert.match(findDocx('northfield-charge-nurse', 'resume'), /resume-2030-02-11\.docx$/);
});

test('the apply profile supplies gates, fallbacks, EEO opt in, and the salary strategy', () => {
  const root = workspace();
  write(root, 'reports/evaluate/copperline-tax-manager/resume-2030-03-02-copperline-tax-manager.json', { ...ACCOUNTANT, compensation: { min: 95000, max: 125000 } });
  write(root, 'data/apply-profile.json', {
    _README: 'ignored',
    workAuthorized: 'yes', requireSponsorship: false, citizen: 'No', citizenOrPermanentResident: true,
    domiciled: 'Y', federalEligible: 'n', nonCompete: false, clearance: '', relocation: 'YES',
    country: 'Canada', postalCode: 'K1A 0B1', stateName: 'Arizona', degreeLevel: 'Master', howHeard: 'A former colleague',
    salaryStrategy: 'TOP', salaryExpectation: 110000, locale: 'en-CA',
    eeoSelfIdentify: true, eeoValues: { gender: ['Man', 'Male'], veteran: 'No' },
  });
  const { answers } = buildAnswers('copperline-tax-manager');
  assert.deepEqual(GATES.map((k) => answers[k]), ['Yes', 'No', 'No', 'Yes', 'Yes', 'No', 'No', '', 'Yes']);
  assert.equal(answers.country, 'Canada');
  assert.equal(answers.postalCode, 'K1A 0B1');
  assert.equal(answers.zip, 'K1A 0B1');
  assert.equal(answers.state, ''); // the country on file is not the United States: no region is read off the location
  assert.equal(answers.stateName, 'Arizona');
  assert.equal(answers.degreeLevel, 'Master');
  assert.equal(answers.howHeard, 'A former colleague');
  assert.equal(answers.website, 'https://tomaslindqvist.example');
  assert.equal(answers.gradYear, '2009');
  assert.equal(answers.salaryStrategy, 'top');
  assert.equal(answers.salaryExpectation, '125000'); // top of the stored band beats the flat figure
  assert.equal(answers.eeoSelfIdentify, true);
  assert.deepEqual(answers.eeoValues, { gender: ['Man', 'Male'], veteran: 'No' });
});

test('identity fallbacks: the template names each one, the report value wins, the profile fills a gap', () => {
  const fallback = {
    fullName: 'Priya Raman', email: 'priya.raman@example.com', phone: '555-0101', location: 'Leeds, West Yorkshire',
    currentCompany: 'Lakeside Regional Hospital', currentTitle: 'Staff Nurse', school: 'Prairie State College of Nursing',
    degree: 'B.S. Nursing', gradYear: '2015',
  };
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'apply-profile.template.json'), 'utf8'));
  for (const k of Object.keys(fallback)) assert.ok(k in template || new RegExp(`\\b${k}\\b`).test(template._help_identity), `template does not name ${k}`);

  // a report with no contact, experience, or education: every value comes from the profile
  const root = workspace();
  write(root, 'reports/queue/northfield-charge-nurse/resume-2030-02-11-northfield-charge-nurse.json', { company: 'Northfield Clinic', role: 'Charge Nurse' });
  write(root, 'data/apply-profile.json', fallback);
  let { answers } = buildAnswers('northfield-charge-nurse');
  for (const [k, v] of Object.entries(fallback)) assert.equal(answers[k], v, k);
  assert.equal(answers.firstName, 'Priya');
  assert.equal(answers.city, 'Leeds');

  // a full report is never overridden by the fallbacks
  write(root, 'reports/queue/copperline-tax-manager/resume-2030-03-02-copperline-tax-manager.json', ACCOUNTANT);
  ({ answers } = buildAnswers('copperline-tax-manager'));
  assert.equal(answers.fullName, 'Tomas Lindqvist');
  assert.equal(answers.email, 'tomas.lindqvist@example.com');
  assert.equal(answers.currentCompany, 'Harbor Ledger Tax Group');
  assert.equal(answers.school, 'Mesa Verde University');
  assert.equal(answers.gradYear, '2009');
});

test('state: read off the location only for a United States location, else the profile value or blank', () => {
  const stateFor = (location, profile) => {
    const root = workspace();
    write(root, 'reports/queue/northfield-charge-nurse/resume-2030-02-11-northfield-charge-nurse.json', { ...NURSE, contact: { ...NURSE.contact, location } });
    if (profile) write(root, 'data/apply-profile.json', profile);
    return buildAnswers('northfield-charge-nurse').answers.state;
  };
  // the second part of a location is a country as often as a region, and a
  // country must never be typed into a state field
  for (const location of ['Leeds, UK', 'Berlin, Germany', 'Berlin, DE', 'London, England, United Kingdom', 'Toronto, ON', 'Sydney, NSW', 'Pune, IN', 'Lyon', '']) {
    assert.equal(stateFor(location), '', location);
    assert.equal(stateFor(location, { country: 'Germany' }), '', location);
  }
  assert.equal(stateFor('Leeds, UK', { country: 'United Kingdom' }), '');
  assert.equal(stateFor('Leeds, United Kingdom', { country: 'United States' }), ''); // not a region code
  // a United States location: the profile country, or the location itself, says so
  for (const country of ['United States', 'USA', 'US', 'U.S.', 'United States of America']) {
    assert.equal(stateFor('Madison, WI', { country }), 'WI', country);
  }
  assert.equal(stateFor('Tucson, AZ, USA'), 'AZ');
  assert.equal(stateFor('Tucson, AZ, United States'), 'AZ');
  assert.equal(stateFor('Madison, WI'), ''); // nothing says which country
  // the region the user wrote down always wins, in any country
  assert.equal(stateFor('Toronto, ON', { state: 'ON', country: 'Canada' }), 'ON');
  assert.equal(stateFor('Leeds, UK', { state: 'West Yorkshire' }), 'West Yorkshire');
  assert.equal(stateFor('Madison, WI', { state: 'Wisconsin', country: 'United States' }), 'Wisconsin');
});

test('EEO values are dropped unless the user opted in; a flat salary is used without a band', () => {
  const root = workspace();
  write(root, 'reports/copperline-tax-manager/resume-2030-03-02-copperline-tax-manager.json', ACCOUNTANT);
  write(root, 'data/apply-profile.json', { eeoSelfIdentify: 'true', eeoValues: { gender: 'Man' }, salaryExpectation: '98000', salaryStrategy: 'median' });
  const { answers } = buildAnswers('copperline-tax-manager');
  assert.equal(answers.eeoSelfIdentify, false); // only a literal true opts in
  assert.deepEqual(answers.eeoValues, {});
  assert.equal(answers.salaryExpectation, '98000');
  assert.equal(answers.salaryStrategy, 'midpoint'); // unknown strategy
});

test('a stored pay band is used only when it is yearly and in the user\'s currency', () => {
  const run = (compensation, discovery) => {
    const root = workspace();
    write(root, 'reports/queue/northfield-charge-nurse/resume-2030-03-01-northfield-charge-nurse.json', { ...NURSE, compensation });
    write(root, 'data/apply-profile.json', { salaryExpectation: '95000' });
    if (discovery) write(root, 'data/profile.json', { version: 1, discovery });
    return buildAnswers('northfield-charge-nurse').answers.salaryExpectation;
  };
  // an hourly or monthly rate, or another currency, leaves the user's figure
  assert.equal(run({ min: 38, max: 54, currency: 'CAD', period: 'hour' }), '95000');
  assert.equal(run({ min: 38, max: 54, period: 'hour' }), '95000');
  assert.equal(run({ min: 38, max: 54 }), '95000'); // too small to be a yearly salary
  assert.equal(run({ min: 4200, max: 5100, currency: 'GBP', period: 'month' }), '95000');
  assert.equal(run({ min: 60000, max: 80000, currency: 'CAD', period: 'year' }), '95000');
  assert.equal(run('$38 - $54 an hour'), '95000');
  assert.equal(run(null), '95000');
  // a yearly band in the user's currency (or one that states neither) is used
  assert.equal(run({ min: 70000, max: 90000, currency: 'USD', period: 'year' }), '80000');
  assert.equal(run({ min: 70000, max: 90000, currency: 'usd', period: 'annual' }), '80000');
  assert.equal(run({ min: 70000, max: 90000 }), '80000');
  assert.equal(run({ min: 60000, max: 80000, currency: 'CAD', period: 'year' }, { salaryCurrency: 'CAD' }), '70000');
  assert.equal(run({ min: 70000, max: 90000, currency: 'USD' }, { salaryCurrency: 'GBP' }), '95000');
});

test('a malformed apply profile is the same as none', () => {
  const root = workspace();
  write(root, 'data/apply-profile.json', '{ "workAuthorized": "Yes", ');
  assert.equal(buildAnswers('anything').answers.workAuthorized, '');
  write(root, 'data/apply-profile.json', '["Yes"]');
  assert.equal(buildAnswers('anything').answers.workAuthorized, '');
});

test('the report folder is found in every lifecycle location', () => {
  const root = workspace();
  const places = {
    'flat-slug': 'reports/flat-slug',
    'verify-slug': 'reports/verify/verify-slug',
    'queue-slug': 'reports/queue/queue-slug',
    'manual-slug': 'reports/manual/manual-slug',
    'applied-slug': 'reports/applied/applied-slug',
    'skipped-slug': 'reports/skipped/skipped-slug',
    'legacy-slug': 'reports/needs-manual/legacy-slug',
    'archived-slug': 'reports/manual/archive/2030-01-20/archived-slug',
  };
  for (const [slug, dir] of Object.entries(places)) write(root, `${dir}/resume-2030-01-01-${slug}.json`, { ...NURSE, role: slug });
  // an older archive copy of the same slug must lose to the newer date
  write(root, 'reports/manual/archive/2030-01-02/archived-slug/resume-2030-01-01-archived-slug.json', { ...NURSE, role: 'stale' });
  for (const [slug, dir] of Object.entries(places)) {
    const { meta } = buildAnswers(slug);
    assert.equal(meta.role, slug, slug);
    assert.equal(path.dirname(meta.jsonPath), path.join(root, dir), slug);
  }
  assert.equal(findResumeJson('../data'), null);
  assert.equal(findResumeJson('queue'), null);
});

test('fromBand applies the salary strategy', () => {
  const band = { min: 80000, max: 100000 };
  assert.equal(fromBand(band), 90000);
  assert.equal(fromBand(band, 'midpoint'), 90000);
  assert.equal(fromBand(band, 'top'), 100000);
  assert.equal(fromBand(band, 'bottom'), 80000);
  assert.equal(fromBand(band, 'anything else'), 90000);
  assert.equal(fromBand({ max: 100000 }, 'bottom'), 100000);
  assert.equal(fromBand({ min: 80000 }, 'top'), 80000);
  assert.equal(fromBand(null, 'top'), null);
  assert.equal(fromBand({}, 'top'), null);
});

test('bandFromText reads a published yearly band and nothing else', () => {
  assert.deepEqual(bandFromText('The base salary range for this role is $72,000 - $91,500 per year.'), { min: 72000, max: 91500 });
  assert.deepEqual(bandFromText('Compensation: $95k \u2013 $120k plus benefits'), { min: 95000, max: 120000 });
  assert.deepEqual(bandFromText('Annual pay range: $68000 to $84000'), { min: 68000, max: 84000 });
  // several bands: the one with the highest top
  assert.deepEqual(bandFromText('Salary by level. Level I: $60,000 - $70,000 salary. Level II: $75,000 - $88,000 salary.'), { min: 75000, max: 88000 });
  assert.deepEqual(bandFromText('Salary: $90 - $120k'), { min: 90000, max: 120000 });
  assert.deepEqual(bandFromText('Salary: $45K - $60K'), { min: 45000, max: 60000 });
  assert.deepEqual(bandFromText('Salary $120,000 - $150,000 / year plus equity and bonus'), { min: 120000, max: 150000 });
  assert.deepEqual(bandFromText('Total compensation: $180,000 - $240,000 (base $150,000 - $190,000) annually'), { min: 180000, max: 240000 });
  // a yearly band next to a small monthly figure: the yearly one
  assert.deepEqual(bandFromText('Salary range is $85,000 to $105,000 annually. We also offer $50 - $75 monthly wellness stipend.'), { min: 85000, max: 105000 });
  // Not a yearly salary, so the user's own figure stands: an hourly rate in
  // any wording, a weekly or monthly rate, a stipend, a bonus, a funding
  // figure. A bare two digit range is never read as thousands.
  for (const text of [
    'Pay rate: $38 - $52 per hour depending on shift',
    'Pay range: $38 - $52 an hour, depending on experience.',
    'Compensation: $41-$58 per hr plus shift differential',
    'Base pay $38 to $52 / h',
    'RN, Medical Surgical. Pay: $41.50 - $58.75 hourly.',
    'Pay rate $38 - $52 kitchen and line staff',
    'Benefits: $50 - $75 monthly wellness stipend. Compensation is competitive.',
    'We raised $50 - $60 million. Salary DOE.',
    'Our fund manages $200 - $400 million. Compensation: competitive.',
    'Compensation: $6,500 - $8,200 per month',
    'Pay range $25,000 - $31,000 per month for locum coverage',
    'Pay rate: $2,100 - $2,600/week travel contract. Compensation includes housing.',
    'Compensation: $5,000 - $25,000 sign-on bonus for night shift nurses',
  ]) assert.equal(bandFromText(text), null, text);
  // A period word that only opens the next sentence, line or column is not
  // the pay period of the band.
  for (const [text, min, max] of [
    ['The salary range for this role is $150,000 - $180,000. Day one benefits include medical and dental.', 150000, 180000],
    ['Base salary: $150,000 - $180,000\nMonthly team offsites and a remote first culture', 150000, 180000],
    ['Salary range: $150,000 - $180,000 (weekly pay schedule)', 150000, 180000],
    ['Registered Nurse. Salary: $72,000 - $91,500 | Day Shift | Full Time', 72000, 91500],
    ['Tax Accountant. Annual salary $68,000 - $84,000. Monthly close experience required.', 68000, 84000],
  ]) assert.deepEqual(bandFromText(text), { min, max }, text);
  for (const text of [
    'Pay range $25,000 - $31,000 monthly',
    'Pay range $25,000 - $31,000 (monthly)',
    'Pay range $25,000 - $31,000 (per month)',
    'Pay range $25,000 - $31,000 USD per month',
    'Compensation $25,000 - $31,000 / mo',
  ]) assert.equal(bandFromText(text), null, text);
  // The band must be in the user's currency. A code or prefix beside the
  // range states it; a bare "$" is read as USD.
  const usd = 'The annual base salary range for this position is $142,000 - $198,000 USD.';
  assert.deepEqual(bandFromText(usd), { min: 142000, max: 198000 });
  assert.deepEqual(bandFromText(usd, 'USD'), { min: 142000, max: 198000 });
  assert.deepEqual(bandFromText('Compensation: US$120,000 - US$150,000'), { min: 120000, max: 150000 });
  for (const currency of ['CAD', 'AUD', 'EUR', 'GBP', 'INR']) assert.equal(bandFromText(usd, currency), null, currency);
  assert.equal(bandFromText('Salary: $72,000 - $91,500 per year', 'CAD'), null); // a bare "$" is not known to be CAD
  for (const cad of ['Salary range: $110,000 - $135,000 CAD', 'Compensation: CAD $110,000 - $135,000 per year', 'Salary: C$110,000 - $135,000', 'Salary: CA$110,000 - CA$135,000']) {
    assert.deepEqual(bandFromText(cad, 'CAD'), { min: 110000, max: 135000 }, cad);
    assert.equal(bandFromText(cad), null, cad);
  }
  // two bands on one line: a code belongs to the range it touches
  const both = 'This position has a starting salary range of $120K - $135K CAD/$150K - $165K USD per year.';
  assert.deepEqual(bandFromText(both), { min: 150000, max: 165000 });
  assert.deepEqual(bandFromText(both, 'CAD'), { min: 120000, max: 135000 });
  for (const text of ['Salary: CAD $120K - $135K / USD $150K - $165K', 'Salary: USD $150K - $165K, CAD $120K - $135K']) {
    assert.deepEqual(bandFromText(text), { min: 150000, max: 165000 }, text);
    assert.deepEqual(bandFromText(text, 'CAD'), { min: 120000, max: 135000 }, text);
  }
  assert.equal(bandFromText('Salary: A$95,000 - $115,000 plus super'), null);
  assert.equal(bandFromText('Salary: R$95,000 - R$115,000'), null); // a dollar sign of some other currency
  // a dollar range with no pay vocabulary near it is not a band
  assert.equal(bandFromText('We manage portfolios from $250,000 - $900,000 for remote clients in the region.'), null);
  // out of bounds
  assert.equal(bandFromText('Total compensation $3,000,000 - $9,000,000'), null);
  assert.equal(bandFromText('Annual stipend $1,200 - $1,500'), null);
  // a bonus or equity line UNDER the salary line does not make the band a bonus
  for (const text of [
    'Compensation\nAnnual base salary: $78,000-$96,000\nTarget annual bonus percentage: 10%\nWorking conditions',
    'Base salary: $78,000 - $96,000\nBonus: up to 15% of base',
    'Base salary: $78,000 - $96,000\r\nEquity: 0.05% - 0.15%',
    'Salary\n$78,000 - $96,000\n\nEquity\n0.1% - 0.5%\n',
    'Base salary $78,000 - $96,000\n\nSign-on bonus available',
    'Salary: $78,000 - $96,000\nRSUs vest over 4 years',
    'Salary: $78,000 - $96,000\n/ Remote',
    'Salary range: $78,000 - $96,000 / per year',
    'Salary range: $78,000 - $96,000/y',
    'Salary range: $78,000 - $96,000 / per annum',
  ]) assert.deepEqual(bandFromText(text), { min: 78000, max: 96000 }, text);
  // on the same line it still does, and so does a per unit rate
  for (const text of [
    'Compensation: $5,000 - $10,000 sign on bonus',
    'Compensation: $20,000 - $30,000 annual bonus',
    'Pay rate: $20,000 - $30,000 / month',
    'Pay rate: $20,000 - $30,000 /per month',
    'Compensation: $20,000 - $30,000 / project',
  ]) assert.equal(bandFromText(text), null, text);
  assert.equal(bandFromText(''), null);
  assert.equal(bandFromText(null), null);
});
