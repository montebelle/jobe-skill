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
  // before city / state / country / location: "Zip code (city of residence)"
  // asks for the code. "postal" alone is not a key: "Postal address" is a
  // street address, which stays a custom question.
  // Whole words only: "zip" also sits inside the name of a job board. A combined
  // "City, State, Zip" field leads with the city and is left to the city row.
  { re: /^(?!.*\bcity\b.*\bzip).*(?:\bzip(?:[ -]?code)?\b|\bpostal code\b|\bpost ?code\b)/, key: 'postalCode' },
  { keys: ['city'], key: 'city' },
  // country before state: "Country/Region" asks for the country
  { keys: ['country'], key: 'country' },
  { keys: ['state', 'province', 'region'], key: 'state' },
  // 'search' covers the Greenhouse city autocomplete, whose input is labeled
  // only with the placeholder "Search" (the container label "Location (City)"
  // belongs to the sibling text input). On an application form a bare "Search"
  // combobox is the location typeahead — route it through the location path.
  { keys: ['location', 'where are you', 'where do you live', 'search'], key: 'location' },
  { keys: ['salary', 'compensation', 'desired pay', 'pay expectation', 'expected', 'comp expectation'], key: 'salaryExpectation' },
];

// A question about what the user is paid now ("Current salary", "Last drawn
// salary"). There is no answer on file for it; it surfaces for the user.
const CURRENT_PAY_RE = /\b(current|currently|present|existing|most recent|last)\b[^?]{0,25}\b(salary|compensation|pay|package|remuneration)\b|\b(salary|compensation|pay|package|remuneration)\b[^?]{0,25}\b(current|currently|most recent|last)\b(?! range| band)/;
// A label that also asks for an expectation ("At present, what salary do you
// expect?") is the expected pay question.
const isCurrentPay = (l) => CURRENT_PAY_RE.test(l) && !/expect|desired|seeking|looking for|target|requirement|minimum (?:\w+ )?(?:salary|compensation|pay)/.test(l);

const EEO_HINTS = ['gender', 'race', 'ethnic', 'veteran', 'disability', 'hispanic', 'latino', 'sexual orientation', 'pronoun'];

// EEO self-identification matcher. The candidate's own choices live in the
// answer map's `eeoValues` (sourced from data/apply-profile.json) — the filler
// hardcodes NO demographics. A value is a string, or a list of acceptable
// phrasings of the same choice (forms word one choice several ways).
//
// Returns null when there is no value on file (the caller declines), else an
// ordered list of patterns. pickOption() walks the form's options once per
// pattern, so an earlier (stricter) pattern always beats a later one:
//   1. the whole option IS one of the user's phrasings;
//   2. the option CONTAINS a phrasing as a whole phrase. Never token by
//      token: a value of several words shares small words with unrelated
//      options, and a short value sits inside longer words;
//   3. for a "no" value only, the standard negative wording that forms render
//      in place of a bare "No" (CC-305 / VEVRAA).
// A value that itself reads as "decline" returns null, so the decline path
// picks the form's own decline option.
// ponytail: on a list of near duplicate options (one group split into several
// sub groups) pattern 2 takes the first in page order; the user lists the
// exact option text as a phrasing to pin it.
const GENDER_SYNONYMS = { male: 'man', man: 'male', female: 'woman', woman: 'female' };
// One spelling for comparison: straight apostrophes, single spaces.
const plain = (v) => String(v == null ? '' : v).replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
function eeoMatcher(sub, eeoValues) {
  const raw = eeoValues ? eeoValues[sub] : null;
  let phrases = (Array.isArray(raw) ? raw : [raw])
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map(plain)
    .filter(Boolean);
  if (!phrases.length) return null; // no value on file -> decline
  if (phrases.some((p) => DECLINE_RE.test(p))) return null; // the user's choice IS decline
  if (sub === 'gender') {
    // forms use either set of words for the same two choices
    phrases = phrases.concat(phrases.map((p) => GENDER_SYNONYMS[p.toLowerCase()]).filter(Boolean));
  }
  // Forms join the parts of one choice with "or", "and", "&", "/" or a bare
  // space. The connective is not part of the choice, so "X or Y" on file also
  // selects "X / Y" and the reverse. Every other word must still be there.
  const SEP = '[\\s/,&-]+(?:(?:or|and)[\\s/,&-]+)*';
  const alts = phrases.map((p) => p.split(/[\s/,&-]+/)
    .filter((w) => w && !/^(?:or|and)$/i.test(w))
    .map((w) => escapeRe(w).replace(/'/g, "'?")).join(SEP)).filter(Boolean);
  // A value of separators and connectives only names no choice. An empty
  // pattern would match every option, so decline instead.
  if (!alts.length) return null;
  const alt = alts.join('|');
  const isNo = phrases.some((p) => /^\s*no\b|\bnot a\b|\b(do not|don'?t) have\b/i.test(p));
  // An affirmative veteran / disability value must never land on the option
  // that states the opposite and merely contains the same words.
  const notNegated = (!isNo && (sub === 'veteran' || sub === 'disability'))
    ? "(?!.*(?<![a-z])(?:not|no|don'?t)(?![a-z]))" : '';
  const passes = [
    new RegExp(`^\\s*(?:${alt})\\s*$`, 'i'),
    new RegExp(`^${notNegated}.*(?<![a-z0-9])(?:${alt})(?![a-z0-9])`, 'i'),
  ];
  if (isNo) {
    const neg = {
      veteran: 'not a (protected )?veteran|^\\s*no\\b',
      disability: "(do ?n'?o?t|don'?t) have a disability|^\\s*no,? i (do ?n'?o?t|don'?t)|^\\s*no\\b",
      transgender: '^\\s*no\\b',
      hispanic: '^\\s*no\\b|^\\s*not hispanic',
    }[sub];
    if (neg) passes.push(new RegExp(neg, 'i'));
  }
  return passes;
}

// First option matching the earliest pattern. `passes` is one RegExp or an
// ordered list. Returns the index, or -1.
function pickIndex(options, passes) {
  const opts = (options || []).map(plain);
  for (const re of [].concat(passes || [])) {
    const i = opts.findIndex((o) => o && re.test(o));
    if (i >= 0) return i;
  }
  return -1;
}
function pickOption(options, passes) {
  const i = pickIndex(options, passes);
  return i >= 0 ? options[i] : null;
}

function eeoSubtype(label) {
  const l = norm(label);
  // "transgender" contains "gender": match it BEFORE the gender rule or it
  // would route to the gender matcher and fall back to decline.
  if (/transgender/.test(l)) return 'transgender';
  // Pronouns and orientation are their own questions even when the label also
  // says "gender"; each is answered only from its own value.
  if (/pronoun/.test(l)) return 'pronouns';
  if (/sexual orientation/.test(l)) return 'orientation';
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
  return null; // anything else -> decline
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
  // Citizenship / residency / eligibility gates, each answered from its OWN
  // apply-profile key (blank => surfaced, never guessed). One key cannot serve
  // them all: a permanent resident answers No to "are you a citizen" and Yes
  // to "are you a citizen or permanent resident". Checked before the generic
  // authorization rule so a bare citizenship question resolves here, not to
  // workAuthorized.
  if (/permanent resident|green ?card/.test(l)) return { kind: 'bool', key: 'citizenOrPermanentResident' };
  if (/domicile/.test(l)) return { kind: 'bool', key: 'domiciled' };
  if (/federal (employment|eligib)/.test(l)) return { kind: 'bool', key: 'federalEligible' };
  if (/citizen|\bnational of\b|u\.?s\.? national/.test(l)) return { kind: 'bool', key: 'citizen' };
  // Existence of a non-competition agreement. Only that fact is answered here;
  // whether to apply to a competing employer is the user's call (the mode
  // flags it).
  if (/non-?compete|non-?competition|restrictive covenant/.test(l)) return { kind: 'bool', key: 'nonCompete' };
  if (/authoriz|legally allowed|eligible to work|right to work|permitted to work/.test(l)) return { kind: 'bool', key: 'workAuthorized' };
  if (/\bsponsor|\bvisa\b/.test(l)) return { kind: 'bool', key: 'requireSponsorship' };
  // The keys mean "holds an active security clearance" and "willing to
  // relocate". Only that question is answered; any other phrasing (obtaining
  // one, a past or expired one, another kind of clearance, whether a move is
  // needed, relocation help) is a different question: surface it.
  if (/security clearance|\bclearance\b/.test(l)) return /security clearance|\b(secret|ts\/sci)\b/.test(l) && /\b(hold|have|possess)\b/.test(l) && !/obtain|eligib|\bable\b|ability|willing|undergo|denied|revoked|suspended|\bever\b|level|\btype\b|which|what|previous|former|\bpast\b|\bheld\b|\bhave you\b|expire|lapse|inactive|\bnot\b|\bpass\b|qualif|\bget\b|\bor\b(?! (?:higher|above))/.test(l) ? { kind: 'bool', key: 'clearance' } : null;
  if (/\brelocat/.test(l)) {
    // A compound question ("located in X or willing to relocate") is answered
    // Yes by someone who lives there and will not move: not this key.
    const s = (l.match(/[^.?]*\b(willing|open|prepared|consider|would you)\b[^.?]*\brelocat[^.?]*/) || [])[0];
    return s && !/\b(located|based|live|living)\b|\bresid|commut/.test(s) && !/unwilling|\bnot\b|\bor\b|assist|package|support|expens|reimburs|cost|bonus|stipend|without|provid|offer|\b(?:do|will|would) you (?:\w+ )?(?:requir|need)/.test(l) ? { kind: 'bool', key: 'relocation' } : null;
  }
  // Present pay is not the expected salary: never answered from it.
  if (isCurrentPay(l)) return null;
  // Only SHORT labels are contact-style fields. A long sentence that merely
  // CONTAINS "blog"/"email"/"degree" is a custom question (e.g. "...Engineering
  // blog..."), not a website/email/degree field — auto-filling it with contact
  // data would send wrong answers. Long labels fall through to question
  // detection instead.
  if (l.length <= 55) {
    for (const m of FIELD_MAP) if (m.re ? m.re.test(l) : m.keys.some((k) => l.includes(k))) return { kind: 'text', key: m.key };
  }
  return null;
}

// Bare URL / email / handle test — its hyphens are meaningful (e.g. a linkedin
// profile slug) so it must fill RAW. Anything else is prose and gets normalized
// (dashes, smart quotes and ATS-illegal characters folded; plain hyphens are
// removed only when the user's profile sets output.stripHyphens).
function isUrlish(s) {
  return /^\s*(https?:\/\/|mailto:|[\w.+-]+@|[\w.-]+\.(com|io|ai|dev|net|org|co)\b)/i.test(s) && !/\s\w+\s\w+\s/.test(s);
}

async function setText(page, idx, value, delay = 18) {
  const loc = page.locator(`[data-cfx="${idx}"]`);
  const v = String(value);
  await loc.click().catch(() => {}); // focus first: a real click before typing generates the pointer telemetry reCAPTCHA v3 grades
  await loc.fill('');
  await loc.type(isUrlish(v) ? v : normalize(v), { delay }); // keystroke cadence = human-ish; prose is ATS-normalized
}

async function setSelect(page, idx, wanted, options) {
  // choose the option whose text best matches `wanted`
  const w = norm(wanted);
  if (!w) return false; // a blank answer matches every option: never pick one
  // An empty placeholder option is contained in every string: skip it.
  const opt = (options || []).find((o) => norm(o) === w) || (options || []).find((o) => norm(o) && (norm(o).includes(w) || w.includes(norm(o))));
  if (!opt) return false;
  await page.locator(`[data-cfx="${idx}"]`).selectOption({ label: opt });
  return true;
}

// A word that turns an option into its opposite ("I am not authorized", "I
// have never held", "I don't"). Whole words only.
const NEGATION_RE = /(?<![a-z])(?:not|never|no|non[a-z]*|neither|nor|cannot|unable|un(?:authoriz|eligib)\w*|ineligible|[a-z]+n't|dont|cant|wont)(?![a-z])/i;

// The word an option must carry to state a Yes to each gate as a sentence.
// A bare "I am ..." / "I have ..." opening says nothing about the gate itself
// ("I have a visa that requires sponsorship" is no Yes to work authorization).
const GATE_WORD = {
  workAuthorized: /authoriz/i,
  citizen: /citizen/i,
  citizenOrPermanentResident: /citizen|resident/i,
  domiciled: /domicil|resid|\blive\b/i,
  federalEligible: /eligible/i,
  nonCompete: /agreement|covenant|subject|bound/i,
  clearance: /clearance/i,
  relocation: /relocat/i,
};
// A Yes that no longer holds ("I have held a clearance previously").
const LAPSED_RE = /\b(?:previous|former|past|inactive|expired|lapsed|no longer)/i;
// A compound that names the subject of the question is not a negation ("I am
// subject to a non-compete agreement", "a non-immigrant visa").
const negated = (o) => NEGATION_RE.test(o.replace(/\bnon-?\s?(?:compet\w*|solicit\w*|disclosure|immigrant)\b/gi, ''));
// What makes an option a qualified Yes rather than the Yes on file: "I am
// authorized to work on a visa", "Authorization required", "... with
// sponsorship". A "without sponsorship / restriction" clause qualifies nothing.
const GATE_NOT = {
  workAuthorized: /\b(?:visa|sponsor\w*|requir\w*|need\w*|h-?1b|opt|cpt|f-?1|student|temporar\w*|until|expir\w*)\b/i,
};

// Which option of a yes/no gate states the user's answer ('Yes' or 'No').
// Returns its index, or -1 when no option, or more than one, could be it: the
// caller then leaves the question for the glance. In order:
//   1. an option that is the bare word;
//   2. the one option that leads with it ("No, I will not"). Two options that
//      both lead with it ("Yes, a citizen" / "Yes, a permanent resident")
//      are a choice the answer on file does not make. A leading No is the
//      word followed by punctuation: "No restrictions, authorized for any
//      employer" is not a No (on the sponsorship question a leading "No
//      sponsorship needed" is). "No, but ..." is a qualified answer, not a No;
//   3. the one option that states it as a sentence: for a Yes, the option
//      that carries the gate's own word (GATE_WORD), no negation ("I am
//      not authorized to work" contains "authorized") and no qualifier
//      (GATE_NOT). The sponsorship
//      question reads the other way round: its Yes is "I require / need", its
//      No is "I do not / will never require / need", and never an option that
//      takes it back ("I do not need sponsorship now but will in the future").
// ponytail: English wordings and a fixed list of negation words; a wording
// outside them selects nothing and surfaces. A user who meets one answers at
// the glance, or writes the option text itself as the profile value.
function gateOption(options, key, want) {
  const opts = (options || []).map(plain);
  const yes = /^yes$/i.test(want);
  const sponsor = key === 'requireSponsorship';
  const hits = (ok) => opts.map((o, i) => (o && ok(o) ? i : -1)).filter((i) => i >= 0);
  const one = (list) => (list.length === 1 ? list[0] : -1);
  const bare = hits((o) => (yes ? /^yes\W*$/i : /^no\W*$/i).test(o));
  if (bare.length) return bare[0];
  const leadRe = yes ? /^yes\b/i : sponsor ? /^no\b/i : /^no\b(?=\W*$|\s*[,.;:-])/i;
  const lead = hits((o) => leadRe.test(o) && (yes || !/\bbut\b/i.test(o)));
  if (lead.length) return one(lead);
  if (sponsor) {
    return one(hits(yes
      ? (o) => /\b(requir|need)/i.test(o) && !negated(o) && !/\bwithout\b/i.test(o)
      : (o) => /do not (require|need)|not require|(will|would) (not|never) (require|need)|never (require|need)/i.test(o)
        && !/\bbut\b|\bwill\b(?! not| never)/i.test(o)));
  }
  const word = GATE_WORD[key];
  const not = GATE_NOT[key];
  return yes && word ? one(hits((o) => word.test(o) && !negated(o) && !LAPSED_RE.test(o)
    && !(not && not.test(o.replace(/\bwithout\b[^,.;]*/gi, ''))))) : -1;
}

// Native <select>: pick the first option whose text matches `regex` (one
// pattern, or an ordered list where an earlier pattern beats a later one).
// Used where a loose substring match is unsafe (a short value can appear
// inside a longer option label) — the caller passes anchored patterns.
async function setSelectMatching(page, idx, regex, options) {
  const opt = pickOption(options, regex);
  if (!opt) return false;
  await page.locator(`[data-cfx="${idx}"]`).selectOption({ label: opt });
  return true;
}

// Open a react-select once, read the actual rendered options, click the first
// whose text matches `regex` (one pattern, or an ordered list where an earlier
// pattern beats a later one). Robust to wording differences (EEO decline labels
// vary: "Decline To Self Identify" / "I don't wish to answer" / "Choose not to
// disclose"). One open + scan, no repeated guess-and-type. `regex` may also be
// a function (option texts) => index. Returns the text of the option clicked
// (truthy), or false.
async function setComboboxMatching(page, idx, regex) {
  const loc = page.locator(`[data-cfx="${idx}"]`);
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click();
    await page.waitForTimeout(350);
    const opts = page.locator(RS_OPTIONS);
    const n = await opts.count();
    const texts = [];
    for (let i = 0; i < n; i++) texts.push((await opts.nth(i).innerText().catch(() => '')) || '');
    const hit = typeof regex === 'function' ? regex(texts) : pickIndex(texts, regex);
    if (hit >= 0) { await opts.nth(hit).click(); return plain(texts[hit]) || true; }
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
// ("<city>, <region>, <country>") that setCombobox's exact/partial match can
// miss — leaving the REQUIRED location empty and failing the submit. Here we
// type the city, wait for the async list, prefer a suggestion containing the
// typed value, and otherwise commit the FIRST suggestion (for a location list
// the top geocoder hit is the right city). Scoped to location fills only, so
// the "never blind-pick" rule still holds for EEO/sponsorship comboboxes.
async function setLocationCombobox(page, idx, wanted) {
  const loc = page.locator(`[data-cfx="${idx}"]`);
  // Type ONLY the city for a clean geocoder query, and match on the option's
  // CITY SEGMENT exactly — a loose substring match picks a different place
  // whose name is contained in the typed city ("Kansas" for "Kansas City").
  // The city is the first comma segment of both the typed value and each
  // suggestion.
  const city = String(wanted).split(',')[0].trim();
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
        if (starts < 0 && seg0.startsWith(cw)) starts = i;  // e.g. "<city> City"
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

const HOW_HEARD_RE = /how did you hear|how were you referred|referral source|how you heard|where did you (hear|find)/;

// The country fallback pattern below is only correct for this one country, so
// it is used only when the user's own country value says so.
const US_ALIAS_RE = /^\s*(u\.?\s?s\.?(\s?a\.?)?|united states( of america)?)\s*$/i;

// Degree dropdowns list LEVELS, not the user's literal degree string. Map the
// user's degree (or their optional `degreeLevel`) to the level it names and
// return a pattern for that level's option; null when no level is recognized.
// Highest level first, so a string naming two degrees resolves to the higher.
// ponytail: English degree names and common abbreviations only; add rows (or
// set degreeLevel to the exact option text) for other naming systems.
const DEGREE_LEVELS = [
  [/doctor|\bph\.?\s?d\b|\bd\.?phil\b|\b(ed|pharm)\.?\s?d\b|\bj\.?d\b|\bm\.?d\b|\bdnp\b/i, /doctor|ph\.?\s?d|\bj\.?d\b|\bm\.?d\b/i],
  [/master|\bm\.?s\.?c?\b|\bm\.?a\b|\bm\.?b\.?a\b|\bm\.?eng\b|\bm\.?ed\b|\bmsn\b|\bmph\b|\bll\.?m\b/i, /master|^\s*m\.?\s?[sa]\.?\b|\bmba\b/i],
  [/bachelor|\bb\.?s\.?c?\b|\bb\.?a\b|\bb\.?eng\b|\bb\.?b\.?a\b|\bbsn\b|\bll\.?b\b|undergrad/i, /bachelor|^\s*b\.?\s?[sa]\.?\b|undergrad/i],
  [/associate|\ba\.?a\.?s?\b|\badn\b/i, /associate/i],
  [/high school|\bged\b|secondary/i, /high school|\bged\b|secondary/i],
];
function degreeLevelRe(degree) {
  const d = String(degree || '');
  const row = d.trim() ? DEGREE_LEVELS.find(([is]) => is.test(d)) : null;
  return row ? row[1] : null;
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
  // Resume target FIRST: a Resume/CV-labelled input that is not the "autofill
  // from resume" helper.
  const resumeTarget = fileInputs.find((f) => /resume|cv\b/.test(txt(f)) && !/autofill/.test(txt(f)))
    || fileInputs.find((f) => !/autofill|cover/.test(txt(f)))
    || fileInputs[0];
  // Cover input: a /cover/-labelled input, else (Greenhouse S3 file inputs carry
  // NO accessible "cover" text — the "Cover Letter" heading is a plain div, not a
  // <label>) the remaining non-resume, non-autofill file input — but ONLY if it
  // is not explicitly some OTHER upload (portfolio / work sample / transcript),
  // which would silently receive the cover-letter file. Without the fallback a
  // required Cover Letter is left empty and the submit fails.
  const OTHER_UPLOAD_RE = /portfolio|work sample|writing sample|transcript|additional (file|document)|other (file|document)/;
  const coverInput = fileInputs.find((f) => /cover/.test(txt(f)))
    || fileInputs.find((f) => f !== resumeTarget && !/autofill/.test(txt(f)) && !OTHER_UPLOAD_RE.test(txt(f)));

  const degreeRe = degreeLevelRe(answers.degreeLevel || answers.degree);
  const countryRe = US_ALIAS_RE.test(answers.country || '') ? /united states|^u\.?\s?s\.?a?\b/i : null;

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
    // or radios). Default: DECLINE. Only when the user opted in
    // (answers.eeoSelfIdentify) is a question answered, and only from the
    // user's own value for that question; a question with no value on file is
    // declined.
    if (m && m.kind === 'eeo') {
      const sub = answers.eeoSelfIdentify === true ? eeoSubtype(f.label) : null;
      const re = sub ? eeoMatcher(sub, answers.eeoValues) : null;
      if (re) {
        const shown = [].concat(answers.eeoValues[sub])[0] || 'self-identified';
        let ok = false;
        if (f.tag === 'select') {
          ok = await setSelectMatching(page, f.idx, re, f.options);
        } else if (f.type === 'combobox') {
          ok = await setComboboxMatching(page, f.idx, re);
        } else if (f.type === 'radio') {
          // each option is its own scanned field; click only the one the
          // matcher picks out of the WHOLE group (so a stricter pattern on a
          // sibling option beats a looser pattern on this one)
          const group = fields.filter((x) => x.type === 'radio' && norm(x.label) === norm(f.label)).map((x) => x.option || '');
          if (f.option && pickOption(group, re) === f.option) {
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

    // yes/no gates. Answered ONLY from a value the user has on file. A blank
    // value is never guessed (no default Yes, no first option): the field falls
    // through to the question paths below and surfaces at the glance, with its
    // options, for the agent to answer. The same goes for a gate rendered as a
    // widget this branch cannot set (free text, checkbox).
    const boolWant = (m && m.kind === 'bool' && typeof answers[m.key] === 'string') ? answers[m.key].trim() : '';
    const boolWidget = f.tag === 'select' || f.type === 'combobox' || f.type === 'buttongroup' || f.type === 'radio';
    if (boolWant && boolWidget) {
      const want = boolWant;
      // A Yes / No is matched by gateOption (options are often phrases, and a
      // phrase can contain the words of its opposite). Any other value is the
      // user's own wording: match it as written.
      const yn = /^(yes|no)$/i.test(want);
      // The glance reports the option that was actually selected, so a wrong
      // pick is visible before anything is submitted.
      let handled = true;
      if (f.tag === 'select') {
        const opt = yn ? (f.options || [])[gateOption(f.options, m.key, want)] : null;
        let ok = false;
        if (opt) { await page.locator(`[data-cfx="${f.idx}"]`).selectOption({ label: opt }); ok = true; }
        else if (!yn) ok = await setSelect(page, f.idx, want, f.options);
        if (ok) filled.push({ label: f.label, value: opt || want });
        else unfilled.push({ label: f.label, reason: 'no matching option for ' + m.key });
      } else if (f.type === 'combobox') {
        const ok = yn ? await setComboboxMatching(page, f.idx, (texts) => gateOption(texts, m.key, want)) : await setCombobox(page, f.idx, want);
        if (ok) filled.push({ label: f.label, value: typeof ok === 'string' ? ok : want });
        else unfilled.push({ label: f.label, reason: 'combobox set failed' });
      } else {
        // radio / button group: each option is its own scanned field. Pick the
        // option out of the WHOLE group, then click only that one; the other
        // options' fields are skipped. When no option in the group matches the
        // value on file, the group is not answerable from it: fall through so
        // it surfaces as a question instead of being skipped unreported.
        const group = fields.filter((x) => x.type === f.type && norm(x.label) === norm(f.label)).map((x) => x.option || '');
        const gi = yn ? gateOption(group, m.key, want) : group.findIndex((o) => norm(o) === norm(want));
        const pick = gi >= 0 ? group[gi] : null;
        if (pick == null) handled = false;
        else if ((f.option || '') === pick) {
          try {
            const rl = page.locator(`[data-cfx="${f.idx}"]`);
            if (f.type === 'radio') await rl.check({ force: true }).catch(async () => { await rl.click({ force: true }); });
            else await rl.click();
            filled.push({ label: f.label, value: pick });
          } catch (e) { unfilled.push({ label: f.label, reason: (f.type === 'radio' ? 'radio' : 'button') + ' click failed' }); }
        }
      }
      if (handled) continue;
    }

    // known text fields
    if (m && m.kind === 'text') {
      const v = answers[m.key];
      if (!v) { unfilled.push({ label: f.label, reason: 'no value for ' + m.key }); continue; }
      try {
        if (f.tag === 'select') {
          let ok = await setSelect(page, f.idx, v, f.options);
          // State dropdowns list full names, not the region code held in
          // answers.state — fall back to the full name.
          if (!ok && m.key === 'state' && answers.stateName) ok = await setSelect(page, f.idx, answers.stateName, f.options);
          if (!ok && m.key === 'degree' && degreeRe) ok = await setSelectMatching(page, f.idx, degreeRe, f.options);
          if (!ok && m.key === 'country' && countryRe) ok = await setSelectMatching(page, f.idx, countryRe, f.options);
          if (ok) filled.push({ label: f.label, value: v });
          else unfilled.push({ label: f.label, reason: 'no matching option' });
        } else if (f.type === 'combobox') {
          // Location/city autocompletes need the geocoder-suggestion path
          // (typed text never exact-matches the fuller suggestion string).
          let ok = (m.key === 'location' || m.key === 'city')
            ? await setLocationCombobox(page, f.idx, v)
            : await setCombobox(page, f.idx, v);
          // degree/country dropdowns hold categories, not the literal value:
          // fall back to a pattern derived from the USER'S value (their degree
          // string -> its level; their country -> its common aliases). No
          // recognizable level / no alias -> no fallback, the field surfaces
          // as unfilled.
          if (!ok && m.key === 'degree' && degreeRe) ok = await setComboboxMatching(page, f.idx, degreeRe);
          if (!ok && m.key === 'country' && countryRe) ok = await setComboboxMatching(page, f.idx, countryRe);
          // State comboboxes hold full names; typing the region code matches nothing.
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
      // "How did you hear about us" as a dropdown: try the user's own answer.
      // No option matches -> surface it like any other choice question (the
      // harness does not pick a source the user never named).
      if (answers.howHeard && HOW_HEARD_RE.test(norm(f.label)) && (f.tag === 'select' || f.type === 'combobox')) {
        const ok = f.tag === 'select' ? await setSelect(page, f.idx, answers.howHeard, f.options) : await setCombobox(page, f.idx, answers.howHeard);
        if (ok) { filled.push({ label: f.label, value: answers.howHeard }); continue; }
      }
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
    // batch run does not need per-job injection for them. Only free-text
    // fields reach this point (choice widgets were handled above).
    const ql = norm(f.label);
    if (isCurrentPay(ql)) { questions.push({ idx: f.idx, label: f.label, type: 'text', required: f.required }); continue; }
    if (/salary|compensation|expected (base|pay|comp)|pay expectation|desired (salary|comp|pay)|comp expectation/.test(ql) && answers.salaryExpectation) {
      try { await setText(page, f.idx, answers.salaryExpectation, typeDelay); filled.push({ label: f.label, value: answers.salaryExpectation }); continue; }
      catch (_) { /* fall through to question */ }
    }
    if (HOW_HEARD_RE.test(ql) && answers.howHeard) {
      try { await setText(page, f.idx, answers.howHeard, typeDelay); filled.push({ label: f.label, value: answers.howHeard }); continue; }
      catch (_) { /* fall through */ }
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
  for (const item of (Array.isArray(items) ? items : [])) {
    // Re-scan before EACH item: clicking a button-group / combobox re-renders
    // the React form and invalidates the data-cfx tags of later controls, so a
    // single up-front scan leaves stale tags and silent no-ops.
    const fields = await page.evaluate(SCAN_FN);
    const { label, text } = item;
    let { option } = item;
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
      // Tolerance: the agent sent `text` but the field by that label is actually
      // a choice widget (react-select combobox / native select / radio / checkbox)
      // with no free-text twin, e.g. a "How did you hear about us" dropdown or
      // a yes/no eligibility question. Route `text` as the chosen option so the
      // widget gets filled instead of silently missing at submit.
      if (!f && text != null) {
        const wt = norm(text);
        f = fields.find((x) => (x.type === 'radio' || x.type === 'buttongroup') && norm(x.label).includes(want) && (norm(x.option || '') === wt || norm(x.option || '').includes(wt)));
        if (!f) {
          const choice = fields.filter((x) => norm(x.label).includes(want) && (x.type === 'combobox' || x.tag === 'select' || x.type === 'checkbox'));
          f = choice[Math.min(nth, choice.length - 1)];
        }
        if (f) option = text; // hand off to the choice-apply path below
      }
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
        // Prose answers are ATS-normalized (see isUrlish) UNLESS the answer is
        // a bare URL/email/handle (a profile slug etc).
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
  // pure helpers, exported for tests
  matchField, eeoSubtype, eeoMatcher, pickOption, gateOption, degreeLevelRe, US_ALIAS_RE,
};
