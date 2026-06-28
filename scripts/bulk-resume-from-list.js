#!/usr/bin/env node
/**
 * Bulk-generate resumes (and queue entries) for a list of postings already
 * enriched in signals/discovered/{date}/ranked-enriched.json.
 *
 * Cover letter content is left as an empty string — Claude composes it per
 * posting in a follow-up pass that meets the cover letter quality bar from
 * `_shared.md` (specific $, leadership signal, decision-grade outcome).
 *
 * Usage:
 *   node scripts/bulk-resume-from-list.js urls.txt
 *   node scripts/bulk-resume-from-list.js https://... https://...
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { getProjectRoot } = require('../lib/config');
const { buildExperience, pickProjects } = require('../lib/bullet-select');
const { detectArchetype } = require('../lib/archetypes');
const { enrich } = require('../lib/enrich');
const { atomicWrite, pushQueueEntry } = require('../lib/tracker-writer');

const ROOT = getProjectRoot();
const TODAY = new Date().toISOString().slice(0, 10);
const REPORTS_DIR = path.join(ROOT, 'reports');

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

function loadBaseline() {
  const p = path.join(ROOT, 'data', 'resume-baseline.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildSummaryFor(archetype) {
  // The baseline summary is the canonical narrative; trust it. We do NOT
  // rewrite the summary per posting in bulk — that's an LLM step.
  return null;
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
  const slug = `${slugify(company)}-${slugify(role)}`;
  const reportDir = path.join(REPORTS_DIR, slug);
  fs.mkdirSync(reportDir, { recursive: true });

  // bulletCounts keys must match role-keys defined in your data/bullet-library.json.
  // Override the default in the baseline JSON's `defaultBulletCounts` field.
  const spec = {
    archetype,
    jdText,
    bulletCounts: baseline.defaultBulletCounts || { current: 4, prior1: 2, prior2: 2, prior3: 1 },
  };

  const experience = buildExperience(baseline, spec);
  const selectedProjects = pickProjects(spec, 2);

  const resume = {
    name: baseline.name,
    company,
    role,
    date: TODAY,
    contact: baseline.contact,
    summary: baseline.summary,
    experience,
    selectedProjects,
    education: baseline.education,
    skills: baseline.skills,
    coverLetter: '', // Composed per-posting by Claude in a follow-up pass
    archetype,
    matchScore: posting.matchScore,
    postingUrl: url,
  };

  const jsonPath = path.join(reportDir, `resume-${TODAY}-${slug}.json`);
  atomicWrite(jsonPath, JSON.stringify(resume, null, 2));

  // Render resume DOCX (cover letter render deferred until coverLetter is composed)
  try {
    execSync(`node scripts/render-docx.js "${jsonPath}"`, { stdio: 'pipe' });
  } catch (err) {
    return { url, ok: false, reason: `render-docx failed: ${err.message.slice(0, 200)}` };
  }

  // Add to apply-queue
  const docxPath = jsonPath.replace(/\.json$/, '.docx');
  const clDocxPath = jsonPath.replace(/resume-/, 'cover-letter-').replace(/\.json$/, '.docx');
  pushQueueEntry({
    slug,
    company,
    role,
    archetype,
    score: posting.matchScore,
    primaryUrl: url,
    resumeDocx: docxPath,
    coverLetterDocx: clDocxPath,
    alternativeUrls: [],
    applied: false,
    tailoringDepth: 'pending-cover-letter',
  });

  return {
    url, ok: true, slug, company, role, archetype,
    matchScore: posting.matchScore,
    bulletCount: experience.reduce((n, e) => n + (e.bullets || []).length, 0),
    projectCount: selectedProjects.length,
    jsonPath, docxPath,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let urls = [];
  if (args.length === 1 && fs.existsSync(args[0])) {
    urls = fs.readFileSync(args[0], 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  } else {
    urls = args;
  }
  if (!urls.length) {
    console.error('Usage: node scripts/bulk-resume-from-list.js <urls.txt | url1 url2 ...>');
    process.exit(1);
  }

  const idx = loadEnrichedIndex(TODAY);
  const baseline = loadBaseline();
  const results = [];
  for (const url of urls) {
    const r = await generateOne(url, idx, baseline);
    results.push(r);
    console.log(r.ok ? `OK  ${r.matchScore ? '['+Math.round(r.matchScore)+']' : ''} ${r.slug}` : `ERR ${url}: ${r.reason}`);
  }

  const ok = results.filter(r => r.ok).length;
  const fail = results.length - ok;
  console.log('---');
  console.log(`generated: ${ok}, failed: ${fail}`);
  if (fail > 0) {
    console.log('failures:');
    for (const r of results.filter(r => !r.ok)) console.log(`  - ${r.url}: ${r.reason}`);
  }
}

main().catch(err => { console.error(err.stack || err); process.exit(1); });
