'use strict';
// The evidence layer scripts: scripts/evidence-index.js (fact index over the
// user's own work folders, credited by tailorBrief), scripts/
// check-evidence-coverage.js and scripts/check-evidence-depth.js (optional
// gates that pass when their data files are absent), and the candidate pool
// writer scripts/bulk-resume-from-list.js. Synthetic fixtures only (a
// registered nurse and a tax accountant), each in a JOBE_USER_ROOT temp
// workspace. No network: the one posting used carries its own JD text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const mkRoot = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `scripts-generation-${name}-`));
const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};
function run(script, args, root, env = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, JOBE_USER_ROOT: root, JOBE_EVIDENCE_ROOTS: '', ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}

// ── Nurse workspace: the in-process one (profile roots, tailorBrief credit) ──

const NURSE = mkRoot('nurse');
const NURSE_WORK = mkRoot('nurse-work');           // an evidence root holding two small files
write(path.join(NURSE_WORK, 'ward-notes.md'), 'Charting moved to MEDITECH Expanse in March.\nTelemetry monitoring checklist for the step down unit.\n');
write(path.join(NURSE_WORK, 'protocol.txt'), 'Sepsis screening protocol, revision 3. Escalate on two triggers.\n');
write(path.join(NURSE, 'data', 'profile.json'), {
  evidence: {
    roots: [NURSE_WORK, path.join(NURSE_WORK, 'does-not-exist')],
    tools: ['telemetry monitoring', { name: 'meditech', match: ['MEDITECH\\s+Expanse'], aliases: ['expanse'] }, 'lacerte'],
  },
});
const NURSE_BASELINE = {
  name: 'Amara Lindqvist',
  contact: { email: 'amara@example.com' },
  summary: 'Registered nurse on acute medical wards.',
  experience: [{ company: 'Northfield General Hospital', title: 'Senior Staff Nurse', dates: 'Mar 2019 to Present', bullets: ['placeholder'] }],
  skills: { Clinical: 'IV therapy, Wound care', Practice: 'Sepsis screening' },
  education: [{ degree: 'BSc Nursing', school: 'Example University' }],
  defaultBulletCounts: { current: 2 },
};
write(path.join(NURSE, 'data', 'resume-baseline.json'), NURSE_BASELINE);
write(path.join(NURSE, 'data', 'bullet-library.json'), {
  companyKeyMap: { 'Northfield General Hospital': 'current' },
  current: [
    { id: 'current-handover', keywords: ['handover', 'medication safety'], text: 'Cut medication errors 31 percent across a 28 bed ward by introducing a two nurse check at handover.' },
    { id: 'current-training', keywords: ['preceptorship', 'discharge planning'], text: 'Trained 14 new graduates and coordinated discharge planning with pharmacy for a 22 patient caseload.' },
  ],
  selectedProjects: [
    { id: 'proj-audit', name: 'Handover audit', keywords: ['audit'], text: 'A structured handover checklist adopted by three wards after a twelve week pilot.' },
  ],
});
process.env.JOBE_USER_ROOT = NURSE;
process.env.JOBE_EVIDENCE_ROOTS = '';

const { tailorBrief, corpusTools } = require('../lib/tailor');
const evidenceIndex = require('../scripts/evidence-index');
const { generateOne } = require('../scripts/bulk-resume-from-list');

const NURSE_JD = [
  'Responsibilities',
  ...Array.from({ length: 5 }, () => 'Chart every assessment in Meditech and keep Meditech orders current for the unit. Meditech downtime procedures apply.'),
  'Qualifications',
  'Meditech charting on an acute unit, sepsis screening, and discharge planning with pharmacy for a full caseload.',
].join('\n');

test('evidence-index: a term proven in the user\'s own files stops reading as a gap', () => {
  assert.equal(corpusTools(), null, 'no index yet');
  const before = tailorBrief(NURSE_JD, NURSE_BASELINE);
  assert.ok(before.coverage.topJdTerms.includes('meditech'));
  assert.ok(before.coverage.gaps.includes('meditech'), 'unproven: listed as a gap');

  const index = evidenceIndex.build(null);
  const file = path.join(NURSE, 'data', 'evidence-index.json');
  assert.ok(fs.existsSync(file), 'the index is written inside the workspace');
  assert.equal(index.repoCount, 1, 'a root holding only files is one project');
  assert.deepEqual(index.generatedFrom, [NURSE_WORK], 'a missing root is skipped');
  // Found: an evidence.tools name, an evidence.tools match pattern, a baseline skill.
  assert.deepEqual(Object.keys(index.toolPresence).sort(), ['meditech', 'sepsis screening', 'telemetry monitoring']);
  // Not found: a listed tool that the files never mention, and library keywords absent from the files.
  assert.ok(!('lacerte' in index.toolPresence));
  assert.ok(!('handover' in index.toolPresence));
  assert.equal(index.aliases.expanse, 'meditech');

  const after = tailorBrief(NURSE_JD, NURSE_BASELINE);
  assert.ok(!after.coverage.gaps.includes('meditech'), 'proven in the index: no longer a gap');
});

test('evidence-index CLI: has answers from the index (exit 0 found, 1 absent), aliases resolve', () => {
  const found = run('evidence-index.js', ['has', 'Telemetry Monitoring'], NURSE);
  assert.equal(found.status, 0, found.out);
  assert.match(found.out, /1 project\(s\)/);
  assert.equal(run('evidence-index.js', ['has', 'expanse'], NURSE).status, 0, 'user alias from evidence.tools');
  const absent = run('evidence-index.js', ['has', 'lacerte'], NURSE);
  assert.equal(absent.status, 1);
  assert.match(absent.out, /NOT FOUND/);
  assert.equal(run('evidence-index.js', ['selftest'], NURSE).status, 0);
  assert.match(run('evidence-index.js', ['tools'], NURSE).out, /meditech\s+1/);
});

// ── Accountant workspace: CLI only (--roots, env roots, project discovery) ──

test('evidence-index: --roots and JOBE_EVIDENCE_ROOTS, one project per subfolder, short names need an alias', () => {
  const root = mkRoot('accountant');
  const work = mkRoot('accountant-work');
  write(path.join(work, 'client-a', 'workpapers.md'), 'Depreciation schedule exported from Lacerte. Go to the next tab.\n');
  write(path.join(work, 'client-b', 'close-checklist.txt'), 'Month end close in QuickBooks, three way match on payables.\n');
  write(path.join(work, 'client-b', 'node_modules', 'x', 'readme.md'), 'lacerte\n');
  write(path.join(root, 'data', 'resume-baseline.json'), { skills: ['Software: Lacerte (advanced), QuickBooks, Go'] });

  const none = run('evidence-index.js', ['build'], root);
  assert.equal(none.status, 0, none.out);
  assert.match(none.out, /no evidence roots configured/);
  assert.ok(!fs.existsSync(path.join(root, 'data', 'evidence-index.json')), 'nothing is written without roots');
  assert.equal(run('evidence-index.js', ['has', 'lacerte'], root).status, 2, 'no index yet');

  const built = run('evidence-index.js', ['build'], root, { JOBE_EVIDENCE_ROOTS: work });
  assert.equal(built.status, 0, built.out);
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'data', 'evidence-index.json'), 'utf8'));
  assert.equal(idx.repoCount, 2);
  assert.deepEqual(idx.toolPresence, { lacerte: ['client-a'], quickbooks: ['client-b'] },
    'vendored folders are skipped and the two letter skill "go" is never matched as a bare word');

  fs.rmSync(path.join(root, 'data', 'evidence-index.json'));
  const flagged = run('evidence-index.js', ['build', '--roots', path.join(work, 'client-b')], root);
  assert.equal(flagged.status, 0, flagged.out);
  assert.equal(run('evidence-index.js', ['has', 'QuickBooks'], root).status, 0);
  assert.equal(run('evidence-index.js', ['has', 'lacerte'], root).status, 1, '--roots replaces every other root');
});

test('evidence-index: terms in other scripts are found, and a mixed term is not credited for its Latin half alone', () => {
  const root = mkRoot('scripts');
  const work = mkRoot('scripts-work');
  const cyrillic = '\u0431\u0443\u0445\u0433\u0430\u043b\u0442\u0435\u0440\u0438\u044f';   // bookkeeping
  const han = '\u5ba1\u8ba1';                                                              // audit, two characters
  const mixed = '\u30c7\u30fc\u30bf\u5206\u6790 SQL';                                        // data analysis SQL
  write(path.join(work, 'ledger', 'notes.md'), `Quarter close: ${cyrillic} and payroll.\n\u5e74\u5ea6${han}\u62a5\u544a\n`);
  write(path.join(work, 'queries', 'notes.md'), 'only sql here\n');
  write(path.join(root, 'data', 'profile.json'), { evidence: { tools: [cyrillic, han, mixed, 'R', '\u7a0e'] } });

  const built = run('evidence-index.js', ['build', '--roots', work], root);
  assert.equal(built.status, 0, built.out);
  assert.match(built.out, /not searched \(too short[^\n]*: r, \u7a0e/, 'terms too short to search are named, not dropped in silence');
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'data', 'evidence-index.json'), 'utf8'));
  assert.deepEqual(idx.toolPresence, { [cyrillic]: ['ledger'], [han]: ['ledger'] });
  assert.equal(run('evidence-index.js', ['has', cyrillic], root).status, 0);
  assert.equal(run('evidence-index.js', ['has', mixed], root).status, 1);
});

// ── Coverage and depth gates ────────────────────────────────────────────────

test('coverage and depth gates pass in a workspace with no data files', () => {
  const root = mkRoot('fresh');
  for (const script of ['check-evidence-coverage.js', 'check-evidence-depth.js']) {
    const r = run(script, [], root);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /skipped/);
    const j = run(script, ['--json'], root);
    assert.equal(j.status, 0);
    assert.doesNotThrow(() => JSON.parse(j.stdout));
  }
  // Anchors configured but no library yet: still nothing to check.
  write(path.join(root, 'data', 'evidence-anchors.json'), { anchors: [{ id: 'a', terms: ['x'] }] });
  assert.equal(run('check-evidence-coverage.js', [], root).status, 0);
});

test('coverage and depth gates: a data file that exists but does not parse is an error, never a skip', () => {
  const root = mkRoot('malformed');
  const library = { current: [{ id: 'c1', keywords: [], text: 'Prepared 340 returns per season.' }] };
  write(path.join(root, 'data', 'bullet-library.json'), library);
  write(path.join(root, 'data', 'evidence-anchors.json'), '{"anchors":[{"id":"a","terms":["zzz"]}],}');
  write(path.join(root, 'data', 'evidence-depth.json'), '{"systems":[{"id":"s","match":["returns"],"mechanisms":["three way match"]}],}');
  const resume = write(path.join(root, 'out', 'resume.json'), { experience: [{ company: 'Harbor Tax Group', bullets: ['Prepared 340 returns.'] }] });
  for (const [script, args] of [['check-evidence-coverage.js', []], ['check-evidence-coverage.js', ['--json']],
    ['check-evidence-depth.js', []], ['check-evidence-depth.js', ['--resume', resume]]]) {
    const r = run(script, args, root);
    assert.equal(r.status, 2, `${script} ${args.join(' ')}: ${r.out}`);
    assert.match(r.out, /cannot parse .*evidence-(anchors|depth)\.json/);
    assert.equal(r.stdout, '', 'nothing on stdout that could read as a result');
  }
  // Valid gate files, broken library: the same.
  write(path.join(root, 'data', 'evidence-anchors.json'), { anchors: [{ id: 'a', terms: ['zzz'] }] });
  write(path.join(root, 'data', 'evidence-depth.json'), { systems: [{ id: 's', match: ['returns'], mechanisms: ['three way match'] }] });
  write(path.join(root, 'data', 'bullet-library.json'), JSON.stringify(library) + ',');
  for (const script of ['check-evidence-coverage.js', 'check-evidence-depth.js']) {
    const r = run(script, [], root);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /cannot parse .*bullet-library\.json/);
  }
});

test('coverage gate: exit 1 names the anchor with no library bullet', () => {
  write(path.join(NURSE, 'data', 'evidence-anchors.json'), { _examples: [{ id: 'ignored', terms: ['zzz'] }], anchors: [
    { id: 'handover-redesign', section: 'current role', terms: ['Two Nurse Check'] },
    { id: 'falls-prevention', section: 'current role', terms: ['falls prevention', 'bed alarm'] },
  ] });
  const r = run('check-evidence-coverage.js', ['--json'], NURSE);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.total, out.covered, out.gaps], [2, 1, 1]);
  assert.deepEqual(out.results.filter((x) => !x.covered).map((x) => x.id), ['falls-prevention']);
  assert.match(run('check-evidence-coverage.js', ['--quiet'], NURSE).out, /falls-prevention {2}\[current role\]/);
  fs.rmSync(path.join(NURSE, 'data', 'evidence-anchors.json'));
});

test('depth gate: library mode and --resume mode flag work named without its method', () => {
  write(path.join(NURSE, 'data', 'evidence-depth.json'), { systems: [
    { id: 'handover-redesign', match: ['handover'], mechanisms: ['two nurse check'] },
    { id: 'graduate-training', match: ['new graduates'], mechanisms: ['competency sign off'] },
    { id: 'not-in-library', match: ['telehealth triage'], mechanisms: ['anything'] },
  ] });
  const lib = run('check-evidence-depth.js', ['--json'], NURSE);
  assert.equal(lib.status, 1);
  const out = JSON.parse(lib.stdout);
  assert.deepEqual([out.deep, out.shallow, out.absent], [1, 1, 1]);
  assert.equal(out.results.find((x) => x.status === 'shallow').id, 'graduate-training');

  const shallowResume = write(path.join(NURSE, 'out', 'shallow.json'), {
    summary: 'Leads handover on a busy ward.',
    experience: [{ company: 'Northfield General Hospital', bullets: ['Runs handover for a 28 bed ward.', { text: 'Mentors students.' }] }],
  });
  const r1 = run('check-evidence-depth.js', ['--resume', shallowResume, '--json'], NURSE);
  assert.equal(r1.status, 1);
  assert.deepEqual(JSON.parse(r1.stdout), { shallow: ['handover-redesign'], deep: [] });
  const deepResume = write(path.join(NURSE, 'out', 'deep.json'), {
    experience: [{ company: 'Northfield General Hospital', bullets: [{ text: 'Introduced a two nurse check at handover.' }] }],
  });
  assert.equal(run('check-evidence-depth.js', ['--resume', deepResume], NURSE).status, 0);
  assert.equal(run('check-evidence-depth.js', ['--resume', path.join(NURSE, 'out', 'missing.json')], NURSE).status, 2);
  fs.rmSync(path.join(NURSE, 'data', 'evidence-depth.json'));
});

// ── Candidate pool writer ───────────────────────────────────────────────────

test('bulk-resume-from-list writes a candidate pool, jd.txt, and _genctx.json under reports/queue, and never a DOCX or a queue entry', async () => {
  const url = 'https://careers.example.org/jobs/charge-nurse-4471';
  const jdText = NURSE_JD + '\n' + 'Lead handover and medication safety on a 28 bed ward. '.repeat(20);
  const posting = { canonicalUrl: url + '/', company: 'Mercy Valley Clinic', title: 'Charge Nurse', jdText, matchScore: 81.4, location: 'Leeds' };
  const r = await generateOne(url + '?src=feed', [posting], NURSE_BASELINE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.slug, 'mercy-valley-clinic-charge-nurse-leeds', 'the slug carries the city unless the policy is remote only');
  assert.equal(r.location, 'Leeds');
  assert.equal(r.dir, path.join(NURSE, 'reports', 'queue', r.slug));
  assert.deepEqual(fs.readdirSync(r.dir).map((f) => f.replace(/\d{4}-\d{2}-\d{2}/, 'DATE')).sort(),
    ['_genctx.json', `candidate-pool-DATE-${r.slug}.json`, 'jd.txt']);
  const pool = JSON.parse(fs.readFileSync(r.jsonPath, 'utf8'));
  assert.equal(pool.candidatePool, true);
  assert.equal(pool.coverLetter, '');
  assert.equal(pool.experience[0].company, 'Northfield General Hospital');
  assert.equal(pool.experience[0].bullets.length, 2, 'bullets come from the library under the mapped role key');
  assert.equal(fs.readFileSync(path.join(r.dir, 'jd.txt'), 'utf8'), jdText);
  const ctx = JSON.parse(fs.readFileSync(path.join(r.dir, '_genctx.json'), 'utf8'));
  assert.equal(ctx.slug, r.slug);
  assert.ok(ctx.briefKeywords.includes('meditech'));
  assert.ok(Array.isArray(ctx.briefGaps) && ctx.evidenceByRole.current.length > 0);
  assert.deepEqual(ctx.poolExperience, pool.experience);
  assert.ok(!fs.existsSync(path.join(NURSE, 'data', 'apply-queue.json')), 'no queue entry is pushed');

  // A slug that already lives in another lifecycle bucket keeps its folder.
  const moved = path.join(NURSE, 'reports', 'evaluate', r.slug);
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(r.dir, moved);
  const again = await generateOne(url, [posting], NURSE_BASELINE);
  assert.equal(again.dir, moved);
  assert.ok(!fs.existsSync(r.dir));

  assert.equal((await generateOne('https://careers.example.org/jobs/unknown', [posting], NURSE_BASELINE)).ok, false);
  assert.match((await generateOne(url, [{ ...posting, jdText: 'too short' }], NURSE_BASELINE)).reason, /jdText too short/);
});

test('bulk-resume-from-list: two cities of one employer and title get two folders; a remote only policy keeps the city free slug', async () => {
  const jdText = NURSE_JD + '\n' + 'Lead handover and medication safety on a 28 bed ward. '.repeat(20);
  const row = (city) => ({ canonicalUrl: `https://careers.example.org/jobs/rn-${city.slice(0, 3)}`, company: 'Example Health', title: 'Registered Nurse', jdText, location: `${city}, CO` });
  const idx = [row('Denver'), row('Boulder')];
  const [a, b] = [await generateOne(idx[0].canonicalUrl, idx, NURSE_BASELINE), await generateOne(idx[1].canonicalUrl, idx, NURSE_BASELINE)];
  assert.deepEqual([a.slug, b.slug], ['example-health-registered-nurse-denver', 'example-health-registered-nurse-boulder']);
  assert.notEqual(a.dir, b.dir);
  assert.deepEqual([a, b].map((r) => JSON.parse(fs.readFileSync(path.join(r.dir, '_genctx.json'), 'utf8')).location), ['Denver, CO', 'Boulder, CO']);

  // The CLI in a remote only workspace: the slug of private, no city.
  const root = mkRoot('remote-only');
  write(path.join(root, 'data', 'profile.json'), { discovery: { workModes: ['remote'] } });
  write(path.join(root, 'data', 'resume-baseline.json'), NURSE_BASELINE);
  const today = new Date().toISOString().slice(0, 10);
  write(path.join(root, 'signals', 'discovered', today, 'ranked-enriched.json'), [{ ...idx[0], alternateUrls: [], location: 'Remote - Denver, CO' }]);
  const r = run('bulk-resume-from-list.js', ['--json', idx[0].canonicalUrl], root);
  assert.equal(r.status, 0, r.out);
  const items = JSON.parse(r.stdout);
  assert.equal(items[0].slug, 'example-health-registered-nurse');
  assert.equal(items[0].location, 'Remote - Denver, CO');
});

test('bulk-resume-from-list: an empty defaultBulletCounts map still selects from the library, and the employer name is not JD vocabulary', async () => {
  const url = 'https://careers.example.org/jobs/ward-sister-90';
  const jdText = NURSE_JD + '\n' + 'Brightwater Health wards run a Brightwater Health handover round on every shift. '.repeat(12);
  assert.ok(tailorBrief(jdText, NURSE_BASELINE).jd.keywords.slice(0, 15).some((k) => /brightwater/.test(k.term)), 'the fixture JD does rank the employer name');
  const posting = { canonicalUrl: url, company: 'Brightwater Health', title: 'Ward Sister', jdText };
  const r = await generateOne(url, [posting], { ...NURSE_BASELINE, defaultBulletCounts: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  const pool = JSON.parse(fs.readFileSync(r.jsonPath, 'utf8'));
  assert.deepEqual(pool.experience[0].bullets.map((b) => (typeof b === 'string' ? b : b.text)).sort(), [
    'Cut medication errors 31 percent across a 28 bed ward by introducing a two nurse check at handover.',
    'Trained 14 new graduates and coordinated discharge planning with pharmacy for a 22 patient caseload.',
  ], 'the scaffolded empty map counts as unset: library bullets, not the baseline placeholder');
  const ctx = JSON.parse(fs.readFileSync(path.join(r.dir, '_genctx.json'), 'utf8'));
  assert.ok(ctx.briefKeywords.length > 0);
  assert.ok(![...ctx.briefKeywords, ...ctx.briefGaps].some((k) => /brightwater|health/.test(k)), JSON.stringify(ctx.briefKeywords));
});

test('bulk-resume-from-list CLI explains a missing baseline instead of crashing', () => {
  const root = mkRoot('nobaseline');
  const r = run('bulk-resume-from-list.js', ['https://careers.example.org/jobs/1'], root);
  assert.equal(r.status, 1);
  assert.match(r.out, /No resume baseline/);
});

test('tailor-brief prints the JD analysis in a workspace with no baseline', () => {
  const root = mkRoot('brief');
  const jd = write(path.join(root, 'jd.txt'), NURSE_JD);
  const r = run('tailor-brief.js', [jd], root);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /TOP JD KEYWORDS:.*meditech/);
});
