/**
 * lib/tailor.js - JD-grounded tailoring brief (the missing pipeline step).
 *
 * Real resume tailoring is NOT "pick pre-written bullets by keyword overlap" —
 * that produces resumes that do not speak to the role (a scheduling role led by
 * an unrelated bullet only because both contain the token "platform"). Real
 * tailoring is: read what the role asks for, map the candidate's REAL evidence
 * to each ask, LEAD with the highest-relevance evidence, and reframe it in the
 * JD's own language.
 *
 * Division of labor:
 *   - This module does the DETERMINISTIC half: extract the JD's requirements,
 *     keywords, stack, and archetype; then rank the candidate's evidence pool
 *     against them and surface coverage + gaps.
 *   - The REFRAMING is an LLM step (modes/evaluate.md Block E), because
 *     truthfully rewording real evidence into a JD's vocabulary cannot be done
 *     by string code without fabricating. The generator consumes this brief and
 *     writes the final resume: reorder experience by relevance, reframe each
 *     bullet into the JD's language, write a role-specific summary, pick
 *     relevant projects. Nothing is invented; everything traces to reference.md
 *     / the bullet library.
 *
 * API:
 *   analyzeJD(jdText, opts?)     -> { archetype, keywords[], responsibilities[], qualifications[], stack[] (the user's own tools the JD names), seniority (the level word in the title line, or null) }
 *                                   opts.exclude: strings (the hiring company's name) whose mentions are not counted as keywords
 *                                   opts.terms: how many keywords to return (default 25)
 *   rankEvidence(jd, library?)   -> { [role]: [{ id, text, matched[], score }] }  (ranked candidates)
 *   tailorBrief(jdText, baseline, opts?) -> { jd, evidenceByRole, coverage, gaps[], checklist[] }
 *   auditResume(resume, jdText?, opts?) -> { ok, issues[], warnings[], ... }   (pre-render quality gate)
 *   auditCoverLetter(text, opts?) -> { ok, issues[], skipped[] }               (substance bar; English only checks are skipped, not failed, for a letter in another language)
 *   scanCodenames(text, terms?)  -> distinct hits from the user's forbidden terms (fatal at render)
 *   scanPositioningVocab(text)   -> distinct internal-framework words (fatal at render)
 */

const fs = require('fs');
const path = require('path');
const { loadLibrary } = require('./bullet-select');
const { detectArchetype } = require('./archetypes');
const { getProjectRoot } = require('./config');
const { loadProfile } = require('./profile');
const { loadBaseline } = require('./tailoring');
const { foldText } = require('./normalize');

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Evidence fact index (scripts/evidence-index.js): the tools found in the
// user's own source trees, written to <workspace>/data/evidence-index.json. A
// tool proven there covers a JD requirement even when no bullet or skills entry
// names it, so a real skill never reads as a gap. The file is optional (most
// users have no source trees); absent means this step is skipped. The index
// only CREDITS evidence. It never strips a stated skill.
//
// TOOL_ALIAS maps the names people type to the canonical index key. It is a
// spelling normalization only (it decides nothing about what gets indexed) and
// is shared with scripts/evidence-index.js. An index may carry its own
// `aliases` object, merged over this one.
const TOOL_ALIAS = {
  pyspark: 'spark', databricks: 'spark', sklearn: 'scikit', 'scikit-learn': 'scikit',
  k8s: 'kubernetes', kubeflow: 'kubernetes', huggingface: 'transformers',
  'sentence-transformers': 'transformers', cv2: 'opencv', next: 'nextjs', 'next.js': 'nextjs',
  golang: 'go', dockerfile: 'docker', torch: 'pytorch',
};
// Cached per index path + mtime, so a workspace switch or an index rebuild in a
// long lived process never serves a stale or foreign index.
const _corpus = new Map();
function corpusTools(root = getProjectRoot()) {
  const file = path.join(root, 'data', 'evidence-index.json');
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = _corpus.get(file);
    if (hit && hit.mtime === mtime) return hit.value;
    const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
    const aliases = idx && idx.aliases && typeof idx.aliases === 'object' ? idx.aliases : {};
    const value = {
      tools: new Set(Object.keys((idx && idx.toolPresence) || {}).map((k) => k.toLowerCase())),
      aliases: { ...TOOL_ALIAS, ...aliases },
    };
    _corpus.set(file, { mtime, value });
    return value;
  } catch { return null; }
}

// JD vocabulary is NOT a hardcoded allowlist: analyzeJD() extracts the JD's
// own salient terms generically (see topTerms below) so the brief works for any
// field. `stack` (named tools and methods the JD mentions) comes from the
// USER's vocabulary: the keywords of their bullet library plus the tools in
// their evidence index. No tool table ships, so a posting in one field is
// never read against another field's tool names.
function userVocabulary() {
  const terms = new Set();
  let library = {};
  try { library = loadLibrary() || {}; } catch { /* no library yet */ }
  for (const role of Object.keys(library)) {
    if (!Array.isArray(library[role])) continue;
    for (const b of library[role]) for (const k of (b && b.keywords) || []) terms.add(String(k).toLowerCase().trim());
  }
  const corpus = corpusTools();
  if (corpus) for (const t of corpus.tools) terms.add(t);
  terms.delete('');
  return [...terms];
}

function decodeHtmlEntities(s) {
  const named = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === '#') {
      const hex = key[1] === 'x';
      const n = parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Out of range code points throw in fromCodePoint; treat them as unknown.
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : ' ';
  });
}

// Structure preserving: block boundaries and list items become line breaks so a
// JD delivered as HTML does not collapse into one paragraph (which silently
// produced empty responsibilities / qualifications).
function stripTags(s) {
  return decodeHtmlEntities(String(s || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n\u2022 ')
    .replace(/<\/(?:p|li|div|section|article|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
// Some feeds ship the markup entity encoded ("&lt;li&gt;..."), whole or inside
// real markup: decoding then leaves tags in the text, so those are stripped
// once more (otherwise "div", "span" and "class" rank as JD keywords).
function stripHtml(s) {
  const once = stripTags(s);
  return /<\/?(?:p|div|li|ul|ol|span|strong|em|b|br|h[1-6])\b[^<>]*>/i.test(once) ? stripTags(once) : once;
}
// Scripts written without spaces between words: a run between two punctuation
// marks is a clause, not a word.
const UNSPACED = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]';
const UNSPACED_RUN_RE = new RegExp(UNSPACED + '+', 'gu');
// Letters of any script: a word with an accented or non Latin letter stays one
// token. Text in an unspaced script yields no token (a whole clause would rank
// as one keyword and the JD coverage gates would demand it verbatim); a Latin
// word glued to it ("SAP" before a kana particle) is still read.
// ponytail: no JD keywords for unspaced scripts, so the coverage gates stay
// passive there; split the runs with WORD_SEGMENTER and add a stop list per
// language to rank them.
function tokenize(s) { return (s || '').toLowerCase().replace(UNSPACED_RUN_RE, ' ').match(/\p{L}[\p{L}\p{M}\p{N}+/.-]*/gu) || []; }

const STOPWORDS = new Set(['the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'at', 'as', 'by', 'is', 'are', 'be', 'will', 'you', 'your', 'our', 'we', 'they', 'this', 'that', 'from', 'have', 'has', 'it', 'its', 'their', 'them', 'who', 'what', 'how', 'all', 'any', 'can', 'may', 'must', 'should', 'work', 'team', 'role', 'job', 'years', 'year', 'experience', 'strong', 'ability', 'including', 'etc', 'able', 'using', 'use', 'used', 'help', 'make', 'new', 'across', 'within', 'into', 'more', 'most', 'well', 'also', 'per', 'via', 'required', 'preferred', 'requirements', 'qualifications', 'responsibilities',
  // General English function words (never a field's vocabulary). Contraction
  // stems are listed because the tokenizer splits at the apostrophe.
  // ponytail: English only; a posting in another language ranks its own
  // function words until a stop list for that language is added.
  'about', 'above', 'after', 'again', 'against', 'along', 'although', 'always', 'among', 'another', 'anyone', 'anything', 'around', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'cannot', 'could', 'did', 'does', 'doing', 'done', 'down', 'during', 'each', 'either', 'else', 'ever', 'every', 'few', 'further', 'had', 'having', 'her', 'here', 'him', 'his', 'however', 'just', 'let', 'like', 'many', 'might', 'much', 'nor', 'not', 'now', 'off', 'once', 'one', 'only', 'onto', 'other', 'others', 'ours', 'out', 'over', 'own', 'rather', 'same', 'shall', 'she', 'since', 'some', 'such', 'than', 'then', 'there', 'these', 'those', 'though', 'through', 'thus', 'too', 'under', 'until', 'upon', 'very', 'was', 'were', 'when', 'where', 'whether', 'which', 'while', 'whom', 'whose', 'why', 'without', 'would', 'yet', 'yours', 'e.g', 'i.e',
  'aren', 'couldn', 'didn', 'doesn', 'don', 'hasn', 'haven', 'isn', 'wasn', 'weren', 'wouldn']);

// Extract the JD's salient terms generically: frequency-ranked non-stopword
// unigrams + adjacent bigrams. No field assumptions -- a nursing JD yields
// nursing terms, an accounting JD yields accounting terms.
// A sentence final period (or a trailing slash or hyphen) is not part of the
// term, so "returns." and "returns" count as one; "c++", "node.js", and "ci/cd"
// keep their inner punctuation. `exclude` holds strings whose tokens must never
// rank (the hiring company's own name is not resume vocabulary).
function topTerms(low, n = 25, exclude = []) {
  const trim = (t) => t.replace(/[./-]+$/, '');
  const skip = new Set((Array.isArray(exclude) ? exclude : [exclude]).flatMap((x) => tokenize(String(x || ''))).map(trim));
  const toks = (low.replace(UNSPACED_RUN_RE, ' ').match(/\p{L}[\p{L}\p{M}\p{N}+/.#-]{2,}/gu) || [])
    .map(trim)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !skip.has(t));
  const counts = new Map();
  for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
  for (let i = 0; i + 1 < toks.length; i++) {
    const bg = `${toks[i]} ${toks[i + 1]}`;
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}

function analyzeJD(jdText, opts = {}) {
  const text = stripHtml(jdText);

  // Archetype is optional + user-defined (configs/archetypes.json); 'General' by
  // default, in which case evidence ranks purely by JD-term overlap.
  const archetype = detectArchetype(text).primary;

  // stack mentions
  // The user's words and the posting text are both folded (case, accents), so
  // a tool written with or without its accent still matches. A trademark sign
  // is dropped first: the fold spells it out as letters glued to the name. A
  // superscript or subscript digit (a footnote mark, "SAP\u00b9") folds to a
  // digit glued to the name, so the text is also read with those blanked.
  // A term stands as a whole word only where the script writes words apart
  // without attached particles (Latin, Cyrillic, Greek) and against digits;
  // next to any other script (kana after a tool name, a kanji compound, a
  // Hangul particle, an Arabic article) the neighbour does not block the match.
  const folded = foldText(text.replace(/[\u2122\u2120\u00ae\u00a9]/g, ' '));
  const hays = [folded, foldText(text.replace(/[\u2122\u2120\u00ae\u00a9\u00b2\u00b3\u00b9\u2070-\u209f]/g, ' '))];
  const EDGE = '[\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{N}]';
  const stack = userVocabulary().filter((t) => {
    const re = new RegExp('(?<!' + EDGE + ')' + escapeRe(foldText(t)) + '(?!' + EDGE + ')', 'u');
    return hays.some((h) => re.test(h));
  });

  // Pull responsibilities + qualifications as BOUNDED sections: each one stops
  // at the next section heading, so a requirement never leaks into the
  // responsibilities list (and the reverse). The heading lists mix generic JD
  // language from several conventions (US, UK, clinical, corporate); a list
  // entry that a posting does not use simply never matches.
  //
  // When the JD has line structure a heading must BE a heading: it sits at the
  // start of a short line that is not a sentence (after an optional bullet
  // glyph and at most three lead words, with no full stop after it, so "Main
  // duties and responsibilities" and "In this role, you will:" count), or it is
  // closed by a colon ("Requirements: an active license ..."; a line that ends
  // in the colon may be longer, "As a nurse on this unit, you will:"), or it
  // closes a line that is not a list item in brackets ("Skills and abilities
  // (required qualifications)").
  // A list item is never a heading with content after its colon: the bullet
  // "Physical requirements: able to lift 50 pounds" stays a duty.
  // A heading word inside a sentence ("gather requirements from carriers",
  // "inbound logistics") no longer starts or truncates a section.
  // A JD flattened to one line has no such structure and matches anywhere.
  // ponytail: a short list item with no full stop that contains a heading word
  // ("Meets all requirements") still reads as a heading; add a profile supplied heading
  // list if users report missed or false headings.
  const multiline = text.includes('\n');
  const heading = (re, lead) => new RegExp(lead + "(?:[ \\t\\u2022*#-]*(?:[\\w',&/]+[ \\t]+){0,3}(?:" + re.source + ')[^\\n.;:]{0,40}(?=\\n|$)'
    + "|(?![ \\t]*[\\u2022*-])[ \\t#]*(?:[\\w',&/]+[ \\t]+){0,3}(?:" + re.source + ')[^\\n.;:]{0,20}:'
    + '|[^\\n.;:]{0,80}(?:' + re.source + ')[^\\n.;:]{0,20}:[ \\t]*(?=\\n|$)'
    + '|(?![ \\t]*[\\u2022*-])[^\\n.;:]{0,80}(?:' + re.source + ')\\)[ \\t]*(?=\\n|$))', 'i');
  const readSection = (i, anchored, stopRe, span) => {
    if (i < 0) return { raw: '', at: 0, lines: [] };
    const whole = text.slice(i, i + span);
    const cut = (stopAt) => {
      let section = stopAt >= 0 ? whole.slice(0, stopAt + 1) : whole;
      // An anchored section opens with its own heading: drop the label only, so
      // content sharing the heading line ("Requirements: an active license") stays.
      if (anchored) section = section.replace(/^\n?[^\n:]*(?::|(?=\n|$))/, '');
      const at = i + (stopAt >= 0 ? stopAt + 1 : whole.length) - section.length;
      const lines = section
        .split(/\n+|\s+\u2022\s+|;\s+/)
        .map((line) => line.replace(/^[-\u2022]\s*/, '').trim())
        .filter((line) => line.length > 25 && line.length < 260)
        .filter((line) => !/^(key )?responsibilities|^minimum qualifications|^preferred qualifications|^qualifications|^requirements$/i.test(line))
        .slice(0, 12);
      // The text the keywords are counted over (raw) is bounded tighter than the
      // listed lines: a bulleted section ends where prose resumes, at the first
      // plain line with no bullet anywhere after it in the section (a
      // sub heading inside the list, "Nice to have", is followed by one and
      // stays). This keeps a trailing section whose heading is in no stop list
      // (schedule, pay range, why join us) out of the vocabulary. A section
      // found by mention only has no known start, so it is left whole.
      // The section ends at its LAST bullet, not at the first plain line: an
      // intro sentence between a sub heading and its bullets ("Candidates with
      // the following will stand out:") does not drop the bullets under it.
      // ponytail: a trailing unlisted section that has bullets of its own (a
      // bulleted perks list) is still counted; add its heading to the stop list.
      if (anchored) {
        const rows = section.split('\n');
        const last = rows.findLastIndex((r) => /^[-\u2022*]\s/.test(r));
        if (last >= 0) section = rows.slice(0, last + 1).join('\n');
      }
      return { raw: section, at, lines };
    };
    const found = cut(whole.slice(1).search(multiline ? heading(stopRe, '\\n') : stopRe));
    // A section found by mention only that yields no line when bounded by
    // heading lines (a blob with few line breaks) is cut at the next mention.
    return found.lines.length || anchored || !multiline ? found : cut(whole.slice(1).search(stopRe));
  };
  const grabSection = (startRe, stopRe, span = 3500) => {
    const at = multiline ? text.search(heading(startRe, '(?:^|\\n)')) : -1;
    const found = at >= 0 ? readSection(at, true, stopRe, span) : null;
    if (found && found.lines.length) return found;
    // No heading line, or a heading with no listable line under it (its label
    // shares a long sentence, or the list sits elsewhere): fall back to the
    // first mention (a prose JD).
    const byMention = readSection(text.search(startRe), false, stopRe, span);
    return byMention.lines.length || !found ? byMention : found;
  };
  const qualStart = /Minimum Qualifications|Preferred Qualifications|Qualifications|Requirements|Person Specification|(?:Essential|Desirable) Criteria|Education and Experience|Skills (?:and|&) (?:Abilities|Experience)|Who You Might Be|You may be a good fit|What You(?:.ll| Will) (?:Need|Bring)/i;
  const resp = grabSection(/What You.ll Do|Key Responsibilities|Responsibilities|Essential Functions|Duties|Accountabilities|Job Expectations|How You.ll Have Impact|You will/i, qualStart);
  const qual = grabSection(qualStart, /Representative Projects|About (?:the role|you|us)|Logistics|Compensation|Benefits|What We Offer|What You(?:.ll| Will)? Get|What.s in it for|How to Apply|How we're different/i);
  const responsibilities = resp.lines;
  const qualifications = qual.lines;

  // Salient JD terms, extracted generically (frequency of non-stopword unigrams
  // + bigrams) so the brief reflects ANY field's vocabulary. They are counted
  // over the responsibilities and qualifications sections only, so company
  // boilerplate (about us, benefits) never becomes required resume vocabulary;
  // a JD where either section is not recognized is counted whole (the duties
  // may sit under a heading this parser does not know).
  // Two sections that overlap in the text (one opened by a mention inside the
  // other) are counted once.
  const [s1, s2] = resp.at <= qual.at ? [resp, qual] : [qual, resp];
  const scoped = s2.at < s1.at + s1.raw.length
    ? text.slice(s1.at, Math.max(s1.at + s1.raw.length, s2.at + s2.raw.length))
    : s1.raw + '\n' + s2.raw;
  // The employer name is not resume vocabulary: its own mentions are not
  // counted, and a name word the JD never uses as an ordinary lowercase word
  // never ranks. A name word that is also the field term (the "tax" of a firm
  // named after tax work) is still counted wherever the JD uses it.
  // A mention is the name as written (same case) standing as whole words, and
  // not inside a dotted or slashed token, so a short name never eats part of
  // an ordinary word and a web address stays one token.
  // ponytail: a one word name that is also a field word ("Care") is dropped
  // where the JD capitalizes it (a sentence start reads as the name) and
  // counted where it is lowercase.
  const mention = (x) => new RegExp('(?<![\\p{L}\\p{N}]|[\\p{L}\\p{N}][./-])' + escapeRe(x).replace(/\s+/g, '\\s+') + '(?![\\p{L}\\p{N}]|[./-][\\p{L}\\p{N}])', 'gu');
  const excl = (Array.isArray(opts.exclude) ? opts.exclude : [opts.exclude]).map((x) => String(x || '').trim()).filter(Boolean);
  const names = excl.flatMap(tokenize).filter((tok) => !mention(tok).test(text));
  const counted = excl.reduce((t, x) => t.replace(mention(x), ' '), resp.raw.trim() && qual.raw.trim() ? scoped : text).toLowerCase();
  const keywords = topTerms(counted, opts.terms || 25, names);

  // Seniority hint: the level word in the title line (the first non empty line,
  // when the caller supplies one), reported as written. No ranking between the
  // words is implied (a "Staff Nurse" and a "Staff Engineer" sit at opposite
  // ends), and body text never decides it ("nursing staff" is not a level).
  const head = (text.match(/\S[^\n]*/) || [''])[0].slice(0, 120);
  const level = head.match(/\b(principal|staff|senior|sr|lead)\b/i);
  const seniority = level ? level[1].toLowerCase().replace(/^sr$/, 'senior') : null;

  return { archetype, keywords, responsibilities, qualifications, stack, seniority };
}

function rankEvidence(jd, library = loadLibrary()) {
  // Match the JD's salient terms against the bullet's TEXT and keywords (not
  // keywords alone) so on-topic evidence is not falsely flagged as a gap.
  const jdTerms = jd.keywords.map(k => k.term.toLowerCase());
  const out = {};
  for (const role of Object.keys(library)) {
    if (!Array.isArray(library[role])) continue;
    const ranked = library[role].map(b => {
      const hay = ((b.text || '') + ' ' + (b.keywords || []).join(' ')).toLowerCase();
      const matched = jdTerms.filter(t => hay.includes(t));
      const archetypeFit = (b.archetypes || []).some(a => jd.archetype.toLowerCase().includes(a.toLowerCase().split(' ')[0]));
      return { id: b.id, text: b.text, matched, score: matched.length + (archetypeFit ? 1.5 : 0) };
    }).sort((a, b) => b.score - a.score);
    out[role] = ranked;
  }
  return out;
}

function tailorBrief(jdText, baseline, opts = {}) {
  const jd = analyzeJD(jdText, opts);
  const evidenceByRole = rankEvidence(jd);
  // coverage: which top JD keywords have at least one matching evidence item
  const covered = new Set();
  for (const role of Object.keys(evidenceByRole)) {
    for (const e of evidenceByRole[role]) for (const m of e.matched) covered.add(m);
  }
  const topJdTerms = jd.keywords.slice(0, 12).map(k => k.term);
  // Also credit the candidate's SKILLS block: a skill listed in the baseline
  // covers a JD requirement even when no bullet names it. Stated skills are
  // authoritative, so one the candidate holds must never read as a gap.
  const skillsText = baseline && baseline.skills ? JSON.stringify(baseline.skills).toLowerCase() : '';
  if (skillsText) {
    for (const t of topJdTerms) {
      if (!covered.has(t) && skillsText.includes(t.toLowerCase())) covered.add(t);
    }
  }
  // Credit the evidence fact index when the workspace has one: a tool proven
  // in the user's own source trees covers the requirement even if neither a
  // bullet nor the skills block names it.
  const corpus = corpusTools();
  if (corpus) {
    for (const t of topJdTerms) {
      if (covered.has(t)) continue;
      const low = t.toLowerCase();
      const key = Object.prototype.hasOwnProperty.call(corpus.aliases, low) ? corpus.aliases[low] : low;
      if (corpus.tools.has(key)) covered.add(t);
    }
  }
  const gaps = topJdTerms.filter(t => !covered.has(t) && !t.split(/\s+/).some(p => covered.has(p)));

  return {
    jd, evidenceByRole,
    coverage: { topJdTerms, gaps },
    checklist: [
      'Lead each experience entry with the highest-relevance evidence for THIS jd.archetype, not the default order.',
      'Reframe every bullet into the JD vocabulary (jd.keywords) WITHOUT inventing — only reword real evidence from reference.md / the library.',
      'Write a role-specific summary that mirrors the JD responsibilities and leads with the strongest matching evidence.',
      'Pick selectedProjects that match the JD (the ones whose focus matches the role), not the default two.',
      'Name the honest gaps (coverage.gaps): position the adjacency; never claim experience the evidence does not support.',
    ],
  };
}

// Resume-quality gate: a non-fatal check run on the resume JSON BEFORE
// rendering. Every signal here is field-agnostic — it flags a resume that reads
// as generic or is structurally incomplete regardless of profession. Fix
// flagged issues and re-check; the gate never blocks a render (callers warn,
// they do not throw).
//
// Metric density counts ANY concrete number as quantification (a specific count
// or a team size is real specificity, not just 3+ digit values), excluding
// standalone years so date ranges do not inflate density.
const METRIC_RE = /\$[\d,]+|\b\d+(\.\d+)?%|\b\d+(\.\d+)?x\b|\bp\d{2}\b|\b\d+-bit\b|\b(?!(?:19|20)\d{2}\b)\d+(\.\d+)?\b/gi;
// "Anchor" = a concrete specific in the whyCompany text: a number, a quoted
// phrase, or a proper noun (a named program, unit, service, regulation,
// product, publication, or award), once the employer's own name is set aside.
// No noun list decides it, so a reason written in any profession passes when
// it names the real thing, and generic praise (which names nothing) does not.
// ponytail: a capitalized word in mid sentence or an all capitals acronym is
// read as a proper noun, so the candidate's own capitalized title or a month
// name also passes; a named thing that opens its sentence and stands alone is
// missed. Tighten only if filler gets through in practice.
// A count of years ("9 years of bedside experience") is the candidate's own
// tenure, never a fact about the employer, so it is not an anchor.
// ponytail: only the words of the name as given are set aside, so a longer
// form of the name in the text ("... Health" when the resume says less) reads
// as a proper noun; store the full employer name in resume.company.
// Letters are matched in any script (an accented or Cyrillic name is set aside
// and recognized like an ASCII one).
// ponytail: scripts without letter case (Arabic, Hebrew, Devanagari, CJK, Thai)
// have no proper noun signal, so the anchor there must be a figure or a quoted
// phrase (straight, curly, low, angle, or corner quotation marks); German
// capitalizes every noun, so the proper noun signal always fires there and the
// check is effectively off for German. Upgrade path: a per language signal.
function whyHasAnchor(why, company) {
  let s = String(why || '').replace(/\d+(?:\.\d+)?\+?[\s-]*(?:years?|yrs?)\b/gi, ' ');
  // The name words are letters and digits only, so they need no escaping.
  for (const word of String(company || '').match(/[\p{L}\p{M}\p{N}]+/gu) || []) {
    s = s.replace(new RegExp('(?<![\\p{L}\\p{M}\\p{N}])' + word + '(?![\\p{L}\\p{M}\\p{N}])', 'giu'), ' ');
  }
  return /\d/.test(s)
    || /["\u201c\u201e\u00ab\u300c\u300e](?=[^"\u201c\u201d\u201e\u00ab\u00bb\u300c\u300d\u300e\u300f]*[\p{L}\p{N}])[^"\u201c\u201d\u201e\u00ab\u00bb\u300c\u300d\u300e\u300f]{3,}["\u201d\u201c\u00bb\u300d\u300f]/u.test(s)
    || /(?<![\p{L}\p{N}_])\p{Lu}{2,}(?![\p{L}\p{N}_])/u.test(s)
    || /[\p{Ll}0-9,;:)]\s+["\u201c\u201e\u00ab]?\s?\p{Lu}\p{L}+/u.test(s);
}
const WHY_PLACEHOLDER_RE = /per-posting|goes here|placeholder|\bTODO\b|\bTBD\b/i;

// Tokens that read as AI-generated or code-inventory dumps in a resume bullet
// (2025-26 recruiter-survey evidence: over-quantification and generated-from-
// code trivia are documented anti-signals). Field-agnostic.
const AI_TELL_RE = /\babout \d|\broughly \d|lines? of (code|python|javascript)|\blocalhost:\d|arxiv|spearheaded|leveraged synerg|results-driven|passionate about driving/i;

// Words are runs of letters, marks and digits in any script. Scripts written
// without spaces between words are counted by the stdlib segmenter.
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });
function countWords(value) {
  let unspaced = 0;
  const rest = String(value || '').replace(UNSPACED_RUN_RE, (run) => {
    for (const seg of WORD_SEGMENTER.segment(run)) if (seg.isWordLike) unspaced++;
    return ' ';
  });
  return unspaced + (rest.match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_'+.-]*/gu) || []).length;
}

// Concatenate only the fields that actually render into the resume document, so
// the size/fill heuristic reflects what a reader sees (not internal metadata,
// the cover letter, or whyCompany).
function renderedResumeText(resume) {
  const parts = [resume.name];
  const contact = resume.contact || {};
  parts.push(contact.phone, contact.email, contact.location, contact.linkedin, contact.github, contact.website, resume.summary);
  for (const e of (resume.experience || [])) {
    parts.push(e.title, e.company, e.location, e.dates, e.subtitle);
    for (const b of (e.bullets || [])) parts.push(typeof b === 'string' ? b : b && b.text);
  }
  parts.push(resume.projectsHeading);
  for (const p of (resume.selectedProjects || [])) parts.push(p && p.name, p && p.summary);
  const skills = resume.skills || {};
  if (typeof skills === 'string') parts.push(skills);
  else if (Array.isArray(skills)) {
    for (const item of skills) parts.push(typeof item === 'string' ? item : item && (item.skills || item.values));
  } else {
    for (const [label, value] of Object.entries(skills)) parts.push(label, Array.isArray(value) ? value.join(', ') : value);
  }
  for (const e of (Array.isArray(resume.education) ? resume.education : [resume.education])) {
    if (e) parts.push(e.degree, e.school, e.location, e.dates);
  }
  for (const a of (Array.isArray(resume.awards) ? resume.awards : [])) parts.push(typeof a === 'string' ? a : null);
  return parts.filter(Boolean).join(' ');
}

function flattenSkillItems(skills) {
  const values = [];
  if (typeof skills === 'string') values.push(skills);
  else if (Array.isArray(skills)) {
    for (const item of skills) {
      if (typeof item === 'string') values.push(item.includes(':') ? item.split(':').slice(1).join(':') : item);
      else if (item) values.push(item.skills || item.values || '');
    }
  } else if (skills && typeof skills === 'object') values.push(...Object.values(skills));
  return values.flatMap((v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)))
    .map((v) => String(v).trim()).filter(Boolean);
}

function canonicalSkill(skill) {
  return String(skill || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/[.]+$/, '').replace(/\s+/g, ' ').trim();
}

// Loose company / degree comparison: case, accents, and punctuation never
// decide whether two strings name the same thing. Letters of every script are
// kept, so a name written in another alphabet still compares.
const fold = (v) => String(v || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const sameOrContains = (a, b) => { const x = fold(a); const y = fold(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };

// auditResume(resume [, jdText] [, opts])
//   jdText           optional — enables the JD-vocabulary coverage gate
//   opts.pageMetrics { pages, lastPageFill } — when the caller has rendered the
//                    DOCX and measured it, the page render is gated on instead
//                    of the coarse word-count backstop.
//   opts.baseline    the user's resume baseline; defaults to the workspace
//                    data/resume-baseline.json. Drives the attribution checks
//                    (current role leads, baseline degrees preserved). Pass
//                    null to skip them; a workspace with no baseline skips too.
//   opts.targetPages page target; defaults to output.targetPages in the user
//                    profile. null means no page target: page fill is never an
//                    issue and only an over-length warning remains.
//   opts.minFill     least fraction of the last page that must be covered (0-1).
//                    Defaults to the minFill the page measurement carries
//                    (check-docx-pages.js --min-fill), else 0.85.
function auditResume(resume, jdText, opts = {}) {
  const baseline = opts.baseline !== undefined ? opts.baseline : loadBaseline();
  const profileTarget = opts.targetPages !== undefined ? opts.targetPages : loadProfile().output.targetPages;
  const targetPages = Number.isFinite(profileTarget) && profileTarget > 0 ? profileTarget : null;
  const issues = [];
  const warnings = [];
  const bullets = (resume.experience || []).flatMap((e) => (e.bullets || []).map((b) => (typeof b === 'string' ? b : b.text)));
  const blob = (resume.summary || '') + ' ' + bullets.join(' ');

  // 0. Required sections. A hand-edited resume JSON can silently drop a
  // required section (e.g. education) and render skips the absent section
  // without complaint. Hard-gate the required sections so a structural omission
  // can never pass audit.
  if (!Array.isArray(resume.education) || !resume.education.length) issues.push('education section is missing — required; restore it from your baseline resume');
  else if (baseline && Array.isArray(baseline.education)) {
    // A tailored resume may reorder or trim, but a degree the baseline lists
    // must never be dropped or reworded into a different degree.
    const have = resume.education.map((e) => (e && e.degree) || '');
    const lost = baseline.education.map((e) => (e && e.degree) || '').filter((d) => fold(d) && !have.some((h) => fold(h).includes(fold(d))));
    if (lost.length) issues.push(`education present but a baseline degree is missing or altered: ${lost.join('; ')} — restore it from your baseline resume`);
  }
  if (!Array.isArray(resume.experience) || !resume.experience.length) issues.push('experience section is missing');
  if (!resume.contact || !resume.contact.email) issues.push('contact block is missing or incomplete');

  // 0c. Attribution shape: the role the baseline lists first (the current one)
  // must LEAD, and experience must stay reverse-chronological. Reordering
  // employers to chase a JD is the attribution failure this guards; relevance
  // is expressed by reordering BULLETS inside an entry, never the entries.
  const expEntries = Array.isArray(resume.experience) ? resume.experience : [];
  if (expEntries.length) {
    const lead = baseline && Array.isArray(baseline.experience) && baseline.experience[0] && baseline.experience[0].company;
    if (lead && !sameOrContains(expEntries[0].company, lead)) {
      issues.push(`experience[0] is "${expEntries[0].company || '(none)'}", but your baseline lists "${lead}" as the current role; it must lead (reverse-chronological attribution).`);
    }
    const startYear = (d) => { const m = String(d || '').match(/(?:19|20)\d{2}/); return m ? +m[0] : null; };
    const years = expEntries.map((e) => startYear(e.dates)).filter((y) => y != null);
    for (let i = 1; i < years.length; i++) {
      if (years[i] > years[i - 1]) { issues.push('experience is not reverse-chronological (a later entry starts after an earlier one) — order newest first.'); break; }
    }
  }

  // 0b. Rendered-size / fill. The RENDERED PAGE is authoritative, NOT word
  // count. Capping on words produced short, under-filled second pages. When the
  // caller has rendered the DOCX and measured it (scripts/check-docx-pages.js
  // --min-fill), it passes { pages, lastPageFill } and we gate on THAT against
  // the user's own page target (output.targetPages: 1 for a short history, 2
  // for a long one): exactly that many pages, last page substantially full.
  // With no target, page fill is never an issue; only an over-length warning
  // remains. Word count is only a COARSE backstop when no page measurement is
  // supplied.
  const wordCount = countWords(renderedResumeText(resume));
  const summaryWordCount = countWords(resume.summary);
  const projects = (resume.selectedProjects || []).filter((p) => p && String(p.summary || '').trim());
  const projectWordCounts = projects.map((p) => countWords(p.summary));
  const pm = opts.pageMetrics && Number.isFinite(opts.pageMetrics.pages) ? opts.pageMetrics : null;
  const minFill = [opts.minFill, pm && pm.minFill].find((v) => Number.isFinite(v) && v > 0 && v <= 1) ?? 0.85;
  if (pm && targetPages) {
    if (pm.pages > targetPages) issues.push(`resume renders ${pm.pages} pages — must be at most ${targetPages} (trim the least relevant content)`);
    else if (pm.pages < targetPages) issues.push(`resume renders only ${pm.pages} page${pm.pages === 1 ? '' : 's'} — your page target is ${targetPages}; add role-relevant, evidence-backed bullets/projects`);
    else if (Number.isFinite(pm.lastPageFill) && pm.lastPageFill < minFill) issues.push(`page ${targetPages} is only ${Math.round(pm.lastPageFill * 100)}% full — the half-empty last page defect; fill it with role-relevant, evidence-backed content, target at least ${Math.min(100, Math.round(minFill * 100) + 3)}%`);
  } else if (pm) {
    if (pm.pages > 2) warnings.push(`resume renders ${pm.pages} pages — most screens expect at most 2; set output.targetPages in data/profile.json to gate on a page target`);
  } else {
    // No render supplied — coarse backstop only; the page check is the real gate.
    if (wordCount < 560) warnings.push(`word count ${wordCount} is low — render and check page fill (the page render is authoritative, not this count)`);
    if (wordCount > 1000) warnings.push(`word count ${wordCount} is high — render and confirm it stays within ${targetPages || 2} pages (the page render is authoritative)`);
  }
  if (summaryWordCount < 35) issues.push(`summary is ${summaryWordCount} words — target 35-80 words with role, strongest evidence, and scope`);
  if (summaryWordCount > 80) issues.push(`summary is ${summaryWordCount} words — cap at 80 so the center of gravity remains scannable`);
  if (projects.length > 4) issues.push(`${projects.length} selected projects — keep at most 4 role-relevant projects`);
  projectWordCounts.forEach((n, i) => { if (n > 65) issues.push(`selected project ${i + 1} is ${n} words — cap each project summary at 65`); });

  const skillCounts = new Map();
  for (const skill of flattenSkillItems(resume.skills)) {
    const key = canonicalSkill(skill);
    if (key) skillCounts.set(key, (skillCounts.get(key) || 0) + 1);
  }
  const duplicateSkills = [...skillCounts.entries()].filter(([, n]) => n > 1);
  if (duplicateSkills.length) issues.push(`duplicate skills: ${duplicateSkills.map(([s, n]) => `${s} (${n}x)`).join(', ')}`);

  // 1. Metric density is a BAND, not a floor. Too thin reads unsubstantiated;
  // too dense (a number in every clause) is a documented AI/fabrication tell.
  // Prefer fewer, mechanism-attached numbers.
  const metrics = (blob.match(METRIC_RE) || []).length;
  const density = bullets.length ? metrics / bullets.length : 0;
  if (density < 0.8) issues.push(`metric density ${density.toFixed(1)}/bullet is below 0.8 — add concrete numbers, parameters, or outcome values to the strongest bullets`);
  if (density > 2.5) issues.push(`metric density ${density.toFixed(1)}/bullet exceeds 2.5 — over-quantification reads as AI-generated/fabricated; keep the 1-2 strongest numbers per bullet and drop trivia (line counts, intervals, TTLs)`);
  // match(), not test(): METRIC_RE is global, and test() would carry lastIndex
  // from one bullet into the next and miss its number.
  const metricBearing = bullets.filter((b) => (b.match(METRIC_RE) || []).length > 0).length;
  if (bullets.length >= 8 && metricBearing === bullets.length) issues.push('every single bullet carries a metric — vary it; 60-80% metric-bearing reads human, 100% reads generated');

  // 1b. AI-tell tokens + uniform openers
  for (const b of bullets) { if (AI_TELL_RE.test(b)) { issues.push(`bullet contains an AI/code-inventory tell (about-hedge, line count, localhost, arXiv citation, or buzzword): "${b.slice(0, 70)}..."`); break; } }
  const openers = bullets.map((b) => (b.trim().split(/\s+/)[0] || '').toLowerCase());
  const topOpener = [...new Set(openers)].map((o) => [o, openers.filter((x) => x === o).length]).sort((a, b) => b[1] - a[1])[0];
  if (topOpener && bullets.length >= 8 && topOpener[1] / bullets.length > 0.4) issues.push(`${topOpener[1]}/${bullets.length} bullets open with "${topOpener[0]}" — uniform openers are an AI tell; vary sentence structure`);

  // 1c. Bullet length: result-first scannability. Walls of text bury the
  // outcome; a couple of deep mechanism bullets are allowed.
  const words = (b) => b.trim().split(/\s+/).length;
  const over = bullets.filter((b) => words(b) > 65).length;
  if (bullets.length && over > 2) issues.push(`${over} bullets exceed 65 words — cap at ~45 (up to 2 deep mechanism bullets per resume may reach ~65); lead with the outcome, methods second`);

  // 2. whyCompany present + specific
  const why = (resume.whyCompany || '').trim();
  if (!why || why.length < 120 || WHY_PLACEHOLDER_RE.test(why)) issues.push('whyCompany is missing, a placeholder, or too short (need 120+ chars, role-specific)');
  else if (!String(resume.company || '').trim()) warnings.push('resume.company is not set, so the employer name could not be set aside in the whyCompany anchor check (the name alone may have passed as the anchor); set resume.company to the full employer name');
  if (why.length >= 120 && !WHY_PLACEHOLDER_RE.test(why) && !whyHasAnchor(why, resume.company)) issues.push('whyCompany lacks a specific anchor: name a program, unit, service, regulation, product, publication, or award of the employer, or give a figure (the employer name alone does not count)');

  // 3. JD-vocabulary coverage gate (optional: pass the JD text). The top JD
  // keywords must appear in the resume — recruiters keyword-SEARCH inside the
  // ATS and scan for the JD's own language. This is the mechanical presence
  // check; the generator's reframe step owns translation. Gates 4-6 below
  // harden it: a keyword that appears only in the summary or skills block (with
  // no backing bullet) reads as an unsubstantiated claim under a human screen.
  // All of these operate on JD-extracted keywords — no hardcoded field vocab.
  let jdCoverage = null;
  if (jdText) {
    const projText = (resume.selectedProjects || []).map((p) => (p.summary || '') + ' ' + (p.name || '')).join(' ');
    const skillsText = JSON.stringify(resume.skills || {});
    const kws = analyzeJD(jdText, { exclude: [resume.company].filter(Boolean) }).keywords.slice(0, 8).map((k) => String(k.term));
    const hay = (blob + ' ' + skillsText + ' ' + projText).toLowerCase();
    const missing = kws.filter((k) => !hay.includes(k.toLowerCase()));
    jdCoverage = { top: kws.length, covered: kws.length - missing.length, missing };
    if (kws.length && missing.length / kws.length > 0.4) issues.push(`JD-vocabulary coverage ${kws.length - missing.length}/${kws.length} — missing top JD terms: ${missing.join(', ')}. Reframe real evidence into the JD's own words (never invent).`);

    // 4. Requirement -> BULLET mapping: summaries and skills tokens do not
    // survive a human screen — each top JD term should be carried by at least
    // one BULLET or PROJECT line, not just a summary sentence. "Tailored summary
    // over an untailored body" is the most common tailoring failure.
    const bulletHay = (bullets.join(' ') + ' ' + projText).toLowerCase();
    const summaryOnly = kws.filter((k) => hay.includes(k.toLowerCase()) && !bulletHay.includes(k.toLowerCase()));
    if (kws.length && (missing.length + summaryOnly.length) / kws.length > 0.5) {
      issues.push(`requirement->bullet mapping weak: ${summaryOnly.length ? 'these top JD terms appear ONLY in summary/skills, no bullet carries them: ' + summaryOnly.join(', ') + '. ' : ''}Move real evidence into bullets — a summary claim without a backing bullet reads as unsubstantiated.`);
    }

    // 5. Center of gravity: the first things a reader sees — summary line 1 plus
    // the top role's first two bullets — must together carry at least 2 of the
    // JD's top-4 terms, so the resume leads with the evidence THIS role asks for
    // rather than the same lead bullets regardless of JD.
    const topRole = (resume.experience || [])[0] || {};
    const topBullets = (topRole.bullets || []).slice(0, 2).map((b) => (typeof b === 'string' ? b : b.text)).join(' ');
    const summaryLine1 = String(resume.summary || '').split(/(?<=\.)\s/)[0] || '';
    const cog = (topBullets + ' ' + summaryLine1).toLowerCase();
    const top4 = kws.slice(0, 4);
    const cogHits = top4.filter((k) => cog.includes(k.toLowerCase())).length;
    if (top4.length >= 3 && cogHits < 2) {
      issues.push(`center-of-gravity: the first things a reader sees (summary line 1 + top role's first 2 bullets) carry only ${cogHits}/4 of the JD's top terms (${top4.join(', ')}). Lead with the evidence this role asks for.`);
    }

    // 6. Unbacked skills tokens: a JD-relevant term that exists ONLY in the
    // skills block invites the "checked and found nothing" rejection. Either add
    // the backing bullet or remove the token.
    const skillsLower = skillsText.toLowerCase();
    const unbacked = kws.filter((k) => skillsLower.includes(k.toLowerCase()) && !bulletHay.includes(k.toLowerCase()) && !String(resume.summary || '').toLowerCase().includes(k.toLowerCase()));
    if (unbacked.length >= 2) {
      issues.push(`unbacked skills tokens (in skills block only, no bullet evidence): ${unbacked.join(', ')} — back them with a bullet or drop them.`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    metricDensity: +density.toFixed(2),
    bulletCount: bullets.length,
    wordCount,
    summaryWordCount,
    projectCount: projects.length,
    projectWordCounts,
    jdCoverage,
  };
}

// ── auditProse: evidence-grounded "AI-register" advisory for prose fields ──
// Runs on cover letters, summaries, and free-text application answers. Returns
// SOFT, advisory nudges ONLY — never a hard AI/human verdict and never a gate.
//
// WHY advisory-only (not a classifier): document-level AI detection is unreliable
// and false-positive-prone against legitimate and non-native-English human
// writing. Liang et al. 2023 (arXiv:2304.02819, Stanford) found GPT detectors
// misclassified non-native TOEFL essays as AI at a 61.22% false-positive rate;
// Krishna et al. NeurIPS 2023 (arXiv:2303.13408, DIPPER) collapsed DetectGPT
// from 70.3% to 4.6% via paraphrase; Sadasivan et al. (arXiv:2303.11156) argue
// reliable detection may be infeasible. So this NEVER emits a verdict.
//
// WHAT it flags: the ONE register signal with strong, replicated corpus support
// — a post-ChatGPT surge in specific "style/flourish" words (Kobak et al.,
// Science Advances 2025, doi:10.1126/sciadv.adt3813, excess-vocabulary over
// 15M+ PubMed abstracts; replicated on 1.29M arXiv abstracts by Geng & Trotta,
// Findings of ACL 2025, arXiv:2502.09606, and on 149k ASCE abstracts,
// arXiv:2602.03864). These are POPULATION frequency shifts (a lower bound), NOT
// per-document proof — hence advisory. And they are NON-STATIONARY (writers
// abandon flagged words within months of exposure), so the list is VERSIONED
// and must be refreshed; treat it as decaying, not canonical.
//
// WHAT it deliberately does NOT flag (no confirmed corpus backing in the
// evidence sweep; flagging them risks penalizing real human writing): em-dash
// overuse (measured NULL, arXiv:2602.03864), sentence uniformity / low
// burstiness (unconfirmed), rule-of-three/tricolon, participle-flourish tails,
// negative parallelism, aphorism formulas, and over-quantification / metric
// density. (lib/normalize.js still folds em-dashes, en-dashes, and smart quotes
// to ASCII at render, and strips plain hyphens only when the user sets
// output.stripHyphens. That is ATS legibility and a style choice, not an
// AI-tell claim.)
const AI_STYLE_MARKERS = {
  version: '2026-07',
  // Strong signal: high excess-ratio flourish words, rarely load-bearing in a
  // resume/cover letter. A hit here is worth surfacing.
  strong: [
    'delve', 'delves', 'delving', 'underscore', 'underscores', 'underscoring',
    'showcase', 'showcases', 'showcasing', 'intricate', 'intricacies',
    'meticulous', 'meticulously', 'pivotal', 'realm', 'tapestry', 'commendable',
    'testament', 'boasts', 'multifaceted', 'nuanced', 'firstly', 'crucially',
  ],
  // Weaker/common: rising markers that ALSO appear in legitimate writing
  // ('crucial'/'enhance'/'additionally' over-fire per Kobak's own caveat).
  // Reported only as an aggregate density signal, never per-word.
  rising: [
    'additionally', 'moreover', 'furthermore', 'notably', 'crucial', 'enhance',
    'enhances', 'enhancing', 'leverage', 'leverages', 'leveraging', 'foster',
    'fosters', 'fostering', 'garner', 'seamless', 'robust', 'holistic',
    'streamline', 'streamlined', 'utilize', 'utilizes', 'utilizing',
  ],
};

/**
 * @param {string} text  prose to check (cover letter, summary, free-text answer)
 * @param {object} [opts] { risingDensityPer100 = 2.0 } aggregate-warn threshold
 * @returns {{ok:boolean, advisory:string[], strongMarkers:string[],
 *            risingMarkers:string[], words:number, markerVersion:string}}
 *   ok is TRUE unless a STRONG marker is present. Advisory only — callers should
 *   surface (never block) on it, and NEVER report a verdict about authorship.
 */
function auditProse(text, opts = {}) {
  const s = String(text || '');
  const words = countWords(s);
  const toks = s.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
  const strongSet = new Set(AI_STYLE_MARKERS.strong);
  const risingSet = new Set(AI_STYLE_MARKERS.rising);
  const strongMarkers = [];
  const risingMarkers = [];
  for (const t of toks) {
    if (strongSet.has(t)) strongMarkers.push(t);
    else if (risingSet.has(t)) risingMarkers.push(t);
  }
  const advisory = [];
  if (strongMarkers.length) {
    advisory.push(`AI-register flourish word(s): ${[...new Set(strongMarkers)].join(', ')} — these surged post-ChatGPT (Kobak et al. 2025) and rarely earn their place in a resume/cover letter; consider a plainer word. Advisory, not a verdict.`);
  }
  // rising markers: only an AGGREGATE density warning (individually legitimate)
  const per100 = words ? (risingMarkers.length / words) * 100 : 0;
  const thresh = Number.isFinite(opts.risingDensityPer100) ? opts.risingDensityPer100 : 2.0;
  if (words >= 40 && per100 >= thresh) {
    advisory.push(`elevated density of common AI-favored connectors/verbs (${risingMarkers.length} in ${words} words: ${[...new Set(risingMarkers)].slice(0, 6).join(', ')}...) — each is fine alone, but the cluster reads generated. Advisory only; do not strip legitimate usage.`);
  }
  return {
    ok: strongMarkers.length === 0,
    advisory,
    strongMarkers: [...new Set(strongMarkers)],
    risingMarkers: [...new Set(risingMarkers)],
    words,
    markerVersion: AI_STYLE_MARKERS.version,
  };
}

// ── Forbidden-term gate (hard, fail closed) ─────────────────────────────────
// The worst render failure is a name that must never leave the building (an
// internal program codename, a client or brand the user may not disclose)
// reaching an employer's ATS. A scrubbed bullet library is not enough: bullets
// written fresh at generation time bypass that cleanup, so the RENDERED text is
// scanned and the render scripts treat any hit as fatal. Fail closed is
// intentional: a false positive costs one reword, a false negative leaks.
//
// The list is the USER's (output.forbiddenTerms in data/profile.json); nothing
// ships. An empty list never matches. Terms match whole, case insensitively,
// and a space inside a term also matches a hyphen ("north star" catches
// "north-star").
function termsRegex(terms) {
  const parts = [...new Set((Array.isArray(terms) ? terms : [])
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => escapeRe(t.trim()).replace(/[\s-]+/g, '[\\s-]+')))]
    .sort((a, b) => b.length - a.length);
  return parts.length ? new RegExp(`(?<![A-Za-z0-9])(?:${parts.join('|')})(?![A-Za-z0-9])`, 'gi') : null;
}

/**
 * @param {string} text     rendered text to scan
 * @param {string[]} [terms] forbidden terms; omitted = the user's
 *                           output.forbiddenTerms from data/profile.json
 * @returns {string[]} distinct hits as they appear in the text ([] when clean
 *                     or when the list is empty)
 */
function scanCodenames(text, terms) {
  const re = termsRegex(terms === undefined ? loadProfile().output.forbiddenTerms : terms);
  return re ? [...new Set(String(text || '').match(re) || [])] : [];
}

// ── Positioning-vocabulary ban (modes/_shared.md, modes/evaluate.md) ────────
// The internal reasoning frameworks the modes use to decide WHAT to include
// must NEVER appear as words in rendered output: same "never appear" class as
// forbidden terms, so fatal. This list is the product's own (it mirrors the
// frameworks the shipped modes name), not a user list. Only UNAMBIGUOUS jargon
// is listed; generic words with real uses (emergence, inversion, optionality)
// are deliberately excluded so a legitimate "matrix inversion" never blocks a
// render. Keep in step with the frameworks in modes/_shared.md.
const POSITIONING_JARGON = [
  'talebian', 'barbell', 'antifragile', 'antifragility', 'via negativa',
  'skin in the game', 'wysiati', 'fat tails', 'fat-tailed',
];
const JARGON_RE = termsRegex(POSITIONING_JARGON);

function scanPositioningVocab(text) {
  return [...new Set(String(text || '').match(JARGON_RE) || [])];
}

// ── Cover-letter substance bar (modes/_shared.md Cover Letter Quality Bar) ──
// Every letter must carry (1) a measurable outcome, (2) a leadership / scope
// signal, (3) a decision-grade outcome. Heuristic regexes: a floor that catches
// a generic letter in ANY profession, not proof of quality.
//   outcome    money, a percent, a multiplier, or a count of two or more digits
//              followed by a plural noun, with at most one word between
//              ("340 returns", "140 client returns", "22 people"). Tenure and
//              durations ("12 years", "30 days") do not count, and neither does
//              a bare number in passing ("June 12 about the opening").
//   leadership led / managed / mentored / supervised / trained / founded / a
//              team size / direct reports / hired / owned the X / owned end to
//              end / org wide
//   decision   a recommendation, priority, decision, adoption, approval, or a
//              change with an object ("changed the intake checklist")
// ponytail: a four digit count starting 19 or 20 ("2000 visits") reads as a
// year and is skipped; write it with a separator or add a second figure. The
// plural test is a suffix check, not a parser: an irregular plural outside the
// short list below is not credited; add it to the list when one comes up.
const CL_OUTCOME_RE = /[$\u20ac\u00a3]\s?\d|\b\d+(?:\.\d+)?\s?(?:%|percent\b|x\b)|\b(?!(?:19|20)\d{2}\b)\d[\d,]*\d\+?\s+(?!(?:years?|yrs?|months?|weeks?|days?|hours?|plus)\b)(?:[a-z]+\s+)?(?!(?:was|has|this|his|its|plus|across|always|less|years|yrs|months|weeks|days|hours)\b)(?:[a-z]{3,}s|people|children|staff)\b/i;
const CL_LEADERSHIP_RE = /\b(?:led|lead|manag(?:e|ed|es|ing)|mentor(?:ed|ing)?|supervis(?:e|ed|es|ing)|trained|found(?:er|ed)|org[ -]wide|team of|\d+[ -]person|direct reports?|hir(?:ed|ing)|owned (?:end to end|the))\b/i;
// Stems use \w* (not a trailing \b) so inflections match: a trailing \b after
// "reallocat" fails on "reallocated" (t|e is no word boundary). The same trap
// silently drops inflected words anywhere a stem is followed by \b.
const CL_DECISION_RE = /\b(?:reallocat\w*|prioriti[sz]\w*|recommend\w*|decision\w*|decided|underperform\w*|adopt\w*|approv\w*|chang(?:ed?|ing) (?:the|how|its|their|our)\b|trade[ -]?offs?\b)/i;

// The leadership and decision lists above are English, so a letter written in
// another language is held to the language neutral checks only (a figure, a
// minimum length, the employer named when the caller passes it); the English
// only checks are reported in `skipped`, never as issues.
// English is told apart the way scripts/render-cover-letter.js does it: the
// share of eight function words plus a share of "the" and "and", which no
// neighbouring language shares; under 30 words, by the absence of non ASCII
// letters.
// ponytail: a letter in another language is not checked for a leadership or a
// decision signal; add per language lists, or a language key in the profile.
// The lighter bar needs positive evidence of another language, not only a low
// count of "the" and "and": a terse English letter ("I am ... I have ... your
// ...") is still English. CL_ENGLISH_ONLY holds words no neighbouring language
// uses (so no "a", "in", "is", "am"), plus the capital pronoun "I".
// In that lighter bar the figure is money, a percent, or a number of two or
// more digits once dates, years, and phone numbers are set aside.
// ponytail: a two digit duration ("12 Jahre"), a clock time, or a five digit
// postal code still counts as the figure; a per language unit list would close it.
const CL_ENGLISH_ONLY = new Set(['the', 'and', 'you', 'your', 'have', 'would', 'this', 'that', 'with', 'from', 'are', 'been', 'which', 'our', 'their']);
function inAnotherLanguage(text) {
  if (readsAsEnglish(text)) return false;
  const words = String(text || '').match(/[\p{L}']+/gu) || [];
  return words.filter((w) => w === 'I' || (w !== 'i' && CL_ENGLISH_ONLY.has(w.toLowerCase()))).length < 0.04 * words.length;
}
const CL_NOT_A_FIGURE_RE = /(?<!\p{Nd})\p{Nd}{1,2}[.\/]\p{Nd}{1,2}(?:[.\/]\p{Nd}{2,4}|[.\/])?(?!\p{Nd})|(?:\+|(?<!\p{Nd})0)\p{Nd}[\p{Nd} ()\/-]{5,}\p{Nd}|\p{Nd}{6,}|(?<!\p{Nd})(?:19|20)\p{Nd}{2}(?!\p{Nd})/gu;
const CL_ENGLISH_WORDS = new Set(['the', 'and', 'to', 'my', 'with', 'for', 'that', 'of']);
function readsAsEnglish(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}']+/gu) || [];
  if (words.length < 30) return !/(?![\x00-\x7F])\p{L}/u.test(text);
  return words.filter((w) => CL_ENGLISH_WORDS.has(w)).length / words.length >= 0.04
    && words.filter((w) => w === 'the' || w === 'and').length >= Math.max(2, 0.025 * words.length);
}
// Well under the shortest documented letter form (250 words): a floor, not a target.
const CL_MIN_WORDS = 100;

// auditCoverLetter(text [, opts])
//   opts.company  the employer; used only for a letter that is not in English
//                 (the letter must name it). Omitted: that check is skipped.
function auditCoverLetter(text, opts = {}) {
  const s = String(text || '');
  if (!s.trim()) return { ok: false, issues: ['cover letter is empty'], skipped: [] };
  const issues = [];
  if (inAnotherLanguage(s)) {
    const skipped = ['leadership/scope signal (English word list; letter is not in English)', 'decision-grade outcome (English word list; letter is not in English)'];
    if (!CL_OUTCOME_RE.test(s) && !/\p{Nd}\s?[%\uff05\u20ac\u00a3$]/u.test(s) && !/\p{Nd}{2}/u.test(s.replace(CL_NOT_A_FIGURE_RE, ' '))) issues.push('no measurable outcome (need one specific money, percent, or scale figure)');
    const n = countWords(s);
    if (n < CL_MIN_WORDS) issues.push(`letter is ${n} words (need at least ${CL_MIN_WORDS})`);
    const nameWords = String(opts.company || '').match(/[\p{L}\p{M}\p{N}]{3,}/gu) || [];
    if (!nameWords.length) skipped.push('employer named (no employer name was passed)');
    // On a stem, so a name in a grammatical case ("v Klinike ...") still counts.
    else if (!nameWords.some((w) => fold(s).includes(fold(w).slice(0, Math.max(4, fold(w).length - 2))))) issues.push(`the employer (${opts.company}) is not named in the letter`);
    return { ok: issues.length === 0, issues, skipped };
  }
  if (!CL_OUTCOME_RE.test(s)) issues.push('no measurable outcome (need one specific money, percent, or scale figure)');
  if (!CL_LEADERSHIP_RE.test(s)) issues.push('no leadership/scope signal (a team led, people trained or supervised, something founded or owned)');
  if (!CL_DECISION_RE.test(s)) issues.push('no decision-grade outcome (a recommendation, priority, or change the work drove)');
  return { ok: issues.length === 0, issues, skipped: [] };
}

module.exports = {
  analyzeJD, rankEvidence, tailorBrief, stripHtml, decodeHtmlEntities,
  auditResume, auditProse, auditCoverLetter, readsAsEnglish, whyHasAnchor,
  countWords, renderedResumeText, flattenSkillItems, canonicalSkill,
  AI_STYLE_MARKERS, scanCodenames, scanPositioningVocab, POSITIONING_JARGON,
  corpusTools, TOOL_ALIAS,
};
