'use strict';
/**
 * What ships in data/, configs/ and templates/ must assume nothing about the
 * user: lists start empty, templates are inert when copied into a workspace,
 * and the examples inside the templates have the shape the readers expect.
 * Fixtures are synthetic (a registered nurse and a tax accountant).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Isolate BEFORE any lib module loads: several capture the workspace at load.
const roots = [];
const freshRoot = () => { roots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'data-templates-'))); return roots[roots.length - 1]; };
process.env.JOBE_USER_ROOT = freshRoot();
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const SYS = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(SYS, rel), 'utf8'));
const template = (name) => path.join(SYS, 'templates', name);
// A "$..." key is a note, never data.
const dataKeys = (obj) => Object.keys(obj).filter((k) => !k.startsWith('$'));

// Where each template lands in a workspace (scripts/user.js scaffold()).
const SCAFFOLD = {
  'seeds.template.json': 'data/queries/seeds.json',
  'negative-list.template.json': 'data/companies/negative-list.json',
  'non-tech-seed.template.json': 'data/companies/non-tech-seed.json',
  'archetypes.template.json': 'data/archetypes.json',
  'bullet-library.template.json': 'data/bullet-library.json',
  'resume-baseline.template.json': 'data/resume-baseline.json',
  'reference.template.md': 'reference.md',
};
const PERSONAL_LISTS = ['data/queries/seeds.json', 'data/companies/negative-list.json', 'data/companies/non-tech-seed.json'];
function scaffoldInto(root) {
  for (const [name, dest] of Object.entries(SCAFFOLD)) {
    fs.mkdirSync(path.dirname(path.join(root, dest)), { recursive: true });
    fs.copyFileSync(template(name), path.join(root, dest));
  }
  return root;
}

test('every shipped JSON file under data/, configs/ and templates/ parses to an object', () => {
  const files = [
    'data/companies/staffing-list.json',
    ...fs.readdirSync(path.join(SYS, 'configs')).filter((f) => f.endsWith('.json')).map((f) => `configs/${f}`),
    ...fs.readdirSync(path.join(SYS, 'templates')).filter((f) => f.endsWith('.json')).map((f) => `templates/${f}`),
  ];
  assert.ok(files.length >= 8, 'expected the shipped data, config and template files');
  for (const rel of files) {
    let parsed;
    assert.doesNotThrow(() => { parsed = readJson(rel); }, `${rel} must be valid JSON`);
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${rel} must be a JSON object`);
  }
});

test('every template this area ships exists', () => {
  for (const name of Object.keys(SCAFFOLD)) assert.ok(fs.existsSync(template(name)), `templates/${name} is missing`);
});

test('seed, exclusion and employer lists ship empty', () => {
  assert.deepStrictEqual(readJson('templates/seeds.template.json').queries, []);
  const neg = readJson('templates/negative-list.template.json');
  assert.deepStrictEqual(neg.companySlugs, []);
  assert.deepStrictEqual(neg.reasons, {});

  const portals = readJson('configs/portals.json');
  assert.deepStrictEqual(
    dataKeys(portals).sort(),
    ['ashby', 'bamboohr', 'breezy', 'greenhouse', 'lever', 'personio', 'recruitee', 'workable'],
  );
  for (const k of dataKeys(portals)) assert.deepStrictEqual(portals[k], [], `configs/portals.json ${k} must ship empty`);

  // The seed, exclusion and employer lists ship as templates only: each live
  // path is a personal file, so no copy of it may be TRACKED. The check asks
  // git, never the disk: in single user mode onboarding creates these files in
  // the clone. Outside a git checkout (an installed copy) there is nothing to ask.
  const tracked = spawnSync('git', ['ls-files', '--', ...PERSONAL_LISTS], { cwd: SYS, encoding: 'utf8' });
  if (!tracked.error && tracked.status === 0) assert.strictEqual(tracked.stdout.trim(), '', 'personal list files must not be tracked');
  const rel = 'templates/non-tech-seed.template.json';
  const seed = readJson(rel);
  assert.deepStrictEqual(dataKeys(seed).sort(), ['icims', 'smartrecruiters', 'workday'], rel);
  for (const k of dataKeys(seed)) assert.deepStrictEqual(seed[k], [], `${rel} ${k} must ship empty`);
});

test('the employer seed template documents the entry shape the sources read', () => {
  const ex = readJson('templates/non-tech-seed.template.json').$examples;
  assert.deepStrictEqual(Object.keys(ex.workday[0]).sort(), ['company', 'host', 'industry', 'site', 'tenant']);
  assert.deepStrictEqual(Object.keys(ex.smartrecruiters[0]).sort(), ['company', 'companyId', 'industry']);
  assert.deepStrictEqual(Object.keys(ex.icims[0]).sort(), ['company', 'host', 'industry']);
  // Example hosts must be obviously fake.
  for (const e of [...ex.workday, ...ex.icims]) assert.match(e.host, /example/);
});

test('the staffing list holds unique, lowercase, hyphenated, unambiguous slugs', () => {
  const { companySlugs } = readJson('data/companies/staffing-list.json');
  assert.ok(Array.isArray(companySlugs) && companySlugs.length > 50, 'the shared broker list should not be empty');
  assert.strictEqual(new Set(companySlugs).size, companySlugs.length, 'duplicate slug');
  assert.deepStrictEqual(companySlugs, [...companySlugs].sort(), 'keep the list sorted');
  for (const s of companySlugs) {
    assert.match(s, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `"${s}" is not a lowercase hyphenated slug`);
    // A very short name is too likely to also be a direct employer.
    assert.ok(s.length >= 4, `"${s}" is too short to identify a broker safely`);
  }
  // An aggregator belongs here, not in a user's own exclusion list.
  assert.ok(companySlugs.includes('jobgether'));
});

test('templates carry no fixed emphasis buckets from any one field', () => {
  const banned = ['AI Platform', 'LLMOps', 'Agentic', 'Applied ML', 'Causal', 'ML Infrastructure', 'Forward Deployed'];
  for (const f of fs.readdirSync(path.join(SYS, 'templates'))) {
    const text = fs.readFileSync(template(f), 'utf8').toLowerCase();
    for (const b of banned) assert.ok(!text.includes(b.toLowerCase()), `templates/${f} mentions "${b}"`);
  }
});

test('templates copied into a fresh workspace are inert: nothing is assumed about the user', () => {
  const root = scaffoldInto(process.env.JOBE_USER_ROOT);
  const { buildProfile } = require('../lib/rank');
  const { loadTaxonomy, detectArchetype } = require('../lib/archetypes');
  const { loadExclusions } = require('../lib/exclusions');
  const { buildExperience, pickProjects } = require('../lib/bullet-select');

  const profile = buildProfile({ root });
  assert.strictEqual(profile.configured, false, 'a scaffolded workspace must not look configured');
  assert.strictEqual(profile.roleTokens.size, 0);
  assert.strictEqual(profile.skills.length, 0, 'template text must not become a skill');
  assert.strictEqual(profile.candidate.degreeLevel, 0, 'template text must not become a degree');

  assert.deepStrictEqual(loadTaxonomy(root), {}, 'the archetypes template must define no bucket');
  assert.strictEqual(detectArchetype('Registered nurse for a cardiac unit. Tax return review.').primary, 'General');

  const ex = loadExclusions({ root });
  assert.strictEqual(ex.negative.size, 0, 'no employer is excluded until the user says so');
  assert.ok(ex.staffing.has('robert-half'), 'the shared broker list still applies');
  assert.strictEqual(loadExclusions({ root, excludeStaffing: false }).all.size, 0);

  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'data/resume-baseline.json'), 'utf8'));
  assert.deepStrictEqual(buildExperience(baseline, { jdText: 'any posting' }), []);
  assert.deepStrictEqual(pickProjects({ jdText: 'any posting' }, 2), []);

  const seeds = JSON.parse(fs.readFileSync(path.join(root, 'data/queries/seeds.json'), 'utf8'));
  assert.deepStrictEqual(seeds.queries, []);
});

test('the examples inside the templates work as real files, for two unrelated professions', () => {
  const lib = readJson('templates/bullet-library.template.json').$examples;
  const base = readJson('templates/resume-baseline.template.json').$examples;
  const cases = [
    { who: 'registered nurse', seed: 'Registered Nurse', token: 'nurse', skill: 'triage', notSkill: 'reconciliation' },
    { who: 'tax accountant', seed: 'Tax Accountant', token: 'accountant', skill: 'reconciliation', notSkill: 'triage' },
  ];
  const { buildProfile } = require('../lib/rank');
  const { buildExperience, pickProjects } = require('../lib/bullet-select');
  const before = process.env.JOBE_USER_ROOT;
  try {
    for (const c of cases) {
      assert.ok(lib[c.who] && base[c.who], `both templates need a "${c.who}" example`);
      const root = freshRoot();
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data/bullet-library.json'), JSON.stringify(lib[c.who]));
      fs.writeFileSync(path.join(root, 'data/resume-baseline.json'), JSON.stringify(base[c.who]));
      process.env.JOBE_USER_ROOT = root;

      // Every example bullet has the documented shape and unique ids per list.
      for (const key of dataKeys(lib[c.who]).filter((k) => Array.isArray(lib[c.who][k]))) {
        const ids = lib[c.who][key].map((b) => b.id);
        assert.strictEqual(new Set(ids).size, ids.length, `${c.who} ${key}: duplicate id`);
        for (const b of lib[c.who][key]) {
          assert.ok(b.id && typeof b.text === 'string' && b.text.length > 20, `${c.who} ${key}: bullet shape`);
          assert.ok(Array.isArray(b.keywords) && b.keywords.length, `${c.who} ${key}: keywords`);
          assert.ok(!/[<>\[\]{}"\\]/.test(b.text), `${c.who} ${b.id}: characters an application form rejects`);
        }
      }

      // The baseline example maps onto the library example through companyKeyMap.
      const exp = buildExperience(base[c.who], { jdText: `${c.seed} ${c.skill}` });
      assert.strictEqual(exp.length, base[c.who].experience.length);
      const currentTexts = lib[c.who].current.map((b) => b.text).sort();
      assert.deepStrictEqual([...exp[0].bullets].sort(), currentTexts, `${c.who}: current role bullets come from the library`);
      assert.deepStrictEqual(exp[1].bullets, lib[c.who].prior1.map((b) => b.text));
      assert.deepStrictEqual(pickProjects({ jdText: c.seed }, 2).map((p) => p.name), lib[c.who].selectedProjects.map((p) => p.name));

      // Fit comes from the user's own files and from nothing else.
      const profile = buildProfile({ root, queries: [{ query: c.seed, location: 'Remote' }] });
      assert.strictEqual(profile.configured, true);
      assert.ok(profile.roleTokens.has(c.token), `${c.who}: role token from the seed title`);
      const terms = profile.skills.map((s) => s.term);
      assert.ok(terms.includes(c.skill), `${c.who}: "${c.skill}" proven by a bullet`);
      assert.ok(!terms.includes(c.notSkill), `${c.who}: no skill from another profession`);
      assert.ok(profile.candidate.degreeLevel >= 2, `${c.who}: degree read from the baseline education`);
    }
  } finally {
    process.env.JOBE_USER_ROOT = before;
  }
});

test('the archetypes template example has the shape lib/archetypes reads', () => {
  const ex = readJson('templates/archetypes.template.json').$examples;
  const { loadTaxonomy } = require('../lib/archetypes');
  for (const who of ['registered nurse', 'tax accountant']) {
    const root = freshRoot();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/archetypes.json'), JSON.stringify(ex[who]));
    const taxonomy = loadTaxonomy(root);
    assert.ok(Object.keys(taxonomy).length >= 2, `${who}: buckets load`);
    for (const bucket of Object.values(taxonomy)) {
      assert.ok(Array.isArray(bucket.keywords) && bucket.keywords.length, `${who}: keywords`);
      assert.ok(Array.isArray(bucket.portfolioDomains), `${who}: portfolioDomains`);
    }
  }
});
