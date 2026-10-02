'use strict';
// Checks for the core mode files (SKILL.md, _shared.md, find.md, evaluate.md,
// batch.md, onboard.md, _profile.template.md). Mode text is the program the
// assistant runs, so the checks are the ones that catch real breakage:
//   1. every code path a mode names exists in the tree
//   2. onboarding covers every key the code reads
//   3. the profile template carries the sections the workflow scripts read
//   4. no stale default or field assumption crept back in
//   5. the shell snippets in the modes actually run, against synthetic
//      workspaces for two unrelated professions (a registered nurse and a tax
//      accountant), isolated through JOBE_USER_ROOT
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Isolation: every lib module this file requires in process resolves an empty
// temp workspace, never real user data. Each snippet run gets its own root.
process.env.JOBE_USER = '';
process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-core-'));

const REPO = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(REPO, '.claude', 'skills', 'jobe');
const FILES = {
  skill: path.join(SKILL_DIR, 'SKILL.md'),
  shared: path.join(SKILL_DIR, 'modes', '_shared.md'),
  find: path.join(SKILL_DIR, 'modes', 'find.md'),
  evaluate: path.join(SKILL_DIR, 'modes', 'evaluate.md'),
  batch: path.join(SKILL_DIR, 'modes', 'batch.md'),
  onboard: path.join(SKILL_DIR, 'modes', 'onboard.md'),
  profileTemplate: path.join(SKILL_DIR, 'modes', '_profile.template.md'),
};
const TEXT = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')]));
const DAY = '2030-01-15';
const HAS_BASH = process.platform !== 'win32';

// ==== fixtures ====

function workspace(profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-core-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  if (profile) fs.writeFileSync(path.join(root, 'data', 'profile.json'), JSON.stringify(profile));
  return root;
}

const NURSE = {
  version: 1,
  candidate: { yearsExperience: 6, degrees: ['BSN'], clearance: null },
  discovery: { workModes: ['onsite', 'hybrid'], hybridMaxOfficeShare: 0.6, countries: ['US'], maxAgeDays: 21, titleExclude: ['travel'] },
  output: { forbiddenTerms: ['Project Lighthouse'], targetPages: 1 },
};
const ACCOUNTANT = {
  version: 1,
  candidate: { yearsExperience: 9, degrees: ['BS Accounting', 'MS Taxation'] },
  discovery: { workModes: ['remote'], countries: ['CA', 'Canada'], salaryFloor: 90000, salaryCurrency: 'CAD' },
};

/** The fenced code block of `text` that contains `marker`. */
function block(text, marker) {
  const blocks = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes(marker));
  assert.strictEqual(blocks.length, 1, `expected exactly one code block containing: ${marker}`);
  return blocks[0];
}

/** Run a mode's shell snippet the way the assistant would, in an isolated workspace. */
function sh(script, root, env = {}) {
  return execFileSync('bash', ['-c', `set -e\n${script}`], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, JOBE_USER: '', JOBE_USER_ROOT: root, JOBE_HOME: REPO, WORKSPACE: root, ...env },
  });
}

// ==== 1. referenced code exists ====

test('every script, lib module, collector, and template a core mode names exists', () => {
  // An optional install wide fallback the code probes for; it never ships.
  const optional = new Set(['configs/archetypes.json']);
  const missing = [];
  for (const [name, text] of Object.entries(TEXT)) {
    const refs = text.match(/\b(?:scripts|lib|collectors|templates|configs)\/[A-Za-z0-9_./-]+\.(?:js|json|md|sh)\b/g) || [];
    for (const ref of new Set(refs)) {
      if (!optional.has(ref) && !fs.existsSync(path.join(REPO, ref))) missing.push(`${name}: ${ref}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('every source file find.md lists is a registered plugin, and none is left out', () => {
  const dir = path.join(REPO, 'collectors', 'sources');
  const onDisk = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
    .flatMap((d) => fs.readdirSync(path.join(dir, d.name)).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')));
  const unlisted = onDisk.filter((id) => !TEXT.find.includes(`${id}.js`));
  assert.deepStrictEqual(unlisted, [], 'a source plugin exists that find.md does not describe');
  assert.ok(!/\b\d+[- ]source\b/i.test(TEXT.find + TEXT.skill), 'no hardcoded source count');
});

// ==== 2. onboarding covers what the code reads ====

test('onboard.md names every key of the structured profile and of the apply profile', () => {
  const { DEFAULTS } = require('../lib/profile');
  const leafKeys = Object.entries(DEFAULTS).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []));
  assert.ok(leafKeys.length >= 20);
  const absent = leafKeys.filter((k) => !new RegExp(`\`${k}\``).test(TEXT.onboard));
  assert.deepStrictEqual(absent, [], 'profile keys with no writing step in onboard.md');

  const apply = JSON.parse(fs.readFileSync(path.join(REPO, 'templates', 'apply-profile.template.json'), 'utf8'));
  const applyKeys = Object.keys(apply).filter((k) => !k.startsWith('_') && !k.startsWith('$'));
  const absentApply = applyKeys.filter((k) => !new RegExp(`\`${k}\\b`).test(TEXT.onboard));
  assert.deepStrictEqual(absentApply, [], 'apply profile keys with no writing step in onboard.md');
});

test('onboard.md has a writing step for every user file a template scaffolds', () => {
  const templates = fs.readdirSync(path.join(REPO, 'templates')).filter((f) => /\.template\./.test(f));
  // templates/x.template.ext is written as x.ext somewhere in the workspace
  const absent = templates.map((f) => f.replace('.template', '')).filter((f) => !TEXT.onboard.includes(f));
  assert.deepStrictEqual(absent, []);
});

// ==== 3. profile template sections ====

test('the profile template carries the sections the modes and workflow scripts read by name', () => {
  const sections = ['Standing rules', 'Attribution rules', 'Role posture leads', 'Verified figures', 'Known corrections', 'What not to use in output'];
  const workflow = fs.readFileSync(path.join(REPO, 'scripts', 'wf-generate-batch.js'), 'utf8');
  for (const s of sections) {
    assert.match(TEXT.profileTemplate, new RegExp(`^## ${s}$`, 'm'), `template lacks "## ${s}"`);
    assert.ok(workflow.includes(`"${s}"`), `workflow script no longer reads "${s}"`);
    assert.ok(TEXT.shared.includes(`**${s}**`), `_shared.md does not document "${s}"`);
  }
  assert.ok(TEXT.skill.includes('"Standing rules"') && /Subagent propagation/.test(TEXT.skill));
});

// ==== 4. no stale default, no field assumption ====

test('core modes state no default work mode, country, day count, or fixed bucket list', () => {
  const stale = [
    [/remoteOnly:\s*true/, 'hardcoded remoteOnly'],
    [/Remote \(US\)/, 'hardcoded remote US location'],
    [/maxAgeDays:\s*\d/, 'hardcoded recency in a prompt'],
    [/\b(?:6|six)[- ]archetypes?\b/i, 'fixed archetype list'],
    [/475\s*(?:-|to)\s*600/, 'word count target'],
    [/\$\{WORKSPACE\}\/reports\/\{(?:company-)?slug/, 'flat report path'],
    [/configs\/archetypes\.json`?\s+and tag/, 'archetypes written to configs/'],
    [/appendTrackerRow/, 'non idempotent tracker write'],
    [/render-pdf\.js/, 'removed script'],
  ];
  const hits = [];
  for (const [name, text] of Object.entries(TEXT)) {
    for (const [re, why] of stale) if (re.test(text)) hits.push(`${name}: ${why}`);
    const nonAscii = [...text].filter((ch) => ch.charCodeAt(0) > 127);
    if (nonAscii.length) hits.push(`${name}: ${nonAscii.length} non ASCII character(s)`);
  }
  assert.deepStrictEqual(hits, []);
});

test('score bands in the modes match configs/default.json', () => {
  const t = JSON.parse(fs.readFileSync(path.join(REPO, 'configs', 'default.json'), 'utf8')).match_thresholds;
  assert.match(TEXT.shared, new RegExp(`Strong Match \\| ${t.strong} to 100`));
  assert.match(TEXT.shared, new RegExp(`Good Match \\| ${t.good} to ${t.strong - 1}`));
  assert.match(TEXT.shared, new RegExp(`Stretch Match \\| ${t.stretch} to ${t.good - 1}`));
  assert.match(TEXT.find, new RegExp(`Score >= ${t.strong} \\(Strong\\)`));
  assert.match(TEXT.find, new RegExp(`Score ${t.good} to ${t.strong - 1} \\(Good\\)`));
});

test('lifecycle buckets named in _shared.md are the ones the code moves folders between', () => {
  const { LIFECYCLE_BUCKETS } = require('../lib/tracker-writer');
  const section = TEXT.shared.split('## Report folder lifecycle')[1].split('\n## ')[0];
  for (const b of LIFECYCLE_BUCKETS) assert.ok(section.includes(`\`${b}\``), `bucket ${b} not documented`);
});

test('positioning words banned in _shared.md cover the list the renderers refuse', () => {
  const { POSITIONING_JARGON } = require('../lib/tailor');
  const section = TEXT.shared.split('## Positioning Reasoning')[1].split('\n## ')[0].toLowerCase();
  const absent = POSITIONING_JARGON.filter((w) => !section.includes(w.replace('-tailed', ' tails')) && !section.includes(w));
  assert.deepStrictEqual(absent, []);
});

// ==== 5. the snippets run ====

test('SKILL policy snippet prints each user\'s own policy and nothing for an empty workspace', { skip: !HAS_BASH }, () => {
  const snippet = block(TEXT.skill, 'mergedFilters:discoveryFilters(p)');
  const run = (profile) => JSON.parse(sh(snippet, workspace(profile)));

  const nurse = run(NURSE);
  assert.deepStrictEqual(nurse.discovery.workModes, ['onsite', 'hybrid']);
  assert.strictEqual(nurse.mergedFilters.remoteOnly, false);
  assert.strictEqual(nurse.mergedFilters.usOnly, true);
  assert.strictEqual(nurse.mergedFilters.maxAgeDays, 21);
  assert.deepStrictEqual(nurse.output.forbiddenTerms, ['Project Lighthouse']);

  const accountant = run(ACCOUNTANT);
  assert.strictEqual(accountant.mergedFilters.remoteOnly, true);
  assert.strictEqual(accountant.mergedFilters.usOnly, false);
  assert.strictEqual(accountant.mergedFilters.salaryFloor, 90000);
  assert.strictEqual(accountant.mergedFilters.salaryCurrency, 'CAD');

  const nobody = run(null);
  assert.deepStrictEqual(nobody.discovery.workModes, []);
  assert.deepStrictEqual(nobody.discovery.countries, []);
  assert.deepStrictEqual(nobody.discovery.titleExclude, []);
  assert.strictEqual(nobody.discovery.salaryFloor, null);
  assert.strictEqual(nobody.mergedFilters.remoteOnly, false);
  assert.strictEqual(nobody.mergedFilters.usOnly, false);
});

test('onboard readback snippet reports the policy that was written', { skip: !HAS_BASH }, () => {
  const out = JSON.parse(sh(block(TEXT.onboard, 'hybridMaxOfficeShare:p.discovery.hybridMaxOfficeShare'), workspace(NURSE)));
  assert.strictEqual(out.hybridMaxOfficeShare, 0.6);
  assert.deepStrictEqual(out.titleExclude, ['travel']);
  assert.strictEqual(out.output.targetPages, 1);
  assert.strictEqual(out.candidate.yearsExperience, 6);
});

test('evaluate report folder snippet lands a new slug in queue and keeps an existing folder where it is', { skip: !HAS_BASH }, () => {
  const snippet = block(TEXT.evaluate, 'locateReportDir(r,process.argv[1])').replace('<the value the reportSlug command above printed>', 'example-hospital-staff-nurse') + '\necho "${REPORT_DIR}"';
  const root = fs.realpathSync(workspace(NURSE));
  const fresh = sh(snippet, root).trim().split('\n').pop();
  assert.strictEqual(fresh, path.join(root, 'reports', 'queue', 'example-hospital-staff-nurse'));
  assert.ok(fs.statSync(fresh).isDirectory());

  const other = fs.realpathSync(workspace(ACCOUNTANT));
  const parked = path.join(other, 'reports', 'manual', 'example-hospital-staff-nurse');
  fs.mkdirSync(parked, { recursive: true });
  assert.strictEqual(sh(snippet, other).trim().split('\n').pop(), parked);
  assert.ok(!fs.existsSync(path.join(other, 'reports', 'queue')));
});

function resumeFor(kind) {
  const nurse = kind === 'nurse';
  return {
    name: nurse ? 'Avery Example' : 'Jordan Sample',
    contact: { email: 'person@example.com', phone: '555 0100', location: 'Example City' },
    company: nurse ? 'Example Health System' : 'Example Advisory Group',
    role: nurse ? 'Care Coordinator' : 'Tax Manager',
    matchScore: nurse ? 82 : 71,
    archetype: 'General',
    postingUrl: 'https://careers.example.org/jobs/1',
    summary: nurse
      ? 'Registered nurse with six years on a cardiac step down unit who redesigned discharge teaching and coordinates transitions across nursing, pharmacy, and case management.'
      : 'Tax accountant with nine years of partnership and corporate returns who built the review control the team now uses and advises clients on state nexus.',
    experience: [{
      title: nurse ? 'Registered Nurse' : 'Senior Tax Accountant',
      company: nurse ? 'Example Hospital' : 'Example Tax Group',
      dates: 'Jan 2020 to Present',
      bullets: nurse
        ? ['Cut 30 day readmissions by 18 percent by splitting discharge teaching into three bedside sessions with a teach back check.']
        : ['Raised first pass acceptance to 98 percent across 140 returns by introducing a standard workpaper index and review checklist.'],
    }],
    education: [{ degree: nurse ? 'BSN' : 'BS Accounting', school: 'Example University', dates: '2012 to 2016' }],
    skills: nurse ? { Clinical: 'Telemetry, wound care' } : { Tax: 'Partnership returns, nexus' },
    coverLetter: 'placeholder',
  };
}

test('evaluate tracker and queue snippet writes workspace relative paths and is safe to run twice', { skip: !HAS_BASH }, () => {
  const snippet = block(TEXT.evaluate, 'upsertTrackerRow({').replace(/\{date\}/g, DAY);
  for (const kind of ['nurse', 'accountant']) {
    const root = fs.realpathSync(workspace(kind === 'nurse' ? NURSE : ACCOUNTANT));
    const slug = kind === 'nurse' ? 'example-health-system-care-coordinator' : 'example-advisory-group-tax-manager';
    const dir = path.join(root, 'reports', 'queue', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `resume-${DAY}-${slug}.json`), JSON.stringify(resumeFor(kind)));
    const env = { REPORT_DIR: dir, SLUG: slug };
    sh(snippet, root, env);
    sh(snippet, root, env);

    const rows = fs.readFileSync(path.join(root, 'data', 'tracker.md'), 'utf8').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l));
    assert.strictEqual(rows.length, 1, 'one tracker row after two runs');
    assert.ok(rows[0].includes(`| reports/queue/${slug}/ |`));
    assert.ok(rows[0].includes('| Evaluated |'));

    const queue = JSON.parse(fs.readFileSync(path.join(root, 'data', 'apply-queue.json'), 'utf8'));
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].reportDir, `reports/queue/${slug}/`);
    assert.strictEqual(queue[0].resumeDocx, `reports/queue/${slug}/resume-${DAY}-${slug}.docx`);
    assert.strictEqual(queue[0].coverLetterDocx, `reports/queue/${slug}/cover-letter-${DAY}-${slug}.docx`);
    assert.strictEqual(queue[0].applied, false);

    // The stored paths are what moveReportFolder rewrites on a bucket change.
    const moved = sh('node -e "console.log(require(\'./lib/tracker-writer\').moveReportFolder(process.argv[1], \'manual\'))" "${SLUG}"', root, env).trim();
    assert.strictEqual(moved, 'true');
    const after = JSON.parse(fs.readFileSync(path.join(root, 'data', 'apply-queue.json'), 'utf8'))[0];
    assert.strictEqual(after.resumeDocx, `reports/manual/${slug}/resume-${DAY}-${slug}.docx`);
    assert.ok(fs.readFileSync(path.join(root, 'data', 'tracker.md'), 'utf8').includes(`reports/manual/${slug}/`));
  }
});

test('evaluate quality gate snippet audits a resume against its jd.txt and exits by the verdict', { skip: !HAS_BASH }, () => {
  const snippet = block(TEXT.evaluate, 'auditResume(JSON.parse(fs.readFileSync(json').replace(/\{date\}/g, DAY);
  const root = fs.realpathSync(workspace(NURSE));
  const slug = 'example-health-system-care-coordinator';
  const dir = path.join(root, 'reports', 'queue', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `resume-${DAY}-${slug}.json`), JSON.stringify(resumeFor('nurse')));
  fs.writeFileSync(path.join(dir, 'jd.txt'), 'Care Coordinator. Coordinate discharge planning and transitions of care. Requires case management, patient education, and utilization review experience.');
  let out, code = 0;
  try { out = sh(snippet, root, { REPORT_DIR: dir, SLUG: slug }); } catch (e) { out = e.stdout; code = e.status; }
  const audit = JSON.parse(out);
  assert.strictEqual(typeof audit.ok, 'boolean');
  assert.ok(Array.isArray(audit.issues));
  assert.ok(audit.jdCoverage !== undefined, 'the JD was passed, so JD coverage is reported');
  assert.strictEqual(code, audit.ok ? 0 : 1);
});

test('find residue merge snippet stamps resolved leads, flags unresolved ones, and leaves the rest alone', { skip: !HAS_BASH }, () => {
  const snippet = block(TEXT.find, "/^residue-batch-.*\\.json$/");
  const root = fs.realpathSync(workspace(ACCOUNTANT));
  const dir = path.join(root, 'signals', 'discovered', DAY);
  fs.mkdirSync(dir, { recursive: true });
  const li = (n) => `https://www.linkedin.com/jobs/view/tax-accountant-${n}`;
  const list = path.join(dir, 'ranked-enriched.json');
  fs.writeFileSync(list, JSON.stringify([
    { company: 'Example Capital Partners', title: 'Tax Accountant', canonicalUrl: li(4100000001), location: 'Remote', remote: 'remote', remoteVerified: false },
    { company: 'Example Clinic Network', title: 'Staff Nurse', canonicalUrl: li(4100000002), location: 'Remote', remote: 'remote', remoteVerified: false },
    { company: 'Example Ledger Co', title: 'Senior Tax Accountant', canonicalUrl: li(4100000003), location: 'Remote', remote: 'remote', remoteVerified: false },
    { company: 'Example Direct Employer', title: 'Tax Analyst', canonicalUrl: 'https://careers.example.org/jobs/77', location: 'Toronto, ON', remote: 'onsite' },
  ]));
  fs.writeFileSync(path.join(dir, 'residue-batch-1.json'), JSON.stringify({ results: [
    { linkedinUrl: li(4100000001), resolved: true, canonicalUrl: 'https://portfolio.example.com/careers/tax-accountant', employerCorrection: 'Example Portfolio Company', location: 'Toronto, ON', remote: 'hybrid', officeShare: 0.4, postedDate: '2030-01-10', compensation: 'CAD 95,000 to 110,000' },
    { linkedinUrl: li(4100000002), resolved: true, canonicalUrl: 'https://clinic.example.org/jobs/staff-nurse', location: 'Remote, Canada', remote: 'remote' },
  ] }));
  fs.writeFileSync(path.join(dir, 'residue-batch-2.json'), JSON.stringify({ results: [
    { linkedinUrl: li(4100000003), resolved: false, reason: 'two listings fit' },
  ] }));
  fs.writeFileSync(path.join(dir, 'residue-batch-3.json'), '{ not json');

  const out = JSON.parse(sh(snippet, root, { LIST: list, TODAY: DAY }).trim().split('\n').pop());
  assert.deepStrictEqual(out, { merged: 2, unresolved: 1 });
  const [hybrid, remote, unresolved, direct] = JSON.parse(fs.readFileSync(list, 'utf8'));

  assert.strictEqual(hybrid.canonicalUrl, 'https://portfolio.example.com/careers/tax-accountant');
  assert.strictEqual(hybrid.linkedinUrl, li(4100000001));
  assert.deepStrictEqual(hybrid.alternateUrls, [li(4100000001)]);
  assert.strictEqual(hybrid.atsResolved, true);
  assert.strictEqual(hybrid.atsBoard, 'employer listing');
  assert.strictEqual(hybrid.employerCorrection, 'Example Portfolio Company');
  assert.strictEqual(hybrid.remote, 'hybrid');
  assert.strictEqual(hybrid.remoteVerified, false);
  assert.strictEqual(hybrid.verifyStatus, 'not-remote');
  assert.strictEqual(hybrid.officeShare, 0.4);
  assert.strictEqual(hybrid.compensation, 'CAD 95,000 to 110,000');

  assert.strictEqual(remote.remoteVerified, true);
  assert.strictEqual(remote.verifyStatus, 'remote');
  assert.strictEqual(remote.verifiedLocation, 'Remote, Canada');

  assert.strictEqual(unresolved.atsResolved, false);
  assert.strictEqual(unresolved.atsResolveReason, 'two listings fit');
  assert.strictEqual(unresolved.canonicalUrl, li(4100000003), 'an unresolved lead keeps its link and is never marked verified');
  assert.strictEqual(unresolved.remoteVerified, false);

  assert.deepStrictEqual(direct, { company: 'Example Direct Employer', title: 'Tax Analyst', canonicalUrl: 'https://careers.example.org/jobs/77', location: 'Toronto, ON', remote: 'onsite' });

  // The final list script reads those stamps: only the verified remote row passes a remote policy.
  const { select } = require('../scripts/final-list');
  const kept = select(JSON.parse(fs.readFileSync(list, 'utf8')), { filters: { workModes: ['remote'], countries: [], minScore: null, excludeStaffing: false }, excluded: new Set(), titlePolicy: { exclude: null, keep: null } }).keep;
  assert.deepStrictEqual(kept.map((p) => p.title), ['Staff Nurse']);
});

test('find listing and summary snippets read the files the pipeline writes', { skip: !HAS_BASH }, () => {
  const root = fs.realpathSync(workspace(NURSE));
  const dir = path.join(root, 'signals', 'discovered', DAY);
  fs.mkdirSync(dir, { recursive: true });
  const list = path.join(dir, 'ranked-enriched.json');
  fs.writeFileSync(list, JSON.stringify([{ matchScore: 81, archetype: 'General', company: 'Example Hospital', title: 'Staff Nurse', location: 'Denver, CO', remote: 'onsite', salaryCheck: 'unknown', minimumsUnmet: ['2 years ICU'], canonicalUrl: 'https://careers.example.org/jobs/9' }]));
  // The block computes TODAY and LIST itself; pin them to the fixture.
  const listing = block(TEXT.find, 'for (const p of top.slice(0,30))').replace(/^TODAY=.*$/m, `TODAY=${DAY}`);
  const out = sh(listing, root);
  assert.ok(out.includes('81 | General | Example Hospital | Staff Nurse | Denver, CO | onsite | unknown | 2 years ICU'));
  assert.ok(out.includes('https://careers.example.org/jobs/9'));

  fs.writeFileSync(path.join(dir, 'discovery-summary.json'), JSON.stringify({ needsAgentFallback: true, fallbackReason: 'merged set 12 < 300', perSource: { remotive: 12 }, afterDedup: 12, payUnknown: 1, withUnmetMinimums: 1 }));
  const summary = JSON.parse(sh(block(TEXT.find, 's.needsAgentFallback'), root, { TODAY: DAY }));
  assert.deepStrictEqual(summary, { needs: true, reason: 'merged set 12 < 300', brave: 0, dedup: 12, payUnknown: 1, withUnmetMinimums: 1 });
});

test('onboard library sanity snippet passes a complete library and names an unmapped employer', { skip: !HAS_BASH }, () => {
  const snippet = block(TEXT.onboard, "missing.push(exp.company + ' (no companyKeyMap entry)')");
  const root = workspace(null);
  const write = (f, o) => fs.writeFileSync(path.join(root, 'data', f), JSON.stringify(o));
  write('resume-baseline.json', { name: 'Avery Example', experience: [{ company: 'Example Hospital' }, { company: 'Example Clinic' }] });
  write('bullet-library.json', { companyKeyMap: { 'Example Hospital': 'current', 'Example Clinic': 'prior1' }, current: [{ id: 'current-1', text: 'x' }], prior1: [{ id: 'prior1-1', text: 'y' }] });
  assert.match(sh(snippet, root), /^OK:/);

  write('resume-baseline.json', { name: 'Jordan Sample', experience: [{ company: 'Example Tax Group' }, { company: 'Example Manufacturing' }] });
  write('bullet-library.json', { companyKeyMap: { 'Example Tax Group': 'current' }, current: [] });
  const out = sh(snippet, root);
  assert.match(out, /ISSUES:/);
  assert.match(out, /Example Tax Group -> current \(empty pool\)/);
  assert.match(out, /Example Manufacturing \(no companyKeyMap entry\)/);
});

test('onboard single user scaffold snippet lays out an inert workspace and never overwrites', { skip: !HAS_BASH }, () => {
  const snippet = block(TEXT.onboard, ".scaffold(process.argv[2])");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-core-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'profile.json'), JSON.stringify(ACCOUNTANT));
  sh(snippet, root);
  for (const f of ['_profile.md', 'reference.md', 'data/resume-baseline.json', 'data/bullet-library.json', 'data/apply-profile.json', 'data/queries/seeds.json']) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} scaffolded`);
  }
  assert.ok(fs.statSync(path.join(root, 'reports', 'queue')).isDirectory());
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'profile.json'), 'utf8')), ACCOUNTANT, 'an existing file is kept');
  // The scaffold asserts nothing about the person: the first run check in SKILL.md treats it as unconfigured.
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'resume-baseline.json'), 'utf8')).name, '');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'bullet-library.json'), 'utf8')).companyKeyMap, {});
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'queries', 'seeds.json'), 'utf8')).queries, []);
});

test('SKILL router finds the modes directory from the repo root', { skip: !HAS_BASH }, () => {
  const snippet = block(TEXT.skill, 'MODES_DIR=""').replace(/^WORKSPACE=.*$/m, 'WORKSPACE="${JOBE_USER_ROOT}"');
  const root = workspace(null);
  const out = sh(snippet, root);
  assert.match(out, /MODES_DIR=\.claude\/skills\/jobe\/modes/);
  // The shell prints the resolved path, which differs when the clone sits behind a symlink.
  assert.strictEqual(fs.realpathSync(/JOBE_HOME=(\S+)/.exec(out)[1]), fs.realpathSync(REPO));
  assert.ok(!out.includes('ERROR'));
});

// ==== 6. statements about changed behavior match the code ====

test('subagent propagation carries every class of house rule', () => {
  const section = TEXT.skill.split('### Subagent propagation')[1].split('\n## ')[0];
  const must = {
    'read the real evidence first': /read the JD, then the user's real evidence/,
    'attribution': /"Attribution rules"/,
    'ATS clean text': /ATS character rule/,
    'hyphens at render': /output\.stripHyphens/,
    'depth of method': /method depth rule/,
    'the deepest layer leads': /deepest layer/,
    'title policy': /title exclude and keep lists/,
    'location policy': /work modes[^.]*countries[^.]*regions/,
    'recency policy': /recency window/,
    'only qualifying rows': /only rows that clear every gate/,
    'compensation on every row': /compensation figure on every row/,
    'names that never render': /output\.forbiddenTerms/,
    'standing rules': /"Standing rules" and "Known corrections"/,
  };
  for (const [what, re] of Object.entries(must)) assert.match(section, re, `SKILL subagent propagation omits: ${what}`);
  const shared = TEXT.shared.split('### Subagents inherit nothing')[1].split('\n## ')[0];
  for (const re of [/"Attribution rules"/, /ATS character rule/, /method depth rule/, /evidence sourcing rule/, /compensation figure on every row/, /title exclude and keep lists/, /recency window/]) {
    assert.match(shared, re, `_shared.md subagent list omits ${re}`);
  }
});

test('the score text is the score the code computes, for a user with no skills on file', () => {
  const { buildProfile, fullScore } = require('../lib/rank');
  const jd = 'Provide direct patient care on a medical surgical unit. Administer medications and document assessments in the chart. '
    + 'Coordinate discharge planning with the care team and educate patients and families. Prepare and review returns for partnerships and '
    + 'reconcile accounts each month. Requires an active license and two years of experience.';
  const score = (query, title) => fullScore({ title, company: 'Example Employer', jdText: jd },
    { profile: buildProfile({ queries: [{ query }], root: workspace() }) }).matchScore;
  for (const [query, title] of [['Senior Registered Nurse', 'Senior Registered Nurse'], ['Senior Tax Accountant', 'Senior Tax Accountant']]) {
    assert.strictEqual(score(query, 'Records Clerk'), 56, 'no title word: the neutral fit part alone');
    assert.strictEqual(score(query, title), 65, 'two role words and the seed seniority word');
  }
  assert.strictEqual(score('Senior Registered Nurse Case Manager', 'Senior Registered Nurse Case Manager'), 67, 'the title bonuses cap at 8 plus 3');
  for (const text of [TEXT.shared, TEXT.find]) {
    assert.match(text, /neutral fit part of 56/);
    assert.match(text, /at most 67/);
    assert.ok(!/share >= 0\.5|requirement lines \(its qualifications/.test(text), 'the round 1 formula is still described');
  }
  const src = fs.readFileSync(path.join(REPO, 'lib', 'rank.js'), 'utf8');
  const num = (name) => Number(src.match(new RegExp(`const ${name} = ([\\d.]+)`))[1]);
  assert.match(TEXT.shared, new RegExp(`rated terms / ${num('FULL_TABLE')}\\b`));
  assert.match(TEXT.shared, new RegExp(`${Math.round(num('COVERED_FULL') * 100)} percent of the words is full coverage and ${Math.round(num('COVERED_FLOOR') * 100)} percent is none`));
  assert.match(TEXT.shared, new RegExp(`under about ${num('FULL_WORDS')} content words`));
  assert.match(TEXT.shared, /gate1: score >= 55, the JD left enough to judge, and coverage >= 0\.5 \* ratedness/);
  assert.match(TEXT.find, /is empty, do NOT auto evaluate the 80 band/);
  // The rated table: the docs carry the code's constants, and onboarding asks for the weak skills too.
  assert.match(TEXT.shared, new RegExp(`share of rated weaknesses / ${num('WEAK_SHARE')}, capped at 1`));
  assert.match(TEXT.shared, new RegExp(`weight = ${num('PRIOR_WEIGHT')} \\* \\(1 - ratedness\\)`));
  assert.match(TEXT.shared, new RegExp(`max\\(0, ${num('STRONG')} - level\\) / ${num('DEFICIT')}\\)`));
  assert.match(TEXT.onboard, /Rate your skills, the weak ones too/);
  assert.match(TEXT.onboard, /a table of only top marks carries no information/);
  assert.match(TEXT.onboard, new RegExp(`rated terms / ${num('FULL_TABLE')}, capped at 1, times the share of rated weaknesses / ${num('WEAK_SHARE')}`));
  assert.ok(!/40 rated terms make the table stand alone\.|`1\.0` when at least one bullet proves it, `0\.6` when it is only in the resume skills block, `0\.2` when it is in `gaps`/.test(TEXT.onboard), 'onboard.md still seeds the table with strengths only');
  assert.ok(!/or Unicode/.test(TEXT.evaluate), 'evaluate.md still tells the generator to write no Unicode');
  assert.ok(!/SLUG="\{company-slug\}-\{role-slug\}"/.test(TEXT.evaluate), 'evaluate.md still shows a hand built slug');
  assert.match(TEXT.onboard, /Rate your skills/);
});

// The rated table and words every field uses. Step 6 tells the user to keep
// such words out of skills.levels; this runs that advice against a posting
// from a third field, written the way real postings are (duties, requirements,
// a team paragraph), for two unrelated professions.
test('a full rated table of field specific skills leaves a posting from another field below 55, and the docs state what generic words do', () => {
  const { buildProfile, fullScore } = require('../lib/rank');
  const OTHER = {
    title: 'Senior Backend Engineer, Payments Platform',
    company: 'Example Software Co',
    jdText: [
      'About the role',
      'You will design and operate the services that move money for our merchants. This is a senior role with technical leadership of a team of six engineers.',
      'What you will do',
      '- Build and run distributed services in Go and Kotlin on Kubernetes, with strict latency and availability targets.',
      '- Own the ledger and settlement pipelines end to end, including on call rotation and incident review.',
      '- Drive compliance work with our security and audit partners, including PCI controls and access reviews.',
      '- Take part in hiring: run interviews, write feedback and help close candidates.',
      '- Provide mentoring and coaching to junior engineers, and lead training sessions on our deployment tooling.',
      '- Work within the team budget for cloud spend and report on cost each quarter.',
      'What we look for',
      '- 6 years of experience building backend systems at scale.',
      '- Strong communication with product, design and finance partners.',
      '- Experience with relational databases, message queues and observability tooling.',
      '- A record of leadership on projects that span several teams.',
    ].join('\n'),
  };
  const B = (keywords, text) => ({ keywords, text });
  const WHO = {
    'nurse manager': {
      seeds: ['Nurse Manager', 'Clinical Nurse Manager'],
      bullets: [
        B(['staff scheduling', 'charge nurse'], 'Led a 28 bed medical surgical unit of 42 nurses, building staff scheduling that cut overtime by 18 percent.'),
        B(['patient safety', 'falls prevention'], 'Reduced patient falls by 30 percent over two quarters through hourly rounding.'),
        B(['wound care', 'medication administration', 'telemetry'], 'Kept practice current with wound care rounds, medication administration audits and telemetry review.'),
        B(['discharge planning', 'case management', 'patient education'], 'Cut 30 day readmissions by 18 percent with discharge planning, case management huddles and patient education.'),
        B(['precepting', 'joint commission'], 'Precepted 19 new graduate nurses and prepared the unit for a Joint Commission survey with zero findings.'),
      ],
      strong: ['staff scheduling', 'charge nurse', 'patient safety', 'falls prevention', 'wound care', 'medication administration', 'telemetry',
        'discharge planning', 'case management', 'patient education', 'precepting', 'joint commission', 'bedside handoff', 'float pool',
        'nurse staffing ratios', 'clinical ladder', 'infection control', 'care coordination', 'acls', 'bls', 'sentinel event review',
        'nursing competencies', 'new graduate residency', 'hourly rounding'],
      weak: ['dialysis', 'ventilator', 'operating room', 'chemotherapy', 'labor and delivery', 'pediatrics', 'utilization review', 'magnet designation'],
    },
    'tax accountant': {
      seeds: ['Tax Accountant', 'Senior Tax Accountant'],
      bullets: [
        B(['multistate returns', 'corporate tax'], 'Prepared 140 multistate corporate income tax returns a season across 31 states with no late filings.'),
        B(['tax provision', 'asc 740'], 'Built the quarterly ASC 740 tax provision for a manufacturer with 9 entities, cutting close time from 8 days to 5.'),
        B(['sales tax', 'audit defense'], 'Defended a three year sales tax audit and reduced the assessment by 62 percent.'),
        B(['partnership returns', 'tax research'], 'Reviewed 60 partnership returns and wrote tax research memos on nexus and apportionment for 12 clients.'),
        B(['reconciliation', 'deferred tax'], 'Reconciled deferred tax accounts to the general ledger each quarter.'),
      ],
      strong: ['multistate returns', 'corporate tax', 'tax provision', 'asc 740', 'sales tax', 'audit defense', 'partnership returns', 'tax research',
        'reconciliation', 'deferred tax', 'nexus', 'apportionment', 'cpa', 'fixed assets', 'depreciation schedules', 'estimated payments',
        'extensions', 'state notices', 'franchise tax', 'property tax', 'tax workpapers', 'trial balance', 'return review', 'exemption certificates'],
      weak: ['transfer pricing', 'international tax', 'estate tax', 'payroll tax', 'sec reporting', 'individual returns', 'excise tax', 'cost segregation'],
    },
  };
  const GENERIC = ['leadership', 'communication', 'training', 'mentoring', 'hiring', 'budget', 'compliance', 'coaching'];
  // What postings for the user's own role ask for and other fields ask for too:
  // the table Step 6 would collect from sample postings if it did not say to leave these out.
  const SHARED = ['excel', 'sql', 'reporting', 'data analysis', 'forecasting', 'process improvement', 'project management', 'automation'];
  const ANALYST = {
    title: 'Senior Data Analyst, Growth',
    company: 'Example Software Co',
    jdText: [
      'About the role',
      'You will own the numbers our growth team runs on, from raw events to the weekly review.',
      'What you will do',
      '- Write SQL against the warehouse and build reporting for acquisition, retention and revenue.',
      '- Lead data analysis for pricing and onboarding experiments and present the results to product leads.',
      '- Build forecasting models for signups and revenue and keep them current each month.',
      '- Drive automation of recurring reports and process improvement across the analytics workflow.',
      '- Run project management for cross team analytics requests, from intake to delivery.',
      'What we look for',
      '- 5 years of experience in analytics at a software company.',
      '- Strong SQL and Excel, and experience with a dashboard tool.',
      '- Experience with experiment design and statistics.',
    ].join('\n'),
  };
  const build = (who, levels) => {
    const root = workspace({ version: 1, skills: { levels } });
    fs.writeFileSync(path.join(root, 'data', 'bullet-library.json'), JSON.stringify({ current: WHO[who].bullets }));
    return buildProfile({ queries: WHO[who].seeds.map((query) => ({ query })), root });
  };
  const score = (profile) => fullScore({ ...OTHER }, { profile });
  let lifted = false, shared = false;
  for (const who of Object.keys(WHO)) {
    const { strong, weak } = WHO[who];
    const rate = (terms) => Object.fromEntries([...terms.map((t, i) => [t, i % 3 ? 0.85 : 1]), ...weak.map((t) => [t, 0.2])]);
    // 40 terms, 8 of them weak: the table Step 6 asks for, field specific words only.
    const specific = build(who, rate([...strong, ...strong.slice(0, 8).map((t) => `${t} review`)]));
    assert.strictEqual(specific.ratedness, 1, `${who}: the table stands alone`);
    assert.strictEqual(specific.ratedTrust, 1, `${who}: the table is trusted in full`);
    const a = score(specific), none = score(build(who, {}));
    assert.ok(a.matchScore < 55 && !a.gatePass.gate1, `${who}, field specific table, on another field: ${a.matchScore} ${a.rankReason}`);
    assert.ok(none.matchScore < 55 && !none.gatePass.gate1, `${who}, nothing rated, on another field: ${none.matchScore}`);
    // The same table with eight words every field uses in place of eight specific ones.
    const generic = build(who, rate([...strong, ...GENERIC]));
    assert.strictEqual(generic.ratedness, 1);
    const g = score(generic);
    if (g.matchScore >= 55 || g.gatePass.gate1) lifted = true;
    // The same again with general tools and methods other fields share, on a posting that asks for them.
    const tools = fullScore({ ...ANALYST }, { profile: build(who, rate([...strong, ...SHARED])) });
    if (tools.matchScore >= 55 || tools.gatePass.gate1) shared = true;
    const lean = fullScore({ ...ANALYST }, { profile: specific });
    assert.ok(lean.matchScore < 55 && !lean.gatePass.gate1, `${who}, field specific table, on an analyst posting: ${lean.matchScore} ${lean.rankReason}`);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8'), contract = fs.readFileSync(path.join(REPO, 'DATA_CONTRACT.md'), 'utf8');
  if (shared) {
    // As long as such terms open the table, Step 6 and every text that repeats it name them next to the generic words.
    for (const [name, text] of Object.entries({ onboard: TEXT.onboard, shared: TEXT.shared, readme, contract })) {
      assert.match(text, /general tools and methods that other fields share \(spreadsheets, SQL, reporting, data analysis, forecasting, process improvement, project management, automation\)/, name);
    }
    assert.match(TEXT.onboard, /would a posting in an unrelated field ask for it in the same words\?/);
    assert.match(TEXT.onboard, /wherever no title gate runs, as in `\/jobe \[URL\]`/);
    assert.match(fs.readFileSync(path.join(REPO, 'docs', 'known-limitations.md'), 'utf8'), /general tools and methods other fields share \(SQL, reporting, data analysis/);
  }
  // Whatever the scorer does with generic words, Step 6 keeps them out of the table.
  assert.match(TEXT.onboard, /Rate only skills specific to the user's field and leave out words that postings in every field use \(leadership, communication, training/);
  // Words every field uses no longer open the table on a posting the user's material does not cover, and no text says they do.
  assert.ok(!lifted, 'generic rated words lifted a posting from another field');
  for (const [name, text] of Object.entries({ onboard: TEXT.onboard, shared: TEXT.shared, readme, contract })) {
    assert.ok(!/once it names three or more rated skills|three in full, whatever the field|unless the posting names three or more|is scored by them too|whatever its field/.test(text), `${name} still says three rated skills open the table in any field`);
    assert.match(text, /halve the coverage/, name);
  }
});

// A table of strengths alone: not a rating, but its terms are evidence.
test('a table of strengths alone has trust 0 and moves a score by its evidence only, and no text says it changes nothing', () => {
  const { buildProfile, fullScore } = require('../lib/rank');
  const CASES = [
    { seeds: ['Registered Nurse'], extra: 'bls',
      bullets: [{ keywords: ['wound care', 'telemetry'], text: 'Ran weekly wound care rounds and monitored telemetry for 6 cardiac patients per shift on a 28 bed unit.' },
        { keywords: ['patient education', 'discharge planning'], text: 'Cut 30 day readmissions by 18 percent with discharge planning and patient education at the bedside.' }],
      jd: 'Registered Nurse - Dialysis\nResponsibilities:\n- Perform hemodialysis treatments for patients with end stage renal disease and operate water treatment systems.\n- Cannulate fistulas and grafts and manage central venous catheters.\n- Monitor telemetry and provide patient education before discharge.\nRequirements:\n- 2 years of dialysis experience required.\n- Active RN license and BLS certification.' },
    { seeds: ['Tax Accountant'], extra: 'cpa',
      bullets: [{ keywords: ['multistate returns', 'corporate tax'], text: 'Prepared 140 multistate corporate income tax returns a season across 31 states with no late filings.' },
        { keywords: ['tax research', 'sales tax'], text: 'Wrote tax research memos on nexus for 12 clients and defended a three year sales tax audit.' }],
      jd: 'Tax Accountant - International\nResponsibilities:\n- Prepare transfer pricing documentation and international tax filings including forms 5471 and 8858.\n- Support reporting of the income tax footnote and corporate tax returns.\n- Perform tax research on treaty positions for expatriate executives.\nRequirements:\n- CPA required.\n- Experience with international tax and transfer pricing required.' },
  ];
  for (const c of CASES) {
    const build = (levels) => {
      const root = workspace({ version: 1, skills: { levels } });
      fs.writeFileSync(path.join(root, 'data', 'bullet-library.json'), JSON.stringify({ current: c.bullets }));
      return buildProfile({ queries: c.seeds.map((query) => ({ query })), root });
    };
    const held = Object.fromEntries(c.bullets.flatMap((b) => b.keywords).map((k) => [k, 1]));
    const post = (profile) => fullScore({ title: c.jd.split('\n')[0], company: 'Example Employer', jdText: c.jd }, { profile });
    const none = post(build({}));
    // Every rated term is already in the bullets: nothing moves.
    const same = build(held);
    assert.strictEqual(same.ratedTrust, 0);
    assert.strictEqual(same.ratedness, 0);
    assert.strictEqual(post(same).matchScore, none.matchScore, `${c.extra}: a strengths table of bullet proven terms changed a score`);
    // One rated term the bullets do not carry is new evidence: the score may move, a little.
    const more = post(build({ ...held, [c.extra]: 1 }));
    assert.ok(Math.abs(more.matchScore - none.matchScore) <= 2, `${c.extra}: ${none.matchScore} to ${more.matchScore}`);
    assert.strictEqual(more.gatePass.gate1, none.gatePass.gate1);
  }
  for (const [name, text] of Object.entries({ shared: TEXT.shared, find: TEXT.find, onboard: TEXT.onboard })) {
    assert.ok(!/changes nothing|nothing changes|changes no score|scores as if nothing were rated|move by a point|moves by about a point/.test(text), `${name} still says a table of strengths alone changes nothing`);
    assert.match(text, /not counted as a rating/, name);
    assert.match(text, /can cross the 55 floor/, name);
  }

  // A table the way a user writes one: about ten strengths, most of them
  // certifications and skills block items the bullets do not name. Trust is 0,
  // yet each term is evidence, and the docs say so.
  const WIDE = [
    { seeds: ['Registered Nurse'], bullets: CASES[0].bullets,
      levels: { 'wound care': 1, telemetry: 0.95, bls: 1, acls: 0.9, 'electronic health record': 0.95, 'rapid response': 1, 'interdisciplinary rounds': 0.9, 'acute care': 1, 'medication administration': 1, 'night shift': 0.9 },
      title: 'Staff Nurse, Medical Unit',
      jd: 'Our medical unit seeks a staff nurse. Duties: medication administration, interdisciplinary rounds, rapid response participation, and charting in the electronic health record. Requirements: BLS and ACLS, acute care background, willingness to work night shift. You will collaborate with physicians, pharmacists and therapists, escalate changes in patient condition, and support unit quality projects. Competitive pay, tuition support and a retention bonus are offered to eligible hires after six months.' },
    { seeds: ['Tax Accountant'], bullets: CASES[1].bullets,
      levels: { 'corporate tax': 1, 'sales tax': 0.95, cpa: 1, 'asc 740': 0.9, 'tax provision': 0.95, 'fixed assets': 1, 'general ledger': 0.9, 'partnership returns': 1, 'estimated payments': 1, 'state notices': 0.9 },
      title: 'Staff Accountant, Tax',
      jd: 'Our finance group seeks a staff accountant for the tax team. Duties: prepare the quarterly tax provision under ASC 740, reconcile fixed assets to the general ledger, review partnership returns, calculate estimated payments and answer state notices. Requirements: CPA or progress toward it, public accounting background, willingness to work extended hours in busy season. You will work with controllers, auditors and outside advisors, raise filing risks early, and support process projects. Competitive pay, tuition support and a retention bonus are offered to eligible hires after six months.' },
  ];
  let crossed = 0;
  for (const c of WIDE) {
    const build = (levels) => {
      const root = workspace({ version: 1, skills: { levels } });
      fs.writeFileSync(path.join(root, 'data', 'bullet-library.json'), JSON.stringify({ current: c.bullets }));
      return buildProfile({ queries: c.seeds.map((query) => ({ query })), root });
    };
    const post = (profile) => fullScore({ title: c.title, company: 'Example Employer', jdText: c.jd }, { profile });
    const wide = build(c.levels), none = post(build({})), w = post(wide);
    assert.strictEqual(wide.ratedTrust, 0, c.title);
    assert.strictEqual(wide.ratedness, 0, c.title);
    // "a point or two higher for each one": well past a point, and never past the ceiling of the fit part.
    assert.ok(w.matchScore - none.matchScore >= 6, c.title + ': ' + none.matchScore + ' to ' + w.matchScore);
    assert.ok(w.matchScore - none.matchScore <= 2 * Object.keys(c.levels).length, c.title + ': ' + none.matchScore + ' to ' + w.matchScore);
    if (none.matchScore < 55 && w.matchScore >= 55 && !none.gatePass.gate1 && w.gatePass.gate1) crossed++;
  }
  assert.ok(crossed >= 1, 'no realistic strengths table crossed the 55 floor: the docs say it can');
});

test('evaluate slug snippet: one folder per city unless the policy is remote only', { skip: !HAS_BASH }, () => {
  const snippet = block(TEXT.evaluate, 'reportSlug({company,title,location}');
  const slug = (root, location) => sh(snippet.replace('"<company>" "<role title>" "<posting location, or empty>"',
    `"Example Health" "Registered Nurse" "${location}"`), root).trim();
  const onsite = workspace(NURSE);          // onsite and hybrid
  assert.strictEqual(slug(onsite, 'Denver, CO'), 'example-health-registered-nurse-denver');
  assert.strictEqual(slug(onsite, 'Boulder, CO'), 'example-health-registered-nurse-boulder');
  assert.strictEqual(slug(onsite, 'Remote'), 'example-health-registered-nurse');
  assert.strictEqual(slug(onsite, ''), 'example-health-registered-nurse');
  assert.strictEqual(slug(workspace(ACCOUNTANT), 'Denver, CO'), 'example-health-registered-nurse', 'remote only: no city');
  assert.strictEqual(slug(workspace(), 'Denver, CO'), 'example-health-registered-nurse-denver', 'no policy keeps one row per city');
  assert.match(TEXT.batch, /reportSlug/);
});

test('mode text states the region, paper size, and character rules the code applies', () => {
  const { regionOk, pageSetup } = require('../lib/profile');
  // The examples printed in onboard.md behave as the text says.
  assert.match(TEXT.onboard, /\["Denver", "Colorado"\]` keeps "Aurora, CO"/);
  assert.strictEqual(regionOk('Aurora, CO', ['Denver', 'Colorado']), true);
  assert.match(TEXT.onboard, /\["Toronto", "ON"\]` keeps "Ottawa, Ontario"/);
  assert.strictEqual(regionOk('Ottawa, Ontario', ['Toronto', 'ON']), true);
  assert.match(TEXT.onboard, /\["Munich", "Bavaria", "BY"\]/);
  assert.strictEqual(regionOk('Augsburg, BY', ['Munich', 'Bavaria']), false, 'outside the four countries a name does not find the code');
  assert.strictEqual(regionOk('Augsburg, BY', ['Munich', 'Bavaria', 'BY']), true);
  assert.ok(!/Write the distinctive name only/.test(TEXT.onboard));
  assert.ok(!/holds no US entry/.test(TEXT.onboard));
  assert.strictEqual(pageSetup({ discovery: { countries: ['Canada'] } }).pageSize, 'letter');
  assert.strictEqual(pageSetup({ discovery: { countries: ['GB', 'United Kingdom'] } }).pageSize, 'a4');
  assert.ok(!/Plain ASCII only/.test(TEXT.shared), '_shared.md still tells every user to write plain ASCII');
  const { normalize } = require('../lib/normalize');
  assert.strictEqual(normalize('Zoë Muñoz – Montréal', { asciiOnly: false, stripHyphens: false }), 'Zoë Muñoz - Montréal');
});
