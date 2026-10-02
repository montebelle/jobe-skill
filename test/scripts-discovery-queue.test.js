'use strict';
// scripts/prune-queue.js (self cleaning apply queue) and scripts/final-list.js
// (the presentation gate). Synthetic rows from two unrelated fields (nursing,
// tax accounting). Every workspace is a fresh JOBE_USER_ROOT temp directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// files: { 'relative/file.json': object|string }, dirs: ['relative/dir', ...]
function workspace(files = {}, dirs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-discovery-queue-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  process.env.JOBE_USER_ROOT = root;
  return root;
}

workspace();
const { companySlug } = require('../lib/posting');
const { classify, folderBucket, historyState, prune } = require('../scripts/prune-queue');
const { select, workMode, money, format } = require('../scripts/final-list');
const { countryOk, regionOk, modePass } = require('../lib/profile');

function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}
const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const QUEUE = 'data/apply-queue.json';

// ── prune-queue ─────────────────────────────────────────────

const ROWS = [
  { slug: 'lakeview-rn-icu', role: 'Registered Nurse, ICU', applied: true },
  { slug: 'harbor-senior-tax', role: 'Senior Tax Accountant', applied: false, resumeDocx: 'reports/skipped/harbor-senior-tax/resume.docx' },
  { slug: 'northside-rn-float', role: 'Registered Nurse', status: 'skipped' },
  { slug: 'ledger-tax-associate', role: 'Tax Associate', applied: false, score: 71 },
  { slug: 'ledger-tax-manager', role: 'Tax Manager' },
  { slug: 'lakeview-staff-nurse', role: 'Staff Nurse' },
  { slug: 'northside-charge-nurse', role: 'Charge Nurse' },
  { slug: 'harbor-staff-accountant', role: 'Staff Accountant' },
  { slug: 'harbor-tax-analyst', role: 'Tax Analyst' },
  { role: 'Row With No Slug' },
  { slug: 'lakeview-nurse-educator', role: 'Nurse Educator' },
];
const FOLDERS = [
  'reports/needs-manual/ledger-tax-manager',
  'reports/queue/lakeview-staff-nurse',
  'reports/archive/northside-charge-nurse',
  'reports/manual/archive/2031-01-15/harbor-staff-accountant',
  'reports/harbor-tax-analyst',
  'reports/applied/lakeview-nurse-educator',
];
const EXPECTED = [
  [true, 'applied'], [true, 'skipped'], [true, 'skipped'], [false, 'orphan'], [true, 'active:needs-manual'],
  [true, 'active:queue'], [false, 'archived'], [false, 'archived'], [true, 'other:flat'], [true, 'other:no-slug'],
  [true, 'other:applied'],
];

test('historyState recognizes every way a row records an outcome', () => {
  assert.equal(historyState({ applied: true }), 'applied');
  assert.equal(historyState({ status: 'Applied' }), 'applied');
  assert.equal(historyState({ reportDir: 'reports/applied/lakeview-rn-icu/' }), 'applied');
  assert.equal(historyState({ skipped: true }), 'skipped');
  assert.equal(historyState({ status: 'SKIPPED' }), 'skipped');
  assert.equal(historyState({ resumeDocx: 'reports/skipped/harbor-senior-tax/resume.docx' }), 'skipped');
  assert.equal(historyState({ applied: false, status: 'Evaluated', resumeDocx: 'reports/queue/x/resume.docx' }), null);
});

test('folderBucket finds a slug in any lifecycle, legacy, flat or dated archive location', () => {
  const root = workspace({}, FOLDERS);
  assert.equal(folderBucket('lakeview-staff-nurse'), 'queue');
  assert.equal(folderBucket('ledger-tax-manager', root), 'needs-manual');
  assert.equal(folderBucket('northside-charge-nurse'), 'archive');
  assert.equal(folderBucket('harbor-staff-accountant'), 'archive');
  assert.equal(folderBucket('harbor-tax-analyst'), 'flat');
  assert.equal(folderBucket('lakeview-nurse-educator'), 'applied');
  assert.equal(folderBucket('ledger-tax-associate'), null);
  assert.equal(folderBucket('../outside'), null);
});

test('classify keeps history and live rows, prunes orphans and archived rows', () => {
  workspace({}, FOLDERS);
  ROWS.forEach((row, i) => {
    const c = classify(row);
    assert.deepEqual([c.keep, c.reason], EXPECTED[i], JSON.stringify(row));
  });
});

test('with no title policy a level word in a role never prunes a row', () => {
  workspace({}, ['reports/queue/lakeview-staff-nurse', 'reports/queue/harbor-principal']);
  assert.equal(classify({ slug: 'lakeview-staff-nurse', role: 'Staff Nurse' }).keep, true);
  assert.equal(classify({ slug: 'harbor-principal', role: 'Principal, Tax Advisory' }).keep, true);
});

test('the title rule follows the user policy, reads the role only, and never touches history', () => {
  workspace(
    { 'data/profile.json': { discovery: { titleExclude: ['travel', 'per diem'], titleKeep: ['travel coordinator'] } } },
    ['reports/queue/lakeview-travel-nurse', 'reports/queue/harbor-travel-coordinator', 'reports/queue/acme-travel-rn'],
  );
  assert.deepEqual(classify({ slug: 'lakeview-travel-nurse', role: 'Travel Nurse' }), { keep: false, reason: 'title-excluded' });
  assert.deepEqual(classify({ slug: 'northside-per-diem', role: 'Per Diem Tax Preparer' }), { keep: false, reason: 'title-excluded' });
  // A keep phrase shields its own words, as in discovery; an exclude phrase
  // elsewhere in the role still prunes the row.
  assert.equal(classify({ slug: 'harbor-travel-coordinator', role: 'Travel Coordinator, Tax' }).reason, 'active:queue');
  assert.equal(classify({ slug: 'harbor-travel-coordinator', role: 'Per Diem Travel Coordinator, Tax' }).reason, 'title-excluded');
  // A row with no role is never pruned by the title rule.
  assert.equal(classify({ slug: 'harbor-travel-coordinator' }).reason, 'active:queue');
  // The slug is not a title.
  assert.equal(classify({ slug: 'acme-travel-rn', role: 'Registered Nurse' }).reason, 'active:queue');
  // History is kept even when the title is excluded.
  assert.equal(classify({ slug: 'old-travel', role: 'Travel Nurse', applied: true }).reason, 'applied');
});

test('prune --dry reports and changes nothing', () => {
  const root = workspace({ [QUEUE]: ROWS }, FOLDERS);
  const out = quiet(() => prune({ dry: true }));
  assert.equal(out.kept.length, 8);
  assert.deepEqual(out.pruned.map((r) => [r.slug, r._reason]), [
    ['ledger-tax-associate', 'orphan'], ['northside-charge-nurse', 'archived'], ['harbor-staff-accountant', 'archived'],
  ]);
  assert.deepEqual(readJson(root, QUEUE), ROWS);
  assert.equal(fs.existsSync(path.join(root, QUEUE + '.bak')), false);
});

test('prune rewrites the queue, backs the old one up, and deletes no report folder', () => {
  const root = workspace({ [QUEUE]: ROWS }, FOLDERS);
  const out = quiet(() => prune());
  const kept = readJson(root, QUEUE);
  assert.deepEqual(kept, out.kept);
  assert.deepEqual(kept.map((r) => r.slug), [
    'lakeview-rn-icu', 'harbor-senior-tax', 'northside-rn-float', 'ledger-tax-manager', 'lakeview-staff-nurse',
    'harbor-tax-analyst', undefined, 'lakeview-nurse-educator',
  ]);
  assert.deepEqual(readJson(root, QUEUE + '.bak'), ROWS);
  for (const d of FOLDERS) assert.ok(fs.existsSync(path.join(root, d)), d);
  // A second run has nothing left to prune.
  assert.equal(quiet(() => prune()).pruned.length, 0);
});

test('prune on a workspace with no queue is a clean no-op', () => {
  const root = workspace();
  const out = quiet(() => prune());
  assert.deepEqual(out, { kept: [], pruned: [] });
  assert.equal(fs.existsSync(path.join(root, QUEUE)), false);
});

// ── final-list ──────────────────────────────────────────────

const LI = 'https://www.linkedin.com/jobs/view/registered-nurse-at-lakeview-hospital-1234567890';
const ats = (n) => `https://boards.greenhouse.io/harbortax/jobs/${n}`;
const POSTINGS = {
  verifiedAts: { title: 'Tax Accountant', company: 'Harbor Tax Group', companySlug: 'harbor-tax-group', canonicalUrl: ats(1), remote: 'remote', us: true, location: 'Remote - US', matchScore: 82, postedDate: '2031-03-01T00:00:00Z', compensation: { min: 90000, max: 110000, currency: 'USD' } },
  linkedinAsserted: { title: 'Registered Nurse', company: 'Lakeview Hospital', companySlug: 'lakeview-hospital', canonicalUrl: LI, remote: 'remote', us: true, location: 'Remote - United States', matchScore: 90 },
  linkedinVerified: { title: 'Telehealth Triage Nurse', company: 'Northside Clinic', companySlug: 'northside-clinic', canonicalUrl: 'https://jobs.lever.co/northside/abc', linkedinUrl: LI, atsResolved: true, atsBoard: 'lever:northside', verifyStatus: 'remote', remote: 'remote', us: true, location: 'Remote - US', matchScore: 75 },
  staffing: { title: 'Senior Tax Accountant', company: 'Lakeview Hospital', companySlug: 'lakeview-hospital', employerCorrection: 'Temp Shift Agency', canonicalUrl: ats(2), remote: 'remote', us: true, location: 'Remote - US', matchScore: 80 },
  lowScore: { title: 'Tax Clerk', company: 'Harbor Tax Group', companySlug: 'harbor-tax-group', canonicalUrl: ats(3), remote: 'remote', us: true, location: 'Remote - US', matchScore: 40 },
  closed: { title: 'Tax Manager', company: 'Harbor Tax Group', companySlug: 'harbor-tax-group', canonicalUrl: ats(4), remote: 'remote', us: true, location: 'Remote - US', matchScore: 88, verify: { status: 'gone', stillOpen: false } },
  atsSaysHybrid: { title: 'Nurse Case Manager', company: 'Northside Clinic', companySlug: 'northside-clinic', canonicalUrl: ats(5), remote: 'remote', us: true, location: 'Remote - US', matchScore: 85, verify: { status: 'ok', stillOpen: true, remote: 'hybrid', location: 'Denver, CO' } },
  onsite: { title: 'Registered Nurse, ICU', company: 'Lakeview Hospital', companySlug: 'lakeview-hospital', canonicalUrl: ats(6), remote: 'onsite', us: true, location: 'Columbus, OH', matchScore: 78 },
  abroad: { title: 'Tax Accountant', company: 'Maple Ledger', companySlug: 'maple-ledger', canonicalUrl: ats(7), remote: 'remote', us: false, location: 'Remote - Canada', matchScore: 77 },
  unplaced: { title: 'Tax Accountant', company: 'Ledger and Pine', companySlug: 'ledger-and-pine', canonicalUrl: ats(8), remote: 'remote', us: null, location: 'Remote', matchScore: 76, minimumsUnmet: ['CPA license required'] },
};
const ALL = Object.values(POSTINGS);
const names = (list) => list.map((p) => Object.keys(POSTINGS).find((k) => POSTINGS[k] === p));
const NO_TITLE_POLICY = { exclude: null, keep: null };
const EXCLUDED = new Set([companySlug('Temp Shift Agency')]);

test('workMode trusts the employer record first and never a LinkedIn label alone', () => {
  assert.equal(workMode(POSTINGS.verifiedAts), 'remote');
  assert.equal(workMode(POSTINGS.linkedinAsserted), 'unknown');
  assert.equal(workMode(POSTINGS.linkedinVerified), 'remote');
  assert.equal(workMode(POSTINGS.atsSaysHybrid), 'hybrid');
  assert.equal(workMode(POSTINGS.onsite), 'onsite');
  assert.equal(workMode({ canonicalUrl: LI, verifyStatus: 'not-remote', verifiedWorkplace: 'hybrid', remote: 'remote' }), 'hybrid');
  assert.equal(workMode({ canonicalUrl: ats(9) }), 'unknown');
});

const row = (over) => ({ title: 'Registered Nurse', company: 'Lakeview Hospital', canonicalUrl: ats(20), matchScore: 80, ...over });
const OPEN = { minScore: 0, excluded: new Set(), titlePolicy: NO_TITLE_POLICY };
const verdict = (p, filters, opts = OPEN) => {
  const { keep, drop } = select([p], { ...opts, filters });
  return keep.length ? 'keep' : (drop[0] ? drop[0].reason : 'left out');
};

test('a guessed verify verdict never overrides the pipeline label, and decides when there is none', () => {
  workspace();
  const guess = { status: 'ok', stillOpen: true, location: 'United States', remote: 'onsite', remoteGuess: true };
  const labeled = row({ title: 'Tax Accountant', remote: 'remote', us: true, location: 'United States', verify: guess });
  assert.equal(workMode(labeled), 'remote');
  assert.equal(verdict(labeled, { workModes: ['remote'], countries: ['US'] }), 'keep');
  // A bare "hybrid" in the JD against a JD verified remote label.
  assert.equal(workMode(row({ remote: 'remote', verify: { remote: 'hybrid', remoteGuess: true } })), 'remote');
  // A loose remote phrase against a pipeline onsite label: no upgrade.
  assert.equal(workMode(row({ remote: 'onsite', verify: { remote: 'remote', remoteGuess: true } })), 'onsite');
  // No pipeline label (silent, or a LinkedIn assertion): the guess is all there is.
  assert.equal(workMode(row({ remote: 'unknown', verify: guess })), 'onsite');
  assert.equal(workMode(row({ verify: guess })), 'onsite');
  assert.equal(workMode(row({ canonicalUrl: LI, remote: 'remote', verify: guess })), 'onsite');
  assert.equal(verdict(row({ canonicalUrl: LI, remote: 'remote', location: 'United States', verify: guess }), { workModes: ['remote'] }), 'left out');
  // A LinkedIn page verified NOT remote is a label too: a guessed remote never beats it.
  const liGuess = { status: 'ok', stillOpen: true, location: 'Columbus, OH', remote: 'remote', remoteGuess: true };
  for (const shown of ['onsite', 'hybrid']) {
    const li = row({ linkedinUrl: LI, remote: 'onsite', us: true, location: 'Columbus, OH', verifyStatus: 'not-remote', verifiedWorkplace: shown, verify: liGuess });
    assert.equal(workMode(li), shown);
    assert.equal(verdict(li, { workModes: ['remote'], countries: ['US'] }), 'left out');
    // A firm employer record still wins.
    assert.equal(workMode({ ...li, verify: { ...liGuess, location: 'Remote - US', remoteGuess: false } }), 'remote');
  }
  // An unverified LinkedIn remote label is still no label, and a guessed
  // remote is no page verification: the row is not listed as remote.
  assert.equal(workMode(row({ canonicalUrl: LI, remote: 'remote', verify: liGuess })), 'unknown');
  for (const verifyStatus of ['inconclusive', 'unreachable', undefined]) {
    const li = row({ canonicalUrl: ats(21), linkedinUrl: LI, atsResolved: true, remote: 'remote', us: true, location: 'United States', verifyStatus, verify: { status: 'ok', stillOpen: true, location: 'United States', remote: 'remote', remoteGuess: true } });
    assert.equal(workMode(li), 'unknown');
    assert.equal(verdict(li, { workModes: ['remote'], countries: ['US'] }), 'left out');
    // A firm employer record, or a page verified row, is still listed.
    assert.equal(verdict({ ...li, verify: { ...li.verify, remoteGuess: false } }, { workModes: ['remote'], countries: ['US'] }), 'keep');
    assert.equal(verdict({ ...li, verifyStatus: 'remote' }, { workModes: ['remote'], countries: ['US'] }), 'keep');
  }
  // The same guess on a row that did not come from LinkedIn still decides.
  assert.equal(workMode(row({ verify: liGuess })), 'remote');
  // A page verified LinkedIn row is a label.
  assert.equal(workMode(row({ canonicalUrl: LI, remote: 'remote', verifyStatus: 'remote', verify: guess })), 'remote');
  // A firm employer record still wins over the pipeline label, either way.
  assert.equal(workMode(row({ remote: 'remote', verify: { remote: 'onsite', location: 'Columbus, OH' } })), 'onsite');
  assert.equal(workMode(row({ remote: 'hybrid', verify: { remote: 'remote', location: 'Remote - US' } })), 'remote');
});

test('verify-listing output feeds the final list: a country only ATS location keeps a remote role', () => {
  workspace();
  const { remoteVerdict } = require('../scripts/verify-listing');
  const remoteFields = (...x) => { const [remote, g] = remoteVerdict(...x); return g ? { remote, remoteGuess: true } : { remote }; };
  const attach = (p, atsLocation, jd, atsTitle = p.title) => {
    const [remote, g] = remoteVerdict(atsLocation, jd, null, null, atsTitle);
    return { ...p, verify: { status: 'ok', stillOpen: true, location: atsLocation, remote, ...(g ? { remoteGuess: true } : {}) } };
  };
  const policy = { workModes: ['remote'], countries: ['US'] };
  const nurse = row({ title: 'Telehealth Triage Nurse', remote: 'remote', us: true, location: 'United States' });
  assert.equal(verdict(attach(nurse, 'United States', 'This role is remote. You will care for patients by phone.'), policy), 'keep');
  assert.equal(verdict(attach(nurse, 'United States', 'Join our team of nurses.'), policy), 'keep');
  const tax = row({ title: 'Senior Tax Accountant', remote: 'remote', us: true, location: 'Remote - US' });
  assert.equal(verdict(attach(tax, 'Columbus, OH (Hybrid); United States (Remote)', 'Prepare returns.'), policy), 'keep');
  assert.equal(verdict(attach(tax, 'United States', 'We run payroll on a hybrid cloud ledger.'), policy), 'keep');
  // A residence rule in the JD of a remote role, read from the rendered page
  // (no ATS location) or beside a country only location: the label stands.
  const residence = 'This is a remote position. Candidates must be located in the United States and hold a compact licence.';
  const remoteNurse = row({ title: 'Telehealth Registered Nurse', remote: 'remote', us: true, location: 'Remote - United States' });
  assert.equal(verdict({ ...remoteNurse, verify: { status: 'ok', stillOpen: true, ...remoteFields('', residence) } }, policy), 'keep');
  assert.equal(verdict(attach(nurse, 'United States', residence), policy), 'keep');
  assert.equal(verdict(attach(nurse, 'Columbus, OH', residence), policy), 'left out');
  assert.equal(verdict(attach(tax, 'Columbus, OH', 'Prepare returns.'), policy), 'left out');
  assert.equal(verdict(attach(tax, 'Denver, CO (Hybrid)', 'Prepare returns.'), policy), 'left out');
  assert.equal(verdict(attach(tax, 'United States', 'This is a hybrid role: 3 days per week in the office.'), policy), 'left out');
});

test('the ATS flag never lists a hybrid job as remote, and an unreachable listing is kept with a note', () => {
  workspace();
  const { remoteVerdict } = require('../scripts/verify-listing');
  const policy = { workModes: ['remote'], countries: ['US'] };
  const days = 'You will work 3 days per week in the office.';
  // The pipeline read hybrid from the JD; the board's remote flag must not undo it.
  for (const [p, loc] of [
    [row({ title: 'Tax Accountant', remote: 'hybrid', us: true, location: 'United States' }), 'United States'],
    [row({ title: 'Nurse Case Manager', remote: 'hybrid', us: true, location: 'Remote - US' }), 'Remote'],
  ]) {
    const [remote, g] = remoteVerdict(loc, days, true, null, p.title);
    assert.deepEqual([remote, g], ['hybrid', false]);
    assert.equal(verdict({ ...p, verify: { status: 'ok', stillOpen: true, remote, location: loc } }, policy), 'left out');
  }
  // What verify-listing writes for a timeout, a 429 or a 5xx.
  const nurse = row({ title: 'Telehealth Triage Nurse', remote: 'remote', us: true, location: 'Remote - US', matchScore: 70,
    verify: { ats: 'greenhouse', board: 'northside', status: 'needs-agent', stillOpen: null, detail: 'greenhouse 503' } });
  const tax = row({ title: 'Senior Tax Accountant', remote: 'remote', us: true, location: 'Remote - US', matchScore: 60,
    atsResolved: true, verify: { status: 'gone', stillOpen: false, detail: 'lever 404' } });
  const open = { ...tax, verify: { status: 'ok', stillOpen: true, remote: 'remote' } };
  assert.equal(verdict(nurse, policy), 'keep');
  assert.equal(verdict(tax, policy), 'left out');
  const text = format(select([nurse, open], { filters: policy, excluded: new Set(), titlePolicy: NO_TITLE_POLICY }));
  assert.match(text, /Telehealth Triage Nurse\n.*\n {4}listing not confirmed open \(needs-agent: greenhouse 503\): check the page/);
  assert.equal(text.match(/not confirmed open/g).length, 1);
  // A row resolved without a board name still prints a source.
  assert.match(text, /\| ATS employer listing \|/);
  assert.doesNotMatch(text, /undefined/);
});

test('select under a remote, one country policy keeps only verified rows', () => {
  workspace();
  const { keep, drop } = select(ALL, {
    filters: { workModes: ['remote'], countries: ['US'] }, minScore: 65, excluded: EXCLUDED, titlePolicy: NO_TITLE_POLICY,
  });
  assert.deepEqual(names(keep), ['verifiedAts', 'linkedinVerified']);
  assert.deepEqual(drop.map(({ p, reason }) => [names([p])[0], reason]), [
    ['staffing', 'excluded company'],
    ['abroad', 'outside country (Remote - Canada)'],
    ['unplaced', 'country unverified (Remote)'],
  ]);
});

test('select with no policy keeps every open listing and still drops excluded companies', () => {
  workspace();
  const { keep, drop, minScore } = select(ALL, { excluded: EXCLUDED });
  assert.equal(minScore, 0);
  assert.deepEqual(names(keep), ['linkedinAsserted', 'atsSaysHybrid', 'verifiedAts', 'onsite', 'abroad', 'unplaced', 'linkedinVerified', 'lowScore']);
  assert.deepEqual(drop.map(({ p }) => names([p])[0]), ['staffing']);
});

test('select accepts any allowed work mode and matches other countries by name', () => {
  workspace();
  const hybridOk = select(ALL, { filters: { workModes: ['remote', 'hybrid'] }, minScore: 65, excluded: new Set(), titlePolicy: NO_TITLE_POLICY });
  assert.ok(names(hybridOk.keep).includes('atsSaysHybrid'));
  assert.equal(names(hybridOk.keep).includes('onsite'), false);
  assert.equal(names(hybridOk.keep).includes('linkedinAsserted'), false);

  const canada = select(ALL, { filters: { countries: ['CA'] }, minScore: 65, excluded: new Set(), titlePolicy: NO_TITLE_POLICY });
  assert.ok(names(canada.keep).includes('abroad'));
  // A location that names no place is unknown and kept; a named place elsewhere is dropped.
  assert.ok(names(canada.keep).includes('unplaced'));
  assert.ok(canada.drop.some(({ p, reason }) => p === POSTINGS.onsite && /^outside country/.test(reason)));
});

test('a one country US policy places bare states and cities, and still wants a positive verdict', () => {
  workspace();
  const us = { countries: ['US'] };
  for (const location of ['San Francisco (Remote)', 'New York', 'Remote - California', 'U.S. Remote', 'Bay Area', 'Remote - New Mexico', 'New Mexico']) {
    assert.equal(verdict(row({ remote: 'remote', us: null, location }), us), 'keep', location);
  }
  assert.equal(verdict(row({ remote: 'remote', us: null, location: 'Remote' }), us), 'country unverified (Remote)');
  assert.equal(verdict(row({ remote: 'remote', us: null, location: 'Springfield' }), us), 'country unverified (Springfield)');
  // The pipeline's verdict fills in for a location that names no country.
  assert.equal(verdict(row({ remote: 'remote', us: true, location: 'Remote' }), us), 'keep');
  // A classifier verdict of "not US" wins over a place name.
  assert.equal(verdict(row({ title: 'Tax Accountant - EMEA', remote: 'remote', us: null, location: 'New York' }), us), 'outside country (New York)');
  assert.equal(verdict(row({ remote: 'onsite', us: null, location: 'Durham, England' }), us), 'outside country (Durham, England)');
  // The state is not the country inside its name; the country still drops.
  assert.equal(verdict(row({ remote: 'remote', us: null, location: 'Remote - Mexico' }), us), 'outside country (Remote - Mexico)');
});

test('any other country list drops only a location that names another country', () => {
  workspace();
  const canada = { countries: ['CA', 'Canada'] };
  for (const location of ['Toronto, ON', 'Toronto, Ontario', 'Toronto', 'Remote - Canada']) {
    assert.equal(verdict(row({ remote: 'onsite', location }), canada), 'keep', location);
  }
  assert.equal(verdict(row({ remote: 'onsite', location: 'Austin, TX' }), canada), 'outside country (Austin, TX)');
  assert.equal(verdict(row({ remote: 'onsite', location: 'Lyon, France' }), canada), 'outside country (Lyon, France)');
  const uk = { countries: ['GB', 'United Kingdom'] };
  for (const location of ['Remote - UK', 'London, England (Remote)', 'Leeds']) {
    assert.equal(verdict(row({ title: 'Tax Accountant', remote: 'remote', location }), uk), 'keep', location);
  }
  assert.equal(verdict(row({ title: 'Tax Accountant', remote: 'remote', location: 'Dublin, Ireland' }), uk), 'outside country (Dublin, Ireland)');
});

test('a posting that states no work mode counts as onsite, as in the pipeline', () => {
  workspace();
  const silent = row({ remote: 'unknown', location: 'Columbus' });
  assert.equal(verdict(silent, { workModes: ['onsite', 'hybrid'] }), 'keep');
  assert.equal(verdict(row({ location: 'Columbus' }), { workModes: ['onsite'] }), 'keep');
  assert.equal(verdict(silent, { workModes: ['remote'] }), 'left out');
  assert.equal(verdict(silent, { workModes: ['remote', 'hybrid'] }), 'left out');
  // An unverified LinkedIn "remote" label is not remote, and it is not what an
  // onsite only user asked for either.
  const asserted = row({ canonicalUrl: LI, remote: 'remote', location: 'Remote' });
  assert.equal(verdict(asserted, { workModes: ['remote'] }), 'left out');
  assert.equal(verdict(asserted, { workModes: ['onsite'] }), 'left out');
  assert.equal(verdict(asserted, { workModes: ['remote', 'onsite'] }), 'keep');
});

test('the region policy applies to every verified mode but remote', () => {
  workspace();
  const denver = { regions: ['Denver'] };
  assert.equal(verdict(row({ remote: 'onsite', location: 'Columbus, OH' }), denver), 'outside region (Columbus, OH)');
  assert.equal(verdict(row({ remote: 'unknown', location: 'Columbus' }), denver), 'outside region (Columbus)');
  // A state code that another country's listing happens to carry is not the state.
  assert.equal(verdict(row({ remote: 'onsite', location: 'Medellin, CO, Colombia' }), { regions: ['Denver', 'Colorado'] }), 'outside region (Medellin, CO, Colombia)');
  assert.equal(verdict(row({ remote: 'onsite', location: 'Aurora, CO, United States' }), { regions: ['Denver', 'Colorado'] }), 'keep');
  assert.equal(verdict(row({ remote: 'hybrid', location: 'Denver, CO' }), denver), 'keep');
  assert.equal(verdict(row({ remote: 'remote', location: 'Columbus, OH' }), denver), 'keep');
  assert.equal(verdict(row({ remote: 'onsite', location: '' }), denver), 'keep');
  // The verified record decides both the mode and the place.
  assert.equal(verdict(POSTINGS.atsSaysHybrid, denver), 'keep');
  assert.equal(verdict(POSTINGS.atsSaysHybrid, { regions: ['Columbus'] }), 'outside region (Denver, CO)');
  // A state or province matches by name and by code, whichever the user wrote.
  const colorado = { regions: ['Denver', 'Colorado'] };
  for (const location of ['Boulder, CO', 'Fort Collins, CO, United States', 'Lakewood, CO, US', 'Aurora, Colorado']) {
    assert.equal(verdict(row({ remote: 'onsite', location }), colorado), 'keep', location);
  }
  const ontario = { regions: ['Toronto', 'Ontario'] };
  for (const location of ['Mississauga, ON', 'Hamilton, ON, Canada', 'London, ON']) {
    assert.equal(verdict(row({ remote: 'hybrid', location }), ontario), 'keep', location);
  }
  assert.equal(verdict(row({ remote: 'onsite', location: 'Miami, FL (On site)' }), ontario), 'outside region (Miami, FL (On site))');
  assert.equal(verdict(row({ remote: 'onsite', location: 'Remote or Austin, TX' }), { regions: ['OR'] }), 'outside region (Remote or Austin, TX)');
  // The profile is read when no option is given.
  workspace({ 'data/profile.json': { discovery: { regions: ['Ontario'], excludeStaffing: false } } });
  assert.equal(verdict(row({ remote: 'onsite', location: 'Toronto, Ontario' }), undefined, {}), 'keep');
  assert.equal(verdict(row({ remote: 'onsite', location: 'Columbus, OH' }), undefined, {}), 'outside region (Columbus, OH)');
});

test('select agrees with the pipeline gates in lib/profile for work mode, country and region', () => {
  workspace();
  const rows = [
    ['remote', 'Remote - Canada'], ['remote', 'Remote'], ['hybrid', 'Denver, CO'], ['onsite', 'Toronto, ON'],
    ['onsite', 'Leeds, England'], ['unknown', 'Columbus'], ['unknown', ''], ['hybrid', 'Lyon, France'],
  ];
  const policies = [
    {},
    { workModes: ['onsite', 'hybrid'], regions: ['Denver', 'Ontario'] },
    { workModes: ['remote'], countries: ['CA', 'Canada'] },
    { workModes: ['remote', 'hybrid'], countries: ['GB', 'United Kingdom'], regions: ['Leeds'] },
    { countries: ['US', 'CA'], regions: ['Toronto'] },
  ];
  for (const policy of policies) {
    const modes = policy.workModes || [];
    const gate = { ...policy, remoteOnly: modes.length === 1 && modes[0] === 'remote' };
    for (const [remote, location] of rows) {
      const p = row({ remote, location });
      const expected = modePass(p, gate, true) && countryOk(location, policy.countries, p.title)
        && (remote === 'remote' || regionOk(location, policy.regions));
      assert.equal(verdict(p, policy) === 'keep', expected, `${JSON.stringify(policy)} ${remote} ${location}`);
    }
  }
});

test('a keep phrase shields only its own words in the final list too', () => {
  workspace({ 'data/profile.json': { discovery: { titleExclude: ['travel', 'per diem'], titleKeep: ['travel coordinator'], excludeStaffing: false } } });
  const opts = { minScore: 0 };
  assert.equal(verdict(row({ title: 'Travel Coordinator, Tax' }), undefined, opts), 'keep');
  assert.equal(verdict(row({ title: 'Per Diem Nurse Travel Coordinator' }), undefined, opts), 'title excluded');
  assert.equal(verdict(row({ title: 'Travel Nurse' }), undefined, opts), 'title excluded');
  assert.equal(verdict(row({ title: '' }), undefined, opts), 'keep');
});

test('select reads the policy, the score floor and the company lists from the workspace', () => {
  workspace({
    'data/profile.json': { discovery: { workModes: ['remote'], countries: ['US'], minScore: 65, titleExclude: ['triage'], excludeStaffing: false } },
    'data/companies/negative-list.json': { companySlugs: [companySlug('Temp Shift Agency')] },
  });
  const { keep, drop, minScore } = select(ALL);
  assert.equal(minScore, 65);
  assert.deepEqual(names(keep), ['verifiedAts']);
  assert.deepEqual(drop.map(({ p, reason }) => [names([p])[0], reason.split(' (')[0]]), [
    ['staffing', 'excluded company'], ['abroad', 'outside country'], ['unplaced', 'country unverified'], ['linkedinVerified', 'title excluded'],
  ]);
  // An explicit option (a command line flag) wins over the file.
  assert.ok(names(select(ALL, { filters: { workModes: [], countries: [] } }).keep).includes('onsite'));
  assert.ok(names(select(ALL, { minScore: 30 }).keep).includes('lowScore'));
});

test('money never returns a blank', () => {
  assert.equal(money(null), 'salary: fetch band');
  assert.equal(money({}), 'salary: fetch band');
  assert.equal(money('$80K - $95K'), '$80K - $95K');
  assert.equal(money({ min: 90000, max: 110000, currency: 'USD' }), '$90000-110000');
  assert.equal(money({ min: 60000, currency: 'CAD' }), 'CAD 60000-?');
  assert.equal(money({ min: 4000, max: 5000, currency: 'EUR', period: 'month' }), 'EUR 4000-5000/month');
  assert.equal(money({ min: 90000, max: 110000, currency: 'USD', period: 'year' }), '$90000-110000');
});

test('format shows compensation, work mode and unmet minimums on every row', () => {
  workspace();
  const text = format(select(ALL, { excluded: EXCLUDED }));
  assert.match(text, /^FINAL LIST \(work modes: any; countries: any; score >= 0\): 8/);
  assert.match(text, /\[82\] Harbor Tax Group \| Tax Accountant\n {4}2031-03-01 \| Remote - US \| remote \| ats-direct \| \$90000-110000/);
  assert.match(text, /\[90\] Lakeview Hospital \| Registered Nurse\n {4}date\? \| .* \| work mode unverified \| ats-direct \| salary: fetch band/);
  assert.match(text, /ATS lever:northside/);
  assert.match(text, /stated minimums not met: CPA license required/);
  assert.match(text, /--- excluded \(1\) ---\n {2}80 Temp Shift Agency +excluded company/);
  const rows = text.split('\n').filter((l) => / \| (remote|hybrid|onsite|work mode unverified) \| /.test(l));
  assert.equal(rows.length, 8);
  for (const row of rows) assert.match(row, /\| (\$|[A-Z]{3} |salary: fetch band)/);
});
