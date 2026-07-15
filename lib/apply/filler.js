// Generic, label-first form filler that operates on a Playwright page.
//
// Works label-first rather than per-ATS-selector because Greenhouse, Lever and
// Ashby all render standard HTML controls with associated labels; matching on
// the label text generalizes far better than brittle CSS paths. Special cases:
// react-select comboboxes (Greenhouse work-auth dropdowns) and file inputs.
//
// It NEVER invents free-text answers: any textarea/long-answer whose label is
// not a known field is returned in `questions` for the agent to write, then
// filled via fillQuestions().

const { normalize } = require('../normalize');

const ATS_HOSTS = [
  [/greenhouse\.io/, 'greenhouse'],
  [/lever\.co/, 'lever'],
  [/ashbyhq\.com/, 'ashby'],
  [/myworkdayjobs\.com/, 'workday'],
  [/smartrecruiters\.com/, 'smartrecruiters'],
  [/icims\.com/, 'icims'],
  [/jobvite\.com/, 'jobvite'],
];

function detectAts(url) {
  for (const [re, id] of ATS_HOSTS) if (re.test(url || '')) return id;
  return 'generic';
}

// label substring -> answer key. Order matters (most specific first).
const FIELD_MAP = [
  { keys: ['first name', 'given name'], key: 'firstName' },
  { keys: ['last name', 'surname', 'family name'], key: 'lastName' },
  { keys: ['preferred name'], key: 'firstName' },
  { keys: ['full name', 'your name', 'name'], key: 'fullName' },
  { keys: ['email'], key: 'email' },
  { keys: ['phone', 'mobile', 'telephone'], key: 'phone' },
  { keys: ['linkedin'], key: 'linkedin' },
  { keys: ['github', 'git hub'], key: 'github' },
  { keys: ['portfolio', 'website', 'personal site', 'personal url', 'blog'], key: 'website' },
  { keys: ['current company', 'current employer', 'employer', 'company'], key: 'currentCompany' },
  { keys: ['current title', 'current role', 'job title', 'title'], key: 'currentTitle' },
  { keys: ['school', 'university', 'college', 'institution'], key: 'school' },
  { keys: ['degree'], key: 'degree' },
  { keys: ['graduation', 'grad year', 'year of graduation'], key: 'gradYear' },
  { keys: ['city'], key: 'city' },
  { keys: ['state', 'province', 'region'], key: 'state' },
  { keys: ['country'], key: 'country' },
  // 'search' covers the Greenhouse city autocomplete, whose input is labeled
  // only with the placeholder "Search" (the container label "Location (City)"
  // belongs to the sibling text input). On an application form a bare "Search"
  // combobox is the location typeahead — route it through the location path.
  { keys: ['location', 'where are you', 'where do you live', 'search'], key: 'location' },
  { keys: ['salary', 'compensation', 'desired pay', 'pay expectation', 'expected', 'comp expectation'], key: 'salaryExpectation' },
];

// yes/no style questions resolved to a candidate answer.
const BOOL_MAP = [
  { keys: ['authoriz', 'legally allowed', 'eligible to work', 'right to work'], key: 'workAuthorized' },
  { keys: ['sponsor', 'visa'], key: 'requireSponsorship' },
];

const EEO_HINTS = ['gender', 'race', 'ethnic', 'veteran', 'disability', 'hispanic', 'latino', 'sexual orientation', 'pronoun'];

// EEO self-identification matcher. The candidate's own choices live in the
// answer map's `eeoValues` (sourced from data/apply-profile.json) — the filler
// hardcodes NO demographics. For a given subtype it builds a regex from the
// user's value and matches it against the form's rendered options; if the value
// is unset it returns null and the caller declines.
//
// Two affordances on top of a bare value match:
//   - Word boundaries are added per token, so a short value never matches a
//     longer option that merely contains it as a substring on a dropdown.
//   - For veteran / disability subtypes a "no" value also matches the standard
//     CC-305 / VEVRAA "negative" option wording that forms render instead of a
//     bare "No".
function eeoMatcher(sub, eeoValues) {
  const val = (eeoValues && eeoValues[sub] != null) ? String(eeoValues[sub]).trim() : '';
  if (!val) return null; // no value on file -> decline
  const tokens = val.split(/[\s,/]+/).filter(Boolean).map(escapeRe);
  const parts = tokens.map((t) => `\\b${t}\\b`);
  const isNo = /^no\b|^n\/?a$|don'?t|do not|not a\b/i.test(val);
  if ((sub === 'veteran' || sub === 'disability') && isNo) {
    if (sub === 'veteran') parts.push('not a (protected )?veteran', '^\\s*no\\b');
    else parts.push("(do ?n'?o?t|don'?t) have a disability", "^\\s*no,? i (do ?n'?o?t|don'?t)", '^\\s*no\\b');
  } else if ((sub === 'transgender' || sub === 'hispanic') && isNo) {
    parts.push('^\\s*no\\b');
  }
  try { return new RegExp(parts.join('|'), 'i'); } catch { return null; }
}
function eeoSubtype(label) {
  const l = norm(label);
  // "transgender" contains "gender": match it BEFORE the gender rule or it
  // would route to the gender matcher and fall back to decline.
  if (/transgender/.test(l)) return 'transgender';
  if (/gender/.test(l)) return 'gender';
  // A STANDALONE Hispanic/Latino yes/no question is answered from
  // eeoValues.hispanic and declines when that value is unset. It must come
  // before the race rule. A combined "Race/Ethnicity" dropdown keeps label
  // "race"/"ethnic" (no "hispanic") and routes to race, which picks the
  // candidate's race option.
  if (/hispanic|latino/.test(l)) return 'hispanic';
  if (/race|ethnic/.test(l)) return 'race';
  if (/veteran/.test(l)) return 'veteran';
  if (/disab/.test(l)) return 'disability';
  return null; // sexual orientation, pronouns, etc. -> decline (no value on file)
}

// In-page scanner: tags every control with data-cfx=idx and returns metadata.
const SCAN_FN = `(() => {
  function labelFor(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const n = document.getElementById(lb); if (n) return n.innerText; }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText; }
    let p = el.closest('label'); if (p) return p.innerText;
    // nearest preceding label/legend within the same field group
    let g = el.closest('div,fieldset,li,section'); let hops = 0;
    while (g && hops < 4) {
      const l = g.querySelector('label,legend'); if (l && !l.contains(el)) return l.innerText;
      g = g.parentElement; hops++;
    }
    return el.getAttribute('placeholder') || el.getAttribute('name') || '';
  }
  // For a radio (and grouped checkbox), labelFor returns the OPTION text
  // (Yes/No/Woman); the real QUESTION is the fieldset legend or a question-
  // bearing ancestor above the group. This recovers it.
  function groupLabel(el, ownOpt) {
    const fsx = el.closest('fieldset');
    if (fsx) { const lg = fsx.querySelector('legend'); if (lg && lg.innerText.trim().length > 3) return lg.innerText; }
    let c = el.closest('[class*="question" i], [class*="field" i], li, div'); let hops = 0;
    while (c && hops < 6) {
      const cand = c.querySelector('legend, [class*="question" i], [class*="title" i], [class*="label" i], label');
      if (cand && !cand.contains(el)) { const t = cand.innerText.replace(/\\s+/g, ' ').trim(); if (t.length > 4 && t !== ownOpt) return t; }
      c = c.parentElement; hops++;
    }
    return ownOpt;
  }
  const out = [];
  let idx = 0;
  const controls = document.querySelectorAll('input, textarea, select, [role="combobox"]');
  controls.forEach((el) => {
    let type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return;
    const style = window.getComputedStyle(el);
    // File inputs on ATS (Greenhouse/Lever) are routinely display:none behind a
    // styled "Attach" button; Playwright setInputFiles drives a hidden file
    // input fine, so never skip one for being hidden — skipping the hidden
    // cover-letter input dropped its upload and failed the submit.
    if (type !== 'file' && (style.display === 'none' || style.visibility === 'hidden')) return;
    // Greenhouse/Ashby render dropdowns + custom questions + EEO as react-select
    // (input.select__input[role=combobox]), never native <select>. Treat as combobox.
    if (el.getAttribute('role') === 'combobox' || /select__input/.test(el.className || '')) type = 'combobox';
    el.setAttribute('data-cfx', String(idx));
    let options = null;
    if (el.tagName === 'SELECT') options = Array.from(el.options).map((o) => o.text.trim());
    let label = (labelFor(el) || '').replace(/\\s+/g, ' ').trim();
    let option = null;
    if (type === 'radio') { option = label.slice(0, 80); label = (groupLabel(el, label) || label).replace(/\\s+/g, ' ').trim(); }
    out.push({
      idx,
      tag: el.tagName.toLowerCase(),
      type,
      name: el.getAttribute('name') || '',
      required: el.required || el.getAttribute('aria-required') === 'true',
      label: label.slice(0, 160),
      option,
      options,
    });
    idx++;
  });
  // Ashby renders some yes/no questions as custom option BUTTONS (class
  // "_option_...") backed by a hidden checkbox, NOT as <input> — so the loop
  // above misses them. Scan them as a 'buttongroup'.
  document.querySelectorAll('button').forEach((el) => {
    const cls = String(el.className || '');
    if (!/option/i.test(cls)) return;
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 40) return;
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return;
    el.setAttribute('data-cfx', String(idx));
    out.push({ idx, tag: 'button', type: 'buttongroup', name: '', required: true, label: (groupLabel(el, t) || t).slice(0, 160), option: t.slice(0, 80), options: null });
    idx++;
  });
  return out;
})()`;

function norm(s) {
  return (s || '').toLowerCase().replace(/[*∗]/g, '').replace(/\(required\)/g, '').trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// react-select option elements ONLY. Deliberately excludes a bare global
// [role="option"]: intl-tel-input renders the full country list as
// li.iti__country[role=option] which is always in the DOM, so a global match
// would click e.g. "Norway" when looking for "No". Scope role=option to the
// open .select__menu.
const RS_OPTIONS = '.select__option, [class*="select__option"], .select__menu [role="option"]';

function matchField(label) {
  const l = norm(label);
  if (!l) return null;
  if (EEO_HINTS.some((h) => l.includes(h))) return { kind: 'eeo' };
  // Work-authorization vs sponsorship-need disambiguation. A single question can
  // contain BOTH "authoriz" and "sponsor"/"visa" (e.g. "will you require
  // sponsorship for authorization to work..."). The candidate's intent is keyed
  // on whether sponsorship is REQUIRED (answer No), so test the require/need
  // framing BEFORE the generic "authorized" rule — otherwise "authoriz" matches
  // first and the harness answers Yes ("needs sponsorship"), which auto-rejects.
  const wantsSponsorship = /(require|requiring|need|needing|will you|now or|future).{0,45}(sponsor|visa)|(sponsor|visa).{0,25}(require|need)/;
  if (wantsSponsorship.test(l)) return { kind: 'bool', key: 'requireSponsorship' };
  if (/authoriz|legally allowed|eligible to work|right to work|permitted to work/.test(l)) return { kind: 'bool', key: 'workAuthorized' };
  if (/\bsponsor|\bvisa\b/.test(l)) return { kind: 'bool', key: 'requireSponsorship' };
  // Only SHORT labels are contact-style fields. A long sentence that merely
  // CONTAINS "blog"/"email"/"degree" is a custom question (e.g. "...Engineering
  // blog..."), not a website/email/degree field — auto-filling it with contact
  // data would send wrong answers. Long labels fall through to question
  // detection instead.
  if (l.length <= 55) {
    for (const m of FIELD_MAP) if (m.keys.some((k) => l.includes(k))) return { kind: 'text', key: m.key };
  }
  return null;
}

// Bare URL / email / handle test — its hyphens are meaningful (e.g. a linkedin
// profile slug) so it must fill RAW. Anything else is prose and gets normalized
// (which strips hyphens/dashes per the no-hyphens rule).
function isUrlish(s) {
  return /^\s*(https?:\/\/|mailto:|[\w.+-]+@|[\w.-]+\.(com|io|ai|dev|net|org|co)\b)/i.test(s) && !/\s\w+\s\w+\s/.test(s);
}

async function setText(page, idx, value, delay = 18) {
  const loc = page.locator(`[data-cfx="${idx}"]`);
  const v = String(value);
  await loc.click().catch(() => {}); // focus first: a real click before typing generates the pointer telemetry reCAPTCHA v3 grades
  await loc.fill('');
  await loc.type(isUrlish(v) ? v : normalize(v), { delay }); // keystroke cadence = human-ish; prose is hyphen-stripped
}

async function setSelect(page, idx, wanted, options) {
  // choose the option whose text best matches `wanted`
  const w = norm(wanted);
  const opt = (options || []).find((o) => norm(o) === w) || (options || []).find((o) => norm(o).includes(w) || w.includes(norm(o)));
  if (!opt) return false;
  await page.locator(`[data-cfx="${idx}"]`).selectOption({ label: opt });
  return true;
}

// Native <select>: pick the first option whose text matches `regex`. Used for
// EEO self-identification where a loose substring match is unsafe (a short
// value can appear inside a longer option label) — the caller passes a
// word-boundary-anchored pattern.
async function setSelectMatching(page, idx, regex, options) {
  const opt = (options || []).find((o) => regex.test(o));
  if (!opt) return false;
  await page.locator(`[data-cfx="${idx}"]`).selectOption({ label: opt });
  return true;
}

// Open a react-select once, read the actual rendered options, click the first
// whose text matches `regex`. Robust to wording differences (EEO decline labels
// vary: "Decline To Self Identify" / "I don't wish to answer" / "Choose not to
// disclose"). One open + scan, no repeated guess-and-type.
async function setComboboxMatching(page, idx, regex) {
  const loc = page.locator(`[data-cfx="${idx}"]`);
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click();
    await page.waitForTimeout(350);
    const opts = page.locator(RS_OPTIONS);
    const n = await opts.count();
    for (let i = 0; i < n; i++) {
      const t = (await opts.nth(i).innerText().catch(() => '')) || '';
      if (regex.test(t)) { await opts.nth(i).click(); return true; }
    }
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  } catch { return false; }
}

// Open a react-select / native combobox, read the rendered option labels, and
// close it without committing. Lets the agent see the choices for a custom
// combobox question (the scan can't enumerate react-select options up front
// because they render only on open). Scoped to question comboboxes — never the
// location geocoder (whose "options" are async API hits).
async function readComboboxOptions(page, idx) {
  const loc = page.locator(`[data-cfx="${idx}"]`);
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown').catch(() => {}); // force-open native combobox
    await page.waitForTimeout(200);
    const opts = page.locator(`${RS_OPTIONS}, [role="listbox"] [role="option"]:not(.iti__country)`);
    const n = await opts.count();
    const out = [];
    for (let i = 0; i < n && i < 60; i++) {
      const t = ((await opts.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (t && !out.includes(t)) out.push(t);
    }
    await page.keyboard.press('Escape').catch(() => {});
    return out;
  } catch { return []; }
}

const DECLINE_RE = /decline|do ?n'?o?t? ?(wish|want)|not to (disclose|answer|identify)|prefer not|choose not/i;

// react-select / combobox: click to open, type to filter, click the matching
// option. Critically does NOT blind-press Enter on a no-match — that could
// commit a wrong value (e.g. select a real demographic on an EEO dropdown).
async function setCombobox(page, idx, wanted) {
  const loc = page.locator(`[data-cfx="${idx}"]`);
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowDown').catch(() => {}); // force-open Ashby-native comboboxes
    await page.waitForTimeout(150);
    await page.keyboard.type(String(wanted), { delay: 15 });
    await page.waitForTimeout(400);
    const w = norm(wanted);
    // Match within the react-select menu, OR an OPEN [role=listbox] (Ashby's
    // native combobox dropdown). Scoping the Ashby option match to the open
    // listbox avoids the always-present EEO option chips that caused mis-clicks
    // with a bare [class*=_option_]. Prefer an EXACT match (so "No" never picks
    // "Norway").
    for (const sel of [RS_OPTIONS, '[role="listbox"] [class*="_option_"], [role="listbox"] [role="option"]:not(.iti__country)']) {
      const opts = page.locator(sel);
      const n = await opts.count();
      let exact = -1, partial = -1;
      for (let i = 0; i < n; i++) {
        const t = norm(await opts.nth(i).innerText().catch(() => ''));
        if (!t) continue;
        if (t === w) { exact = i; break; }
        if (partial < 0 && (t.includes(w) || w.includes(t))) partial = i;
      }
      const pick = exact >= 0 ? exact : partial;
      if (pick >= 0) {
        await opts.nth(pick).click();
        await page.waitForTimeout(140);
        // Verify the value actually committed — a react-select click sometimes
        // highlights without firing onChange, so the field reads empty at
        // submit. If the control text does not now reflect the choice, retry by
        // committing the highlighted option with Enter.
        const committed = await page.evaluate(({ i, w }) => {
          const el = document.querySelector(`[data-cfx="${i}"]`);
          if (!el) return true;
          const nn = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const cont = el.closest('[class*="select"],[class*="combobox"],div,fieldset,label') || el.parentElement || el;
          const txt = nn(cont.innerText || cont.textContent || '');
          return !w || txt.includes(w);
        }, { i: idx, w: w.slice(0, 14) }).catch(() => true);
        if (!committed) {
          await loc.click().catch(() => {});
          await page.waitForTimeout(120);
          await page.keyboard.type(String(wanted), { delay: 12 }).catch(() => {});
          await page.waitForTimeout(250);
          await page.keyboard.press('Enter').catch(() => {});
        }
        return true;
      }
    }
    await page.keyboard.press('Escape').catch(() => {}); // no match -> commit nothing
    return false;
  } catch { return false; }
}

// Location/city autocompletes (Greenhouse + Ashby) resolve typed text against
// an async geocoding API, so the rendered suggestion is a fuller string
// ("New York, NY, United States") that setCombobox's exact/partial match can
// miss — leaving the REQUIRED location empty and failing the submit. Here we
// type the city, wait for the async list, prefer a suggestion containing the
// typed value, and otherwise commit the FIRST suggestion (for a location list
// the top geocoder hit is the right city). Scoped to location fills only, so
// the "never blind-pick" rule still holds for EEO/sponsorship comboboxes.
async function setLocationCombobox(page, idx, wanted) {
  const loc = page.locator(`[data-cfx="${idx}"]`);
  // Type ONLY the city for a clean geocoder query, and match on the option's
  // CITY SEGMENT exactly — a loose substring match picked "York, New York" (a
  // hamlet) for "New York" because "new york".includes("york"). The city is the
  // first comma segment of both the typed value and each suggestion.
  const city = String(wanted).split(',')[0].trim(); // "New York"
  const cw = norm(city);
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click();
    await page.waitForTimeout(200);
    await loc.fill('').catch(() => {});
    await page.keyboard.type(city, { delay: 22 });
    await page.waitForTimeout(950); // async geocoder
    for (const sel of [RS_OPTIONS, '[role="listbox"] [class*="_option_"], [role="listbox"] [role="option"]:not(.iti__country)', '[role="option"]:not(.iti__country)']) {
      const opts = page.locator(sel);
      const n = await opts.count();
      if (!n) continue;
      let exact = -1, starts = -1;
      for (let i = 0; i < n; i++) {
        const t = norm(await opts.nth(i).innerText().catch(() => ''));
        if (!t) continue;
        const seg0 = t.split(',')[0].trim();
        if (seg0 === cw) { exact = i; break; }              // city segment matches exactly
        if (starts < 0 && seg0.startsWith(cw)) starts = i;  // e.g. "New York City"
      }
      const pick = exact >= 0 ? exact : (starts >= 0 ? starts : 0);
      const chosen = (await opts.nth(pick).innerText().catch(() => '') || '').replace(/\s+/g, ' ').trim();
      await opts.nth(pick).click();
      return chosen || true; // return the committed option text for the glance
    }
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  } catch { return false; }
}

/**
 * Fill everything fillable. Returns a structured report.
 */
// Cookie / consent banners render a fixed overlay that intercepts pointer
// events: a checkbox check() or react-select open times out on "obscured".
// Dismiss it up front, privacy-preserving option first (decline).
async function dismissConsentOverlays(page) {
  const BTN = 'button, a[role="button"], [role="button"], input[type="button"]';
  const DECLINE = /^\s*(i do not accept|do not accept|decline( all)?|reject( all| non.?essential)?|only (necessary|essential)|(necessary|essential) only|deny|refuse)\s*$/i;
  const ACCEPT = /^\s*(i accept|accept( all| cookies)?|got it|allow( all)?|agree|okay|ok)\s*$/i;
  for (const rx of [DECLINE, ACCEPT]) {
    try {
      const loc = page.locator(BTN).filter({ hasText: rx }).first();
      if (await loc.count() && await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 2500 }).catch(() => {});
        await page.waitForTimeout(400);
        return true;
      }
    } catch { /* keep trying */ }
  }
  return false;
}

async function fillForm(page, answers, opts = {}) {
  // opts.slow (Ashby): type contact fields at a slower human cadence — Ashby's
  // reCAPTCHA v3 grades keystroke timing, and 18ms/char reads machine-fast.
  const typeDelay = opts.slow ? 55 : 18;
  await dismissConsentOverlays(page).catch(() => {});
  // Scroll through the whole form first: Ashby/Greenhouse lazy-render the EEO +
  // legal/eligibility (radio) sections only when they enter view, so a single
  // top-of-page scan can miss required radios. This makes the scan complete.
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    for (let y = 0; y <= h; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 90)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(500);
  const scanned = await page.evaluate(SCAN_FN);
  // Fill text/select fields FIRST and file inputs LAST: uploading a resume
  // triggers ATS "autofill from resume" re-renders (Ashby) that invalidate the
  // data-cfx tags on any field filled afterward. File-last keeps tags fresh.
  const fields = [...scanned].sort((a, b) => (a.type === 'file' ? 1 : 0) - (b.type === 'file' ? 1 : 0));

  // Pick the ONE real resume file input. Ashby forms have BOTH an "Autofill
  // from resume" helper AND the required "Resume" field; uploading to the
  // helper leaves the required field empty and the submit fails. Prefer a
  // Resume/CV-labelled input that is NOT the autofill helper.
  const fileInputs = fields.filter((f) => f.type === 'file');
  const txt = (f) => norm(f.label) + ' ' + norm(f.name);
  const coverInput = fileInputs.find((f) => /cover/.test(txt(f)));
  const resumeCands = fileInputs.filter((f) => f !== coverInput);
  const resumeTarget = resumeCands.find((f) => /resume|cv\b/.test(txt(f)) && !/autofill/.test(txt(f)))
    || resumeCands.find((f) => !/autofill/.test(txt(f)))
    || resumeCands[0];

  const filled = [];
  const unfilled = [];
  let questions = []; // free-text + choice questions we won't invent
  let resumeUploaded = false;

  for (const f of fields) {
    // resume / cover-letter file inputs — only the chosen real targets, never
    // the "autofill from resume" helper or hidden duplicates.
    if (f.type === 'file') {
      // On a re-scan pass (after a submit rejection) the resume is already
      // uploaded; re-uploading re-triggers the ATS autofill re-render and is
      // pure churn — skip it.
      if (opts.skipResume) continue;
      const isCover = coverInput && f.idx === coverInput.idx;
      const isResume = resumeTarget && f.idx === resumeTarget.idx;
      if (!isCover && !isResume) continue;
      const docx = isCover ? answers.coverLetterDocx : answers.resumeDocx;
      if (docx) {
        try {
          await page.locator(`[data-cfx="${f.idx}"]`).setInputFiles(docx, { timeout: 8000 });
          filled.push({ label: f.label || (isCover ? 'cover letter file' : 'resume file'), value: docx.split('/').pop() });
          if (isResume) resumeUploaded = true;
        } catch (e) { unfilled.push({ label: f.label || (isCover ? 'cover' : 'resume'), reason: 'upload failed: ' + e.message.split('\n')[0] }); }
      }
      continue;
    }

    const m = matchField(f.label);

    // EEO (Greenhouse renders these as react-select comboboxes, native selects,
    // or radios). Default: the candidate self-identifies on the four standard
    // demographic questions with their real answers; anything else (orientation,
    // pronouns) is declined. Set answers.eeoSelfIdentify=false to decline all.
    if (m && m.kind === 'eeo') {
      const sub = answers.eeoSelfIdentify === false ? null : eeoSubtype(f.label);
      const re = sub ? eeoMatcher(sub, answers.eeoValues) : null;
      if (re) {
        const shown = (answers.eeoValues && answers.eeoValues[sub]) || 'self-identified';
        let ok = false;
        if (f.tag === 'select') {
          ok = await setSelectMatching(page, f.idx, re, f.options);
        } else if (f.type === 'combobox') {
          ok = await setComboboxMatching(page, f.idx, re);
        } else if (f.type === 'radio') {
          // each option is its own scanned field; click only the matching one
          if (re.test(f.option || '')) {
            try {
              const rl = page.locator(`[data-cfx="${f.idx}"]`);
              await rl.check({ force: true }).catch(async () => { await rl.click({ force: true }); });
              filled.push({ label: f.label, value: shown });
            } catch (e) { unfilled.push({ label: f.label, reason: 'eeo radio click failed' }); }
          }
          continue; // non-matching radio option: skip silently
        }
        if (ok) { filled.push({ label: f.label, value: shown }); continue; }
        // self-id option not present -> fall through to decline so a REQUIRED
        // field still validates.
      }
      if (f.tag === 'select') {
        const ok = await setSelect(page, f.idx, 'decline', f.options) ||
                   await setSelect(page, f.idx, 'prefer not', f.options) ||
                   await setSelect(page, f.idx, "don't wish", f.options);
        if (ok) filled.push({ label: f.label, value: re ? 'declined (self-id option not found)' : 'declined' });
        else unfilled.push({ label: f.label, reason: 'eeo: no decline option' });
      } else if (f.type === 'combobox') {
        const ok = await setComboboxMatching(page, f.idx, DECLINE_RE);
        if (ok) filled.push({ label: f.label, value: re ? 'declined (self-id option not found)' : 'declined' });
        else unfilled.push({ label: f.label, reason: 'eeo combobox: no decline option' });
      }
      continue;
    }

    // yes/no questions
    if (m && m.kind === 'bool') {
      const want = answers[m.key]; // 'Yes' / 'No'
      if (f.tag === 'select') {
        if (await setSelect(page, f.idx, want, f.options)) filled.push({ label: f.label, value: want });
        else unfilled.push({ label: f.label, reason: 'no matching yes/no option' });
      } else if (f.type === 'combobox') {
        // react-select yes/no options are often phrases ("No, I do not require
        // sponsorship") — match by anchored pattern, not exact text.
        const re = want.toLowerCase() === 'no'
          ? /^\s*no\b|do not (require|need)|not require|^no,/i
          : /^\s*yes\b|authoriz|^i am|i have/i;
        if (await setComboboxMatching(page, f.idx, re)) filled.push({ label: f.label, value: want });
        else unfilled.push({ label: f.label, reason: 'combobox set failed' });
      } else if (f.type === 'buttongroup') {
        // each yes/no button is a separate field; click only the one whose
        // option text matches the known answer (authorized=Yes, sponsorship=No)
        if (norm(f.option || '') === norm(want)) {
          try { await page.locator(`[data-cfx="${f.idx}"]`).click(); filled.push({ label: f.label, value: want }); }
          catch (e) { unfilled.push({ label: f.label, reason: 'button click failed' }); }
        }
      } else if (f.type === 'radio') {
        // Each radio option is its own scanned field (f.option = "Yes"/"No").
        // Click only the option matching the known answer; the non-matching
        // option's field is skipped silently (same model as buttongroup).
        if (norm(f.option || '') === norm(want)) {
          try {
            const rl = page.locator(`[data-cfx="${f.idx}"]`);
            await rl.check({ force: true }).catch(async () => { await rl.click({ force: true }); });
            filled.push({ label: f.label, value: want });
          } catch (e) { unfilled.push({ label: f.label, reason: 'radio click failed' }); }
        }
      }
      continue;
    }

    // known text fields
    if (m && m.kind === 'text') {
      const v = answers[m.key];
      if (!v) { unfilled.push({ label: f.label, reason: 'no value for ' + m.key }); continue; }
      try {
        if (f.tag === 'select') {
          let ok = await setSelect(page, f.idx, v, f.options);
          // State dropdowns list full names ("New York"), not the abbreviation
          // ("NY") in answers.state — fall back to the full name.
          if (!ok && m.key === 'state' && answers.stateName) ok = await setSelect(page, f.idx, answers.stateName, f.options);
          if (ok) filled.push({ label: f.label, value: v });
          else unfilled.push({ label: f.label, reason: 'no matching option' });
        } else if (f.type === 'combobox') {
          // Location/city autocompletes need the geocoder-suggestion path
          // (typed text never exact-matches the fuller suggestion string).
          let ok = (m.key === 'location' || m.key === 'city')
            ? await setLocationCombobox(page, f.idx, v)
            : await setCombobox(page, f.idx, v);
          // degree/country dropdowns hold categories, not the literal value:
          // fall back to a pattern (degree string -> "Bachelor's").
          if (!ok && m.key === 'degree') ok = await setComboboxMatching(page, f.idx, /bachelor|^b\.?\s?s\.?\b|undergrad/i);
          if (!ok && m.key === 'country') ok = await setComboboxMatching(page, f.idx, /united states|^u\.?\s?s\.?a?\b/i);
          // State comboboxes hold full names; typing "NY" matches nothing.
          if (!ok && m.key === 'state' && answers.stateName) ok = await setCombobox(page, f.idx, answers.stateName);
          if (!ok && (m.key === 'location' || m.key === 'city')) ok = await setCombobox(page, f.idx, v);
          if (ok) filled.push({ label: f.label, value: (typeof ok === 'string' ? ok : v) });
          else unfilled.push({ label: f.label, reason: 'combobox failed' });
        } else {
          await setText(page, f.idx, v, typeDelay);
          filled.push({ label: f.label, value: String(v).slice(0, 60) });
        }
      } catch (e) { unfilled.push({ label: f.label, reason: e.message }); }
      continue;
    }

    // cover-letter textarea (matched by label, not in FIELD_MAP)
    if (f.tag === 'textarea' && /cover letter/i.test(f.label) && answers.coverLetterText) {
      await setText(page, f.idx, answers.coverLetterText);
      filled.push({ label: f.label, value: '[cover letter pasted]' });
      continue;
    }

    // checkboxes
    if (f.type === 'checkbox') {
      const cl = norm(f.label);
      const isConsent = /acknowledge|consent|agree|privacy|terms|policy|gdpr|certify|processed|self.?identif|demographic|voluntar/.test(cl);
      // Marketing/communication opt-ins must stay UNCHECKED even though they
      // often contain "agree".
      const isMarketing = /market|promotion|newsletter|updates|offers|subscribe|email me|text me|\bsms\b|receive (news|email|communication|text)/.test(cl);
      if (isConsent && !isMarketing) {
        // Privacy/terms/demographic consent. Greenhouse marks the demographic
        // self-ID consent box NON-required in the DOM but rejects the submit
        // without it ("accept the terms to proceed"), so check it regardless of
        // the required flag — not only when f.required.
        try { await page.locator(`[data-cfx="${f.idx}"]`).check(); filled.push({ label: f.label, value: 'checked (consent)' }); }
        catch (e) { unfilled.push({ label: f.label, reason: 'consent check failed: ' + e.message.split('\n')[0] }); }
      } else if (f.required && !isMarketing) {
        questions.push({ idx: f.idx, label: f.label, type: 'checkbox', required: true }); // substantive -> agent decides
      }
      // optional marketing/SMS checkboxes -> leave at default (unchecked)
      continue;
    }

    // unmatched custom choice question (react-select combobox / native select / radio)
    // -> surface for the agent to answer with an option value
    if (f.type === 'combobox' || f.type === 'radio' || f.type === 'buttongroup' || f.tag === 'select') {
      const type = f.type === 'combobox' ? 'combobox' : f.type === 'buttongroup' ? 'buttongroup' : (f.tag === 'select' ? 'select' : 'radio');
      let options = f.options || null;
      // react-select options are not in the static scan (they render on open).
      // Open the combobox once to capture them so the agent can pick a real
      // option instead of guessing. Done here (before the file upload sorted
      // last) so the data-cfx tag is still fresh.
      if (f.type === 'combobox' && (!options || !options.length)) {
        const probed = await readComboboxOptions(page, f.idx);
        if (probed.length) options = probed;
      }
      questions.push({ idx: f.idx, label: f.label, type, option: f.option || null, options, required: f.required });
      continue;
    }

    // auto-answer the two standard long-label questions every form asks, so a
    // batch run does not need per-job injection for them.
    const ql = norm(f.label);
    if (/salary|compensation|expected (base|pay|comp)|pay expectation|desired (salary|comp|pay)|comp expectation/.test(ql) && answers.salaryExpectation) {
      try {
        if (f.type === 'combobox') { /* rare: leave for agent */ }
        else { await setText(page, f.idx, answers.salaryExpectation, typeDelay); filled.push({ label: f.label, value: answers.salaryExpectation }); continue; }
      } catch (_) { /* fall through to question */ }
    }
    if (/how did you hear|how were you referred|referral source|how you heard|where did you (hear|find)/.test(ql)) {
      try {
        if (f.type === 'combobox') { if (await setComboboxMatching(page, f.idx, /company|career|website|other|job ?board/i)) { filled.push({ label: f.label, value: 'Company website' }); continue; } }
        else if (f.tag === 'select') { if (await setSelect(page, f.idx, 'Company', f.options) || await setSelect(page, f.idx, 'Other', f.options)) { filled.push({ label: f.label, value: 'Company website' }); continue; } }
        else { await setText(page, f.idx, answers.howHeard, typeDelay); filled.push({ label: f.label, value: answers.howHeard }); continue; }
      } catch (_) { /* fall through */ }
    }

    // unmatched free-text / long answer -> a custom question for the agent
    if (f.tag === 'textarea' || (f.tag === 'input' && f.type === 'text' && f.label && f.label.length > 24)) {
      questions.push({ idx: f.idx, label: f.label, type: 'text', required: f.required });
      continue;
    }

    if (f.required) unfilled.push({ label: f.label || `(${f.type})`, reason: 'required, unmatched' });
  }

  // Collapse the per-radio entries into ONE question per group-question, with
  // the available option texts, so the agent answers {label, option}.
  const grpQs = questions.filter((q) => q.type === 'radio' || q.type === 'buttongroup');
  if (grpQs.length) {
    const groups = {};
    for (const q of grpQs) {
      const k = q.type + '|' + norm(q.label);
      if (!groups[k]) groups[k] = { label: q.label, type: q.type, required: q.required, options: [] };
      if (q.option && !groups[k].options.includes(q.option)) groups[k].options.push(q.option);
    }
    questions = [...questions.filter((q) => q.type !== 'radio' && q.type !== 'buttongroup'), ...Object.values(groups)];
  }

  // Drop unfilled entries whose label was already filled or surfaced as a
  // question. react-select renders several controls per widget, so a leftover
  // hidden/duplicate control reports "unfilled" for a field that is actually
  // handled — noise, not a real gap.
  const handled = new Set([...filled, ...questions].map((x) => norm(x.label)));
  const unfilledClean = unfilled.filter((u) => !handled.has(norm(u.label)));
  return { filled, unfilled: unfilledClean, questions, resumeUploaded, totalFields: fields.length };
}

// Fill agent-written answers to custom questions.
// items: [{label, text}] for free-text, or [{label, option}] for a choice
// widget (react-select combobox / native select / radio / checkbox).
// Re-scans first because an earlier resume upload may have re-rendered the form
// and dropped the data-cfx tags; matches each answer to its field by label
// substring (stable across re-render).
async function fillQuestions(page, items) {
  const done = [];
  for (const item of items) {
    // Re-scan before EACH item: clicking a button-group / combobox re-renders
    // the React form and invalidates the data-cfx tags of later controls, so a
    // single up-front scan leaves stale tags and silent no-ops.
    const fields = await page.evaluate(SCAN_FN);
    const { label, text, option } = item;
    const want = norm(label).slice(0, 24);
    // nth: when several controls share the SAME label (e.g. two separate
    // "None/Not applicable" checkbox groups in an export-control attestation),
    // the agent disambiguates by occurrence index (0-based, DOM order).
    const nth = Number.isInteger(item.nth) ? item.nth : 0;
    let f;
    if (option != null) {
      const wo = norm(option);
      const isGrp = (x) => x.type === 'radio' || x.type === 'buttongroup';
      // a radio / button-group: match the GROUP question AND the specific option
      f = fields.find((x) => isGrp(x) && norm(x.label).includes(want) && norm(x.option || '') === wo)
        || fields.find((x) => isGrp(x) && norm(x.label).includes(want) && norm(x.option || '').includes(wo));
      if (!f) {
        // combobox / select / checkbox matched by label; for duplicate labels
        // pick the nth match in DOM order.
        const matches = fields.filter((x) => norm(x.label).includes(want) && (x.type === 'combobox' || x.tag === 'select' || x.type === 'checkbox'));
        f = matches[Math.min(nth, matches.length - 1)] || matches[0];
      }
    } else {
      const matches = fields.filter((x) => norm(x.label).includes(want) && (x.tag === 'textarea' || x.type === 'text' || x.type === 'number' || x.type === 'email' || x.type === 'tel' || x.type === 'url' || !x.type));
      f = matches[Math.min(nth, matches.length - 1)] || matches[0];
    }
    if (!f) { done.push({ label, ok: false, reason: 'field not found on re-scan' }); continue; }
    try {
      if (option != null) {
        // choice widget: pick the option the agent decided on
        let ok = false;
        if (f.type === 'combobox') ok = await setCombobox(page, f.idx, option);
        else if (f.tag === 'select') ok = await setSelect(page, f.idx, option, f.options);
        else if (f.type === 'checkbox') { await page.locator(`[data-cfx="${f.idx}"]`).check(); ok = true; }
        else if (f.type === 'radio') { await page.locator(`[data-cfx="${f.idx}"]`).check(); ok = true; }
        else if (f.type === 'buttongroup') { await page.locator(`[data-cfx="${f.idx}"]`).scrollIntoViewIfNeeded().catch(() => {}); await page.locator(`[data-cfx="${f.idx}"]`).click(); ok = true; }
        done.push({ label: f.label, ok, set: option });
      } else {
        // free-text: fill() not type() — a long answer typed char-by-char blows
        // the action timeout; fill is instant (paste-like) and React-safe.
        // Prose answers are ATS-normalized (strips hyphens/dashes per the
        // no-hyphens rule) UNLESS the answer is a bare URL/email/handle
        // (a profile slug etc).
        const loc = page.locator(`[data-cfx="${f.idx}"]`);
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.fill(isUrlish(text) ? text : normalize(text));
        done.push({ label: f.label, ok: true });
      }
    } catch (e) { done.push({ label: f.label, ok: false, reason: e.message.split('\n')[0] }); }
  }
  return done;
}

// Find and click an "Apply" button if the form is not already inline.
async function clickApplyIfPresent(page) {
  const formAlready = await page.locator('input[type="file"], textarea, input[name*="email" i], input[type="email"]').count();
  if (formAlready > 0) return false;
  // Try a few apply-verb controls (link or button); some boards render the
  // form only after this click. Excludes "apply on company site" type links.
  const btn = page.locator('a, button', { hasText: /^\s*(apply|apply now|apply for this (job|role|position)|i'?m interested|submit application)\s*$/i }).first();
  if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(1800); return true; }
  return false;
}

// Locate the submit button without clicking it. Robust across ATS skins: the
// submit control is at the BOTTOM and may be a <button> with no type=submit
// (Ashby) or an <input>. Match submit-verb text, exclude non-submit actions
// (upload / replace / save draft / cancel / back / autofill), and take the LAST
// visible match so we never grab a top-of-form "Upload"/"Autofill" button.
function submitLocator(page) {
  const sel = [
    'button[type="submit"]:not([disabled])',
    'input[type="submit"]:not([disabled])',
    'button:has-text("Submit Application")',
    'button:has-text("Submit application")',
    'button:has-text("Submit my application")',
    'button:has-text("Send Application")',
    'button:has-text("Send application")',
    'button:has-text("Submit")',
    '[role="button"]:has-text("Submit Application")',
    'button:has-text("Apply")[type="submit"]',
  ].join(', ');
  return page.locator(sel)
    .filter({ hasNotText: /upload|replace|remove|cancel|\bback\b|save draft|autofill|add (another|more)|^edit$|attach/i })
    .last();
}

module.exports = {
  detectAts, fillForm, fillQuestions, clickApplyIfPresent, submitLocator, SCAN_FN, dismissConsentOverlays,
};
