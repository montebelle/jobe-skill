'use strict';
// The mode and agent text owned by the modes-rest area is instructions a model
// follows, so the checks here are of two kinds:
//   1. Text rules: no fixed job title catalogue in the discovery agent, no flat
//      report path where a report is read, no fancy dashes.
//   2. Doc and code agree: the shell snippets the modes print are EXTRACTED from
//      the markdown and run against a synthetic JOBE_USER_ROOT workspace, so a
//      snippet that drifts from the lib API fails here.
// Fixtures are two unrelated synthetic candidates: a registered nurse and a tax
// accountant. Nothing touches the network or a real workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MODES = path.join(REPO, '.claude', 'skills', 'jobe', 'modes');
const AGENTS = path.join(REPO, '.claude', 'agents');
const MODE_FILES = ['apply', 'apply-all', 'apply-assisted', 'linkedin-search', 'linkedin-tab', 'tracker',
  'interview-prep', 'followup', 'patterns', 'contacto', 'deep', 'project', 'calibrate', 'audit'];
const AGENT_FILES = ['jobe-job-discovery', 'jobe-jd-analyzer', 'jobe-company-intel', 'jobe-competitor'];
const mode = (name) => fs.readFileSync(path.join(MODES, name + '.md'), 'utf8');
const agent = (name) => fs.readFileSync(path.join(AGENTS, name + '.md'), 'utf8');

const bash = process.platform === 'win32' ? false : 'bash';
const skipShell = bash ? false : 'needs bash';

function workspace(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jobe-modes-rest-${tag}-`));
}
function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
// Fenced code blocks of a markdown file, dedented (blocks inside list items are indented).
function codeBlocks(md) {
  const out = [];
  const re = /^([ \t]*)```\w*\n([\s\S]*?)^[ \t]*```/gm;
  for (const m of md.matchAll(re)) {
    out.push(m[2].split('\n').map((l) => (l.startsWith(m[1]) ? l.slice(m[1].length) : l)).join('\n'));
  }
  return out;
}
function block(md, marker) {
  const hit = codeBlocks(md).find((b) => b.includes(marker));
  assert.ok(hit, `no code block containing: ${marker}`);
  return hit;
}
// Run a documented snippet from the install root, the way the modes say to.
function run(script, root, extraEnv = {}) {
  return execFileSync(bash, ['-c', script], {
    cwd: REPO,
    env: { ...process.env, JOBE_USER_ROOT: root, WORKSPACE: root, JOBE_HOME: REPO, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const NURSE_SLUG = 'northfield-clinic-charge-nurse';
const ACCOUNTANT_SLUG = 'ridgeline-cpa-senior-tax-accountant';
const NURSE_RESUME = {
  name: 'Priya Raman',
  contact: { email: 'priya.raman@example.com', phone: '555-0101', location: 'Madison, WI' },
  summary: 'Registered nurse with eight years on medical surgical units.',
  experience: [{ company: 'Lakeside Regional Hospital', title: 'Registered Nurse', bullets: ['Cut falls 30 percent on a 28 bed unit.'] }],
  education: [{ school: 'Prairie State College of Nursing', degree: 'B.S. Nursing', dates: '2011 - 2015' }],
  company: 'Northfield Clinic', role: 'Charge Nurse',
};
const ACCOUNTANT_RESUME = {
  name: 'Tomas Lindqvist',
  contact: { email: 'tomas.lindqvist@example.com', phone: '555-0102', location: 'Tucson, AZ' },
  summary: 'Tax accountant covering partnership and multistate returns.',
  experience: [{ company: 'Ridgeline CPA Group', title: 'Senior Tax Accountant', bullets: ['Filed 140 partnership returns per season.'] }],
  education: [{ school: 'Sonoran State University', degree: 'B.S. Accounting', dates: '2009 - 2013' }],
  company: 'Ridgeline CPA Group', role: 'Senior Tax Accountant', compensation: { min: 80000, max: 100000 },
};

// ---------------------------------------------------------------- text rules

test('owned mode and agent files carry no fancy dashes or smart quotes', () => {
  const bad = /[–—‘’“”]/;
  for (const f of MODE_FILES) assert.ok(!bad.test(mode(f)), `${f}.md has a fancy dash or smart quote`);
  for (const f of AGENT_FILES) assert.ok(!bad.test(agent(f)), `${f}.md has a fancy dash or smart quote`);
});

test('modes that read a report never assume a flat reports/{slug}/ path', () => {
  for (const f of ['apply', 'apply-all', 'apply-assisted', 'interview-prep', 'contacto', 'audit']) {
    const text = mode(f);
    assert.ok(!/\$\{WORKSPACE\}\/reports\/[{<]slug[}>]\//.test(text), `${f}.md names a flat report path`);
    assert.ok(!/require\(['"][^'"]*reports\/[<{]slug/.test(text), `${f}.md requires a flat report path`);
  }
});

test('the discovery agent has no built in title catalogue: every search template takes its role from the prompt', () => {
  const text = agent('jobe-job-discovery');
  const strategy = text.slice(text.indexOf('## Search Strategy'), text.indexOf('## CRITICAL'));
  const templates = strategy.split('\n').filter((l) => /^- `/.test(l));
  assert.ok(templates.length >= 8, 'expected the search templates');
  for (const line of templates) {
    assert.ok(/\{role\}/.test(line), `template without {role}: ${line}`);
    // Every quoted search term is a placeholder, never a literal title.
    for (const q of line.match(/"[^"`]+"/g) || []) assert.ok(/^"\{[a-z ]+\}"$/.test(q), `literal search term ${q} in: ${line}`);
  }
  assert.match(text, /If this is missing or empty, STOP/);
  assert.match(text, /outputPath\*\* \(required\)/);
  // The Codex mirror wraps the body in a TOML string: keep it free of escapes.
  for (const f of AGENT_FILES) assert.ok(!/\\|"""|'''/.test(agent(f)), `${f}.md has a backslash or a triple quote`);
});

test('apply modes document the control channel array, the security code action, and every harness phase', () => {
  const apply = mode('apply');
  assert.match(apply, /`answers` is an ARRAY/);
  assert.match(apply, /action:'security-code'/);
  // Phase names are read from the harness, so a new phase must be documented.
  const harness = fs.readFileSync(path.join(REPO, 'scripts', 'camoufox-apply.js'), 'utf8');
  const phases = new Set([...harness.matchAll(/phase: '([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(phases.size >= 9, 'expected the harness phases');
  for (const p of phases) assert.ok(apply.includes('`' + p + '`'), `apply.md does not document phase ${p}`);
  assert.match(apply, /moveReportFolder\(slug, 'manual'\)/);
  for (const f of ['apply', 'apply-all', 'apply-assisted']) assert.match(mode(f), /nonCompete/, `${f}.md lacks the non compete warning`);
});

// ------------------------------------------------- documented snippets run

test('linkedin-search snippets: queries and search URL come from the seeds and the profile, with no built in policy', { skip: skipShell }, () => {
  const md = mode('linkedin-search');
  const queriesCmd = block(md, 'profileQueries()');
  const urlCmd = block(md, 'buildSearchUrl({ keywords: process.argv[1]');

  // Nurse: onsite and hybrid, no country policy, one seed excluded by her own title policy.
  const nurse = workspace('nurse');
  write(nurse, 'data/queries/seeds.json', { queries: [{ query: 'Registered Nurse', location: 'Madison, WI' }, { query: 'Travel Nurse', location: 'Madison, WI' }] });
  write(nurse, 'data/profile.json', { discovery: { workModes: ['onsite', 'hybrid'], maxAgeDays: 7, titleExclude: ['travel'] } });
  assert.match(run(queriesCmd, nurse), /Registered Nurse/);
  assert.doesNotMatch(run(queriesCmd, nurse), /Travel Nurse/);
  const nurseUrl = new URL(run(urlCmd.replace('"<query>" 25', '"Registered Nurse" 25'), nurse).trim());
  assert.equal(nurseUrl.searchParams.get('keywords'), 'Registered Nurse');
  assert.equal(nurseUrl.searchParams.get('f_WT'), '1,3');
  assert.equal(nurseUrl.searchParams.get('geoId'), null);
  assert.equal(nurseUrl.searchParams.get('f_TPR'), 'r604800');
  assert.equal(nurseUrl.searchParams.get('start'), '25');

  // Accountant: no profile at all, so no work mode facet and no geo restriction.
  const acct = workspace('accountant');
  write(acct, 'data/queries/seeds.json', { queries: [{ query: 'Tax Accountant', location: 'Tucson, AZ' }] });
  assert.match(run(queriesCmd, acct), /Tax Accountant/);
  const acctUrl = new URL(run(urlCmd.replace('"<query>" 25', '"Tax Accountant" 0'), acct).trim());
  assert.equal(acctUrl.searchParams.get('f_WT'), null);
  assert.equal(acctUrl.searchParams.get('geoId'), null);
  assert.equal(acctUrl.searchParams.get('start'), null);
});

test('apply-assisted, interview-prep and contacto snippets resolve a report in any lifecycle bucket and never guess an answer', { skip: skipShell }, () => {
  // Nurse: a parked report under manual, no apply profile on file.
  const nurse = workspace('nurse');
  write(nurse, `reports/manual/${NURSE_SLUG}/resume-2030-01-05-${NURSE_SLUG}.json`, NURSE_RESUME);
  const answersCmd = block(mode('apply-assisted'), 'buildAnswers(').replace('{slug}', NURSE_SLUG);
  const a = JSON.parse(run(answersCmd, nurse)).answers;
  assert.equal(a.fullName, 'Priya Raman');
  for (const k of ['workAuthorized', 'requireSponsorship', 'citizen', 'citizenOrPermanentResident', 'domiciled', 'federalEligible', 'clearance', 'relocation', 'nonCompete']) {
    assert.equal(a[k], '', `${k} must be blank when nothing is on file`);
  }
  assert.equal(a.eeoSelfIdentify, false);
  assert.deepEqual(a.eeoValues, {});
  assert.equal(a.salaryExpectation, '');

  // Accountant: a queued report plus an apply profile with his own answers.
  const acct = workspace('accountant');
  write(acct, `reports/queue/${ACCOUNTANT_SLUG}/resume-2030-01-05-${ACCOUNTANT_SLUG}.json`, ACCOUNTANT_RESUME);
  write(acct, 'data/apply-profile.json', { workAuthorized: 'Yes', nonCompete: 'Yes', salaryStrategy: 'top' });
  const b = JSON.parse(run(answersCmd.replace(NURSE_SLUG, ACCOUNTANT_SLUG), acct)).answers;
  assert.equal(b.workAuthorized, 'Yes');
  assert.equal(b.nonCompete, 'Yes');
  assert.equal(b.citizen, '');
  assert.equal(b.salaryExpectation, '100000');

  for (const f of ['interview-prep', 'contacto']) {
    const locate = block(mode(f), 'locateReportDir(');
    assert.equal(run(locate.replace('{slug}', NURSE_SLUG), nurse).trim(), path.join(nurse, 'reports', 'manual', NURSE_SLUG));
    assert.equal(run(locate.replace('{slug}', ACCOUNTANT_SLUG), acct).trim(), path.join(acct, 'reports', 'queue', ACCOUNTANT_SLUG));
    assert.equal(run(locate.replace('{slug}', 'no-such-report'), acct).trim(), 'null');
  }
});

test('apply snippets write a control file in the documented shape', { skip: skipShell }, () => {
  const root = workspace('nurse');
  const apply = mode('apply');
  const ctl = path.join(root, 'signals', 'apply', NURSE_SLUG, 'control.json');
  fs.mkdirSync(path.dirname(ctl), { recursive: true });
  const cases = [["action:'answers'", 'answers'], ["action:'submit'", 'submit'], ["action:'security-code'", 'security-code'], ["action:'confirm'", 'confirm']];
  for (const [marker, action] of cases) {
    run(block(apply, marker).replace('{slug}', NURSE_SLUG), root);
    const c = JSON.parse(fs.readFileSync(ctl, 'utf8'));
    assert.equal(c.action, action);
    if (action === 'answers') {
      assert.ok(Array.isArray(c.answers), 'answers must be an array');
      assert.deepEqual(Object.keys(c.answers[0]), ['label', 'text']);
    }
    if (action === 'security-code') assert.equal(typeof c.code, 'string');
    if (action === 'confirm') assert.equal(typeof c.link, 'string');
  }
});

test('tracker orphan scan lists job slugs across buckets and legacy flat folders, and skips non job buckets', { skip: skipShell }, () => {
  const root = workspace('accountant');
  for (const d of [`reports/queue/${ACCOUNTANT_SLUG}`, `reports/manual/${NURSE_SLUG}`, 'reports/applied/harbor-tax-staff-accountant',
    'reports/legacy-flat-slug', 'reports/audit/coverage-check', 'reports/archive/aged-out-role', 'reports/manual/archive/2030-01-01/old-parked']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  const out = run(block(mode('tracker'), 'sort -u'), root).trim().split('\n');
  assert.deepEqual(out, ['harbor-tax-staff-accountant', 'legacy-flat-slug', NURSE_SLUG, ACCOUNTANT_SLUG].sort());
});

test('calibrate snippets: record, list, adjudicate, kappa, all inside the workspace', { skip: skipShell }, () => {
  const root = workspace('nurse');
  const md = mode('calibrate');
  run(block(md, 'recordLlmJudge('), root);
  const log = path.join(root, 'data', 'calibration.jsonl');
  const entry = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.equal(entry.kind, 'cover-letter-quality');
  assert.equal(entry.llmLabel, true);
  const listed = run(block(md, 'pendingHumanReview('), root);
  assert.ok(listed.includes(entry.id), 'the pending list shows the recorded id');
  run(block(md, 'recordHumanAdjudication(').replace('"<id>" "<true|false|category>" "<optional note>"', `"${entry.id}" true "agreed"`), root);
  const kappa = run('KIND=cover-letter-quality\n' + block(md, 'kappaForKind('), root);
  assert.match(kappa, /n = 1/);
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8').trim()).humanLabel, true, 'true and false stay booleans');

  // A category label is stored as written, so a disagreement shows in kappa.
  const record = block(md, 'recordLlmJudge(');
  const asGhost = record.replace('cover-letter-quality "<report slug>" true', 'ghost-score "posting-1" Suspicious');
  assert.notEqual(asGhost, record, 'the record snippet placeholder changed');
  run(asGhost, root);
  const ghost = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.kind === 'ghost-score');
  assert.equal(ghost.llmLabel, 'Suspicious');
  const adjudicate = block(md, 'recordHumanAdjudication(');
  const asHuman = adjudicate.replace('"<id>" "<true|false|category>" "<optional note>"', `"${ghost.id}" "High Confidence" "disagree"`);
  assert.notEqual(asHuman, adjudicate, 'the adjudication snippet placeholder changed');
  run(asHuman, root);
  const after = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.kind === 'ghost-score');
  assert.equal(after.humanLabel, 'High Confidence');
  assert.match(run('KIND=ghost-score\n' + block(md, 'kappaForKind('), root), /observed agreement \(po\): 0\.000/);
});

test('audit snippet finds the newest resume JSON in whichever bucket holds it', { skip: skipShell }, () => {
  const root = workspace('accountant');
  write(root, `reports/applied/${ACCOUNTANT_SLUG}/resume-2030-01-05-${ACCOUNTANT_SLUG}.json`, ACCOUNTANT_RESUME);
  const out = run(block(mode('audit'), 'auditScorer(').replace('<slug>', ACCOUNTANT_SLUG), root);
  assert.match(out, /variance:/);
  assert.match(out, /school:/);
});

test('tracker orphan scan works under zsh on a flat only workspace (an unmatched glob must not abort it)', { skip: skipShell }, () => {
  const snippet = block(mode('tracker'), 'sort -u');
  for (const shell of ['bash', 'zsh']) {
    if (spawnSync(shell, ['-c', 'true']).error) continue;   // shell not installed
    const flat = workspace('nurse');
    for (const d of ['reports/acme-nurse', 'reports/beta-tax']) fs.mkdirSync(path.join(flat, d), { recursive: true });
    const env = { ...process.env, JOBE_USER_ROOT: flat, WORKSPACE: flat, JOBE_HOME: REPO };
    const r = spawnSync(shell, ['-c', snippet], { cwd: REPO, env, encoding: 'utf8' });
    assert.equal(r.stderr, '', `${shell}: ${r.stderr}`);
    assert.deepEqual(r.stdout.trim().split('\n'), ['acme-nurse', 'beta-tax'], shell);
    const none = workspace('accountant');   // no reports folder at all
    const e = spawnSync(shell, ['-c', snippet], { cwd: REPO, env: { ...env, WORKSPACE: none }, encoding: 'utf8' });
    assert.equal(e.stdout + e.stderr, '', `${shell} on a workspace with no reports`);
  }
});

test('manual ingest modes apply the region gate and the apply modes state the live pay band rule', () => {
  assert.match(mode('linkedin-tab'), /no work mode, country, region, or recency gate/);
  assert.match(mode('linkedin-tab'), /`discovery\.regions` for every posting that is not remote/);
  assert.match(mode('linkedin-search'), /`discovery\.regions`/);
  for (const f of ['apply', 'apply-all']) {
    assert.match(mode(f), /only when it is a yearly salary in the user's currency \(`discovery\.salaryCurrency`/, f);
  }
  assert.match(mode('apply'), /text of the option actually selected/);
  // The live band parser reads dollar currencies only; every statement of the
  // rule must name that ceiling, and the code must still behave that way.
  const { bandFromText } = require('../lib/apply/answers.js');
  assert.equal(bandFromText('Salary: \u00a345,000 - \u00a355,000 per annum', 'GBP'), null);
  assert.equal(bandFromText('Salary: \u20ac60.000 - \u20ac75.000 brutto pro Jahr', 'EUR'), null);
  assert.equal(bandFromText('Salary range: $120,000 - $150,000 per year', 'GBP'), null);
  const CEILING = /written with a dollar sign are read[^.;)]*\(USD, CAD, AUD, NZD, SGD, HKD, MXN\)[;,] (?:so )?with any other \`?salaryCurrency\`? (?:the|your) stored \`?salaryExpectation\`? is always used/;
  const samples = { USD: 'Salary range: $120,000 - $150,000 per year', CAD: 'Salary: CAD $90,000 - $110,000 annually', AUD: 'Salary: A$95,000 - A$115,000 plus super', NZD: 'Salary NZ$80,000 - NZ$95,000', SGD: 'Annual salary S$70,000 - S$90,000', HKD: 'Annual salary HK$400,000 - HK$520,000', MXN: 'Salary: MX$480,000 - MX$600,000 MXN annual' };
  for (const [cur, text] of Object.entries(samples)) assert.ok(bandFromText(text, cur), cur);
  const texts = {
    apply: mode('apply'), 'apply-all': mode('apply-all'),
    README: fs.readFileSync(path.join(REPO, 'README.md'), 'utf8'),
    DATA_CONTRACT: fs.readFileSync(path.join(REPO, 'DATA_CONTRACT.md'), 'utf8'),
    template: fs.readFileSync(path.join(REPO, 'templates', 'apply-profile.template.json'), 'utf8'),
  };
  for (const [name, text] of Object.entries(texts)) assert.match(text, CEILING, name);
});
