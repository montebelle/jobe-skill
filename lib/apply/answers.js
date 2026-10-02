// Build the flat answer map a form filler consumes, from a report's resume
// JSON plus an OPTIONAL apply-profile. Every value is real candidate data
// sourced from the user's own files; the filler never invents answers
// (free-text custom questions are left for the agent to write).
//
// Identity (name / contact / education / current role) comes from the report's
// resume JSON, which `/jobe onboard` + the evaluate flow produce. Answers a
// resume does not carry — work authorization, citizenship and eligibility
// gates, salary target, "how did you hear about us", and EEO/demographic
// self-identification — come from an OPTIONAL `data/apply-profile.json`
// (gitignored; copy `templates/apply-profile.template.json`).
//
// A BLANK value is never guessed. Every yes/no gate defaults to '' and the
// filler then surfaces the question at the glance instead of answering it.
//
// EEO defaults to DECLINE: with no apply-profile, `eeoSelfIdentify` is false and
// `eeoValues` is empty, so the tool transmits no demographics. A user who wants
// to self-identify sets `eeoSelfIdentify: true` and fills `eeoValues` with their
// OWN choices; the filler then matches those against each form's rendered
// options. Questions with no value on file always decline.

const fs = require('fs');
const path = require('path');
const { getUserRoot, getSystemRoot } = require('../config');
const { locateReportDir } = require('../tracker-writer');
const { loadProfile, discoveryFilters } = require('../profile');
const { US_ALIAS_RE } = require('./filler');

// A slug's report folder, wherever it sits in the lifecycle (flat staging,
// any bucket, legacy bucket names, dated archives). One shared resolver, so
// this file keeps no bucket list of its own.
function reportDir(slug) {
  return locateReportDir(getUserRoot(), slug);
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

// One figure out of a pay band, by the user's `salaryStrategy`:
//   midpoint (default) | top | bottom
// Used for the band the harness reads off the live posting and for the band
// stored on the report's resume JSON; buildAnswers passes the stored one only
// when it is yearly and in the user's currency. A band with one end missing returns the
// end that exists. An unknown strategy means midpoint.
function fromBand(band, strategy) {
  if (!band) return null;
  const min = Number(band.min) || 0;
  const max = Number(band.max) || 0;
  if (!min || !max) return max || min || null;
  const s = String(strategy || '').toLowerCase();
  if (s === 'top') return Math.max(min, max);
  if (s === 'bottom') return Math.min(min, max);
  return Math.round((min + max) / 2);
}

// Parse the pay band a posting publishes out of its page text. Returns
// { min, max } in whole units of the user's currency per year, or null (the
// caller then keeps the user's stored figure).
//   - a "$X - $Y" range counts only when pay vocabulary sits within 250
//     characters of it, so a benefits figure, an equity total, or another
//     role's band elsewhere on the page is not mistaken for the band;
//   - a two or three digit figure means thousands only with a k suffix
//     ("$90 - $120k"). A bare "$38 - $52" is an hourly rate, a stipend, or a
//     figure in millions, never a yearly salary;
//   - a range followed by a pay period other than a year ("an hour", "/mo",
//     "per week") or by what it pays for ("sign on bonus", "stipend") is
//     skipped, and so is a k range with hourly wording near it;
//   - the currency must be the user's (`currency`, from
//     discovery.salaryCurrency). A code or prefix next to the range ("CAD",
//     "US$") states it; a bare "$" is read as USD;
//   - with several bands, the one with the highest top wins;
//   - a top outside 20,000 .. 2,000,000 is treated as a misparse.
// ponytail: dollar ranges in English copy only. A user whose currency is not
// written with "$" always gets null (their own value is used), and a bare "$"
// on a posting from another dollar country is read as USD; extend BAND_RE and
// pass the posting country when a user needs more.
// (The (?!\d) guards stop a five digit figure written without a comma,
// "84000", from being read as "840"; the \b after k stops the next word,
// "$52 kitchen", from being read as the suffix.)
const BAND_RE = /\$\s?(\d{2,3})(?:,?(\d{3}))?(?!\d)(?:\s?([kK])\b)?\s?(?:-|\u2013|\u2014|to)\s?(?:[A-Z]{1,2})?\$?\s?(\d{2,3})(?:,?(\d{3}))?(?!\d)(?:\s?([kK])\b)?/g;
const PAY_WORDS_RE = /salary|compensation|pay (range|rate|band)|base pay|annual|remuneration|\bOTE\b/i;
const HOURLY_RE = /per hour|hourly|\/\s?hour|\/\s?hr\b/i;
// What follows the range when it is not a yearly salary. The period must be
// attached to the range: "per month", "an hour", "/week", "monthly",
// "(weekly)" on the same line. A period word that merely opens the next
// sentence or line ("... $180,000. Day one benefits", "| Day Shift") is not,
// and neither is a bonus or equity line under the salary line.
const CODES = 'USD|CAD|AUD|NZD|SGD|HKD|MXN';
const PERIOD = '(?:(?:per|an?|each)\\s+(?:hour|hr|month|mo|week|wk|day|fortnight|pay\\s+period)|hourly|monthly|bi-?weekly|weekly|daily)';
const NOT_YEARLY_RE = new RegExp(
  `^(?:[^\\S\\r\\n]|\\))*(?:(?:${CODES})\\s+)?(?:${PERIOD}\\b|\\(\\s*${PERIOD}\\s*\\))`
  + '|^[^\\S\\r\\n]*\\/\\s*(?!yr|year|y\\b|ann|pa\\b|per\\s+(?:year|annum)|(?:' + CODES + ')\\b)[a-z]'
  + '|^[^\\S\\r\\n]*(?:(?:in|of|as|a|an|sign(?:ing)?|on|annual|yearly|wellness|relocation|retention|performance|referral|target)\\W+){0,3}(?:bonus|stipend|allowance|reimbursement|equity|stock|rsus?)\\b', 'i');
const DOLLAR_CODES = { US: 'USD', CA: 'CAD', C: 'CAD', AU: 'AUD', A: 'AUD', NZ: 'NZD', S: 'SGD', SG: 'SGD', HK: 'HKD', MX: 'MXN' };
// A code states the currency of a range when it sits right before it ("CAD
// $110,000 - ...") or right after it ("... $135,000 CAD"). In "$120K - $135K
// CAD/$150K - $165K USD" the CAD trails the first range: a code that follows a
// figure is not the prefix of the next range, and a code that is followed by a
// "$" figure is not the suffix of the previous one.
const CODE_BEFORE_RE = new RegExp(`(?<![\\dkK]\\s?)(?<![A-Za-z])(${CODES})\\W{0,2}$`, 'i');
const CODE_AFTER_RE = new RegExp(`^[^A-Za-z]{0,2}(${CODES})(?![A-Za-z])(?!\\s?[A-Z]{0,2}\\$)`, 'i');
function bandFromText(text, currency = 'USD') {
  const s = String(text || '');
  const cur = String(currency || 'USD').toUpperCase();
  if (!Object.values(DOLLAR_CODES).includes(cur)) return null;
  let best = null;
  for (const g of s.matchAll(BAND_RE)) {
    const end = g.index + g[0].length;
    const around = s.slice(Math.max(0, g.index - 250), end + 250);
    if (!PAY_WORDS_RE.test(around)) continue;
    const prefix = (s.slice(Math.max(0, g.index - 3), g.index).match(/(?<![A-Za-z])([A-Z]{1,2})$/) || [])[1];
    const code = (s.slice(Math.max(0, g.index - 8), g.index).match(CODE_BEFORE_RE) || s.slice(end, end + 12).match(CODE_AFTER_RE) || [])[1];
    const stated = code ? code.toUpperCase() : prefix ? (DOLLAR_CODES[prefix] || 'other') : 'USD';
    if (stated !== cur) continue;
    if (NOT_YEARLY_RE.test(s.slice(end, end + 40))) continue;
    let lo = parseInt(g[1] + (g[2] || ''), 10);
    let hi = parseInt(g[4] + (g[5] || ''), 10);
    if (hi < 1000 && !(g[3] || g[6])) continue;
    if (HOURLY_RE.test(around) && hi < 1000) continue;
    if (hi < 1000) hi *= 1000;
    if (lo < 1000) lo *= 1000;
    if (lo > hi) continue;
    if (!best || hi > best.max) best = { min: lo, max: hi };
  }
  return best && best.max >= 20000 && best.max <= 2000000 ? best : null;
}

// Optional structured answers that a resume JSON does not carry. Gitignored;
// absent by default (EEO then declines, and every gate stays blank for the
// agent to confirm at the glance). Workspace file first, then the optional
// shared fallback.
function loadApplyProfile() {
  for (const p of [
    path.join(getUserRoot(), 'data', 'apply-profile.json'),
    path.join(getSystemRoot(), 'configs', 'apply-profile.json'),
  ]) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) return j;
    } catch { /* malformed -> defaults */ }
  }
  return {};
}

// Last 4-digit year in an education "dates" string ("1998 - 2003" -> "2003").
function gradYearFrom(dates) {
  const years = String(dates || '').match(/\b(?:19|20)\d{2}\b/g);
  return years && years.length ? years[years.length - 1] : '';
}

const httpsify = (u) => (u ? `https://${String(u).replace(/^https?:\/\//, '')}` : '');

// A yes/no gate as the user wrote it: true/false and y/n spellings become
// 'Yes' / 'No'; any other text is kept as written; nothing on file is ''.
function yesNo(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  const s = typeof v === 'string' ? v.trim() : '';
  if (/^y(es)?$/i.test(s)) return 'Yes';
  if (/^no?$/i.test(s)) return 'No';
  return s;
}

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
  const salaryStrategy = /^(top|bottom)$/i.test(p.salaryStrategy || '') ? p.salaryStrategy.toLowerCase() : 'midpoint';
  // The stored band is the posting's own: an hourly or monthly rate, or pay in
  // another currency, is not a yearly figure to type, so the user's stored
  // figure stands (same rule as the pipeline's salary floor; a band that
  // states no currency or period is taken as written).
  const cur = discoveryFilters(loadProfile()).salaryCurrency;
  const b = r.compensation && typeof r.compensation === 'object' ? r.compensation : null;
  const yearly = b && (!b.period || /^(year|yr|annual|annum)/i.test(String(b.period)))
    && (!b.currency || String(b.currency).toUpperCase() === cur)
    && Number(b.max || b.min) >= 1000;
  const salary = yearly ? fromBand(b, salaryStrategy) : null;

  const loc = c.location || p.location || '';
  // The region code is read off "City, ST" only for a location known to be in
  // the United States (the profile country, or a third part that says so).
  // Anywhere else the second part may be a country ("Leeds, UK", "Berlin, DE"),
  // which must never be typed into a state field: the region then comes from
  // `state` in the apply profile, or stays blank and surfaces at the glance.
  const parts = loc.split(',').map((x) => x.trim());
  const inUs = US_ALIAS_RE.test(p.country || '') || (parts.length > 2 && US_ALIAS_RE.test(parts[parts.length - 1]));
  const stateGuess = inUs && /^[A-Za-z]{2}$/.test(parts[1] || '') ? parts[1] : '';

  const answers = {
    firstName: first,
    lastName: last,
    fullName: r.name || p.fullName || '',
    email: c.email || p.email || '',
    phone: c.phone || p.phone || '',
    location: loc,
    city: loc ? loc.split(',')[0].trim() : '',
    state: p.state || stateGuess,         // region code, e.g. "IL"
    stateName: p.stateName || '',         // full name for state dropdowns that reject the code
    // Postal code: from the resume contact or the apply-profile. Blank => the
    // agent fills required zip fields at the glance rather than guessing.
    postalCode: c.postalCode || c.zip || p.postalCode || '',
    zip: c.postalCode || c.zip || p.postalCode || '',
    // No default country: blank surfaces at the glance.
    country: p.country || '',
    linkedin: httpsify(c.linkedin || p.linkedin),
    github: httpsify(c.github || p.github),
    website: httpsify(c.website || p.website || c.github),

    currentCompany: exp0.company || p.currentCompany || '',
    currentTitle: exp0.title || p.currentTitle || '',

    school: edu.school || p.school || '',
    degree: edu.degree || p.degree || '',
    degreeLevel: p.degreeLevel || '',     // optional: the level a degree DROPDOWN should pick
    gradYear: gradYearFrom(edu.dates) || p.gradYear || '',

    // Eligibility gates: not in the resume JSON, they come from the
    // apply-profile. 'Yes' | 'No' | '' each. Blank => the filler surfaces the
    // question; it never answers a gate the user has not answered.
    workAuthorized: yesNo(p.workAuthorized),
    requireSponsorship: yesNo(p.requireSponsorship),
    citizen: yesNo(p.citizen),                                     // "are you a citizen of <country>"
    citizenOrPermanentResident: yesNo(p.citizenOrPermanentResident), // "citizen or permanent resident"
    domiciled: yesNo(p.domiciled),                                 // "are you domiciled in <country>"
    federalEligible: yesNo(p.federalEligible),                     // "eligible for federal employment"
    // Whether the user is bound by a non-competition agreement. This is only
    // the answer to that question; whether to apply to a competing employer is
    // the user's decision and the mode flags it.
    nonCompete: yesNo(p.nonCompete),
    clearance: yesNo(p.clearance),                                 // holds an active security clearance
    relocation: yesNo(p.relocation),                               // willing to relocate

    salaryStrategy,
    salaryExpectation: salary ? String(salary)
      : (p.salaryExpectation ? String(p.salaryExpectation) : ''),

    coverLetterText: r.coverLetter || '',
    whyCompany: r.whyCompany || '',

    // EEO / demographics. DECLINE by default — the tool ships no demographics.
    // Opt in via data/apply-profile.json: { "eeoSelfIdentify": true,
    // "eeoValues": { "gender": "...", "race": "...", "veteran": "...",
    // "disability": "...", "hispanic": "...", "transgender": "...",
    // "orientation": "...", "pronouns": "..." } } with the user's OWN choices.
    // Each value is a string, or a list of acceptable phrasings of the same
    // choice. The filler matches these against each form's options; anything
    // not listed always declines.
    eeoSelfIdentify: p.eeoSelfIdentify === true,
    eeoValues: (p.eeoSelfIdentify === true && p.eeoValues && typeof p.eeoValues === 'object') ? p.eeoValues : {},

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

module.exports = {
  buildAnswers, findResumeJson, findDocx, findResumeUpload,
  loadApplyProfile, fromBand, bandFromText,
};
