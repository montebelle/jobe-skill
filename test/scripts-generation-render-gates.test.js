'use strict';
// Render path gates and renderer output: scripts/render-docx.js and
// scripts/render-cover-letter.js. Forbidden terms (from the user's profile) and
// positioning vocabulary are fatal; the quality, depth, and substance checks
// warn by default and block under --strict / JOBE_STRICT_AUDIT=1. Synthetic
// fixtures only (a registered nurse and a tax accountant), each in its own
// JOBE_USER_ROOT temp workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const mkRoot = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `scripts-generation-${name}-`));
const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};

// Workspace with a forbidden list (the nurse), and one with nothing at all
// (the fresh clone case).
const GUARDED = mkRoot('guarded');
write(path.join(GUARDED, 'data', 'profile.json'), { output: { forbiddenTerms: ['Project Lantern', 'Bluebird'] } });
const BARE = mkRoot('bare');
process.env.JOBE_USER_ROOT = GUARDED;

const { scanCodenames, scanPositioningVocab, auditCoverLetter, auditResume } = require('../lib/tailor');
const { prepareCoverLetter } = require('../scripts/render-cover-letter');

function run(script, args, root, env = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, JOBE_USER_ROOT: root, JOBE_STRICT_AUDIT: '', ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

// Read one entry of a DOCX (a zip) with the standard library only.
function zipEntry(file, name) {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nameLen + skip;
  }
  return null;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const nurse = () => ({
  name: 'Amara Lindqvist',
  company: 'Mercy Valley Clinic',
  role: 'Charge Nurse',
  date: '2031-03-04',
  contact: { email: 'amara@example.com', location: 'Leeds' },
  summary: 'Registered nurse with a decade on acute medical wards, leading handover redesign and medication safety audits across two hospital sites. Trains new graduates in sepsis screening, runs the ward incident review, and turns audit findings into bedside protocols that hold up on night shifts and during winter surges.',
  experience: [{
    company: 'Northfield General Hospital', title: 'Senior Staff Nurse', location: 'Leeds', dates: 'Mar 2019 to Present',
    bullets: [
      'Cut medication errors 31 percent across a 28 bed ward by introducing a two nurse check at handover.',
      'Trained 14 new graduates in sepsis screening using a six step bedside protocol.',
      'Ran the weekly incident review and turned its findings into revised escalation rules for the night team.',
    ],
  }, {
    company: 'Calder Community Trust', title: 'Staff Nurse', location: 'Halifax', dates: 'Sep 2014 to Feb 2019',
    bullets: ['Managed a caseload of 22 patients per shift on a respiratory ward, coordinating discharge plans with pharmacy.'],
  }],
  selectedProjects: [{ name: 'Handover audit', summary: 'A structured handover checklist adopted by three wards after a twelve week pilot, built from incident review data.' }],
  skills: { Clinical: 'IV therapy, Wound care, Sepsis screening', Systems: 'Electronic prescribing' },
  education: [{ degree: 'BSc Nursing', school: 'Example University', dates: '2014' }],
  awards: ['Ward team of the year', 'Preceptor commendation'],
  whyCompany: 'Mercy Valley Clinic publishes its ward level safety audit results each quarter under the Safer Nursing Care Tool and runs a nurse led escalation service, which is the kind of open, protocol driven setting where my handover and incident review work applies directly.',
  coverLetter: [
    'Dear Mercy Valley Clinic Nursing Team,',
    'I led a team of 6 nurses through a handover redesign that cut medication errors 31 percent, and the trust adopted the two nurse check on every medical ward.',
    'Your nurse led escalation service is the setting where that work applies, and I would welcome a conversation.',
    'Sincerely,\nAmara Lindqvist',
  ].join('\n\n'),
});

const accountant = () => ({
  name: 'Tobias Renner',
  contact: { email: 'tobias@example.com' },
  summary: 'Tax accountant preparing returns for small businesses.',
  experience: [{
    company: 'Harbor Tax Group', title: 'Senior Tax Accountant', dates: 'Jan 2020 to Present',
    bullets: ['Prepared 340 individual and small business returns per season with a 98 percent first pass acceptance rate.'],
  }],
  skills: { Tax: 'Partnership returns, Notices' },
  education: [{ degree: 'BS Accounting', school: 'Example State College' }],
  coverLetter: 'I am excited about this role and I am a great fit for your team culture.',
});

const fixture = (root, data, name = 'resume-test.json') => write(path.join(root, 'out', name), data);

// ── Library level gates (the mechanism, on synthetic terms) ─────────────────

test('scanCodenames reads the forbidden list from the user profile', () => {
  assert.deepEqual(scanCodenames('Built the Bluebird intake flow'), ['Bluebird']);
  assert.ok(scanCodenames('the project lantern pilot').length === 1, 'case insensitive, whole term');
  assert.deepEqual(scanCodenames('bluebirds and lanterns are not the listed terms'), []);
  assert.deepEqual(scanCodenames('Bluebird', []), [], 'an empty list never blocks');
});

test('scanPositioningVocab catches framework jargon and ignores ordinary words', () => {
  assert.ok(scanPositioningVocab('a barbell strategy that stays antifragile').includes('barbell'));
  assert.ok(scanPositioningVocab('skin in the game').includes('skin in the game'));
  assert.deepEqual(scanPositioningVocab('a ledger inversion and the emergence of a pattern'), []);
});

test('auditCoverLetter: generic letter fails all three, a substantive one passes, empty is not ok', () => {
  const bad = auditCoverLetter(accountant().coverLetter);
  assert.equal(bad.ok, false);
  assert.equal(bad.issues.length, 3);
  const good = auditCoverLetter('I led a team of 6 preparers and found $48,000 in missed deductions across 120 returns, so the partners approved a second review step for every filing.');
  assert.equal(good.ok, true, JSON.stringify(good.issues));
  assert.equal(auditCoverLetter('').ok, false);
});

test('auditResume flags a wrong lead employer and out of order experience against the baseline', () => {
  const baseline = { experience: [{ company: 'Harbor Tax Group' }], education: [{ degree: 'BS Accounting' }] };
  const base = { education: [{ degree: 'BS Accounting' }], contact: { email: 'x@example.com' }, summary: 'x '.repeat(40) };
  const wrongLead = auditResume({ ...base, experience: [{ company: 'Ridgeline Bookkeeping', dates: 'Mar 2021 to Present', bullets: [] }] }, undefined, { baseline });
  assert.ok(wrongLead.issues.some((i) => /must lead/.test(i)));
  const outOfOrder = auditResume({ ...base, experience: [
    { company: 'Harbor Tax Group', dates: 'Jan 2020 to Present', bullets: [] },
    { company: 'County Revenue Office', dates: 'May 2012 to Dec 2015', bullets: [] },
    { company: 'Ridgeline Bookkeeping', dates: 'Mar 2016 to Dec 2019', bullets: [] },
  ] }, undefined, { baseline });
  assert.ok(outOfOrder.issues.some((i) => /reverse-chronological/.test(i)));
  const ok = auditResume({ ...base, experience: [
    { company: 'Harbor Tax Group', dates: 'Jan 2020 to Present', bullets: [] },
    { company: 'Ridgeline Bookkeeping', dates: 'Mar 2016 to Dec 2019', bullets: [] },
  ] }, undefined, { baseline });
  assert.ok(!ok.issues.some((i) => /must lead|reverse-chronological/.test(i)), JSON.stringify(ok.issues));
});

// ── Resume renderer ─────────────────────────────────────────────────────────

test('resume renders in a workspace with no user files, with native list bullets and blank author metadata', () => {
  const input = fixture(BARE, nurse());
  const r = run('render-docx.js', [input], BARE);
  assert.equal(r.status, 0, r.out);
  const docx = input.replace(/\.json$/, '.docx');
  const documentXml = zipEntry(docx, 'word/document.xml');
  const numberingXml = zipEntry(docx, 'word/numbering.xml');
  assert.match(documentXml, /<w:numPr>/);
  assert.match(numberingXml, /<w:numFmt w:val="bullet"\/>/);
  assert.ok(!documentXml.includes(String.fromCharCode(0x2022)), 'the bullet glyph lives in numbering metadata, never in resume text (experience or awards)');
  // 4 experience bullets + 2 awards are list items.
  assert.equal(documentXml.match(/<w:numPr>/g).length, 6);
  assert.match(documentXml, /<w:keepLines\/>/);
  assert.match(documentXml, /SELECTED PROJECTS[\s\S]*EXPERIENCE[\s\S]*SKILLS[\s\S]*EDUCATION[\s\S]*AWARDS/);
  const core = zipEntry(docx, 'docProps/core.xml');
  assert.ok(!/<dc:creator>[^<]+<\/dc:creator>/.test(core), 'creator must be blank');
  assert.ok(!/<cp:lastModifiedBy>[^<]+<\/cp:lastModifiedBy>/.test(core), 'lastModifiedBy must be blank');
  assert.ok(!/jobe/i.test(core), 'no tool name in document metadata');
});

test('layout "compact" shrinks type and spacing', () => {
  const standard = fixture(BARE, nurse(), 'resume-standard.json');
  const compact = fixture(BARE, { ...nurse(), layout: 'compact' }, 'resume-compact.json');
  assert.equal(run('render-docx.js', [standard], BARE).status, 0);
  assert.equal(run('render-docx.js', [compact], BARE).status, 0);
  const a = zipEntry(standard.replace(/\.json$/, '.docx'), 'word/document.xml');
  const b = zipEntry(compact.replace(/\.json$/, '.docx'), 'word/document.xml');
  assert.match(a, /w:line="276"/);
  assert.match(b, /w:line="252"/);
  assert.ok(!/w:line="276"/.test(b));
});

test('a forbidden term in any rendered field is fatal, strict or not, and nothing is written', () => {
  const data = nurse();
  data.awards.push('Bluebird rollout lead');
  const input = fixture(GUARDED, data, 'resume-leak.json');
  const r = run('render-docx.js', [input], GUARDED);
  assert.equal(r.status, 1);
  assert.match(r.out, /forbidden-terms-gate\] FATAL.*Bluebird/);
  assert.ok(!fs.existsSync(input.replace(/\.json$/, '.docx')));
  // The same JSON renders where the list is empty: the gate is the user's list, not a shipped one.
  const free = fixture(BARE, data, 'resume-leak.json');
  assert.equal(run('render-docx.js', [free], BARE).status, 0);
});

test('positioning vocabulary is fatal', () => {
  const data = nurse();
  data.summary += ' An antifragile approach to staffing.';
  const input = fixture(BARE, data, 'resume-jargon.json');
  const r = run('render-docx.js', [input], BARE);
  assert.equal(r.status, 1);
  assert.match(r.out, /positioning-vocab-gate\] FATAL.*antifragile/);
  assert.ok(!fs.existsSync(input.replace(/\.json$/, '.docx')));
});

test('the fatal gates cannot be skipped: unparsable JSON exits non-zero and writes nothing', () => {
  const input = write(path.join(BARE, 'out', 'resume-broken.json'), '{ "name": "Amara Lindqvist", ');
  const r = run('render-docx.js', [input], BARE);
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(input.replace(/\.json$/, '.docx')));
});

test('quality audit warns by default and blocks under --strict or JOBE_STRICT_AUDIT=1', () => {
  const input = fixture(BARE, accountant(), 'resume-thin.json');
  const docx = input.replace(/\.json$/, '.docx');
  const warn = run('render-docx.js', [input], BARE);
  assert.equal(warn.status, 0, warn.out);
  assert.match(warn.out, /\[resume-audit\] \d+ quality issue/);
  assert.match(warn.out, /no jd\.txt beside the JSON/);
  assert.ok(fs.existsSync(docx));
  fs.rmSync(docx);
  const strict = run('render-docx.js', ['--strict', input], BARE);
  assert.equal(strict.status, 1);
  assert.ok(!fs.existsSync(docx));
  const viaEnv = run('render-docx.js', [input], BARE, { JOBE_STRICT_AUDIT: '1' });
  assert.equal(viaEnv.status, 1);
  assert.ok(!fs.existsSync(docx));
});

test('a clean resume passes --strict, and a sibling jd.txt makes the audit JD aware', () => {
  const dir = path.join(BARE, 'out', 'with-jd');
  const input = write(path.join(dir, 'resume-clean.json'), nurse());
  const clean = run('render-docx.js', ['--strict', input], BARE);
  assert.equal(clean.status, 0, clean.out);
  // A JD about something else entirely: the JD coverage check now runs and fails.
  write(path.join(dir, 'jd.txt'), 'Requirements\n' + Array.from({ length: 6 }, () =>
    'Prepare partnership returns, resolve apportionment notices, and reconcile depreciation schedules for partnership clients.').join('\n'));
  const jdAware = run('render-docx.js', ['--strict', input], BARE);
  assert.equal(jdAware.status, 1, jdAware.out);
  assert.match(jdAware.out, /JD-vocabulary coverage|requirement->bullet/);
  assert.ok(!/no jd\.txt beside the JSON/.test(jdAware.out));
});

test('depth gate at render: a body of work named without its method warns, and blocks under --strict', () => {
  const root = mkRoot('depth');
  write(path.join(root, 'data', 'evidence-depth.json'), { systems: [
    { id: 'handover-redesign', match: ['handover'], mechanisms: ['sbar', 'closed loop readback'] },
  ] });
  const input = fixture(root, nurse());
  const warn = run('render-docx.js', [input], root);
  assert.equal(warn.status, 0, warn.out);
  assert.match(warn.out, /\[depth-gate\] 1 item\(s\) named without a method or mechanism: handover-redesign/);
  assert.equal(run('render-docx.js', ['--strict', input], root).status, 1);
  const deep = nurse();
  deep.experience[0].bullets[0] += ' The check uses a closed loop readback.';
  const fixed = fixture(root, deep, 'resume-deep.json');
  const ok = run('render-docx.js', ['--strict', fixed], root);
  assert.equal(ok.status, 0, ok.out);
});

// ── Page setup and contact line (both renderers) ────────────────────────────

test('paper size and date order follow output.pageSize and output.dateLocale; no profile means Letter and en-US', () => {
  const pgSz = (docx) => zipEntry(docx, 'word/document.xml').match(/<w:pgSz[^>]*>/)[0];
  const render = (root, name) => {
    const input = fixture(root, nurse(), `resume-${name}.json`);
    assert.equal(run('render-docx.js', [input], root).status, 0);
    assert.equal(run('render-cover-letter.js', [input], root).status, 0);
    return { resume: input.replace(/\.json$/, '.docx'), letter: path.join(path.dirname(input), `cover-letter-${name}.docx`) };
  };

  const bare = render(BARE, 'page-bare');
  for (const f of [bare.resume, bare.letter]) assert.match(pgSz(f), /w:w="12240" w:h="15840"/);
  assert.match(zipEntry(bare.letter, 'word/document.xml'), /March 4, 2031/);

  const a4 = mkRoot('a4');
  write(path.join(a4, 'data', 'profile.json'), { output: { pageSize: 'A4', dateLocale: 'en-GB' } });
  const set = render(a4, 'page-a4');
  for (const f of [set.resume, set.letter]) assert.match(pgSz(f), /w:w="11906" w:h="16838"/);
  assert.match(zipEntry(set.letter, 'word/document.xml'), /4 March 2031/);

  // A locale tag the runtime rejects never stops the render.
  const odd = mkRoot('odd-locale');
  write(path.join(odd, 'data', 'profile.json'), { output: { pageSize: 'letter', dateLocale: 'not a locale' } });
  const fallback = render(odd, 'page-odd');
  assert.match(pgSz(fallback.letter), /w:w="12240"/);
  assert.match(zipEntry(fallback.letter, 'word/document.xml'), /March 4, 2031/);
});

test('contact.website prints in both contact lines, once when it equals the code host link, and is read by the fatal scan', () => {
  const data = accountant();
  data.contact = { email: 'tobias@example.com', website: 'https://portfolio.example.org/tobias' };
  const input = fixture(BARE, data, 'resume-site.json');
  assert.equal(run('render-docx.js', [input], BARE).status, 0);
  assert.equal(run('render-cover-letter.js', [input], BARE).status, 0);
  const letter = path.join(path.dirname(input), 'cover-letter-site.docx');
  for (const f of [input.replace(/\.json$/, '.docx'), letter]) {
    assert.match(zipEntry(f, 'word/document.xml'), /tobias@example\.com {2}\| {2}https:\/\/portfolio\.example\.org\/tobias/);
  }

  data.contact.github = data.contact.website;
  const same = fixture(BARE, data, 'resume-site-same.json');
  assert.equal(run('render-docx.js', [same], BARE).status, 0);
  assert.equal(zipEntry(same.replace(/\.json$/, '.docx'), 'word/document.xml').match(/portfolio\.example\.org/g).length, 1);

  const leak = nurse();
  leak.contact.website = 'https://example.org/bluebird';
  const leaked = fixture(GUARDED, leak, 'resume-site-leak.json');
  const r = run('render-docx.js', [leaked], GUARDED);
  assert.equal(r.status, 1);
  assert.match(r.out, /forbidden-terms-gate\] FATAL.*bluebird/);
  assert.ok(!fs.existsSync(leaked.replace(/\.json$/, '.docx')));
});

// ── Cover letter renderer ───────────────────────────────────────────────────

test('prepareCoverLetter lifts the greeting and sign off the letter carries and adds the English defaults only when it has none', () => {
  const a = prepareCoverLetter('Dear Ward Manager,\n\nBody one.\n\nBody two.\n\nSincerely,\nAmara Lindqvist', 'Mercy Valley Clinic', 'Amara Lindqvist');
  assert.deepEqual(a, { greeting: 'Dear Ward Manager,', paragraphs: ['Body one.', 'Body two.'], closing: 'Sincerely,' });
  // Closing and name as separate paragraphs, name written with a middle initial.
  const b = prepareCoverLetter('Body one.\r\n\r\nKind regards,\r\n\r\nTobias J. Renner', 'Harbor Tax Group', 'Tobias Renner');
  assert.deepEqual(b, { greeting: 'Dear Harbor Tax Group Hiring Team,', paragraphs: ['Body one.'], closing: 'Kind regards,' });
  // No company, no name: a plain default greeting and the body untouched.
  const c = prepareCoverLetter('Body that ends by naming Tobias Renner in a sentence.', '', '');
  assert.deepEqual(c, { greeting: 'Dear Hiring Team,', paragraphs: ['Body that ends by naming Tobias Renner in a sentence.'], closing: 'Sincerely,' });
  // A title with a period is still a greeting; an earlier sign off is dropped.
  const d = prepareCoverLetter('Dear Dr. Okafor,\n\nBody one.\n\nThank you,\n\nSincerely,\n\nAmara Lindqvist', 'Mercy Valley Clinic', 'Amara Lindqvist');
  assert.deepEqual(d, { greeting: 'Dear Dr. Okafor,', paragraphs: ['Body one.'], closing: 'Sincerely,' });

  // English variants: the sign off is recognized, with or without the name.
  for (const close of ['Yours sincerely,', 'Yours faithfully,', 'Yours truly,', 'Sincerely yours,', 'Best,', 'With best wishes,', 'Many thanks,', 'Warm regards']) {
    for (const sep of ['\n', '\n\n']) {
      const r = prepareCoverLetter(`To whom it may concern,\n\nBody one.\n\n${close}${sep}Tobias Renner`, 'Harbor Tax Group', 'Tobias Renner');
      assert.deepEqual(r, { greeting: 'To whom it may concern,', paragraphs: ['Body one.'], closing: close }, close);
    }
    assert.equal(prepareCoverLetter(`Body one.\n\n${close}`, 'Harbor Tax Group', 'Tobias Renner').closing, close);
  }
  // A sentence that merely starts like a sign off stays in the body.
  const e = prepareCoverLetter('Body one.\n\nYours sincerely, I remain keen to discuss the role further with you.', 'Harbor Tax Group', 'Tobias Renner');
  assert.equal(e.paragraphs.length, 2);
  assert.equal(e.closing, 'Sincerely,');

  // A short last sentence followed by the name is body text, not a sign off.
  const [, p1, p2] = nurse().coverLetter.split('\n\n');
  for (const last of ['I would welcome a conversation.', 'Thank you for your time.', 'My licence number is on file.', 'May I call you next week?']) {
    for (const sep of ['\n', '\n\n']) {
      const r = prepareCoverLetter(['Dear Ms Okafor,', p1, p2, `${last}${sep}Amara Lindqvist`].join('\n\n'), 'Mercy Valley Clinic', 'Amara Lindqvist');
      assert.equal(r.closing, 'Sincerely,', last);
      assert.equal(r.paragraphs.join(' ').includes(last), true, last);
    }
  }
  const two = prepareCoverLetter(['Dear Ms Okafor,', p1, 'I am available from March.', 'Thank you for your time.', 'Amara Lindqvist'].join('\n\n'), 'Mercy Valley Clinic', 'Amara Lindqvist');
  assert.deepEqual(two, { greeting: 'Dear Ms Okafor,', paragraphs: [p1, 'I am available from March.', 'Thank you for your time.'], closing: 'Sincerely,' });

  // Credentials after the name are still the signature: one sign off, no name in the body.
  for (const [name, creds] of [['Amara Lindqvist', ', RN, BSN'], ['Tobias Renner', ', CPA'], ['Tobias Renner', ', Ph.D.']]) {
    for (const sep of ['\n', '\n\n']) {
      const r = prepareCoverLetter(['Dear Ms Okafor,', p1, p2, `Sincerely,${sep}${name}${creds}`].join('\n\n'), 'Mercy Valley Clinic', name);
      assert.deepEqual(r, { greeting: 'Dear Ms Okafor,', paragraphs: [p1, p2], closing: 'Sincerely,' }, creds);
    }
  }
  // A subject line or a list intro is body text, and a short unpunctuated last
  // line before the name of an English letter is not a sign off.
  for (const first of ['Re: Charge Nurse, Cardiac Step Down Unit (Req 4471):', 'Re: Charge Nurse:', 'Three things I would bring to Ledger and Finch:']) {
    const r = prepareCoverLetter([first, p1, p2].join('\n\n'), 'Mercy Valley Clinic', 'Amara Lindqvist');
    assert.deepEqual(r, { greeting: 'Dear Mercy Valley Clinic Hiring Team,', paragraphs: [first, p1, p2], closing: 'Sincerely,' }, first);
  }
  for (const head of [[], ['Dear Ms Okafor,']]) {
    const r = prepareCoverLetter([...head, p1, p2, 'References available on request', 'Amara Lindqvist, RN, BSN'].join('\n\n'), 'Mercy Valley Clinic', 'Amara Lindqvist');
    assert.equal(r.closing, 'Sincerely,');
    assert.deepEqual(r.paragraphs, [p1, p2, 'References available on request']);
  }
  // A sentence that starts with the name is not a signature.
  assert.equal(prepareCoverLetter(`${p1}\n\nAmara Lindqvist, nurse, will call`, 'Mercy Valley Clinic', 'Amara Lindqvist').paragraphs.length, 2);
});

// Realistic letters in other languages: the letter's own greeting and sign off
// are used once, and no English line is ever added.
const LETTERS = {
  german: {
    name: 'Jörg Weiß', company: 'Klinikum Nordstadt',
    greeting: 'Sehr geehrte Frau Dr. Schäfer,',
    body: [
      'als Stationsleitung einer kardiologischen Station mit 28 Betten habe ich ein Team von sechs Pflegefachkräften geführt und das Übergabeprotokoll so umgestellt, dass Medikationsfehler innerhalb eines Jahres um 31 Prozent zurückgingen.',
      'Entscheidend war, die Doppelkontrolle an das Patientenbett zu verlegen, weil die Auswertung der Vorfälle zeigte, dass die meisten Fehler in den ersten zehn Minuten nach der Übergabe entstanden.',
      'Über die Einladung zu einem Gespräch freue ich mich sehr.',
    ],
    closing: 'Mit freundlichen Grüßen',
  },
  french: {
    name: 'Anaïs Lefèvre', company: 'Cabinet Moreau',
    greeting: 'Madame, Monsieur,',
    body: [
      'Expert-comptable depuis huit ans, j\'ai encadré une équipe de six collaborateurs et préparé 340 déclarations par saison, avec un taux d\'acceptation de 98 % dès le premier dépôt.',
      'J\'ai choisi d\'instaurer une seconde relecture pour chaque dossier après avoir constaté que 48 000 € de déductions avaient été oubliés sur 120 déclarations.',
    ],
    closing: 'Cordialement,',
  },
  spanish: {
    name: 'María Núñez', company: 'Hospital San Rafael',
    greeting: 'Estimado equipo de selección:',
    body: [
      'Durante seis años coordiné un equipo de seis enfermeras en una unidad de 28 camas y reduje los errores de medicación un 31 por ciento con una doble verificación en el cambio de turno.',
      'Me gustaría conversar sobre cómo aplicar ese trabajo en su servicio de escalamiento.',
    ],
    closing: 'Atentamente,',
  },
  russian: {
    name: 'Ирина Соколова', company: 'Клиника Север',
    greeting: 'Уважаемая Анна Сергеевна,',
    body: [
      'Я руководила командой из шести медсестёр в кардиологическом отделении на 28 коек и сократила число ошибок при выдаче лекарств на 31 процент, введя двойную проверку при передаче смены.',
      'Буду рада обсудить, как этот опыт пригодится в вашей службе.',
    ],
    closing: 'С уважением,',
  },
  // Languages whose everyday words collide with English ones (for, to, my, of).
  norwegian: {
    name: 'Kari Nordmann', company: 'Oslo Sykehus',
    greeting: 'Hei,',
    body: [
      'Jeg har arbeidet som sykepleier i åtte år ved en kardiologisk avdeling med 28 senger, og jeg har hatt ansvar for å lære opp nye kolleger og for å følge opp pasienter etter operasjon. Jeg trives godt med å arbeide i team og tar gjerne ansvar for vaktlister.',
      'I min nåværende jobb har jeg ledet et prosjekt for å redusere feil ved utdeling av legemidler, og vi klarte å få ned antall avvik med 31 prosent på ett år. Jeg ser frem til å høre fra dere.',
    ],
    closing: 'Med vennlig hilsen',
  },
  danish: {
    name: 'Søren Kjær', company: 'Revision Nord',
    greeting: 'Kære Hanne Østergaard,',
    body: [
      'Jeg har arbejdet som revisor i otte år og har haft ansvar for at udarbejde 340 selvangivelser pr. sæson for små virksomheder. Jeg har lært nye kolleger op og har indført en ekstra gennemgang for at undgå fejl i fradrag.',
      'I mit nuværende job har jeg ledet et team på seks, og vi fik 98 procent af sagerne godkendt ved første indsendelse. Tak for din tid og for muligheden for at fortælle mere om mit arbejde.',
    ],
    closing: 'Med venlig hilsen',
  },
  afrikaans: {
    name: 'Annelie Müller', company: 'Kaapse Kliniek',
    greeting: 'Geagte Mevrou Botha,',
    body: [
      'Ek werk al agt jaar as verpleegkundige in my huidige pos by \'n kardiologie-eenheid met 28 beddens, waar ek die opleiding van nuwe personeel behartig. My ervaring sluit die opvolg van pasiënte ná operasies in, en my span het die aantal medikasiefoute met 31 persent verminder.',
      'Ek het die hoof van my afdeling gehelp om \'n nuwe oorhandigingsproses in te stel. Die werk van my span is deur die bestuur erken, en ek sien uit daarna om van u te hoor oor my aansoek.',
    ],
    closing: 'Vriendelike groete',
  },
};

test('prepareCoverLetter: a letter in another language keeps its own greeting and sign off and never gets an English one', () => {
  for (const [lang, l] of Object.entries(LETTERS)) {
    for (const sep of ['\n', '\n\n']) {
      const full = prepareCoverLetter([l.greeting, ...l.body, `${l.closing}${sep}${l.name}`].join('\n\n'), l.company, l.name);
      assert.deepEqual(full, { greeting: l.greeting, paragraphs: l.body, closing: l.closing }, lang);
    }
    // No greeting and no sign off in the body: nothing English is added.
    assert.deepEqual(prepareCoverLetter(l.body.join('\n\n'), l.company, l.name), { greeting: '', paragraphs: l.body, closing: '' }, lang);
    // A sentence long sign off formula is body text; only the name is lifted.
    const signed = prepareCoverLetter([...l.body, l.name].join('\n\n'), l.company, l.name);
    assert.deepEqual(signed, { greeting: '', paragraphs: l.body, closing: '' }, lang);
  }
  // An English job title or employer name inside the letter does not make it English.
  for (const [lang, title, company] of [['danish', 'Senior Tax and Compliance Accountant', 'Revision Nord'], ['norwegian', 'Clinical Nurse Specialist, Head and Neck Surgery', 'Oslo Sykehus'], ['afrikaans', 'Head of Nursing and Midwifery', 'Kaapse Kliniek'], ['german', 'Head of Tax and Accounting', 'The Trade and Audit Group']]) {
    const body = [`${LETTERS[lang].body[0].split('. ')[0]} (${title}, ${company}).`, LETTERS[lang].body[1]];
    assert.deepEqual(prepareCoverLetter(body.join('\n\n'), company, LETTERS[lang].name), { greeting: '', paragraphs: body, closing: '' }, lang);
  }
  // Transliterated text (no accents) is told apart by its greeting line.
  const ascii = prepareCoverLetter('Sehr geehrte Damen und Herren,\n\nIch leite ein Team von sechs Pflegekraeften.\n\nMit freundlichen Gruessen\nAnna Mueller', 'Klinik Nord', 'Anna Mueller');
  assert.deepEqual(ascii, { greeting: 'Sehr geehrte Damen und Herren,', paragraphs: ['Ich leite ein Team von sechs Pflegekraeften.'], closing: 'Mit freundlichen Gruessen' });
  // An English letter that names an accented employer still gets the defaults.
  const en = prepareCoverLetter(nurse().coverLetter.split('\n\n').slice(1, 3).join('\n\n').replace('the trust', 'the Hôpital Saint-André trust'), 'Mercy Valley Clinic', 'Amara Lindqvist');
  assert.equal(en.greeting, 'Dear Mercy Valley Clinic Hiring Team,');
  assert.equal(en.closing, 'Sincerely,');
});

// Text of every run of a DOCX body, one paragraph per line.
const docxText = (file) => zipEntry(file, 'word/document.xml')
  .split('</w:p>').map((p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
  .filter(Boolean).join('\n').replace(/&amp;/g, '&').replace(/&apos;/g, "'");

test('rendered letters: one greeting and one sign off in the letter\'s language; accents, other scripts and clinical symbols survive', () => {
  for (const [lang, l] of Object.entries(LETTERS)) {
    const data = { name: l.name, company: l.company, date: '2031-03-04', contact: { email: 'someone@example.com' },
      coverLetter: [l.greeting, ...l.body, `${l.closing}\n${l.name}`].join('\n\n') };
    const input = fixture(BARE, data, `resume-${lang}.json`);
    const r = run('render-cover-letter.js', [input], BARE);
    assert.equal(r.status, 0, r.out);
    const lines = docxText(path.join(path.dirname(input), `cover-letter-${lang}.docx`)).split('\n');
    assert.deepEqual(lines.slice(3), [l.greeting, ...l.body, l.closing, l.name], lang);
    assert.equal(lines[0], l.name.toUpperCase());
    assert.ok(!/Dear |Sincerely/.test(lines.join('\n')), lang);
  }

  const data = nurse();
  Object.assign(data, { name: 'Zoë Müller-Nguyễn', summary: data.summary + ' Titrated noradrenaline at 5 µg/min and kept core temperature within 36.5 °C ± 0.5 °C.' });
  data.experience[0].company = 'Universitätsklinikum Köln';
  data.experience[0].bullets[0] = 'Сократила время обхода на 20 процентов в отделении на 28 коек, SpO₂ ≥ 94 %.';
  data.skills.Clinical = 'Wundversorgung, Überwachung, 看護記録';
  data.coverLetter = data.coverLetter.replace('Amara Lindqvist', data.name).replace('31 percent', '31 percent at 5 µg/min and 36.5 °C');
  const input = fixture(BARE, data, 'resume-accents.json');
  assert.equal(run('render-docx.js', [input], BARE).status, 0);
  const resume = docxText(path.join(path.dirname(input), 'resume-accents.docx'));
  for (const kept of ['ZOË MÜLLER-NGUYỄN', 'Universitätsklinikum Köln', 'Сократила время обхода на 20 процентов в отделении на 28 коек', '5 µg/min', '36.5 °C ± 0.5 °C', 'Wundversorgung, Überwachung, 看護記録']) {
    assert.ok(resume.includes(kept), `${kept}\n${resume}`);
  }
  assert.equal(run('render-cover-letter.js', [input], BARE).status, 0);
  const letter = docxText(path.join(path.dirname(input), 'cover-letter-accents.docx')).split('\n');
  assert.ok(letter.join('\n').includes('31 percent at 5 µg/min and 36.5 °C'));
  assert.deepEqual(letter.slice(-2), ['Sincerely,', 'Zoë Müller-Nguyễn']);

  // output.asciiOnly folds the same input to plain ASCII and still strips the signature once.
  const ASCII = mkRoot('ascii');
  write(path.join(ASCII, 'data', 'profile.json'), { output: { asciiOnly: true } });
  const folded = fixture(ASCII, data, 'resume-accents.json');
  assert.equal(run('render-docx.js', [folded], ASCII).status, 0);
  const plain = docxText(path.join(path.dirname(folded), 'resume-accents.docx'));
  assert.ok(plain.includes('5 ug/min') && plain.includes('Wundversorgung, Uberwachung'), plain);
  assert.equal(run('render-cover-letter.js', [folded], ASCII).status, 0);
  const plainLetter = docxText(path.join(path.dirname(folded), 'cover-letter-accents.docx'));
  assert.deepEqual(plainLetter.split('\n').slice(-2), ['Sincerely,', 'Zoe Muller-Nguyen']);
  // Every rendered field is folded, header and identity fields included.
  for (const [what, text] of [['resume', plain], ['letter', plainLetter]]) assert.match(text, /^[\x00-\x7F]*$/, what);
  assert.ok(plain.includes('ZOE MULLER-NGUYEN') && plain.includes('Universitatsklinikum Koln'), plain);
});

test('header and identity fields: typographic punctuation is folded, hyphens survive output.stripHyphens, asciiOnly folds them all', () => {
  const data = accountant();
  Object.assign(data, { name: 'Zoë Müller-Nguyễn', company: 'Hôpital “Saint-André”', date: '2031-03-04',
    contact: { phone: '+44 (0)113 496-0000', email: 'zoe@example.com', location: 'Leeds – UK' },
    skills: { 'Tax – UK': 'Self-assessment returns' },
    education: { degree: 'BSc Accounting — First', school: 'Leeds “Met” <UK>', location: 'München', dates: '2012 – 2015' },
    coverLetter: 'I led a team of 6 preparers and found $48,000 in missed deductions across 120 returns, so the partners approved a second review step.' });
  data.experience[0] = { ...data.experience[0], company: 'Lowe & Hart “Advisory” <UK>', location: 'Leeds – UK', dates: 'Jan 2019 – Present' };
  const render = (root) => {
    const input = fixture(root, data, 'resume-header.json');
    assert.equal(run('render-docx.js', [input], root).status, 0);
    assert.equal(run('render-cover-letter.js', [input], root).status, 0);
    return [docxText(input.replace(/\.json$/, '.docx')), docxText(path.join(path.dirname(input), 'cover-letter-header.docx'))];
  };

  const [resume, letter] = render(BARE);
  for (const kept of ['ZOË MÜLLER-NGUYỄN', '+44 (0)113 496-0000  |  zoe@example.com  |  Leeds - UK', 'Jan 2019 - Present',
    "Lowe & Hart 'Advisory' less than UK greater than  |  Leeds - UK", 'Tax - UK: ', 'BSc Accounting - First', "Leeds 'Met'", 'München', '2012 - 2015']) {
    assert.ok(resume.includes(kept), `${kept}\n${resume}`);
  }
  assert.ok(!/[\u2013\u2014\u201c\u201d<>]/.test(resume + letter), resume);
  assert.ok(letter.includes("Dear Hôpital 'Saint-André' Hiring Team,") && letter.endsWith('Sincerely,\nZoë Müller-Nguyễn'), letter);

  // output.stripHyphens removes hyphens from prose, never from a name, a phone number or a date range.
  const NOHYPHEN = mkRoot('nohyphen');
  write(path.join(NOHYPHEN, 'data', 'profile.json'), { output: { stripHyphens: true } });
  const [r2, l2] = render(NOHYPHEN);
  for (const kept of ['ZOË MÜLLER-NGUYỄN', '496-0000', 'Jan 2019 - Present', '2012 - 2015', 'Self assessment returns']) assert.ok(r2.includes(kept), `${kept}\n${r2}`);
  assert.ok(l2.endsWith('Sincerely,\nZoë Müller-Nguyễn') && l2.includes('ZOË MÜLLER-NGUYỄN'), l2);

  const ASCII = mkRoot('ascii-header');
  write(path.join(ASCII, 'data', 'profile.json'), { output: { asciiOnly: true } });
  const [r3, l3] = render(ASCII);
  assert.match(r3 + l3, /^[\x00-\x7F]*$/);
  assert.ok(r3.includes('ZOE MULLER-NGUYEN') && r3.includes('Munchen') && l3.includes("Dear Hopital 'Saint-Andre' Hiring Team,"), r3 + l3);

  // A name in a script asciiOnly removes is kept as written, never swapped for a placeholder.
  // Skill labels follow the same rule, so no row is merged or lost; a number in the contact block prints.
  data.name = 'Ирина Соколова';
  data.contact.phone = 5551234567;
  const rowsOf = { 'Мови': 'English, Deutsch', 'Навички': 'Excel, SAP', 'Податки': 'IFRS, VAT', 'Café': 'Payroll', 'Cafe': 'Audit' };
  for (const skills of [rowsOf, Object.entries(rowsOf).map(([k, v]) => `${k}: ${v}`), Object.entries(rowsOf).map(([category, v]) => ({ category, skills: v }))]) {
    data.skills = skills;
    const [r4, l4] = render(ASCII);
    assert.ok(r4.startsWith('ИРИНА СОКОЛОВА') && l4.endsWith('Ирина Соколова') && !/YOUR NAME/i.test(r4 + l4), r4);
    for (const line of ['Мови: English, Deutsch', 'Навички: Excel, SAP', 'Податки: IFRS, VAT', 'Cafe: Payroll', 'Cafe: Audit']) assert.ok(r4.split('\n').includes(line), `${line}\n${r4}`);
    for (const text of [r4, l4]) assert.ok(text.includes('5551234567  |  zoe@example.com'), text);
  }
  assert.ok(render(BARE)[0].includes('5551234567  |  zoe@example.com'));
});

test('section headings are English by default and follow output.sectionHeadings when the profile sets it', () => {
  const english = fixture(BARE, nurse(), 'resume-headings.json');
  assert.equal(run('render-docx.js', [english], BARE).status, 0);
  assert.deepEqual(docxText(english.replace(/\.json$/, '.docx')).split('\n').filter((l) => /^[A-Z ]+$/.test(l)).slice(1),
    ['SUMMARY', 'SELECTED PROJECTS', 'EXPERIENCE', 'SKILLS', 'EDUCATION', 'AWARDS']);

  const sets = {
    german: { summary: 'Profil', projects: 'Projekte', experience: 'Berufserfahrung', skills: 'Kenntnisse', education: 'Ausbildung', awards: 'Auszeichnungen' },
    spanish: { summary: 'Perfil', projects: 'Proyectos', experience: 'Experiencia profesional', skills: 'Competencias', education: 'Formación', awards: 'Premios' },
  };
  for (const [lang, sectionHeadings] of Object.entries(sets)) {
    const root = mkRoot(`headings-${lang}`);
    write(path.join(root, 'data', 'profile.json'), { output: { sectionHeadings } });
    const input = fixture(root, nurse(), 'resume-headings.json');
    assert.equal(run('render-docx.js', [input], root).status, 0);
    const lines = docxText(input.replace(/\.json$/, '.docx')).split('\n');
    const at = Object.values(sectionHeadings).map((h) => lines.indexOf(h.toUpperCase()));
    assert.ok(at.every((i) => i > 0) && at.every((i, n) => n === 0 || i > at[n - 1]), `${lang}: ${lines.join(' / ')}`);
    for (const word of ['SUMMARY', 'SELECTED PROJECTS', 'EXPERIENCE', 'SKILLS', 'EDUCATION', 'AWARDS']) assert.ok(!lines.includes(word), `${lang}: ${word}`);
  }

  // A partial or malformed map never breaks a render: unset keys stay English,
  // and a per resume projectsHeading still wins.
  const partial = mkRoot('headings-partial');
  write(path.join(partial, 'data', 'profile.json'), { output: { sectionHeadings: { skills: 'Kenntnisse', education: 7, summary: '  ', projects: 'Projekte' } } });
  const input = fixture(partial, { ...nurse(), projectsHeading: 'Audits' }, 'resume-headings.json');
  assert.equal(run('render-docx.js', [input], partial).status, 0);
  const lines = docxText(input.replace(/\.json$/, '.docx')).split('\n');
  for (const word of ['SUMMARY', 'AUDITS', 'EXPERIENCE', 'KENNTNISSE', 'EDUCATION']) assert.ok(lines.includes(word), word);
  assert.ok(!lines.includes('PROJEKTE') && !lines.includes('SKILLS'));
  const odd = mkRoot('headings-odd');
  write(path.join(odd, 'data', 'profile.json'), { output: { sectionHeadings: 'Profil' } });
  const plain = fixture(odd, nurse(), 'resume-headings.json');
  assert.equal(run('render-docx.js', [plain], odd).status, 0);
  assert.ok(docxText(plain.replace(/\.json$/, '.docx')).split('\n').includes('EXPERIENCE'));

  // The PDF reading order check uses the same words as the renderer.
  const { headingText } = require('../scripts/render-docx');
  assert.equal(headingText('summary', 'Summary'), 'SUMMARY');
});

test('a postscript after the signature is printed once after the name and never produces a second sign off', () => {
  const [greet, p1, p2] = nurse().coverLetter.split('\n\n');
  const ps = 'P.S. I am available to start in November.';
  for (const tail of [['Sincerely,\nAmara Lindqvist'], ['Sincerely,', 'Amara Lindqvist'], ['Kind regards,\nAmara Lindqvist, RN']]) {
    for (const mark of [ps, ps.replace('P.S.', 'PS:'), ps.replace('P.S.', 'PS'), ps.replace('P.S.', 'P. S.')]) {
      const r = prepareCoverLetter([greet, p1, p2, ...tail, mark].join('\n\n'), 'Mercy Valley Clinic', 'Amara Lindqvist');
      assert.deepEqual(r, { greeting: greet, paragraphs: [p1, p2], closing: tail[0].split('\n')[0], postscript: [mark] }, mark);
    }
  }
  // On the line right after the name (no blank line): same result.
  for (const tail of ['Sincerely,\nAmara Lindqvist', 'Sincerely,\n\nAmara Lindqvist', 'Kind regards,\nDr. Amara Q. Lindqvist, RN']) {
    assert.deepEqual(prepareCoverLetter([greet, p1, p2, `${tail}\n${ps}`].join('\n\n'), 'Mercy Valley Clinic', tail.split('\n').pop().replace(', RN', '')),
      { greeting: greet, paragraphs: [p1, p2], closing: tail.split('\n')[0], postscript: [ps] }, tail);
  }
  // A hard wrapped body paragraph with a line that opens like one is never cut.
  const wrapped = 'Our unit moved 28 beds to bedside handover in one quarter and I trained the\nPS team of 14 graduates who now run it on every shift without me.';
  assert.deepEqual(prepareCoverLetter([greet, p1, wrapped].join('\n\n'), 'Mercy Valley Clinic', 'Amara Lindqvist').paragraphs, [p1, wrapped]);
  // No sign off before it: the postscript is still set aside and the default is added once.
  assert.deepEqual(prepareCoverLetter([p1, p2, ps].join('\n\n'), 'Mercy Valley Clinic', 'Amara Lindqvist'),
    { greeting: 'Dear Mercy Valley Clinic Hiring Team,', paragraphs: [p1, p2], closing: 'Sincerely,', postscript: [ps] });
  // A body paragraph that only looks like one stays where it is, and a letter never loses its only paragraph.
  for (const body of ['PS5 launch audits taught me to check every release twice.', 'Psychology rotations shaped how I run handover.', 'PD sessions for 14 graduates were mine to plan.']) {
    assert.deepEqual(prepareCoverLetter([p1, body].join('\n\n'), '', '').paragraphs, [p1, body], body);
  }
  assert.deepEqual(prepareCoverLetter(ps, '', '').paragraphs, [ps]);
  // Other languages: the letter's own sign off, then its postscript.
  const de = LETTERS.german;
  const post = 'PS: Ab dem 1. November bin ich verfügbar.';
  assert.deepEqual(prepareCoverLetter([de.greeting, ...de.body, `${de.closing}\n${de.name}`, post].join('\n\n'), de.company, de.name),
    { greeting: de.greeting, paragraphs: de.body, closing: de.closing, postscript: [post] });
  const es = LETTERS.spanish;
  assert.deepEqual(prepareCoverLetter([es.greeting, ...es.body, `${es.closing}\n${es.name}`, 'P. D.: Puedo incorporarme en noviembre.'].join('\n\n'), es.company, es.name).postscript,
    ['P. D.: Puedo incorporarme en noviembre.']);

  const data = nurse();
  data.coverLetter += `\n\n${ps}`;
  const input = fixture(BARE, data, 'resume-postscript.json');
  assert.equal(run('render-cover-letter.js', ['--strict', input], BARE).status, 0);
  const lines = docxText(path.join(path.dirname(input), 'cover-letter-postscript.docx')).split('\n');
  assert.deepEqual(lines.slice(-3), ['Sincerely,', 'Amara Lindqvist', ps]);
  assert.equal(lines.filter((l) => /^Sincerely/.test(l)).length, 1);
  assert.equal(lines.filter((l) => l === 'Amara Lindqvist').length, 1);
});

test('a signature name that opens like a postscript marker is the name, printed once, and a real postscript after it still counts', () => {
  const [greet, p1, p2] = nurse().coverLetter.split('\n\n');
  const ps = 'P.S. I am available to start in November.';
  const cases = [['Sincerely,', 'P. S. Raman', 'P. S. Raman'], ['Kind regards,', 'P.S. Nair, RN', 'P.S. Nair'],
    ['Yours faithfully,', 'P. D. Sharma', 'P. D. Sharma'], ['Atentamente,', 'P. S\u00e1nchez', 'P. S\u00e1nchez']];
  cases.forEach(([close, signed, name], i) => {
    for (const sep of ['\n', '\n\n']) {
      const letter = [greet, p1, p2, `${close}${sep}${signed}`].join('\n\n');
      assert.deepEqual(prepareCoverLetter(letter, 'Mercy Valley Clinic', name), { greeting: greet, paragraphs: [p1, p2], closing: close }, signed);
      for (const psSep of ['\n', '\n\n']) {
        assert.deepEqual(prepareCoverLetter(`${letter}${psSep}${ps}`, 'Mercy Valley Clinic', name),
          { greeting: greet, paragraphs: [p1, p2], closing: close, postscript: [ps] }, `${signed} + postscript`);
      }
      const data = { ...nurse(), name, coverLetter: letter };
      const input = fixture(BARE, data, `resume-psname${i}${sep.length}.json`);
      assert.equal(run('render-cover-letter.js', [input], BARE).status, 0);
      const lines = docxText(path.join(path.dirname(input), `cover-letter-psname${i}${sep.length}.docx`)).split('\n');
      assert.deepEqual(lines.slice(-2), [close, name], signed);
      assert.equal(lines.filter((l) => l.includes(name)).length, 1, signed);
    }
  });
  // With no name on file the Unicode boundary alone keeps an accented surname out.
  assert.equal(prepareCoverLetter([greet, p1, p2, 'Atentamente,', 'P. S\u00e1nchez'].join('\n\n'), '', '').postscript, undefined);
});

test('cover letter renders exactly one greeting and one signature, with blank author metadata', () => {
  const input = fixture(BARE, nurse(), 'resume-letter.json');
  const r = run('render-cover-letter.js', ['--strict', input], BARE);
  assert.equal(r.status, 0, r.out);
  const docx = path.join(path.dirname(input), 'cover-letter-letter.docx');
  const xml = zipEntry(docx, 'word/document.xml');
  assert.equal(xml.match(/Dear /g).length, 1);
  assert.match(xml, /Dear Mercy Valley Clinic Nursing Team,/);
  assert.equal(xml.match(/Sincerely,/g).length, 1);
  assert.equal(xml.match(/Amara Lindqvist/g).length, 1, 'the signature appears once (the header is in capitals)');
  assert.ok(!/<dc:creator>[^<]+<\/dc:creator>/.test(zipEntry(docx, 'docProps/core.xml')));
});

test('cover letter gates: forbidden term fatal, substance bar blocks only under --strict', () => {
  const leak = nurse();
  leak.coverLetter = leak.coverLetter.replace('handover redesign', 'Project Lantern handover redesign');
  const leaked = fixture(GUARDED, leak, 'resume-cl-leak.json');
  const fatal = run('render-cover-letter.js', [leaked], GUARDED);
  assert.equal(fatal.status, 1);
  assert.match(fatal.out, /forbidden-terms-gate\] FATAL.*Project Lantern/);
  assert.ok(!fs.existsSync(path.join(path.dirname(leaked), 'cover-letter-cl-leak.docx')));

  const generic = fixture(BARE, accountant(), 'resume-cl-generic.json');
  const docx = path.join(path.dirname(generic), 'cover-letter-cl-generic.docx');
  const warn = run('render-cover-letter.js', [generic], BARE);
  assert.equal(warn.status, 0, warn.out);
  assert.match(warn.out, /\[cover-letter-audit\] 3 missing required element/);
  assert.ok(fs.existsSync(docx));
  fs.rmSync(docx);
  assert.equal(run('render-cover-letter.js', ['--strict', generic], BARE).status, 1);
  assert.ok(!fs.existsSync(docx));
});

test('strict cover letter render: a complete letter in another language is written, with the unchecked elements named; a thin one is still refused', () => {
  const full = {
    german: [...LETTERS.german.body.slice(0, 2),
      'Im Klinikum Nordstadt möchte ich diese Arbeit fortsetzen. Ich habe 14 neue Kolleginnen und Kollegen in der Sepsis Früherkennung eingearbeitet, die wöchentliche Auswertung der Vorfälle geleitet und der Pflegedirektion empfohlen, die Dienstplanung auf feste Übergabezeiten umzustellen. Die Direktion hat diese Empfehlung übernommen, und die Einsparung lag bei 40.000 EUR im Jahr.',
      LETTERS.german.body[2]],
    french: [...LETTERS.french.body,
      'Au sein du Cabinet Moreau, je souhaite poursuivre ce travail. J\'ai formé quatre nouveaux collaborateurs à la préparation des déclarations des sociétés de personnes, animé la revue hebdomadaire des dossiers en retard et recommandé à la direction de regrouper les relances des clients en une seule campagne par trimestre. La direction a adopté cette décision, ce qui a réduit de 20 % le nombre de dossiers déposés après la date limite.',
      'Je serais heureuse de vous présenter ce parcours lors d\'un entretien et je reste à votre disposition pour toute précision.'],
  };
  for (const [lang, body] of Object.entries(full)) {
    const l = LETTERS[lang];
    const data = { name: l.name, company: l.company, date: '2031-03-04', contact: { email: 'someone@example.com' },
      coverLetter: [l.greeting, ...body, `${l.closing}\n${l.name}`].join('\n\n') };
    const input = fixture(BARE, data, `resume-strict-${lang}.json`);
    const docx = path.join(path.dirname(input), `cover-letter-strict-${lang}.docx`);
    const r = run('render-cover-letter.js', ['--strict', input], BARE);
    assert.equal(r.status, 0, `${lang}: ${r.out}`);
    assert.match(r.out, /\[cover-letter-audit\] not checked for a letter not in English, verify by hand: leadership/);
    assert.ok(!/missing required element/.test(r.out), r.out);
    assert.deepEqual(docxText(docx).split('\n').slice(3), [l.greeting, ...body, l.closing, l.name], lang);

    // The same letter naming no employer and carrying no figure is refused.
    fs.rmSync(docx);
    data.coverLetter = data.coverLetter.replaceAll(l.company, 'X').replace(/\d[\d.,\s]*/g, '');
    fixture(BARE, data, `resume-strict-${lang}.json`);
    const thin = run('render-cover-letter.js', ['--strict', input], BARE);
    assert.equal(thin.status, 1, `${lang}: ${thin.out}`);
    assert.match(thin.out, /no measurable outcome/);
    assert.match(thin.out, /employer .* is not named/);
    assert.ok(!fs.existsSync(docx));
  }
});
