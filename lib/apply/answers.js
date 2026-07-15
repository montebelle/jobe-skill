// Build the flat answer map a form filler consumes, from a report's resume
// JSON plus an OPTIONAL apply-profile. Every value is real candidate data
// sourced from the user's own files; the filler never invents answers
// (free-text custom questions are left for the agent to write).
//
// Identity (name / contact / education / current role) comes from the report's
// resume JSON, which `/jobe onboard` + the evaluate flow produce. Answers a
// resume does not carry — work authorization, salary target, "how did you hear
// about us", and EEO/demographic self-identification — come from an OPTIONAL
// `data/apply-profile.json` (gitignored; copy `templates/apply-profile.template.json`).
//
// EEO defaults to DECLINE: with no apply-profile, `eeoSelfIdentify` is false and
// `eeoValues` is empty, so the tool transmits no demographics. A user who wants
// to self-identify sets `eeoSelfIdentify: true` and fills `eeoValues` with their
// OWN choices; the filler then matches those against each form's rendered
// options. Questions with no value on file always decline.

const fs = require('fs');
const path = require('path');
const { getUserRoot, getSystemRoot } = require('../config');

const WS = getUserRoot();      // active user workspace (reports, apply-profile)
const SYS = getSystemRoot();   // shared install (configs fallback)

// staging dir first, then the applied/ + skipped/ buckets a job moves to.
function reportDir(slug) {
  for (const d of [
    path.join(WS, 'reports', slug),
    path.join(WS, 'reports', 'applied', slug),
    path.join(WS, 'reports', 'skipped', slug),
  ]) if (fs.existsSync(d)) return d;
  return null;
}

function findResumeJson(slug) {
  const dir = reportDir(slug);
  if (!dir) return null;
  // Prefer the NEWEST resume-{date}-{slug}.json: a folder can hold both an old
  // and a re-tailored resume. Sort by the EXTRACTED date (descending), not the
  // raw filename — a raw lexicographic sort lets a legacy '{slug}-resume.json'
  // outrank dated files whenever slug[0] > 'r'. Legacy undated names come LAST.
  const all = fs.readdirSync(dir).filter((f) => /resume.*\.json$/.test(f));
  const dateOf = (f) => (f.match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
  const dated = all.filter((f) => dateOf(f)).sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  const undated = all.filter((f) => !dateOf(f));
  const candidates = [...dated, ...undated].map((f) => path.join(dir, f));
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function findDocx(slug, kind /* 'resume' | 'cover' */) {
  const dir = reportDir(slug);
  if (!dir) return null;
  // Newest-first by EXTRACTED date (undated legacy names last) so the
  // re-tailored resume/cover is picked, never a stale or legacy-named one.
  const dateOf = (f) => (f.match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.docx'))
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  const isCover = (f) => /cover/i.test(f);
  const pick = kind === 'cover' ? files.find(isCover) : files.find((f) => !isCover(f));
  return pick ? path.join(dir, pick) : null;
}

// The uploadable resume file. PDF is the PRIMARY submission format (preserves
// the reviewed layout; Greenhouse parses it reliably below its 2.5 MB limit),
// with the DOCX as fallback. Newest PDF first (a folder can hold a stale + a
// re-tailored render).
function findResumeUpload(slug) {
  const dir = reportDir(slug);
  if (!dir) return null;
  const pdfs = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.pdf') && !/cover/i.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return pdfs[0] || findDocx(slug, 'resume');
}

function splitName(full) {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: full || '', last: '' };
  return { first: parts[0], last: parts[parts.length - 1] };
}

function midpoint(comp) {
  if (!comp) return null;
  const { min, max } = comp;
  if (min && max) return Math.round((min + max) / 2);
  return max || min || null;
}

// Optional structured answers that a resume JSON does not carry. Gitignored;
// absent by default (EEO then declines, work-auth/salary stay blank for the
// agent to fill at the glance).
function loadApplyProfile() {
  for (const p of [
    path.join(WS, 'data', 'apply-profile.json'),
    path.join(SYS, 'configs', 'apply-profile.json'),
  ]) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* malformed -> defaults */ }
  }
  return {};
}

// Last 4-digit year in an education "dates" string ("2012 - 2016" -> "2016").
function gradYearFrom(dates) {
  const years = String(dates || '').match(/\b(?:19|20)\d{2}\b/g);
  return years && years.length ? years[years.length - 1] : '';
}

const httpsify = (u) => (u ? `https://${String(u).replace(/^https?:\/\//, '')}` : '');

/**
 * @param {string} slug
 * @returns {{answers: object, meta: object}}
 */
function buildAnswers(slug) {
  const jsonPath = findResumeJson(slug);
  const r = jsonPath ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : {};
  const c = r.contact || {};
  const p = loadApplyProfile();
  const { first, last } = splitName(r.name || p.fullName || '');
  const edu = (r.education && r.education[0]) || {};
  const exp0 = (r.experience && r.experience[0]) || {};
  const salary = midpoint(r.compensation);

  const loc = c.location || p.location || '';
  const stateGuess = (loc.split(',')[1] || '').trim(); // "New York, NY" -> "NY"

  const answers = {
    firstName: first,
    lastName: last,
    fullName: r.name || p.fullName || '',
    email: c.email || p.email || '',
    phone: c.phone || p.phone || '',
    location: loc,
    city: loc ? loc.split(',')[0].trim() : '',
    state: p.state || stateGuess,         // e.g. "NY"
    stateName: p.stateName || '',         // full name for state dropdowns that reject the code
    // Postal code: from the resume contact or the apply-profile. Blank => the
    // agent fills required zip fields at the glance rather than guessing.
    postalCode: c.postalCode || c.zip || p.postalCode || '',
    zip: c.postalCode || c.zip || p.postalCode || '',
    country: p.country || 'United States',
    linkedin: httpsify(c.linkedin || p.linkedin),
    github: httpsify(c.github || p.github),
    website: httpsify(c.website || p.website || c.github),

    currentCompany: exp0.company || p.currentCompany || '',
    currentTitle: exp0.title || p.currentTitle || '',

    school: edu.school || p.school || '',
    degree: edu.degree || p.degree || '',
    gradYear: gradYearFrom(edu.dates) || p.gradYear || '',

    // Work authorization: not in the resume JSON — comes from apply-profile.
    // Blank => the agent confirms it at the glance rather than guessing.
    workAuthorized: p.workAuthorized || '',          // 'Yes' | 'No' | ''
    requireSponsorship: p.requireSponsorship || '',  // 'Yes' | 'No' | ''

    salaryExpectation: salary ? String(salary)
      : (p.salaryExpectation ? String(p.salaryExpectation) : ''),

    coverLetterText: r.coverLetter || '',
    whyCompany: r.whyCompany || '',

    // EEO / demographics. DECLINE by default — the tool ships no demographics.
    // Opt in via data/apply-profile.json: { "eeoSelfIdentify": true,
    // "eeoValues": { "gender": "...", "race": "...", "veteran": "...",
    // "disability": "...", "hispanic": "...", "transgender": "..." } } with the
    // user's OWN choices. The filler matches these against each form's options;
    // anything not listed always declines.
    eeoSelfIdentify: p.eeoSelfIdentify === true,
    eeoValues: (p.eeoSelfIdentify === true && p.eeoValues) ? p.eeoValues : {},

    howHeard: p.howHeard || 'Company careers page',

    resumeDocx: findResumeUpload(slug),
    coverLetterDocx: findDocx(slug, 'cover'),
  };

  const meta = {
    slug,
    jsonPath,
    company: r.company || null,
    role: r.role || null,
    postingUrl: r.postingUrl || null,
    hasReport: Boolean(jsonPath),
  };

  return { answers, meta };
}

module.exports = { buildAnswers, findResumeJson, findDocx, findResumeUpload };
