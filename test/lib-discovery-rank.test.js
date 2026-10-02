'use strict';
// lib/rank.js: title policy, seed derived seniority boost, proficiency
// weighted fit, hard requirement blockers, stated minimums, gates. Synthetic
// fixtures only (a registered nurse and a tax accountant), each in its own
// temp workspace; the process root is an empty temp directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function workspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-discovery-rank-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

process.env.JOBE_USER_ROOT = workspace();
const { buildProfile, isRoleMatch, quickScore, fullScore, fuseRanking, statedMinimums, EMPTY_PROFILE } = require('../lib/rank');

const NURSE = workspace({
  'data/queries/seeds.json': { queries: [{ query: 'Senior Registered Nurse', location: 'Austin, TX' }, { query: 'Charge Nurse' }] },
  'data/bullet-library.json': {
    companyKeyMap: { 'Example Hospital': 'current' },
    current: [
      { id: 'c1', text: 'x', keywords: ['wound care', 'triage', 'patient education', 'IV therapy', 'electronic health records'] },
      { id: 'c2', text: 'y', keywords: ['medication administration', 'care plans', 'telemetry'] },
    ],
  },
  'data/resume-baseline.json': {
    skills: { Clinical: 'Wound Care, Phlebotomy, Ventilator Management', Systems: 'Epic' },
    education: [{ degree: 'BSN', school: 'Example State University' }],
  },
  'data/evidence-index.json': { toolPresence: { cerner: ['charting-notes'] } },
  'data/profile.json': {
    candidate: { yearsExperience: 4, degrees: ['BSN'], clearance: false },
    discovery: { titleExclude: ['travel', 'per diem', 'intern'], titleKeep: ['travel coordinator'] },
    skills: {
      gaps: ['dialysis', 'telemetry', 'cerner', { label: 'surgical first assist', terms: ['first assist', 'rnfa'], unlessAlso: ['circulating'] }],
      levels: { epic: 0.9 },
    },
  },
});

const ACCOUNTANT = workspace({
  'data/queries/seeds.json': { queries: ['Tax Accountant', 'Staff Accountant'] },
  'data/bullet-library.json': {
    current: [{ id: 'a1', text: 'x', keywords: ['tax preparation', 'general ledger', 'reconciliation', 'accounts payable', 'month-end close', 'excel'] }],
  },
});

const nurse = buildProfile({ root: NURSE });
const accountant = buildProfile({ root: ACCOUNTANT });
const levelOf = (profile, term) => (profile.skills.find((s) => s.term === term) || {}).level;
const post = (title, jdText, extra = {}) => ({ title, jdText, canonicalUrl: `https://example.org/jobs/${encodeURIComponent(title)}`, ...extra });

test('title policy drops an excluded title, a keep phrase rescues it, role tokens still gate', () => {
  assert.equal(isRoleMatch('Travel Nurse', nurse), false);
  assert.equal(isRoleMatch('Per Diem Registered Nurse', nurse), false);
  assert.equal(isRoleMatch('Nurse Travel Coordinator', nurse), true);
  // A keep phrase shields only its own words, not the rest of the title.
  assert.equal(isRoleMatch('Per Diem Nurse Travel Coordinator', nurse), false);
  assert.equal(isRoleMatch('Nurse Travel Coordinator (Travel)', nurse), false);
  assert.equal(isRoleMatch('Nurse Travel Coordinator Intern', nurse), false);
  assert.equal(isRoleMatch('Registered Nurse', nurse), true);
  assert.equal(isRoleMatch('Nursing Supervisor', nurse), true, 'inflected title still matches the seed');
  assert.equal(isRoleMatch('Tax Accountant', nurse), false, 'another profession is not a role match');
  assert.equal(isRoleMatch('Accounting Manager', accountant), true);
  assert.equal(isRoleMatch('Travel Nurse', accountant), false);
});

test('title policy applies with no seeds; no policy and no seeds is permissive', () => {
  const noSeeds = buildProfile({ root: workspace({ 'data/profile.json': { discovery: { titleExclude: ['intern'] } } }) });
  assert.equal(noSeeds.configured, false);
  assert.equal(isRoleMatch('Nursing Intern', noSeeds), false);
  assert.equal(isRoleMatch('Bookkeeper', noSeeds), true);
  assert.equal(isRoleMatch('Anything At All'), true);
  assert.equal(isRoleMatch('Anything At All', null), true);
  assert.equal(isRoleMatch('', EMPTY_PROFILE), false);
  assert.equal(quickScore(post('Nursing Intern'), { profile: noSeeds }).rankReason, 'title-excluded');
});

test('skill levels are derived: bullet backed 1.0, skills block or evidence 0.6, gap 0.2, override wins', () => {
  assert.equal(levelOf(nurse, 'wound care'), 1);
  assert.equal(levelOf(nurse, 'phlebotomy'), 0.6);
  assert.equal(levelOf(nurse, 'dialysis'), 0.2);
  assert.equal(levelOf(nurse, 'epic'), 0.9, 'skills.levels override');
  assert.equal(levelOf(nurse, 'telemetry'), 1, 'a bullet backed skill is never a gap');
  assert.equal(levelOf(nurse, 'cerner'), 0.6, 'evidence index credits a declared gap');
  assert.deepEqual(nurse.gapSkills.map((g) => g.label), ['dialysis', 'surgical first assist']);
  assert.equal(levelOf(accountant, 'month end close'), 1, 'hyphens fold to spaces');
});

test('fit is proficiency weighted: unknown below declared gap below skills block below bullet backed', () => {
  const base = 'You will handle wound care, triage, and patient education on a busy unit.';
  const plain = fullScore(post('Registered Nurse', base), { profile: nurse });
  const cov = (word) => fullScore(post('Registered Nurse', `${base} ${word} is part of the day.`), { profile: nurse });
  const [unknown, gap, block, bullet] = ['Lithotripsy', 'Dialysis', 'Phlebotomy', 'Telemetry'].map(cov);
  const trace = [unknown, gap, block, bullet].map((p) => p.fitCoverage).join(' < ');
  assert.ok(unknown.fitCoverage < gap.fitCoverage && gap.fitCoverage < block.fitCoverage && block.fitCoverage < bullet.fitCoverage, trace);
  assert.ok(gap.fitCoverage < plain.fitCoverage, 'a declared gap drags coverage down');
  assert.ok(bullet.fitCoverage > plain.fitCoverage, 'a bullet backed skill lifts it');
  assert.match(gap.rankReason, /gap:dialysis/);
  assert.match(plain.rankReason, /fit:wound care\/triage\/patient education/);
  assert.doesNotMatch(plain.rankReason, /differentiators/, 'library keywords alone earn no bonus');
  assert.match(plain.rankReason, /\+\d(\.\d)? role-match/);
  assert.equal(plain.archetype, 'General');
  // Only a skill the user rated at 0.9 or above is a differentiator.
  const rated = fullScore(post('Registered Nurse', `${base} Charting is done in Epic every shift.`), { profile: nurse });
  assert.match(rated.rankReason, /\+1\.2 differentiators/);
  // A skill the user rated low is their own statement that it is weak: a JD
  // naming it scores below the same JD without it.
  const low = buildProfile({ root: workspace({
    'data/bullet-library.json': { current: [{ id: 'c1', text: 'x', keywords: ['wound care', 'triage', 'patient education'] }] },
    'data/profile.json': { skills: { levels: { phlebotomy: 0.3 } } },
  }) });
  const ratedLow = fullScore(post('Registered Nurse', `${base} Phlebotomy every shift.`), { profile: low });
  const without = fullScore(post('Registered Nurse', base), { profile: low });
  assert.ok(ratedLow.fitCoverage < without.fitCoverage, `${ratedLow.fitCoverage} vs ${without.fitCoverage}`);
});

// Bands, monotonicity, and stability on full length job descriptions live in
// lib-discovery-rank-fit.test.js.

test('skill matching is whole phrase with inflections, not substring', () => {
  const hit = fullScore(post('Tax Accountant', 'Advanced Excel. Bank reconciliations every week. Month-end close.'), { profile: accountant });
  assert.match(hit.rankReason, /skills:3\/6/);
  const miss = fullScore(post('Tax Accountant', 'An excellent communicator who reconciles nothing here.'), { profile: accountant });
  assert.match(miss.rankReason, /skills:0\/6/);
  assert.ok(miss.fitCoverage < hit.fitCoverage);
});

test('an empty profile scores neutral and passes every gate', () => {
  const p = fullScore(post('Senior Charge Nurse', 'Needs 10+ years. PhD is required. Active security clearance. Master\'s degree required.'));
  assert.equal(p.matchScore, 56);
  assert.equal(p.fitCoverage, 0.5);
  assert.deepEqual(p.minimumsUnmet, []);
  assert.deepEqual(p.gatePass, { gate1: true, gate2: true, minimums: true });
  assert.equal(fullScore(post('Charge Nurse', '')).matchScore, null);
  assert.equal(quickScore(post('Senior Staff Principal Lead Nurse')).quickScore, 1, 'no seeds, no seniority boost');
});

test('years: the largest ask against the candidate years drives gate2 and a stated minimum', () => {
  const jd = 'Requires 10+ years of bedside experience, including 3+ years in triage.';
  const n = fullScore(post('Registered Nurse', jd), { profile: nurse });
  assert.deepEqual(n.minimumsUnmet, ['10+ years (you: 4)']);
  assert.equal(n.gatePass.gate2, false);
  assert.equal(n.gatePass.minimums, false);
  assert.match(n.rankReason, /-5 10y\+-required/);
  assert.match(n.rankReason, /-6 unmet stated minimums: 10\+ years \(you: 4\)/);

  const a = fullScore(post('Tax Accountant', jd), { profile: accountant });
  assert.deepEqual(a.minimumsUnmet, [], 'unknown years skips the check');
  assert.equal(a.gatePass.gate2, true);
  assert.doesNotMatch(a.rankReason, /10y/);

  const ok = fullScore(post('Registered Nurse', 'Requires 3+ years of bedside experience.'), { profile: nurse });
  assert.equal(ok.gatePass.gate2, true);
  assert.deepEqual(ok.minimumsUnmet, []);
});

test('degree and clearance blockers compare against the candidate facts', () => {
  const masters = statedMinimums(post('Registered Nurse', 'A Master\'s degree is required for this unit.'), nurse);
  assert.deepEqual(masters, ['advanced degree minimum (you: BSN)']);
  assert.deepEqual(statedMinimums(post('Registered Nurse', 'Proficiency in MS Office is required.'), nurse), []);
  // "MS" before a product name is the vendor in every position of the pattern.
  for (const jd of [
    'Minimum 2 years of recent acute care experience and working knowledge of MS Office',
    'Minimum of 3 years experience using MS Excel and Sage in a practice environment',
    'Minimum 3 years experience with Ms Dynamics',
    'Minimum qualifications: Bachelor degree in nursing; proficient in MS Excel',
    // Hyphenated, and further products.
    'Minimum requirements: proficiency in MS-Office and MS-Excel.',
    'Minimum qualifications: MS Azure, MS Publisher experience.',
    'Minimum: MS-Word and PowerPoint',
  ]) assert.deepEqual(statedMinimums(post('Registered Nurse', jd), nurse), [], jd);
  for (const jd of ['Minimum of an MS in Nursing', 'Minimum: Master degree', 'MS or PhD preferred']) {
    assert.deepEqual(statedMinimums(post('Registered Nurse', jd), nurse), ['advanced degree minimum (you: BSN)'], jd);
  }
  assert.deepEqual(statedMinimums(post('Tax Accountant', 'A Master\'s degree is required.'), accountant), [], 'no known degree, no blocker');

  const blocked = fullScore(post('Registered Nurse', 'PhD is required. An active security clearance is needed.'), { profile: nurse });
  assert.match(blocked.rankReason, /-15 phd-required/);
  assert.match(blocked.rankReason, /-18 clearance/);
  const open = fullScore(post('Tax Accountant', 'PhD is required. An active security clearance is needed.'), { profile: accountant });
  assert.doesNotMatch(open.rankReason, /phd-required|clearance/);
});

test('a declared gap is unmet only in a required context, outside an example list, without its alternative', () => {
  const unmet = (jd) => statedMinimums(post('Registered Nurse', jd), nurse);
  assert.deepEqual(unmet('Minimum qualifications: dialysis experience.'), ['dialysis']);
  assert.deepEqual(unmet('Nice to have: dialysis experience.'), []);
  assert.deepEqual(unmet('Experience with a modality such as dialysis is required.'), []);
  assert.deepEqual(unmet('First assist certification required.'), ['surgical first assist']);
  assert.deepEqual(unmet('Required: first assist or circulating experience.'), []);
  assert.deepEqual(unmet('Telemetry experience required. Cerner experience required.'), [], 'held skills are never gaps');
});

test('seniority boost applies only to level words in the user\'s own seeds', () => {
  assert.equal(quickScore(post('Staff Accountant'), { profile: accountant }).quickScore, 2);
  assert.equal(quickScore(post('Senior Accountant'), { profile: accountant }).quickScore, 1);
  assert.equal(quickScore(post('Sr. Registered Nurse'), { profile: nurse }).quickScore, 2);
  assert.equal(quickScore(post('Staff Nurse'), { profile: nurse }).quickScore, 1);
  const jd = 'General ledger work.';
  assert.match(fullScore(post('Staff Accountant', jd), { profile: accountant }).rankReason, /\+3 seniority-fit/);
  assert.doesNotMatch(fullScore(post('Principal Accountant', jd), { profile: accountant }).rankReason, /seniority/);
});

test('fuseRanking fuses skill overlap, user level, and freshness; freshness alone with no profile', () => {
  const day = 86400000;
  // Wins skill overlap and the seed derived level, loses freshness: 2 of 3.
  const older = post('Staff Tax Accountant', 'General ledger, reconciliation, accounts payable.', { postedDate: new Date(Date.now() - 20 * day).toISOString() });
  const newer = post('Accountant', 'Filing.', { postedDate: new Date(Date.now() - 2 * day).toISOString() });
  assert.equal(fuseRanking([newer, older], { profile: accountant })[0], older);
  assert.equal(older.rrfRank, 1);
  // No skills on file and no level words: those signals are left out.
  assert.equal(fuseRanking([older, newer])[0], newer);
  assert.equal(newer.rrfRank, 1);
  assert.deepEqual(fuseRanking([]), []);
});
