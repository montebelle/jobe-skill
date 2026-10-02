'use strict';
// lib/tailor.js: structure preserving JD parsing, bounded section extraction,
// gap detection credits (skills block, evidence index), the resume audit, and
// the render path gates. Synthetic fixtures only (a registered nurse and a tax
// accountant), isolated in a JOBE_USER_ROOT temp workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jobe-lib-generation-tailor-'));
const write = (rel, body) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
};
// The profile and the library are read (and cached) on first use, so they are
// written before any lib module is required.
write('data/profile.json', { output: { forbiddenTerms: ['Project Falcon', 'Zephyr'] } });
write('data/bullet-library.json', {
  companyKeyMap: { 'Harbor Tax Group': 'current' },
  current: [
    { id: 'current-returns', keywords: ['tax returns', 'reconciliation'], text: 'Prepared 340 individual and small business tax returns per season with a first pass acceptance rate of 98%.' },
    { id: 'current-audit', keywords: ['audit support', 'cl\u00f4ture mensuelle', '\u63a1\u8840', '\u96fb\u5b50\u30ab\u30eb\u30c6', '\u62a4\u7406', '\uac04\ud638', 'SAP'], text: 'Led audit support for 12 clients, assembling workpapers that closed every inquiry without adjustment.' },
  ],
});
process.env.JOBE_USER_ROOT = ROOT;

const {
  analyzeJD, tailorBrief, auditResume, auditProse, auditCoverLetter, readsAsEnglish, whyHasAnchor, countWords, canonicalSkill,
  renderedResumeText, scanCodenames, scanPositioningVocab, stripHtml, decodeHtmlEntities,
  corpusTools, TOOL_ALIAS,
} = require('../lib/tailor');

// ── JD parsing ──────────────────────────────────────────────────────────────

test('analyzeJD preserves HTML list and section boundaries (nurse JD)', () => {
  const jd = analyzeJD(`
    <h2>Key responsibilities</h2><ul>
      <li>Assess and monitor patients on a 24 bed medical surgical unit each shift</li>
      <li>Explain discharge &amp; medication plans to patients and their families</li>
    </ul><h2>Minimum qualifications</h2><ul>
      <li>Active registered nurse license in good standing in this state</li>
      <li>Two years of acute care bedside nursing in a hospital setting</li>
    </ul><h2>Benefits</h2><p>Tuition support and a retirement match, described here only as an example.</p>`);
  assert.equal(jd.responsibilities.length, 2);
  assert.equal(jd.qualifications.length, 2);
  assert.match(jd.responsibilities[1], /discharge & medication/);
  assert.ok(!jd.responsibilities.some((s) => /registered nurse license/.test(s)), 'a qualification leaked into responsibilities');
  assert.ok(!jd.qualifications.some((s) => /Tuition support/.test(s)), 'the section after qualifications leaked in');
});

test('analyzeJD reads a plain text JD with bullet glyphs (accountant JD)', () => {
  const jd = analyzeJD([
    'Responsibilities',
    '• Prepare federal and state returns for individuals and partnerships',
    '• Reconcile client ledgers and resolve notices from tax authorities',
    'Requirements',
    '• Enrolled agent or CPA credential, or active progress toward one',
    'Compensation',
    'Paid hourly during the season with overtime after forty hours.',
  ].join('\n'));
  assert.equal(jd.responsibilities.length, 2);
  assert.deepEqual(jd.qualifications, ['Enrolled agent or CPA credential, or active progress toward one']);
  assert.ok(jd.keywords.some((k) => k.term === 'returns'));
});

// A posting with company boilerplate around the real sections, in two
// unrelated professions and two heading conventions.
const ICU_JD = [
  'Registered Nurse, Intensive Care',
  'About Cedar Ridge Health',
  'Cedar Ridge Health is a regional system. Cedar Ridge Health cares for patients. Cedar Ridge Health offers benefits.',
  'Job Summary',
  'The nurse joins our nursing staff to deliver patient care.',
  'Essential Functions',
  '\u2022 Assess and monitor critically ill patients on a 16 bed intensive care unit.',
  '\u2022 Titrate vasoactive drips and manage ventilated patients per protocol.',
  '\u2022 Review discharge requirements with families before transfer to step down care.',
  'Education and Experience',
  '\u2022 Active registered nurse license in good standing is required.',
  '\u2022 Two years of critical care nursing in a hospital is preferred.',
  '\u2022 Current life support certification for adult patients.',
  '\u2022 Experience charting ventilated patients in an electronic record.',
  'Benefits',
  'Cedar Ridge Health offers generous benefits. Benefits include tuition benefits.',
].join('\n');
const UK_ACCOUNTANT_JD = [
  'Senior Management Accountant',
  'Bramble Lane Advisory is hiring. Bramble Lane Advisory serves charities. Bramble Lane Advisory is growing.',
  'Key accountabilities',
  '- Prepare monthly management accounts and variance commentary for trustees.',
  '- Lead the year end audit file and liaise with external auditors.',
  '- Review partial exemption calculations and quarterly returns for accuracy.',
  'Person specification',
  '- Professionally qualified accountant with charity sector exposure.',
  '- Confident with fund accounting and statutory reporting requirements.',
  '- Able to coach two finance assistants through month end.',
  'What we offer',
  'A pension and 28 days of leave at Bramble Lane Advisory.',
].join('\n');

test('analyzeJD finds clinical and UK style headings; seniority comes from the title line only', () => {
  const nurse = analyzeJD(ICU_JD);
  assert.equal(nurse.responsibilities.length, 3);
  assert.equal(nurse.qualifications.length, 4);
  assert.equal(nurse.seniority, null, '"nursing staff" in the body is not a level');
  assert.ok(!nurse.qualifications.some((s) => /generous benefits/.test(s)));

  const uk = analyzeJD(UK_ACCOUNTANT_JD);
  assert.equal(uk.responsibilities.length, 3);
  assert.equal(uk.qualifications.length, 3);
  assert.equal(uk.seniority, 'senior');
  assert.ok(!uk.qualifications.some((s) => /pension/.test(s)), '"What we offer" closes the section');
  assert.equal(analyzeJD('Sr. Tax Accountant\nPrepare returns.').seniority, 'senior');
});

test('analyzeJD headings must be headings: a heading word inside a sentence never starts or truncates a section', () => {
  const jd = analyzeJD([
    'Warehouse Supervisor',
    'Responsibilities',
    '\u2022 Gather requirements from carriers and warehouse teams for each outbound lane.',
    '\u2022 Schedule dock doors and labor for forty inbound trailers per shift.',
    'Qualifications',
    '\u2022 Three years in inbound logistics or distribution center operations.',
    '\u2022 Forklift certification and a clean safety record for two years.',
    '\u2022 Comfortable reporting overtime compensation and benefits accruals each week.',
    'Benefits',
    'Health cover from the first day on site, described here as an example.',
  ].join('\n'));
  assert.equal(jd.responsibilities.length, 2);
  assert.equal(jd.qualifications.length, 3);
  assert.match(jd.qualifications[0], /inbound logistics/);
  assert.ok(!jd.qualifications.some((s) => /Health cover/.test(s)));
});

test('analyzeJD keywords: no trailing punctuation, no boilerplate, no employer name', () => {
  for (const [jd, company] of [[ICU_JD, 'Cedar Ridge Health'], [UK_ACCOUNTANT_JD, 'Bramble Lane Advisory']]) {
    const terms = analyzeJD(jd).keywords.map((k) => k.term);
    assert.ok(terms.length > 0);
    assert.ok(!terms.some((t) => /[./-]$/.test(t)), 'a term ends in punctuation: ' + terms.join(' | '));
    // Scoped to the role sections: the employer and the benefits never rank.
    for (const word of company.toLowerCase().split(' ').concat('benefits')) {
      assert.ok(!terms.slice(0, 8).some((t) => t.split(' ').includes(word)), word + ' ranked in the top 8');
    }
  }
  assert.equal(analyzeJD(ICU_JD).keywords[0].term, 'patients');

  // A JD with no section headings is counted whole; there the employer name is
  // kept out by the exclude option, and "returns." folds into "returns".
  const prose = 'Bramble Lane Advisory seeks a preparer. Bramble Lane Advisory files partnership returns. You review returns. Bramble Lane Advisory values accuracy in returns.';
  assert.ok(analyzeJD(prose).keywords.some((k) => k.term === 'bramble'));
  const scrubbed = analyzeJD(prose, { exclude: ['Bramble Lane Advisory'] }).keywords;
  assert.ok(!scrubbed.some((k) => /bramble|lane|advisory/.test(k.term)));
  assert.deepEqual(scrubbed[0], { term: 'returns', count: 3 });
  assert.ok(!tailorBrief(prose, null, { exclude: ['Bramble Lane Advisory'] }).coverage.topJdTerms.some((t) => /bramble/.test(t)));
});

test('stripHtml keeps block boundaries and decodes entities', () => {
  assert.equal(stripHtml('<p>One&nbsp;line</p><p>Two<br>Three</p>'), 'One line\nTwo\nThree');
  assert.equal(decodeHtmlEntities('R&amp;D &#65;&#x42; &unknown; &#99999999;'), 'R&D AB    ');
});

test('word and skill canonicalization helpers are deterministic', () => {
  assert.equal(countWords('one two three'), 3);
  assert.equal(canonicalSkill(' Excel (advanced) '), 'excel');
});

// ── gap detection ───────────────────────────────────────────────────────────

const ACCOUNTANT_JD = [
  'Tax accountant. Prepare tax returns and reconciliation schedules in QuickBooks.',
  'QuickBooks is used daily; QuickBooks certification is welcome. Tax returns are filed through Ledgerflow.',
  'Ledgerflow experience matters: Ledgerflow exports feed every reconciliation. Bookpilot is the review tool; Bookpilot queues are checked daily in Bookpilot.',
].join(' ');

test('tailorBrief credits the baseline skills block, then the workspace evidence index', () => {
  const top = tailorBrief(ACCOUNTANT_JD).coverage;
  for (const term of ['quickbooks', 'ledgerflow', 'bookpilot']) assert.ok(top.topJdTerms.includes(term), `fixture: ${term} must be a top JD term`);
  // No bullet names any of the three tools: all read as gaps.
  assert.ok(top.gaps.includes('quickbooks') && top.gaps.includes('ledgerflow') && top.gaps.includes('bookpilot'));
  // Evidence carried by a bullet is never a gap.
  assert.ok(!top.gaps.includes('tax returns') && !top.gaps.includes('reconciliation'));

  // A skill the baseline lists is credited even though no bullet names it.
  const withSkills = tailorBrief(ACCOUNTANT_JD, { skills: { Software: 'QuickBooks, Excel' } }).coverage;
  assert.ok(!withSkills.gaps.includes('quickbooks'));
  assert.ok(withSkills.gaps.includes('ledgerflow'));

  // No index in the workspace: the step is skipped.
  assert.equal(corpusTools(), null);

  // A tool present in the user's evidence index is credited, directly or
  // through an alias the index carries.
  write('data/evidence-index.json', { toolPresence: { ledgerflow: ['books-repo'], 'review-queue': ['books-repo'] }, aliases: { bookpilot: 'review-queue' } });
  const withIndex = tailorBrief(ACCOUNTANT_JD, { skills: { Software: 'QuickBooks, Excel' } }).coverage;
  assert.deepEqual(withIndex.gaps.filter((g) => ['quickbooks', 'ledgerflow', 'bookpilot'].includes(g)), []);
  assert.ok(corpusTools().tools.has('ledgerflow'));
  assert.equal(corpusTools().aliases.bookpilot, 'review-queue');
  assert.equal(typeof TOOL_ALIAS, 'object');
});

// ── auditResume ─────────────────────────────────────────────────────────────

function fixture() {
  const bullet = 'Cut medication errors 38% across a 24 bed unit by introducing a double check protocol with 3 verification steps for high alert drugs.';
  return {
    name: 'Avery Quinn',
    contact: { email: 'avery@example.com', phone: '555-555-0100', location: 'Springfield' },
    summary: 'Registered nurse with six years across medical surgical and step down units, known for calm triage, clear handoffs, and steady preceptorship of new graduates. Builds dependable shift routines, measurable safety improvements, and patient education that families can follow at home after discharge from the unit.',
    experience: [
      { title: 'Charge Nurse', company: 'Lakeside Medical Center', location: 'Springfield', dates: '2022 to Present', subtitle: 'Medical surgical unit.', bullets: Array.from({ length: 10 }, () => bullet) },
    ],
    selectedProjects: [
      { name: 'Falls Prevention Round', summary: 'Designed an hourly rounding checklist with bed alarm audits and family teaching that the unit kept after the pilot ended.' },
      { name: 'Preceptor Guide', summary: 'Wrote a week by week orientation guide for new graduates covering handoff, charting, and escalation for a busy unit.' },
    ],
    skills: { Clinical: 'Triage, Wound care, IV therapy', Systems: 'Electronic charting, Barcode medication administration' },
    education: [{ degree: 'B.S. Nursing', school: 'Example State University', location: 'Springfield', dates: '2014 to 2018' }],
    whyCompany: 'Your hospital opened a dedicated step down unit in 2024 and published its nurse to patient ratio policy, which matches how I run a safe shift.',
  };
}

test('auditResume catches summary, project, and duplicate-skill defects', () => {
  const resume = fixture();
  resume.summary = Array.from({ length: 81 }, () => 'signal').join(' ');
  // 4 role relevant projects are allowed; only 5+ is excessive.
  resume.selectedProjects.push({ name: 'Third', summary: 'A concise third project.' });
  resume.selectedProjects.push({ name: 'Fourth', summary: 'A concise fourth project.' });
  resume.selectedProjects.push({ name: 'Fifth', summary: 'A concise fifth project.' });
  resume.skills.Clinical += ', Telemetry, Telemetry (step down)';
  const audit = auditResume(resume);
  assert.ok(audit.issues.some((i) => /summary is 81 words/.test(i)));
  assert.ok(audit.issues.some((i) => /5 selected projects/.test(i)));
  assert.ok(audit.issues.some((i) => /duplicate skills: telemetry \(2x\)/.test(i)));
  assert.equal(audit.summaryWordCount, 81);
  assert.equal(audit.projectCount, 5);
});

test('4 projects are allowed', () => {
  const resume = fixture();
  resume.selectedProjects.push({ name: 'Third', summary: 'A concise third project.' });
  resume.selectedProjects.push({ name: 'Fourth', summary: 'A concise fourth project.' });
  const audit = auditResume(resume);
  assert.equal(audit.projectCount, 4);
  assert.ok(!audit.issues.some((i) => /selected projects/.test(i)));
});

test('auditResume gates on rendered pages and fill against the page target, never on word count', () => {
  const resume = fixture();
  resume.selectedProjects[0].summary = Array.from({ length: 66 }, () => 'evidence').join(' ');
  resume.experience[0].bullets = Array.from({ length: 70 }, () => 'Reduced falls 22% on a 24 bed unit with 3 rounding checks for every patient at risk.');
  // Oversized project summaries are still a hard issue.
  const advisory = auditResume(resume);
  assert.ok(advisory.issues.some((i) => /selected project 1 is 66 words/.test(i)));
  // Total word count is NEVER a hard failure: the rendered page is authoritative.
  assert.ok(!advisory.issues.some((i) => /word count/.test(i)));
  assert.ok(advisory.warnings.some((w) => /word count/.test(w)));

  // With a page target, sizing gates on the render.
  const two = { targetPages: 2 };
  assert.ok(auditResume(fixture(), '', { ...two, pageMetrics: { pages: 3 } }).issues.some((i) => /renders 3 pages/.test(i)));
  assert.ok(auditResume(fixture(), '', { ...two, pageMetrics: { pages: 1 } }).issues.some((i) => /renders only 1 page /.test(i)));
  assert.ok(auditResume(fixture(), '', { ...two, pageMetrics: { pages: 2, lastPageFill: 0.6 } }).issues.some((i) => /page 2 is only 60% full/.test(i)));
  assert.ok(!auditResume(fixture(), '', { ...two, pageMetrics: { pages: 2, lastPageFill: 0.9 } }).issues.some((i) => /renders|is only/.test(i)));
  // The fill minimum is the caller's: opts.minFill, else the one the page
  // measurement carries, else 0.85.
  const at75 = (pm, opts = {}) => auditResume(fixture(), '', { ...two, ...opts, pageMetrics: { pages: 2, lastPageFill: 0.75, ...pm } }).issues.filter((i) => /is only/.test(i));
  assert.match(at75({})[0], /page 2 is only 75% full.*target at least 88%/);
  assert.deepEqual(at75({ minFill: 0.7 }), []);
  assert.deepEqual(at75({}, { minFill: 0.7 }), []);
  assert.match(at75({ minFill: 0.7 }, { minFill: 0.8 })[0], /75% full.*target at least 83%/, 'opts.minFill wins over the measurement');
  assert.equal(at75({ minFill: 'x' }).length, 1, 'a malformed minimum falls back to 0.85');
  // A one page target is a valid choice for a short history.
  assert.ok(!auditResume(fixture(), '', { targetPages: 1, pageMetrics: { pages: 1, lastPageFill: 0.9 } }).issues.some((i) => /renders|is only/.test(i)));
  assert.ok(auditResume(fixture(), '', { targetPages: 1, pageMetrics: { pages: 2 } }).issues.some((i) => /must be at most 1/.test(i)));

  // No target (the profile default): page fill is never an issue; only an
  // over-length warning remains.
  const none = auditResume(fixture(), '', { pageMetrics: { pages: 1, lastPageFill: 0.2 } });
  assert.ok(!none.issues.some((i) => /renders|is only/.test(i)));
  const long = auditResume(fixture(), '', { pageMetrics: { pages: 4 } });
  assert.ok(!long.issues.some((i) => /renders/.test(i)));
  assert.ok(long.warnings.some((w) => /renders 4 pages/.test(w)));
});

test('auditResume attribution: the baseline current role leads, newest first, degrees preserved', () => {
  const baseline = {
    experience: [{ company: 'Lakeside Medical Center' }, { company: 'Northfield Clinic' }],
    education: [{ degree: 'B.S. Nursing' }],
  };
  const shape = /must lead|reverse-chronological|baseline degree/;
  assert.ok(!auditResume(fixture(), '', { baseline }).issues.some((i) => shape.test(i)));

  const wrongLead = fixture();
  wrongLead.experience.unshift({ title: 'Staff Nurse', company: 'Northfield Clinic', dates: '2023 to Present', bullets: [] });
  assert.ok(auditResume(wrongLead, '', { baseline }).issues.some((i) => /"Northfield Clinic".*"Lakeside Medical Center".*must lead/.test(i)));

  const outOfOrder = fixture();
  outOfOrder.experience.push(
    { title: 'Nurse Aide', company: 'Hillcrest Care', dates: '2016 to 2018', bullets: [] },
    { title: 'Staff Nurse', company: 'Northfield Clinic', dates: '2018 to 2022', bullets: [] },
  );
  assert.ok(auditResume(outOfOrder, '', { baseline }).issues.some((i) => /reverse-chronological/.test(i)));

  const lostDegree = fixture();
  lostDegree.education = [{ degree: 'Associate Degree', school: 'Example State University' }];
  assert.ok(auditResume(lostDegree, '', { baseline }).issues.some((i) => /baseline degree is missing or altered: B\.S\. Nursing/.test(i)));

  // Punctuation, case, and a longer legal name never count as a different employer or degree.
  const loose = fixture();
  loose.experience[0].company = 'LAKESIDE MEDICAL CENTER, INC.';
  loose.education[0].degree = 'BS Nursing';
  assert.ok(!auditResume(loose, '', { baseline }).issues.some((i) => shape.test(i)));

  // No baseline (a fresh workspace, or an explicit null): the checks are skipped.
  assert.ok(!auditResume(wrongLead, '', { baseline: null }).issues.some((i) => /must lead|baseline degree/.test(i)));
  assert.ok(!auditResume(lostDegree).issues.some((i) => /must lead|baseline degree/.test(i)));

  // A missing education section is always an issue.
  const noEducation = fixture();
  delete noEducation.education;
  assert.ok(auditResume(noEducation, '', { baseline: null }).issues.some((i) => /education section is missing/.test(i)));
});

test('auditResume JD coverage works on any field vocabulary', () => {
  const jd = 'Charge nurse for a medical surgical unit. Medication safety, falls prevention, rounding, and discharge teaching. Medication safety audits weekly. Falls prevention rounding every shift.';
  const covered = auditResume(fixture(), jd);
  assert.ok(covered.jdCoverage && covered.jdCoverage.top > 0);
  const offTopic = auditResume(fixture(), 'Tax accountant preparing partnership returns, depreciation schedules, payroll filings, and sales tax reconciliations. Partnership returns and payroll filings every quarter. Depreciation schedules reviewed monthly.');
  assert.ok(offTopic.issues.some((i) => /JD-vocabulary coverage/.test(i)));
});

test('auditResume JD gates never ask for the employer name or boilerplate (nurse and accountant)', () => {
  const gates = /JD-vocabulary coverage|requirement->bullet|center-of-gravity/;
  const nurse = fixture();
  nurse.company = 'Cedar Ridge Health';
  nurse.summary = 'Registered nurse who delivers intensive care to critically ill and ventilated patients on a 16 bed unit. ' + nurse.summary;
  nurse.experience[0].bullets = [
    'Assess and monitor critically ill patients on a 16 bed intensive care unit, cutting medication errors 38%.',
    'Titrate vasoactive drips and manage ventilated patients per protocol across 3 shifts.',
    ...nurse.experience[0].bullets.slice(2),
  ];
  const a = auditResume(nurse, ICU_JD, { baseline: null });
  assert.deepEqual(a.jdCoverage.missing, []);
  assert.ok(!a.issues.some((i) => gates.test(i)), a.issues.join('\n'));

  // No section headings (counted whole): the company on the resume JSON is
  // what keeps the employer name out of the gates.
  const prose = 'Bramble Lane Advisory seeks a preparer. Bramble Lane Advisory files partnership returns. Bramble Lane Advisory reviews partnership returns for accuracy.';
  const acct = fixture();
  acct.experience[0].bullets = ['Prepared 340 partnership returns per season.', 'A preparer who reviews partnership returns for accuracy and files 98% on first pass.', ...acct.experience[0].bullets.slice(2)];
  assert.ok(auditResume(acct, prose, { baseline: null }).jdCoverage.missing.includes('bramble'));
  acct.company = 'Bramble Lane Advisory';
  const b = auditResume(acct, prose, { baseline: null });
  assert.ok(!b.jdCoverage.missing.some((t) => /bramble|lane|advisory/.test(t)), b.jdCoverage.missing.join(', '));
});

test('auditResume: a ledger code or part number is not an AI tell; a field metric name is not itself a metric', () => {
  const tell = /AI\/code-inventory tell/;
  const resume = fixture();
  resume.experience[0].bullets[0] = 'Reconciled account 6100.1000 against 340 vendor statements each month end.';
  assert.ok(!auditResume(resume).issues.some((i) => tell.test(i)));
  resume.experience[0].bullets[0] = 'Summarized arXiv preprints for the unit journal club.';
  assert.ok(auditResume(resume).issues.some((i) => tell.test(i)));
  // "public-index" used to count as a metric through an unbounded substring.
  const plain = fixture();
  plain.experience[0].bullets = Array.from({ length: 10 }, () => 'Maintained the public-index of ward guidance for new starters.');
  assert.equal(auditResume(plain).metricDensity, 0);
});

test('renderedResumeText covers every rendered field, awards included', () => {
  const resume = fixture();
  resume.awards = ['Unit Excellence Award 2023'];
  const text = renderedResumeText(resume);
  assert.match(text, /Unit Excellence Award/);
  assert.match(text, /Lakeside Medical Center/);
  assert.ok(!text.includes(resume.whyCompany), 'whyCompany is not rendered into the resume');
});

// ── auditProse ──────────────────────────────────────────────────────────────

test('auditProse flags validated flourish words, advisory only, no verdict', () => {
  const hit = auditProse('I would delve into the intricate tapestry of your mission and showcase pivotal, meticulous work.');
  assert.ok(!hit.ok);
  assert.ok(hit.strongMarkers.includes('delve') && hit.strongMarkers.includes('tapestry'));
  assert.ok(hit.advisory.length >= 1);
  assert.equal(typeof hit.markerVersion, 'string');
  assert.ok(!('isAI' in hit) && !('verdict' in hit));
});

test('auditProse does not flag plain evidence first prose', () => {
  const clean = auditProse('I rebuilt the handoff sheet so each nurse confirms allergies, lines, and pending labs; missed items fell from 14 to 2 a month.');
  assert.ok(clean.ok);
  assert.equal(clean.strongMarkers.length, 0);
  assert.equal(clean.advisory.length, 0);
});

// ── render path gates ───────────────────────────────────────────────────────

test('scanCodenames reads the user forbidden terms from the profile when none are passed', () => {
  assert.deepEqual(scanCodenames('Ran project falcon for two seasons'), ['project falcon']);
  assert.deepEqual(scanCodenames('Led the Zephyr rollout and the Project-Falcon pilot').sort(), ['Project-Falcon', 'Zephyr']);
  // Whole terms only: a longer word that contains a term is clean.
  assert.deepEqual(scanCodenames('zephyrs and falconry are not on the list'), []);
  assert.deepEqual(scanCodenames('Prepared 340 returns for small business clients'), []);
});

test('scanCodenames with an explicit list; an empty list never matches', () => {
  assert.deepEqual(scanCodenames('Closed the books for Bluebird Bakery', ['Bluebird Bakery']), ['Bluebird Bakery']);
  assert.deepEqual(scanCodenames('Ran Project Falcon', []), []);
  assert.deepEqual(scanCodenames('Ran Project Falcon', ['', '   ', null]), []);
  // Regex characters in a term are literal.
  assert.deepEqual(scanCodenames('the C++ (legacy) ledger', ['C++ (legacy)']), ['C++ (legacy)']);
});

test('scanPositioningVocab catches internal framework words, ignores generic words', () => {
  assert.ok(scanPositioningVocab('a barbell plan that stays antifragile').includes('barbell'));
  assert.ok(scanPositioningVocab('skin in the game').includes('skin in the game'));
  assert.deepEqual(scanPositioningVocab('matrix inversion and the emergence of a clear schedule'), []);
  assert.deepEqual(scanPositioningVocab('prepared quarterly estimates and reconciled every ledger'), []);
});

test('auditCoverLetter flags a generic letter missing all three elements', () => {
  const bad = auditCoverLetter('I am excited about this role and I am a great fit for your team culture.');
  assert.equal(bad.ok, false);
  assert.equal(bad.issues.length, 3);
  assert.equal(auditCoverLetter('').ok, false);
});

test('auditCoverLetter passes outcome + leadership + decision in two unrelated professions', () => {
  const nurse = auditCoverLetter('As charge nurse I led a team of 6 and cut medication errors 38% in one year. The audit showed most errors came at shift change, so the unit adopted a double check at handoff.');
  assert.equal(nurse.ok, true, JSON.stringify(nurse.issues));
  const accountant = auditCoverLetter('I managed a seasonal staff of four preparers and closed 340 returns with no late filings. My review of extension requests found $48,000 in missed deductions, and the partners decided to change the intake checklist.');
  assert.equal(accountant.ok, true, JSON.stringify(accountant.issues));
});

test('auditCoverLetter: tenure is not an outcome, and inflected decision words match', () => {
  const tenureOnly = auditCoverLetter('I have 12 years of experience and I led the day shift. We reprioritized nothing.');
  assert.ok(tenureOnly.issues.some((i) => /measurable outcome/.test(i)));
  // A contentless letter fails all three: a bare number in passing, "owned"
  // or "changed" without an object, and a duration are not substance.
  const empty = auditCoverLetter('Dear team, I am writing on June 12 about the opening. For 30 days I was a hard worker who owned my schedule and I have changed a lot as a person. I would love to join.');
  assert.equal(empty.issues.length, 3, JSON.stringify(empty.issues));
  const thin = auditCoverLetter('I am writing on June 12 about the opening at your Fortune 500 company. I owned my schedule, managed many projects, and I have changed a lot as a person.');
  assert.ok(thin.issues.some((i) => /measurable outcome/.test(i)) && thin.issues.some((i) => /decision-grade/.test(i)));
  // The shapes the mode text illustrates, in two professions.
  for (const ok of [
    'Readmissions fell 18 percent over two quarters. I trained 22 nurses through the rollout. The unit adopted the three session format as its standard.',
    'The restructure meant 210,000 dollars lower state tax in the first year. I owned the filing calendar for 140 client returns. The client approved moving where inventory is held.',
    'I closed 140 client returns, led 8 preparers across 5 offices, and recommended that the partners change how extensions are tracked.',
  ]) assert.deepEqual(auditCoverLetter(ok).issues, []);
  const inflected = auditCoverLetter('I supervised 14 volunteers and the board reallocated the outreach budget after my review.');
  assert.equal(inflected.ok, true, JSON.stringify(inflected.issues));
});

// ── JD sections and keywords on realistic posting shapes ────────────────────

const top = (jd, n, opts) => analyzeJD(jd, opts).keywords.slice(0, n).map((k) => k.term);

test('analyzeJD: when only one section heading is recognized the keywords come from the whole JD', () => {
  // The duties sit under a heading this parser does not know.
  const jd = [
    'Registered Nurse, ICU',
    "What you'll be doing",
    '\u2022 Deliver ICU care to ventilated ICU patients on a 16 bed ICU.',
    '\u2022 Titrate drips and document ICU assessments every hour.',
    '\u2022 Hand over each ICU patient to the incoming ICU nurse.',
    'Requirements',
    '\u2022 Active license in good standing with the state board.',
    '\u2022 Minimum two years of bedside practice in a hospital.',
  ].join('\n');
  const out = analyzeJD(jd);
  assert.equal(out.responsibilities.length, 0);
  assert.equal(out.qualifications.length, 2);
  assert.equal(out.keywords[0].term, 'icu');
  assert.equal(out.keywords[0].count, 7);

  // The mirror case for an accountant: duties heading known, requirements not.
  const acct = analyzeJD([
    'Tax Accountant',
    'Responsibilities',
    '- Prepare partnership returns and reconcile the general ledger each month.',
    'The ideal candidate',
    '- Has prepared partnership returns for three seasons; partnership work is most of this desk.',
  ].join('\n'));
  assert.equal(acct.qualifications.length, 0);
  assert.deepEqual(acct.keywords[0], { term: 'partnership', count: 3 });
});

test('analyzeJD: a heading that shares its line with content still bounds a section', () => {
  const inline = analyzeJD([
    'Staff Nurse',
    'Responsibilities: Provide direct patient care to adults on a surgical ward per protocol.',
    'Monitor ventilated patients and escalate any deterioration to the charge nurse.',
    'Requirements: Active RN license in good standing with the state board.',
    'BLS and ACLS certification, both current at the date of hire.',
    'Benefits: We offer health insurance and a retirement match to every employee.',
  ].join('\n'));
  assert.equal(inline.responsibilities.length, 2);
  assert.match(inline.responsibilities[0], /^Provide direct patient care/, 'content on the heading line is kept, the label is not');
  assert.equal(inline.qualifications.length, 2);
  assert.ok(!inline.responsibilities.some((s) => /Requirements|license|insurance/.test(s)));
  assert.ok(!inline.qualifications.some((s) => /Benefits|insurance/.test(s)));
  assert.equal(inline.keywords.find((k) => k.term === 'license').count, 1, 'no token is counted twice');

  const mixed = analyzeJD([
    'Payroll Accountant',
    'Responsibilities',
    '- Run the fortnightly payroll for 400 staff and reconcile the control account.',
    'Requirements',
    '- Part qualified accountant with two years in a payroll or ledger role.',
    'Compensation: The salary for this post is set by the national pay scale.',
    'Benefits: A pension, a cycle scheme, and 28 days of annual leave.',
  ].join('\n'));
  assert.equal(mixed.qualifications.length, 1);
  assert.ok(!mixed.qualifications.some((s) => /Compensation|Benefits|pension/.test(s)));

  // A lead in sentence that ends in a colon is a heading however long it is;
  // a later sentence that merely contains the phrase and a colon is not.
  const lead = analyzeJD([
    'As a tax senior on the private client desk, you will:',
    '\u2022 Prepare trust and estate returns for forty households each season.',
    '\u2022 Review the work of two juniors before partner sign off.',
    'Why you will enjoy working with this group: the partners answer the phone.',
    'Requirements',
    '\u2022 A recognized tax qualification and three seasons in practice.',
  ].join('\n'));
  assert.equal(lead.responsibilities.length, 3);
  assert.match(lead.responsibilities[0], /trust and estate returns/);
  assert.equal(lead.qualifications.length, 1);
});

test('analyzeJD: a JD flattened to one line is read by mention, UK and clinical headings included', () => {
  const nurse = analyzeJD('Staff Nurse. Essential Functions \u2022 Assess and monitor patients on a 24 bed surgical unit \u2022 Explain discharge plans to patients and families Education and Experience \u2022 Active registered nurse license in good standing \u2022 Two years of acute care nursing in a hospital Benefits \u2022 Tuition support and a retirement match for all staff');
  assert.equal(nurse.responsibilities.length, 2);
  assert.equal(nurse.qualifications.length, 2);
  assert.ok(!nurse.qualifications.some((s) => /Tuition/.test(s)));

  const uk = analyzeJD('Management Accountant. Main duties: prepare monthly management accounts for trustees; lead the year end audit file with external auditors; Person Specification: professionally qualified accountant with charity exposure; confident with fund accounting and statutory reporting; What we offer: a pension and 28 days of leave');
  assert.equal(uk.responsibilities.length, 2);
  assert.equal(uk.qualifications.length, 2);
  assert.ok(!uk.qualifications.some((s) => /pension/.test(s)));
});

test('analyzeJD: trailing sections under unlisted headings do not change the keywords', () => {
  const base = [
    'Cardiac Nurse',
    'Responsibilities',
    '\u2022 Coordinate cardiac discharge planning and telephone follow up for cardiac patients.',
    '\u2022 Teach medication plans to cardiac patients and their families.',
    'Qualifications',
    '\u2022 Registered nurse license in good standing.',
    '\u2022 Two years of cardiac or telemetry nursing.',
    'Nice to have',
    '\u2022 Case management certification.',
  ];
  const trailing = base.concat([
    'Schedule',
    'Monday to Friday, 8am to 5pm Mountain time, with one weekend in six.',
    'Pay range',
    'The pay range for this position is 82,000 to 96,000 dollars per year.',
    'Why join us',
    'We offer medical, dental, and vision coverage from the first day.',
    'Generous paid time off and tuition reimbursement for every nurse.',
    'Example Health Partners is an equal opportunity employer.',
  ]);
  const a = analyzeJD(base.join('\n'));
  const b = analyzeJD(trailing.join('\n'));
  assert.deepEqual(b.keywords, a.keywords);
  assert.equal(a.keywords[0].term, 'cardiac');
  // The sub heading inside the list does not end it.
  assert.ok(analyzeJD(trailing.join('\n'), { terms: 200 }).keywords.some((k) => k.term === 'case management'));
  assert.ok(a.qualifications.some((s) => /Case management/.test(s)));
});

test('analyzeJD: overlapping sections are counted once (qualifications listed before duties)', () => {
  const jd = analyzeJD([
    'Tax Senior',
    'Minimum qualifications',
    '\u2022 Enrolled agent credential and three seasons in public practice.',
    'Responsibilities',
    '\u2022 Prepare fiduciary returns and review fiduciary workpapers each week.',
  ].join('\n'));
  assert.equal(jd.keywords.find((k) => k.term === 'fiduciary').count, 2);
});

test('analyzeJD: the employer name is set aside, a name word that is also the field word still ranks', () => {
  const tax = [
    'Tax Accountant at Summit Tax Advisory',
    'Summit Tax Advisory is a regional firm. Summit Tax Advisory serves small business clients.',
    'Responsibilities',
    '\u2022 Prepare partnership and small business tax returns.',
    '\u2022 Research multistate tax questions for clients.',
    'Requirements',
    '\u2022 Three seasons preparing tax returns in public practice.',
    '\u2022 Working knowledge of tax research software.',
  ].join('\n');
  const named = top(tax, 8, { exclude: ['Summit Tax Advisory'] });
  assert.equal(named[0], 'tax');
  assert.ok(named.includes('tax returns'));
  const all = analyzeJD(tax, { exclude: ['Summit Tax Advisory'], terms: 500 }).keywords.map((k) => k.term);
  assert.ok(!all.some((t) => /summit|advisory/.test(t)));

  // No section headings, so the whole text is counted: the four employer
  // mentions do not inflate "health", which the JD uses once on its own.
  const prose = 'Mercy Valley Health is hiring. Mercy Valley Health nurses assess patients, teach patients, and discharge patients. Mercy Valley Health values safety. Staff at Mercy Valley Health receive health insurance.';
  const k = analyzeJD(prose, { exclude: ['Mercy Valley Health'] }).keywords;
  assert.equal(k[0].term, 'patients');
  assert.equal(k.find((x) => x.term === 'health').count, 1);
  assert.ok(!k.some((x) => /mercy|valley/.test(x.term)));

  // The gate sees the field word: a resume that never says tax is told so.
  const acct = fixture();
  acct.company = 'Summit Tax Advisory';
  assert.ok(auditResume(acct, tax, { baseline: null }).jdCoverage.missing.includes('tax'));
});

test('analyzeJD: function words never rank, and opts.terms sets how many keywords return', () => {
  const prose = 'About the ward: you would be one of those nurses who, through every shift, does more than others. Why not? Because there is no other ward like this one, and such wards are rare. Triage is constant here; triage is the job, and triage is taught.';
  const k = analyzeJD(prose, { terms: 200 }).keywords;
  assert.equal(k[0].term, 'triage');
  for (const w of ['about', 'through', 'every', 'than', 'others', 'why', 'not', 'because', 'there', 'other', 'like', 'such', 'would', 'those', 'does']) {
    assert.ok(!k.some((x) => x.term.split(' ').includes(w)), w + ' ranked');
  }
  assert.equal(analyzeJD(ICU_JD).keywords.length, 25);
  assert.equal(analyzeJD(ICU_JD, { terms: 5 }).keywords.length, 5);
  assert.ok(analyzeJD(ICU_JD, { terms: 100 }).keywords.length > 25);
});

// ── whyCompany anchor ───────────────────────────────────────────────────────

test('whyCompany anchor: a named thing, a figure, or a quoted phrase passes in any profession; praise does not', () => {
  const good = [
    // nursing
    ['Lakeside Regional', 'Lakeside Regional runs the only Level I trauma center in the region and holds Magnet designation, which is why new graduates stay.'],
    ['Lakeside Regional', 'Your cardiac step down team keeps readmissions low in the first 72 hours at home, the transition I have worked on for years.'],
    ['Lakeside Regional', 'The nurse residency you built with the state Board of Nursing is the reason I am applying to this unit.'],
    ['Lakeside Regional', 'I want to practice on a unit that publishes its falls data, as yours did in the "Safer Wards" report.'],
    // accounting
    ['Harbor Ledger Partners', 'Your practice files for 340 small farms, the client base I have prepared returns for since I qualified.'],
    ['Harbor Ledger Partners', 'The way your partners wrote about Making Tax Digital for sole traders matches how I explain filing to clients.'],
    ['Harbor Ledger Partners', 'Harbor Ledger Partners moved its audit clients to FRS 102 early, and that transition work is what I do best.'],
    // teaching
    ['Maple Fork School District', 'Your district moved every elementary school to the Wilson Reading System, the structured literacy program I trained in.'],
    ['Maple Fork School District', 'The dual language strand you opened in 2023 is where my bilingual certification would be used every day.'],
    ['Maple Fork School District', 'Your board adopted a policy it calls \u201cno zeros before a retake\u201d, which is how I already grade in third grade.'],
  ];
  const bad = [
    // nursing
    ['Lakeside Regional', 'I admire your commitment to excellent patient care and would love to grow with a team that values compassion.'],
    ['Lakeside Regional', 'I have always wanted to work at Lakeside Regional because of its great reputation and its caring culture.'],
    ['Lakeside Regional', 'Your hospital is known for its service to patients and its mission, and that standard of care inspires me.'],
    ['Lakeside Regional', 'Lakeside is a place where nurses are supported, and I believe my values align with the values of Lakeside Regional.'],
    // accounting
    ['Harbor Ledger Partners', 'Your firm has a strong reputation for client service and a collaborative culture where I could keep learning.'],
    ['Harbor Ledger Partners', 'I am excited by the opportunity to bring my skills to a growing firm with an impressive platform and product.'],
    ['Harbor Ledger Partners', 'Harbor Ledger Partners is an industry leader, and joining Harbor would be a wonderful next step in my career.'],
    // teaching
    ['Maple Fork School District', 'Your district moved every elementary school to a structured literacy curriculum, and the reading coaches are the support I want.'],
    ['Maple Fork School District', 'I am passionate about education and believe every child deserves a great teacher in a welcoming school community.'],
    ['Maple Fork School District', 'Maple Fork School District has wonderful students and families, and I would be proud to teach in the District.'],
    // the candidate's own tenure is a figure, but not a fact about the employer
    ['Lakeside Regional', 'I am excited to join Lakeside Regional because I bring 9 years of bedside experience and a deep passion for compassionate care, teamwork, and lifelong learning in a supportive environment.'],
    ['Harbor Ledger Partners', 'With 12+ yrs in practice and a 6-year record of clean reviews, I would love to grow with a firm that values integrity and hard work.'],
  ];
  for (const [company, why] of good) assert.ok(whyHasAnchor(why, company), 'should pass: ' + why);
  for (const [company, why] of bad) assert.ok(!whyHasAnchor(why, company), 'should be flagged: ' + why);
  // Without the company the employer name itself reads as a proper noun.
  assert.ok(whyHasAnchor(bad[1][1], ''));

  // Through the audit: the same gate, with the employer taken from the resume.
  const flagged = (why, company) => {
    const r = fixture();
    r.company = company;
    r.whyCompany = why;
    return auditResume(r, undefined, { baseline: null }).issues.some((i) => /lacks a specific anchor/.test(i));
  };
  // (The anchor check applies to a whyCompany of 120 or more characters.)
  const pad = ' That is the setting I have worked toward, and it is why I am applying here.';
  assert.ok(!flagged(good[0][1] + pad, good[0][0]));
  assert.ok(flagged(bad[1][1] + pad, bad[1][0]), 'the employer name alone is not an anchor');
  assert.ok(flagged(bad[7][1] + pad, bad[7][0]), 'a specific with no name or figure is told to name one');
  assert.ok(!flagged(bad[7][1].replace('curriculum', 'curriculum in 2023') + pad, bad[7][0]));
  assert.ok(flagged(bad[10][1], bad[10][0]), 'a count of years is not an anchor');
  // A figure about the employer still counts when a tenure sits beside it.
  assert.ok(whyHasAnchor('After 9 years at the bedside I want the unit that runs a 24 bed ward.', 'Lakeside Regional'));

  // No employer on the resume: the name cannot be set aside, and the audit says so.
  const noCompany = fixture();
  delete noCompany.company;
  noCompany.whyCompany = bad[1][1] + pad;
  const audit = auditResume(noCompany, undefined, { baseline: null });
  assert.ok(audit.warnings.some((w) => /resume\.company is not set/.test(w)));
  noCompany.company = bad[1][0];
  assert.ok(!auditResume(noCompany, undefined, { baseline: null }).warnings.some((w) => /resume\.company is not set/.test(w)));
});

// ── employer name removal, section bounds ───────────────────────────────────

test('analyzeJD: an employer name is removed only as written and as whole words', () => {
  const nurse = [
    'Staff Nurse',
    'Responsibilities',
    '- Provide wound care and palliative care to adults using Python based charting tools.',
    '- Plan care with the family and take part in production of the ground floor rota.',
    '- Offer mentorship to students; see wards.example.org/care-homes for the rota.',
    'Requirements',
    '- Two years of acute care practice and a current license.',
  ].join('\n');
  const plain = analyzeJD(nurse, { terms: 200 }).keywords;
  // Short names and a name that starts an ordinary word change nothing.
  for (const name of ['G P', 'Pro', 'Ment', 'Wards']) {
    assert.deepEqual(analyzeJD(nurse, { exclude: [name], terms: 200 }).keywords, plain, name);
  }
  for (const w of ['python', 'production', 'ground', 'mentorship', 'wards.example.org/care-homes']) {
    assert.ok(plain.some((k) => k.term === w), w);
  }
  // A one word name that is the field term is still counted where the JD uses it.
  const care = analyzeJD(nurse, { exclude: ['Care'], terms: 200 }).keywords;
  assert.deepEqual(care[0], { term: 'care', count: 4 });
  assert.ok(care.some((k) => k.term === 'wards.example.org/care-homes'), 'a web address stays one token');

  const acct = [
    'Audit Senior at Audit',
    'Responsibilities',
    '- Lead the audit of charity clients and review audit files.',
    '- Plan each audit with the partner.',
    'Requirements',
    '- Three years of audit work and a tax qualification.',
  ].join('\n');
  assert.deepEqual(analyzeJD(acct, { exclude: ['Audit'] }).keywords[0], { term: 'audit', count: 4 });

  // The name itself goes, whatever follows it, and a name the JD only writes
  // in another case never ranks.
  const firm = 'Responsibilities\n- Prepare returns for Harbor clients. Harbor\'s partners review them; HARBOR files on time.\nRequirements\n- Three seasons preparing returns in practice.';
  const k = analyzeJD(firm, { exclude: ['Harbor'], terms: 200 }).keywords.map((x) => x.term);
  assert.ok(!k.some((t) => /harbor/.test(t)), k.join(','));
  assert.ok(k.includes('returns'));
});

test('analyzeJD: bullets under an intro sentence stay in the keyword scope; trailing prose does not', () => {
  const jd = [
    'ICU Nurse',
    'Responsibilities',
    '- Deliver bedside care to ventilated adults and titrate drips per protocol.',
    'Requirements',
    '- Active RN license in good standing with the state board.',
    'Preferred',
    'Candidates with the following will stand out:',
    '- CCRN certification and ECMO experience',
    '- Experience with CRRT and Impella devices',
    'Schedule',
    'Three twelve hour shifts each week with one weekend in four.',
  ].join('\n');
  const k = analyzeJD(jd, { terms: 200 }).keywords.map((x) => x.term);
  for (const w of ['ccrn', 'ecmo', 'crrt', 'impella']) assert.ok(k.includes(w), w);
  assert.ok(!k.includes('weekend') && !k.includes('shifts'));
});

test('analyzeJD: a heading with no listable line under it falls back to the first mention', () => {
  // The label opens one long paragraph (over the line length a list item may
  // have), so the duties are read from the earlier sentence that states them.
  const para = 'A day in the life of a payroll accountant here involves running the fortnightly payroll for four hundred staff, reconciling the control account, answering pension queries from members, preparing the year end returns for the auditors, and keeping the ledger clean enough that the month end close takes two days instead of five';
  const jd = [
    'Payroll Accountant',
    'In this post you will run payroll and reconcile the control account each fortnight.',
    'What You Will Do: ' + para + '.',
    'Requirements:',
    '- Part qualified accountant with two years in a payroll or ledger role.',
  ].join('\n');
  assert.ok(para.length > 260);
  const out = analyzeJD(jd);
  assert.equal(out.responsibilities.length, 1);
  assert.match(out.responsibilities[0], /run payroll and reconcile/);
  assert.equal(out.qualifications.length, 1);
});

test('analyzeJD: a heading written in brackets at the end of a line opens the section', () => {
  const jd = analyzeJD([
    'Charge Nurse',
    'Your day to day (Key Responsibilities)',
    '- Run the shift huddle and assign patients by acuity for a 28 bed ward.',
    '- Flexible cover of the bleep at night (weekend duties)',
    'Your skills and background (Required Qualifications)',
    '- Registered nurse with five years on an acute medical ward.',
    '- Completed a recognized mentorship or preceptor course.',
    'What will set you apart (preferred qualifications):',
    '- Experience leading a ward through an inspection.',
  ].join('\n'));
  assert.equal(jd.responsibilities.length, 2, 'a list item ending in a bracket is not a heading');
  assert.equal(jd.qualifications.length, 4);
  assert.match(jd.qualifications[0], /^Registered nurse/);
});

test('analyzeJD: a list item with a heading word before a colon is not a heading (nurse and accountant)', () => {
  const nurse = analyzeJD([
    'Registered Nurse, Intensive Care Unit',
    '',
    'About the unit',
    'Our 24 bed ICU cares for medical and surgical patients.',
    '',
    'Responsibilities',
    '\u2022 Assess and monitor critically ill patients in a 24 bed ICU',
    '\u2022 Titrate vasoactive drips and manage ventilators per protocol',
    '\u2022 Physical requirements: able to lift 50 pounds and stand for a 12 hour shift',
    '\u2022 Chart assessments in the electronic health record each shift',
    '\u2022 Educate families about the plan of care and discharge needs',
    '',
    'Qualifications',
    '\u2022 Active RN license in good standing in the state',
    '\u2022 BLS and ACLS certification from the American Heart Association',
    '\u2022 Two years of ICU or step down experience preferred',
    '\u2022 CCRN certification within one year of hire',
    '',
    'Benefits',
    '\u2022 Medical, dental and vision coverage from day one',
  ].join('\n'));
  assert.equal(nurse.responsibilities.length, 5);
  assert.match(nurse.responsibilities[2], /^Physical requirements: able to lift/);
  assert.equal(nurse.qualifications.length, 4);
  assert.ok(!nurse.qualifications.some((s) => /lift|Chart|Educate|dental/.test(s)));

  const acct = analyzeJD([
    'Payroll and Benefits Accountant',
    '',
    "What You'll Do",
    '- Prepare and review monthly payroll journals and reconciliations',
    '- Other duties: cover the purchase ledger during the year end close',
    '- File quarterly payroll tax returns in six states',
    '',
    'Requirements',
    '- CPA license or progress toward one',
    '- Experience with employee benefits: 401(k), HSA and pension accounting',
    '- Four years of general ledger accounting experience',
    '- Travel requirements: two site visits each quarter to the regional offices',
    '',
    'What You Get',
    '- A pension match, a cycle scheme and 28 days of annual leave',
  ].join('\n'));
  assert.equal(acct.responsibilities.length, 3);
  assert.equal(acct.qualifications.length, 4);
  assert.ok(acct.qualifications.some((s) => /^Travel requirements:/.test(s)));
  assert.ok(!acct.qualifications.some((s) => /pension match/.test(s)), 'a perks list under its own heading is not a qualification');
});

// ── round 3: realistic heading variants, encoded markup, other scripts ──────

test('analyzeJD: "what you will bring", "skills and experience" and "job expectations" headings (nurse and accountant)', () => {
  const nurse = analyzeJD([
    'Registered Nurse, Day Surgery',
    'What you will do:',
    '\u2022 Admit and prepare patients for same day procedures on a 12 bay unit',
    '\u2022 Monitor recovery and teach discharge care to patients and families',
    'What you will bring:',
    '\u2022 An active registered nurse license in good standing',
    '\u2022 Two years of perioperative or acute care nursing',
    'What we offer you',
    '\u2022 Medical, dental and vision coverage from day one',
  ].join('\n'));
  assert.equal(nurse.responsibilities.length, 2);
  assert.equal(nurse.qualifications.length, 2);
  assert.ok(!nurse.responsibilities.some((s) => /license/.test(s)));
  assert.ok(!nurse.qualifications.some((s) => /dental/.test(s)));

  const acct = analyzeJD([
    'Senior Tax Accountant',
    'Job Expectations:',
    'Prepare partnership and corporate returns for a portfolio of forty clients',
    'Review workpapers prepared by two junior accountants each week',
    'Relevant Skills & Experience',
    'CPA license and five years in public accounting',
    'Working knowledge of multi state apportionment rules',
    'Benefits',
    'A retirement match and paid study leave for each exam sitting',
  ].join('\n'));
  assert.equal(acct.responsibilities.length, 2);
  assert.deepEqual(acct.qualifications, ['CPA license and five years in public accounting', 'Working knowledge of multi state apportionment rules']);
});

test('stripHtml: entity encoded markup, script and style blocks never reach the JD text', () => {
  const encoded = '&lt;h3&gt;Responsibilities&lt;/h3&gt;&lt;ul&gt;&lt;li class=&quot;x&quot;&gt;Reconcile supplier statements &amp;amp; resolve differences each month&lt;/li&gt;'
    + '&lt;li&gt;Prepare the quarterly sales tax return for three states&lt;/li&gt;&lt;/ul&gt;&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Two years of accounts payable experience in a finance team&lt;/li&gt;&lt;/ul&gt;';
  const text = stripHtml(encoded);
  assert.ok(!/[<>]|&lt;|class=/.test(text), text);
  assert.match(text, /Reconcile supplier statements & resolve differences/);
  const jd = analyzeJD(encoded);
  assert.equal(jd.responsibilities.length, 2);
  assert.equal(jd.qualifications.length, 1);
  assert.ok(!jd.keywords.some((k) => /^(?:li|ul|class|quot|amp)\b/.test(k.term)), 'markup ranked as a keyword');

  // Encoded markup inside real markup, and a data block in a script tag.
  const mixed = '<div><script type="application/ld+json">{"qualifications":"none","skills":"none"}</script><style>.a{color:red}</style>'
    + '&lt;p&gt;Assess patients at triage&lt;/p&gt;&lt;p&gt;Record observations hourly&lt;/p&gt;</div>';
  assert.equal(stripHtml(mixed), 'Assess patients at triage\nRecord observations hourly');
  // A literal comparison sign in plain text is not markup.
  assert.equal(stripHtml('Keep variance &lt; 5 percent and margin &gt; 20 percent'), 'Keep variance < 5 percent and margin > 20 percent');
});

test('analyzeJD keywords and employer names: letters of any script stay one word', () => {
  const jd = analyzeJD([
    'Bilanzbuchhalter',
    'Responsibilities',
    '- Erstellung der Jahresabschl\u00fcsse und der Umsatzsteuervoranmeldung f\u00fcr zw\u00f6lf Mandanten',
    '- Pr\u00fcfung der Jahresabschl\u00fcsse und Abstimmung der Konten mit der Kanzlei M\u00fcller',
    'Requirements',
    '- Abschluss als Bilanzbuchhalter und Erfahrung mit Jahresabschl\u00fcsse nach HGB',
  ].join('\n'), { exclude: ['M\u00fcller'], terms: 100 });
  const terms = jd.keywords.map((k) => k.term);
  assert.ok(terms.includes('jahresabschl\u00fcsse'), terms.join(','));
  assert.equal(jd.keywords.find((k) => k.term === 'jahresabschl\u00fcsse').count, 3);
  assert.ok(!terms.some((t) => /^jahresabschl$|^sse$|^pr$|^fung$/.test(t)), 'a word was split at its accented letter');
  assert.ok(!terms.some((t) => /m\u00fcller|^ller$/.test(t)), 'the employer name ranked');

  // The user's own vocabulary is matched folded: with or without the accent.
  for (const text of ['Responsable de la cl\u00f4ture mensuelle et des rapprochements.', 'Owns the Cloture Mensuelle calendar and audit support requests.']) {
    assert.ok(analyzeJD(text).stack.includes('cl\u00f4ture mensuelle'), text);
  }
  assert.ok(!analyzeJD('Owns the enclosure mensuelles calendar.').stack.includes('cl\u00f4ture mensuelle'));
});

test('countWords counts words in any script; plain ASCII counts are unchanged', () => {
  const ws = (t) => t.trim().split(/\s+/).length;
  for (const t of [
    'Prepared 340 individual and small business tax returns per season with a first-pass acceptance rate of 98%.',
    "Led the unit's night shift (C++ was not involved), cut errors 3.5x, and ran end-to-end audits.",
    'Infirmi\u00e8re dipl\u00f4m\u00e9e avec six ann\u00e9es en r\u00e9animation et en soins intensifs p\u00e9diatriques \u00e0 Lyon',
    '\u041c\u0435\u0434\u0438\u0446\u0438\u043d\u0441\u043a\u0430\u044f \u0441\u0435\u0441\u0442\u0440\u0430 \u0441 \u043e\u043f\u044b\u0442\u043e\u043c \u0440\u0430\u0431\u043e\u0442\u044b \u0432 \u0440\u0435\u0430\u043d\u0438\u043c\u0430\u0446\u0438\u0438',
    'Steuerberaterin mit zw\u00f6lf Jahren Erfahrung in der Pr\u00fcfung von Jahresabschl\u00fcssen',
  ]) assert.equal(countWords(t), ws(t), t);
  // Written without spaces: counted by the segmenter, never as zero or one.
  assert.ok(countWords('\u79c1\u306f\u6771\u4eac\u306e\u75c5\u9662\u3067\u516d\u5e74\u9593\u770b\u8b77\u5e2b\u3068\u3057\u3066\u50cd\u304d\u307e\u3057\u305f') >= 6);
  assert.equal(countWords(''), 0);
});

test('auditResume and whyHasAnchor on a resume written in another script (Cyrillic)', () => {
  const clinic = '\u041a\u043b\u0438\u043d\u0438\u043a\u0430 \u0417\u0434\u043e\u0440\u043e\u0432\u044c\u0435';
  const degree = '\u0411\u0430\u043a\u0430\u043b\u0430\u0432\u0440 \u0441\u0435\u0441\u0442\u0440\u0438\u043d\u0441\u043a\u043e\u0433\u043e \u0434\u0435\u043b\u0430';
  const word = '\u0441\u043c\u0435\u043d\u0430';
  const baseline = { experience: [{ company: clinic }], education: [{ degree }] };
  const resume = fixture();
  resume.summary = Array.from({ length: 49 }, () => word).join(' ');
  resume.experience[0].company = '\u041e\u041e\u041e \u00ab' + clinic + '\u00bb';
  resume.education = [{ degree, school: '\u041c\u0413\u041c\u0423' }];
  const ok = auditResume(resume, undefined, { baseline });
  assert.equal(ok.summaryWordCount, 49);
  assert.ok(!ok.issues.some((i) => /summary is|must lead|baseline degree/.test(i)), ok.issues.join(' | '));

  const altered = fixture();
  altered.experience[0].company = clinic;
  altered.education = [{ degree: '\u041c\u0430\u0433\u0438\u0441\u0442\u0440 \u0441\u0435\u0441\u0442\u0440\u0438\u043d\u0441\u043a\u043e\u0433\u043e \u0434\u0435\u043b\u0430' }];
  assert.ok(auditResume(altered, undefined, { baseline }).issues.some((i) => /baseline degree is missing or altered/.test(i)));
  const wrongLead = fixture();
  wrongLead.experience[0].company = '\u0411\u043e\u043b\u044c\u043d\u0438\u0446\u0430 \u2116 5';
  assert.ok(auditResume(wrongLead, undefined, { baseline }).issues.some((i) => /must lead/.test(i)));

  // The employer name alone is not an anchor; a named program is. Same rule as ASCII.
  const praise = '\u044f \u0445\u043e\u0447\u0443 \u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c \u0432 ' + clinic + ', \u043f\u043e\u0442\u043e\u043c\u0443 \u0447\u0442\u043e \u0443 \u043d\u0435\u0451 \u0445\u043e\u0440\u043e\u0448\u0430\u044f \u0440\u0435\u043f\u0443\u0442\u0430\u0446\u0438\u044f.';
  assert.ok(!whyHasAnchor(praise, clinic));
  assert.ok(whyHasAnchor(praise + ' \u0432\u0430\u0448\u0430 \u043f\u0440\u043e\u0433\u0440\u0430\u043c\u043c\u0430 \u0428\u043a\u043e\u043b\u0430 \u0434\u0438\u0430\u0431\u0435\u0442\u0430 \u043c\u043d\u0435 \u0431\u043b\u0438\u0437\u043a\u0430.', clinic));
  assert.ok(whyHasAnchor('The \u00c9cole de Sages-Femmes partnership is why I am applying.', 'Clinique Sainte-Anne'));
  assert.ok(!whyHasAnchor('I admire the caring culture of Clinique Sainte-Anne.', 'Clinique Sainte-Anne'));
});

test('auditResume: the "every bullet carries a metric" gate reads each bullet on its own', () => {
  const numbers = ['20 percent', '12 new nurses', '28 bed', '15%', '140 charts', '30 patients', '6 drills', '4 students', '9 to 4'];
  const bullets = numbers.map((n, i) => (i % 2 ? `Trained staff across the unit and reached ${n} by the end of the quarter.` : `Reached ${n} after a change to the handoff routine on the ward.`));
  const all = fixture();
  all.experience[0].bullets = bullets;
  assert.ok(auditResume(all, undefined, { baseline: null }).issues.some((i) => /every single bullet carries a metric/.test(i)));
  const varied = fixture();
  varied.experience[0].bullets = bullets.map((b, i) => (i < 2 ? 'Precepted new graduates through their first independent shifts on the unit.' : b));
  assert.ok(!auditResume(varied, undefined, { baseline: null }).issues.some((i) => /every single bullet/.test(i)));
});

test('auditCoverLetter: a letter in another language gets the language neutral checks; English only checks are skipped, not failed', () => {
  const de = (figure) => [
    'Sehr geehrte Frau Albrecht,',
    'seit sechs Jahren arbeite ich als Gesundheits- und Krankenpflegerin auf einer internistischen Station und bewerbe mich bei der Klinik am Seeufer, weil Ihre Station f\u00fcr \u00dcberleitungspflege genau die Arbeit macht, die ich weiterentwickeln m\u00f6chte.',
    `Auf meiner jetzigen Station habe ich die \u00dcbergabe am Bett eingef\u00fchrt und damit die Dokumentationsfehler ${figure} gesenkt. Ich leite ein Team von Pflegekr\u00e4ften im Fr\u00fchdienst, habe neue Kolleginnen eingearbeitet und der Pflegedirektion empfohlen, die Dienstplanung auf feste Tandems umzustellen. Die Direktion hat diese Empfehlung \u00fcbernommen.`,
    'Besonders wichtig ist mir, dass Patientinnen und Patienten nach der Entlassung wissen, wie es zu Hause weitergeht. Deshalb habe ich gemeinsam mit dem Sozialdienst ein Entlassgespr\u00e4ch entwickelt, das Angeh\u00f6rige einbezieht und offene Fragen schriftlich festh\u00e4lt.',
    '\u00dcber die Einladung zu einem Gespr\u00e4ch w\u00fcrde ich mich sehr freuen.',
    'Mit freundlichen Gr\u00fc\u00dfen',
  ].join('\n\n');
  const german = de('um 31 %');
  assert.equal(readsAsEnglish(german), false);
  const ok = auditCoverLetter(german);
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.ok, true);
  assert.equal(ok.skipped.length, 3);
  assert.ok(ok.skipped.some((x) => /leadership/.test(x)) && ok.skipped.some((x) => /decision/.test(x)) && ok.skipped.some((x) => /employer/.test(x)));

  // No figure: exactly the outcome issue, the English only checks still skipped.
  const noFigure = auditCoverLetter(de('deutlich'));
  assert.equal(noFigure.issues.length, 1);
  assert.match(noFigure.issues[0], /no measurable outcome/);
  // A year is not a figure.
  assert.match(auditCoverLetter(de('seit 2021 deutlich')).issues[0], /no measurable outcome/);

  // The employer, when the caller passes it, must be named (accents and case aside).
  assert.deepEqual(auditCoverLetter(german, { company: 'KLINIK AM SEEUFER gGmbH' }).issues, []);
  assert.equal(auditCoverLetter(german, { company: 'KLINIK AM SEEUFER gGmbH' }).skipped.length, 2);
  const other = auditCoverLetter(german, { company: 'Nordhafen Hospiz' });
  assert.equal(other.issues.length, 1);
  assert.match(other.issues[0], /Nordhafen Hospiz\) is not named/);

  // Too short to be a letter.
  const short = auditCoverLetter('Ich habe die Dokumentationsfehler um 31 % gesenkt und m\u00f6chte bei Ihnen arbeiten.');
  assert.ok(short.issues.some((i) => /letter is \d+ words/.test(i)));
  assert.ok(!short.issues.some((i) => /leadership|decision/.test(i)));

  // A tax accountant writing in French, and a letter in a script without spaces.
  const fr = [
    'Madame, Monsieur,',
    'Expert-comptable depuis neuf ans, je souhaite rejoindre le cabinet Dulac et Associ\u00e9s, dont le p\u00f4le agricole suit des exploitations que je connais bien.',
    'Dans mon cabinet actuel, j\u2019encadre une \u00e9quipe de quatre collaborateurs et nous avons cl\u00f4tur\u00e9 340 d\u00e9clarations sans aucun retard la saison derni\u00e8re. Ma revue des demandes de d\u00e9lai a fait appara\u00eetre 48 000 \u20ac de d\u00e9ductions oubli\u00e9es, et les associ\u00e9s ont d\u00e9cid\u00e9 de modifier la liste de contr\u00f4le \u00e0 l\u2019entr\u00e9e des dossiers.',
    'Je tiens \u00e0 expliquer chaque d\u00e9claration en termes simples, parce qu\u2019un client qui comprend son dossier transmet ses pi\u00e8ces \u00e0 temps et pose les bonnes questions avant l\u2019\u00e9ch\u00e9ance.',
    'Je serais heureuse d\u2019en parler avec vous lors d\u2019un entretien.',
    'Veuillez agr\u00e9er, Madame, Monsieur, mes salutations distingu\u00e9es.',
  ].join('\n\n');
  assert.deepEqual(auditCoverLetter(fr, { company: 'Dulac et Associ\u00e9s' }).issues, []);
  const ja = '\u79c1\u306f\u516d\u5e74\u9593\u3001\u5185\u79d1\u75c5\u68df\u3067\u770b\u8b77\u5e2b\u3068\u3057\u3066\u50cd\u304d\u3001\u7533\u3057\u9001\u308a\u306e\u624b\u9806\u3092\u898b\u76f4\u3057\u3066\u6295\u85ac\u30df\u30b9\u309238%\u6e1b\u3089\u3057\u307e\u3057\u305f\u3002'.repeat(8);
  assert.equal(readsAsEnglish(ja), false);
  assert.deepEqual(auditCoverLetter(ja).issues, []);

  // English letters are judged exactly as before, with nothing skipped.
  const generic = auditCoverLetter('I am excited about this role and I am a great fit for your team culture.');
  assert.equal(generic.issues.length, 3);
  assert.deepEqual(generic.skipped, []);
  const longGeneric = auditCoverLetter(Array.from({ length: 12 }, () => 'I am excited about the role and the team, and I would love to bring my passion for care to the unit.').join(' '));
  assert.equal(longGeneric.issues.length, 3, 'a long generic English letter still fails all three');
  assert.ok(readsAsEnglish('As charge nurse I led a team of 6 and cut medication errors 38% in one year. The audit showed most errors came at shift change, so the unit adopted a double check at handoff.'));
});

test('analyzeJD: a tool of the user followed by a trademark sign is still in stack', () => {
  const jd = 'About the role. You will prepare tax returns\u2122 for small firms and handle Reconciliation\u00ae at month end. Requirements: 3 years with audit support\u2120.';
  const { stack } = analyzeJD(jd);
  for (const term of ['tax returns', 'reconciliation', 'audit support']) assert.ok(stack.includes(term), term + ' in ' + JSON.stringify(stack));
});

test('whyHasAnchor: a named program in native quotation marks is an anchor; the quoted employer alone is not', () => {
  // Russian and French guillemets, German low quotes, Japanese corner brackets.
  assert.ok(whyHasAnchor('\u0412\u0430\u0448\u0430 \u043a\u043b\u0438\u043d\u0438\u043a\u0430 \u0443\u0447\u0430\u0441\u0442\u0432\u0443\u0435\u0442 \u0432 \u043f\u0440\u043e\u0433\u0440\u0430\u043c\u043c\u0435 \u00ab\u0417\u0435\u043c\u0441\u043a\u0438\u0439 \u0434\u043e\u043a\u0442\u043e\u0440\u00bb, \u0438 \u044f \u0445\u043e\u0447\u0443 \u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c \u0432 \u043e\u0442\u0434\u0435\u043b\u0435\u043d\u0438\u0438 \u043a\u0430\u0440\u0434\u0438\u043e\u043b\u043e\u0433\u0438\u0438.', '\u041a\u043b\u0438\u043d\u0438\u043a\u0430 \u0417\u0434\u043e\u0440\u043e\u0432\u044c\u0435'));
  assert.ok(whyHasAnchor('Votre cabinet a lanc\u00e9 la d\u00e9marche \u00ab qualit\u00e9 comptable \u00bb que je connais bien.', 'Cabinet Durand'));
  assert.ok(whyHasAnchor('ihre station nimmt am programm \u201epflege plus\u201c teil.', 'Klinikum Nord'));
  assert.ok(whyHasAnchor('\u8cb4\u9662\u306e\u300c\u5730\u57df\u5305\u62ec\u30b1\u30a2\u75c5\u68df\u300d\u3067\u306e\u770b\u8b77\u306b\u643a\u308f\u308a\u305f\u3044\u3068\u8003\u3048\u3066\u304a\u308a\u307e\u3059\u3002', '\u5c71\u7530\u75c5\u9662'));
  assert.ok(whyHasAnchor('Your firm runs the "close faster" initiative that I know well.', 'Harbor Tax Group'));
  // Generic praise stays flagged, and so does the employer's own name in quotes.
  assert.ok(!whyHasAnchor('Votre cabinet a une excellente r\u00e9putation et une belle \u00e9quipe.', 'Cabinet Durand'));
  assert.ok(!whyHasAnchor('\u8cb4\u9662\u306e\u770b\u8b77\u306b\u643a\u308f\u308a\u305f\u3044\u3068\u8003\u3048\u3066\u304a\u308a\u307e\u3059\u3002', '\u5c71\u7530\u75c5\u9662'));
  assert.ok(!whyHasAnchor('\u044f \u0445\u043e\u0447\u0443 \u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c \u0432 \u043a\u043b\u0438\u043d\u0438\u043a\u0435 \u00ab\u041a\u043b\u0438\u043d\u0438\u043a\u0430 \u0417\u0434\u043e\u0440\u043e\u0432\u044c\u0435\u00bb, \u043f\u043e\u0442\u043e\u043c\u0443 \u0447\u0442\u043e \u0443 \u0432\u0430\u0441 \u0445\u043e\u0440\u043e\u0448\u0430\u044f \u043a\u043e\u043c\u0430\u043d\u0434\u0430.', '\u041a\u043b\u0438\u043d\u0438\u043a\u0430 \u0417\u0434\u043e\u0440\u043e\u0432\u044c\u0435'));
  assert.ok(!whyHasAnchor('I would love to work at "Harbor Tax Group" because of the people.', 'Harbor Tax Group'));
});

test('auditCoverLetter: in another language a date, a phone number, a year, or a single digit is not the figure', () => {
  const de = (extra) => [
    'Sehr geehrte Frau Schmidt,',
    'mit gro\u00dfem Interesse habe ich Ihre Ausschreibung gelesen. Ich bin eine motivierte und zuverl\u00e4ssige Pflegefachkraft und arbeite gern im Team. Ihr Haus hat einen sehr guten Ruf, und ich m\u00f6chte gern ein Teil davon werden. Ich bin flexibel, belastbar und freundlich im Umgang mit Patientinnen und Patienten. Die Arbeit am Menschen bereitet mir gro\u00dfe Freude. Ich bringe Erfahrung aus verschiedenen Bereichen mit und lerne schnell.',
    `Ich bin seit 2015 in der Pflege t\u00e4tig und habe am 01.03.2024 meine Weiterbildung begonnen. Sie erreichen mich unter 0151 2345678 oder +49 151 2345678. ${extra} \u00dcber eine Einladung zu einem pers\u00f6nlichen Gespr\u00e4ch w\u00fcrde ich mich sehr freuen. Ich stehe Ihnen ab sofort zur Verf\u00fcgung und kann kurzfristig anfangen. F\u00fcr R\u00fcckfragen bin ich jederzeit gern f\u00fcr Sie erreichbar. Vielen Dank f\u00fcr Ihre Zeit und Ihre Aufmerksamkeit bei der Pr\u00fcfung meiner Unterlagen.`,
    'Mit freundlichen Gr\u00fc\u00dfen',
  ].join('\n\n');
  const generic = auditCoverLetter(de(''));
  assert.equal(generic.issues.length, 1);
  assert.match(generic.issues[0], /no measurable outcome/);
  assert.match(auditCoverLetter(de('Ich habe 5 Jahre Erfahrung.')).issues[0], /no measurable outcome/);
  // A count, a percent, and money written after the number are figures.
  assert.deepEqual(auditCoverLetter(de('Ich betreue 24 Betten im Nachtdienst.')).issues, []);
  assert.deepEqual(auditCoverLetter(de('Die Sturzrate sank um 8 %.')).issues, []);
  assert.deepEqual(auditCoverLetter(de('Das sparte der Station 120 000 \u20ac im Jahr.')).issues, []);
});

test('auditCoverLetter: a terse English letter with few "the" and "and" is still held to the full English bar', () => {
  const nurse = [
    'Dear Hiring Manager,',
    'I am writing to apply for your Registered Nurse position. I have worked in medical-surgical nursing for several years. I care deeply about my patients. I work hard on every shift. I communicate well with physicians, families, pharmacists, therapists. I am reliable. I am flexible on scheduling. I am comfortable with electronic charting. I enjoy bedside care, patient teaching, wound care, discharge planning. I would welcome a conversation about how I could contribute. I am available for interview at your convenience. I can start within four weeks. I hold an active licence in this state. I have current certifications in basic life support. I would be grateful for your consideration. Thank you for your time.',
    'Sincerely,',
  ].join('\n\n');
  const accountant = [
    'Dear Ms Patel,',
    'I am applying for your Senior Tax Accountant role. I prepare corporate returns, partnership returns, individual returns. I review workpapers. I research technical questions. I am organised, careful, punctual. Clients trust me. Colleagues rely on me. I enjoy busy season. I am keen on a firm where I can keep learning. I am comfortable in several tax software packages. I am a licensed CPA in good standing. I would value a chance to discuss your needs. I am available at short notice. I am happy to provide references on request. Thank you very much for considering my application.',
    'Yours sincerely,',
  ].join('\n\n');
  assert.equal(readsAsEnglish(accountant), false, 'the shared detector is unchanged');
  const a = auditCoverLetter(accountant);
  assert.equal(a.issues.length, 3);
  assert.deepEqual(a.skipped, []);
  // One figure does not carry it: the leadership and decision checks still apply.
  const withFigure = auditCoverLetter(accountant.replace('I review workpapers.', 'I review workpapers for 6 clients a week.'));
  assert.ok(withFigure.issues.some((i) => /leadership/.test(i)) && withFigure.issues.some((i) => /decision/.test(i)));
  const n = auditCoverLetter(nurse);
  assert.deepEqual(n.skipped, []);
  assert.ok(n.issues.some((i) => /decision/.test(i)) && n.issues.some((i) => /measurable/.test(i)));
  // An English line with one accented name is English too.
  assert.deepEqual(auditCoverLetter('I led a team of 9 nurses and recommended a protocol that cut handover time 20%. Zo\u00eb').skipped, []);
});

test('auditCoverLetter: the employer named in a grammatical case counts as named', () => {
  const ru = '\u0423\u0432\u0430\u0436\u0430\u0435\u043c\u0430\u044f \u0410\u043d\u043d\u0430 \u041f\u0435\u0442\u0440\u043e\u0432\u043d\u0430! \u042f \u043c\u0435\u0434\u0438\u0446\u0438\u043d\u0441\u043a\u0430\u044f \u0441\u0435\u0441\u0442\u0440\u0430 \u0441 \u043e\u043f\u044b\u0442\u043e\u043c \u0440\u0430\u0431\u043e\u0442\u044b \u0432 \u043a\u0430\u0440\u0434\u0438\u043e\u043b\u043e\u0433\u0438\u0438 \u0438 \u0445\u043e\u0447\u0443 \u0440\u0430\u0431\u043e\u0442\u0430\u0442\u044c \u0432 \u041a\u043b\u0438\u043d\u0438\u043a\u0435 \u0417\u0434\u043e\u0440\u043e\u0432\u044c\u044f. \u0412 \u043e\u0442\u0434\u0435\u043b\u0435\u043d\u0438\u0438 \u044f \u0432\u0435\u043b\u0430 12 \u043f\u0430\u0446\u0438\u0435\u043d\u0442\u043e\u0432 \u0437\u0430 \u0441\u043c\u0435\u043d\u0443 \u0438 \u0441\u043e\u043a\u0440\u0430\u0442\u0438\u043b\u0430 \u0432\u0440\u0435\u043c\u044f \u043f\u0435\u0440\u0435\u0434\u0430\u0447\u0438 \u0441\u043c\u0435\u043d\u044b \u043d\u0430 20 \u043f\u0440\u043e\u0446\u0435\u043d\u0442\u043e\u0432. '.repeat(4);
  assert.deepEqual(auditCoverLetter(ru, { company: '\u041a\u043b\u0438\u043d\u0438\u043a\u0430 \u0417\u0434\u043e\u0440\u043e\u0432\u044c\u0435' }).issues, []);
  const other = auditCoverLetter(ru, { company: '\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u0431\u043e\u043b\u044c\u043d\u0438\u0446\u0430' });
  assert.equal(other.issues.length, 1);
  assert.match(other.issues[0], /is not named/);
});

test('analyzeJD stack: the user\'s terms are found in postings written without spaces, next to a particle, and before a footnote mark', () => {
  // Japanese (nurse): kanji and kana neighbours never block a term; a Latin tool name is followed by a kana particle.
  const ja = analyzeJD('\u770b\u8b77\u5e2b\u52df\u96c6\u3002\u75c5\u68df\u3067\u306e\u770b\u8b77\u696d\u52d9\u3001\u63a1\u8840\u3001\u96fb\u5b50\u30ab\u30eb\u30c6\u306e\u8a18\u9332\u3092\u62c5\u5f53\u3057\u3066\u3044\u305f\u3060\u304d\u307e\u3059\u3002SAP\u306e\u7d4c\u9a13\u304c\u3042\u308c\u3070\u5c1a\u53ef\u3002').stack;
  for (const term of ['\u63a1\u8840', '\u96fb\u5b50\u30ab\u30eb\u30c6', 'sap']) assert.ok(ja.includes(term), term + ' in ' + JSON.stringify(ja));
  // Chinese (nurse) and Korean (a particle is attached to the noun and to the tool name).
  assert.ok(analyzeJD('\u62db\u8058\u6ce8\u518c\u62a4\u58eb\u3002\u8d1f\u8d23\u75c5\u623f\u62a4\u7406\u5de5\u4f5c\uff0c\u719f\u6089\u7535\u5b50\u75c5\u5386\u3002').stack.includes('\u62a4\u7406'));
  const ko = analyzeJD('\uac04\ud638\uc0ac \uba74\ud5c8 \ud544\uc218. SAP\uc744 \uc0ac\uc6a9\ud569\ub2c8\ub2e4.').stack;
  for (const term of ['\uac04\ud638', 'sap']) assert.ok(ko.includes(term), term + ' in ' + JSON.stringify(ko));
  // A footnote mark after the term (accountant).
  const noted = analyzeJD('Requirements: SAP\u00b9 and reconciliation\u00b2 experience, audit support\u2083 preferred.').stack;
  for (const term of ['sap', 'reconciliation', 'audit support']) assert.ok(noted.includes(term), term + ' in ' + JSON.stringify(noted));
  // Still a whole word where the script writes words apart: Latin (accented or not), Cyrillic, digits.
  for (const text of ['Uses SAPHIR daily.', 'Le SAP\u00e9 du service.', 'Unsaponified esaps.', 'Version SAP2 only.', '\u041e\u043f\u044b\u0442 SAP\u0430 \u043e\u0431\u044f\u0437\u0430\u0442\u0435\u043b\u0435\u043d.']) {
    assert.ok(!analyzeJD(text).stack.includes('sap'), text);
  }
});

test('analyzeJD keywords: an unspaced script yields no clause keywords, so the JD coverage gates stay quiet on a matching resume', () => {
  const ja = '\u770b\u8b77\u5e2b\u52df\u96c6\u3002\u75c5\u68df\u3067\u306e\u770b\u8b77\u696d\u52d9\u3001\u63a1\u8840\u3001\u96fb\u5b50\u30ab\u30eb\u30c6\u306e\u8a18\u9332\u3092\u62c5\u5f53\u3057\u3066\u3044\u305f\u3060\u304d\u307e\u3059\u3002\u591c\u52e4\u3042\u308a\u3002\u60a3\u8005\u3055\u3093\u3068\u3054\u5bb6\u65cf\u3078\u306e\u8aac\u660e\u3001\u9000\u9662\u652f\u63f4\u3001\u611f\u67d3\u5bfe\u7b56\u306e\u5b9f\u65bd\u3002\u5fdc\u52df\u8cc7\u683c\uff1a\u770b\u8b77\u5e2b\u514d\u8a31\u3001\u81e8\u5e8a\u7d4c\u9a13\u4e09\u5e74\u4ee5\u4e0a\u3002\u30c1\u30fc\u30e0\u533b\u7642\u306b\u7a4d\u6975\u7684\u306b\u53c2\u52a0\u3067\u304d\u308b\u65b9\u3002';
  const zh = '\u62db\u8058\u6ce8\u518c\u62a4\u58eb\u3002\u8d1f\u8d23\u75c5\u623f\u62a4\u7406\u5de5\u4f5c\uff0c\u719f\u6089\u7535\u5b50\u75c5\u5386\uff0c\u53c2\u4e0e\u611f\u67d3\u63a7\u5236\u548c\u51fa\u9662\u8ba1\u5212\u3002\u8981\u6c42\uff1a\u62a4\u58eb\u6267\u4e1a\u8bc1\u4e66\uff0c\u4e09\u5e74\u4ee5\u4e0a\u4e34\u5e8a\u7ecf\u9a8c\u3002';
  const th = '\u0e23\u0e31\u0e1a\u0e2a\u0e21\u0e31\u0e04\u0e23\u0e1e\u0e22\u0e32\u0e1a\u0e32\u0e25\u0e27\u0e34\u0e0a\u0e32\u0e0a\u0e35\u0e1e \u0e23\u0e31\u0e1a\u0e1c\u0e34\u0e14\u0e0a\u0e2d\u0e1a\u0e01\u0e32\u0e23\u0e1e\u0e22\u0e32\u0e1a\u0e32\u0e25\u0e1c\u0e39\u0e49\u0e1b\u0e48\u0e27\u0e22\u0e43\u0e19 \u0e2b\u0e2d\u0e1c\u0e39\u0e49\u0e1b\u0e48\u0e27\u0e22';
  for (const jd of [ja, zh, th]) {
    const terms = analyzeJD(jd, { exclude: ['\u3055\u304f\u3089\u75c5\u9662'] }).keywords.map((k) => k.term);
    assert.deepEqual(terms, [], 'clause keywords: ' + terms.join(' | '));
  }
  // A Latin word glued to the unspaced text is still a keyword, on its own.
  assert.deepEqual(top('SAP\u306e\u7d4c\u9a13\u304c\u3042\u308c\u3070\u5c1a\u53ef\u3002SAP\u3092\u4f7f\u7528\u3057\u307e\u3059\u3002', 1), ['sap']);

  const resume = {
    company: '\u3055\u304f\u3089\u75c5\u9662',
    summary: '\u770b\u8b77\u5e2b\u3068\u3057\u3066\u75c5\u68df\u3067\u516b\u5e74\u52e4\u52d9\u3002\u63a1\u8840\u3001\u96fb\u5b50\u30ab\u30eb\u30c6\u306e\u8a18\u9332\u3001\u9000\u9662\u652f\u63f4\u3001\u611f\u67d3\u5bfe\u7b56\u3092\u62c5\u5f53\u3002',
    experience: [{ company: '\u307f\u3069\u308a\u75c5\u9662', title: '\u770b\u8b77\u5e2b', bullets: [
      '\u75c5\u68df\u3067\u306e\u770b\u8b77\u696d\u52d9\u3092\u62c5\u5f53\u3057\u3001\u63a1\u8840\u3068\u96fb\u5b50\u30ab\u30eb\u30c6\u306e\u8a18\u9332\u3092\u884c\u3044\u3001\u8ee2\u5012\u4e8b\u6545\u309220%\u524a\u6e1b',
      '\u9000\u9662\u652f\u63f4\u3068\u611f\u67d3\u5bfe\u7b56\u306e\u5b9f\u65bd\u3067\u518d\u5165\u9662\u309215%\u524a\u6e1b',
      '\u591c\u52e4\u3067\u60a3\u8005\u3055\u3093\u3068\u3054\u5bb6\u65cf\u3078\u306e\u8aac\u660e\u3092\u62c5\u5f53',
    ] }],
    skills: { '\u81e8\u5e8a': ['\u63a1\u8840', '\u96fb\u5b50\u30ab\u30eb\u30c6'] },
  };
  const audit = auditResume(resume, ja, { baseline: null, targetPages: null });
  assert.ok(!audit.issues.some((i) => /JD-vocabulary coverage|center-of-gravity/.test(i)), audit.issues.join('\n'));
  const brief = tailorBrief(ja, null);
  assert.deepEqual(brief.coverage.gaps, []);

  // Spaced scripts are unchanged: a Korean posting still ranks its own words.
  assert.ok(top('\uac04\ud638\uc0ac \ubaa8\uc9d1. \ubcd1\ub3d9 \uac04\ud638 \uc5c5\ubb34\uc640 \ud658\uc790 \uad50\uc721\uc744 \ub2f4\ub2f9\ud569\ub2c8\ub2e4. \uac04\ud638\uc0ac \uba74\ud5c8 \ud544\uc218.', 3).includes('\uac04\ud638\uc0ac'));
});
