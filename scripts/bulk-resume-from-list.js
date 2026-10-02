#!/usr/bin/env node
/**
 * Bulk-generate per-JD CANDIDATE POOLS (not final resumes) for a list of
 * postings already enriched in signals/discovered/{date}/ranked-enriched.json.
 *
 * bullet-select only SELECTS and ORDERS library bullets by keyword overlap;
 * that output is a candidate POOL, never the final resume (shipping the raw
 * pool makes every role lead with the same bullets). The JD-grounded reframe
 * (modes/evaluate.md Block E) is a required model step this Node script cannot
 * perform, so this script STOPS at the pool. Per posting it writes, into the
 * report folder (reports/queue/{slug}/ unless the slug already has a folder in
 * another lifecycle bucket):
 *
 *   candidate-pool-{date}-{slug}.json  the pool, flagged candidatePool: true
 *   jd.txt                             the job description (the renderers and
 *                                      the audit read it from beside the JSON)
 *   _genctx.json                       the tailoring brief for the reframe
 *                                      stage: JD keywords, honest gaps, ranked
 *                                      evidence, the two pools
 *
 * It does NOT render a DOCX and does NOT push an apply-queue entry. The reframe
 * stage rewrites summary + bullets into the JD vocabulary, preserves real
 * figures, passes auditResume(jd) + check-evidence-depth, then renders and
 * queues.
 *
 * Usage:
 *   node scripts/bulk-resume-from-list.js urls.txt
 *   node scripts/bulk-resume-from-list.js https://... https://...
 *   node scripts/bulk-resume-from-list.js --json urls.txt   # stdout = items[]
 *     for scripts/wf-generate-batch.js: [{ slug, company, role, score,
 *     archetype, dir, url, location }] (progress lines move to stderr)
 */

const fs = require('fs');
const path = require('path');

const { getProjectRoot } = require('../lib/config');
const { buildExperience, pickProjects } = require('../lib/bullet-select');
const { detectArchetype } = require('../lib/archetypes');
const { enrich } = require('../lib/enrich');
const { tailorBrief } = require('../lib/tailor');
const { loadBaseline } = require('../lib/tailoring');
const { atomicWrite, locateReportDir } = require('../lib/tracker-writer');
const { reportSlug } = require('../lib/dedup');
const { loadProfile, discoveryFilters } = require('../lib/profile');

const ROOT = getProjectRoot();
const TODAY = new Date().toISOString().slice(0, 10);

function loadEnrichedIndex(date) {
  let p = path.join(ROOT, 'signals', 'discovered', date, 'ranked-enriched.json');
  if (!fs.existsSync(p)) {
    // Fall back to the most-recent available date (handles UTC-rollover edge
    // when running just past midnight UTC against an enriched file written
    // under the previous local-date directory).
    const dir = path.join(ROOT, 'signals', 'discovered');
    if (!fs.existsSync(dir)) return [];
    const dates = fs.readdirSync(dir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (let i = dates.length - 1; i >= 0; i--) {
      const candidate = path.join(dir, dates[i], 'ranked-enriched.json');
      if (fs.existsSync(candidate)) {
        console.error(`[bulk-resume] ranked-enriched.json not found for ${date}; falling back to ${dates[i]}`);
        p = candidate;
        break;
      }
    }
    if (!fs.existsSync(p)) return [];
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function canonKey(u) {
  return (u || '')
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/(application|apply)\/?$/, '')
    .replace(/\/$/, '');
}

async function generateOne(url, idx, baseline) {
  const want = canonKey(url);
  const posting = idx.find(p =>
    canonKey(p.canonicalUrl) === want ||
    (p.alternateUrls || []).some(u => canonKey(u) === want)
  );
  if (!posting) {
    return { url, ok: false, reason: 'not in ranked-enriched' };
  }

  // Ensure JD is enriched (uses 30-day cache)
  await enrich(posting).catch(() => null);
  const jdText = posting.jdText || '';
  if (jdText.length < 400) {
    return { url, ok: false, reason: `jdText too short (${jdText.length} chars)` };
  }

  // Archetype: prefer pipeline-detected, else re-detect
  const archetype = posting.archetype || detectArchetype(jdText).primary;

  const company = posting.company || 'Unknown';
  const role = posting.title || '';
  // One folder per row the dedup keeps: the slug carries the city unless the
  // work mode policy is remote only (lib/dedup.js reportSlug).
  const slug = reportSlug({ company, title: role, location: posting.location }, discoveryFilters(loadProfile()));
  // New pools land in the queue bucket. A slug that already has a folder in
  // any lifecycle bucket (or a legacy flat one) keeps it, so the pool sits
  // where the reframe stage and the apply harness will look for the report.
  const reportDir = locateReportDir(ROOT, slug) || path.join(ROOT, 'reports', 'queue', slug);
  fs.mkdirSync(reportDir, { recursive: true });

  // bulletCounts keys must match role-keys defined in your data/bullet-library.json.
  // Override the default in the baseline JSON's `defaultBulletCounts` field.
  // An empty map (the scaffolded baseline) counts as unset.
  const spec = {
    archetype,
    jdText,
    company: posting.company, // lets the selector keep the employer's name out of its JD terms
    bulletCounts: Object.keys(baseline.defaultBulletCounts || {}).length
      ? baseline.defaultBulletCounts : { current: 4, prior1: 2, prior2: 2, prior3: 1 },
  };

  const experience = buildExperience(baseline, spec);
  const selectedProjects = pickProjects(spec, 2);

  // CANDIDATE POOL, not a final resume. summary/bullets are the raw
  // keyword-selected library content; the JD-grounded reframe (a model step
  // this script cannot do) must rewrite them before this is a real resume.
  // Flagged so nothing downstream mistakes the pool for a ready-to-render or
  // ready-to-queue resume.
  const candidatePool = {
    name: baseline.name,
    company,
    role,
    date: TODAY,
    contact: baseline.contact,
    summary: baseline.summary, // placeholder; the reframe writes a per-JD summary
    experience,
    selectedProjects,
    education: baseline.education,
    skills: baseline.skills,
    coverLetter: '', // composed per posting in the reframe pass
    archetype,
    matchScore: posting.matchScore,
    postingUrl: url,
    candidatePool: true,
  };

  // Stop here: write the pool, do NOT render a DOCX and do NOT push a queue
  // entry. The reframe stage renders + queues after tailoring to the JD.
  const jsonPath = path.join(reportDir, `candidate-pool-${TODAY}-${slug}.json`);
  atomicWrite(jsonPath, JSON.stringify(candidatePool, null, 2));

  // The two inputs the render gates and the batch workflows read from the
  // report folder: the JD itself, and the deterministic tailoring brief.
  atomicWrite(path.join(reportDir, 'jd.txt'), jdText);
  // The hiring company's own name is never JD vocabulary to mirror or a gap.
  const brief = tailorBrief(jdText, baseline, { exclude: [posting.company].filter(Boolean) });
  const evidenceByRole = {};
  for (const [roleKey, ranked] of Object.entries(brief.evidenceByRole)) {
    const top = ranked.filter(e => e.score > 0).slice(0, 8);
    if (top.length) evidenceByRole[roleKey] = top;
  }
  atomicWrite(path.join(reportDir, '_genctx.json'), JSON.stringify({
    slug, company, role,
    score: posting.matchScore ?? null,
    archetype,
    url,
    location: posting.location || null,
    compensation: posting.compensation || null,
    date: TODAY,
    jdChars: jdText.length,
    briefKeywords: brief.jd.keywords.slice(0, 15).map(k => k.term),
    briefGaps: brief.coverage.gaps,
    evidenceByRole,
    poolExperience: experience,
    poolProjects: selectedProjects,
  }, null, 2));

  return {
    url, ok: true, slug, company, role, archetype,
    matchScore: posting.matchScore,
    location: posting.location || null,
    bulletCount: experience.reduce((n, e) => n + (e.bullets || []).length, 0),
    projectCount: selectedProjects.length,
    jsonPath, dir: reportDir,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  // With --json, stdout carries only the items array.
  const say = asJson ? console.error : console.log;
  let urls = [];
  if (rest.length === 1 && fs.existsSync(rest[0])) {
    urls = fs.readFileSync(rest[0], 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  } else {
    urls = rest;
  }
  if (!urls.length) {
    console.error('Usage: node scripts/bulk-resume-from-list.js [--json] <urls.txt | url1 url2 ...>');
    process.exit(1);
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error('No resume baseline at data/resume-baseline.json in the active workspace. Run /jobe onboard first.');
    process.exit(1);
  }
  const idx = loadEnrichedIndex(TODAY);
  const results = [];
  for (const url of urls) {
    const r = await generateOne(url, idx, baseline);
    results.push(r);
    say(r.ok ? `OK  ${r.matchScore ? '['+Math.round(r.matchScore)+']' : ''} ${r.slug}` : `ERR ${url}: ${r.reason}`);
  }

  const ok = results.filter(r => r.ok).length;
  const fail = results.length - ok;
  say('---');
  say(`candidate pools written: ${ok}, failed: ${fail} (reframe required before render/queue)`);
  if (fail > 0) {
    say('failures:');
    for (const r of results.filter(r => !r.ok)) say(`  - ${r.url}: ${r.reason}`);
  }
  if (asJson) {
    process.stdout.write(JSON.stringify(results.filter(r => r.ok).map(r => ({
      slug: r.slug, company: r.company, role: r.role, score: r.matchScore ?? null,
      archetype: r.archetype, dir: r.dir, url: r.url, location: r.location,
    })), null, 2) + '\n');
  }
}

if (require.main === module) main().catch(err => { console.error(err.stack || err); process.exit(1); });

module.exports = { generateOne, slugify, canonKey };
