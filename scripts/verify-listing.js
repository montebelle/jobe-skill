#!/usr/bin/env node
'use strict';
/**
 * Full listing verification. Run it BEFORE generating any resume.
 *
 * For each posting, go to the EMPLOYER'S OWN ATS (its JSON API where one
 * exists) and confirm, from that source only:
 *   stillOpen   the requisition is live (not 404, closed, or removed)
 *   titleSim    how closely the board's title matches the recorded one
 *               (catches a link that points at a different requisition)
 *   location    exactly as the ATS states it
 *   remote      remote | hybrid | onsite | unknown, derived from the ATS record
 *               (remoteGuess: true marks a verdict that is only a coarse guess)
 *   postedDate  the ORIGINAL publish date, for the recency rule
 *   comp        when the ATS publishes it
 *
 * Anything the script cannot reach (a page rendered by script, a careers host
 * whose Greenhouse board cannot be confirmed) is reported status='needs-agent':
 * never assumed good, and never assumed gone.
 *
 * The result is attached to each posting as `verify`; scripts/final-list.js
 * reads it.
 *
 *   node scripts/verify-listing.js <listFile> [--write]
 */
const fs = require('fs');
const path = require('path');
const { classify, verifyGreenhouseBoard } = require('./classify-gate');
const { classifyRemote, parseLocation, HOME_BASED } = require('../lib/posting');

const UA = 'jobe-discovery/1.0 (personal job search)';
// Careers pages with no API often answer only a browser style agent. A plain
// one, with no identity in it.
const PAGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { err: res.status };
    return { data: await res.json() };
  } catch (e) { return { err: e.message }; }
}
async function getText(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': PAGE_UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { status: res.status, body: await res.text(), finalUrl: res.url };
  } catch (e) { return { status: 0, body: '', err: e.message }; }
}

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function titleSim(a, b) {
  const A = new Set(norm(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(norm(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / new Set([...A, ...B]).size;
}

// Precedence: what the ATS states in its location and workplace fields (a
// remote field yields to a hybrid phrase in the title or JD), then
// a hybrid statement in the title or JD (the bare word, or the pipeline's
// phrase patterns: "3 days per week in the office"), then the ATS boolean
// flag, then the phrase level reading of the title and JD the pipeline itself
// uses (lib/posting.js classifyRemote), and last the bare location. The flag
// is a weak signal: boards set "remote" on roles whose description says hybrid.
//
// Returns [mode, guess]. guess is true when the verdict rests on a coarse
// reading and not on a statement of the work mode:
//   - a location that offers both modes ("City (Hybrid); Country (Remote)"),
//   - a bare "hybrid" in the JD that the phrase patterns do not confirm (it
//     also matches "hybrid cloud"),
//   - a loose remote phrase in the JD ("remote first", "work from home") that
//     the pipeline's reading does not confirm (the employer may be remote
//     first while this role sits in a named city),
//   - a location that names no work mode and no city ("United States"),
//   - a JD onsite phrase ("must be located in") with no city in the location.
// scripts/final-list.js lets a guess stand only when the pipeline has no
// label of its own for the posting.
// ponytail: the bare word still decides for a posting with no pipeline label,
// unless the pipeline's own reading of the title and JD says remote. It errs
// toward NOT calling a role remote, and it still outranks the ATS flag.
function remoteVerdict(loc, extraText = '', flag = null, workplaceType = null, title = '') {
  const s = `${loc || ''} ${workplaceType || ''}`.toLowerCase();
  if (/hybrid/.test(s)) return ['hybrid', /\bremote\b/.test(s)];
  if (workplaceType && /^on-?site$/i.test(workplaceType)) return ['onsite', false];
  const text = String(extraText);
  // Home based wording counts when it is the whole place (parseLocation's rule).
  // A remote field yields to a hybrid statement in the title or JD, as the
  // pipeline's own label does.
  if (/\bremote\b/.test(s) || (HOME_BASED.test(loc || '') && parseLocation(loc).remote === 'remote')) return [classifyRemote('remote', title, text) === 'hybrid' ? 'hybrid' : 'remote', false];
  const t = text.toLowerCase();
  const viaJd = classifyRemote(parseLocation(loc || '').remote, title, text);
  if (/\bhybrid\b/.test(t)) {
    // viaJd 'remote' means no hybrid phrase matched: the word is unconfirmed
    // ("hybrid cloud") and the JD states the role is remote.
    if (viaJd === 'remote') return ['remote', true];
    return ['hybrid', classifyRemote('unknown', title, text) !== 'hybrid'];
  }
  // The flag yields to a hybrid statement in the title or JD.
  if (flag === true) return [classifyRemote('unknown', title, text) === 'hybrid' ? 'hybrid' : 'remote', false];
  if (/fully remote|100% remote|remote[- ](first|us|usa)|work from home|telecommute|remote u\.?s/.test(t)) return ['remote', viaJd !== 'remote'];
  if (flag === false) return ['onsite', false];
  // A JD onsite phrase ("must be located in <country>") beside a location that
  // names no city is a guess: remote roles state a residence rule the same way.
  if (viaJd !== 'unknown') return [viaJd, viaJd === 'onsite' && parseLocation(loc || '').remote !== 'onsite'];
  if (loc && !/remote/i.test(loc)) return ['onsite', true];
  return ['unknown', false];
}
const remoteFrom = (...args) => remoteVerdict(...args)[0];
// The two fields verify() attaches: remote, and remoteGuess only when true.
const remoteFields = (...args) => {
  const [remote, guess] = remoteVerdict(...args);
  return guess ? { remote, remoteGuess: true } : { remote };
};

function parseUrl(u = '') {
  const s = String(u);
  let m;
  if ((m = s.match(/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([^/?]+)\/jobs\/(\d+)/i))) return { ats: 'greenhouse', board: m[1], id: m[2], eu: /\.eu\./i.test(s) };
  if ((m = s.match(/greenhouse\.io\/embed\/job_app\?for=([^&]+)&token=(\d+)/i))) return { ats: 'greenhouse', board: m[1], id: m[2], eu: /\.eu\./i.test(s) };
  if ((m = s.match(/[?&]gh_jid=(\d+)/i))) {
    // An employer domain fronting Greenhouse: the board is only a guess until
    // verify() confirms which candidate serves this job id.
    const g = classify(s);
    const candidates = g.boardCandidates || [g.board].filter(Boolean);
    return { ats: 'greenhouse', board: candidates[0] || null, id: m[1], guessed: true, candidates };
  }
  if ((m = s.match(/jobs\.ashbyhq\.com\/([^/?]+)\/([0-9a-f-]{36})/i))) return { ats: 'ashby', board: decodeURIComponent(m[1]), id: m[2] };
  if ((m = s.match(/jobs\.lever\.co\/([^/?]+)\/([0-9a-f-]{36})/i))) return { ats: 'lever', board: m[1], id: m[2] };
  return { ats: 'other' };
}

// Only a 404 or 410 from the listing's own API says it is gone. A timeout, a
// rate limit or a server error says nothing about it.
const unreached = (out, ats, err) => (err === 404 || err === 410
  ? { ...out, status: 'gone', stillOpen: false, detail: `${ats} ${err}` }
  : { ...out, status: 'needs-agent', stillOpen: null, detail: `${ats} ${err}` });

async function verify(p) {
  const url = p.canonicalUrl || p.url || '';
  const k = parseUrl(url);
  const out = { ats: k.ats, board: k.board || null };

  if (k.ats === 'greenhouse') {
    if (k.guessed) {
      // A 404 on a guessed board says nothing about the listing. Confirm the
      // board first; when none of the candidates serves the job, hand it over.
      const board = await verifyGreenhouseBoard(k.candidates, k.id);
      if (!board) return { ...out, status: 'needs-agent', stillOpen: null, detail: `greenhouse board not confirmed for this careers host (tried: ${k.candidates.join(', ') || 'none'})` };
      k.board = out.board = board;
    }
    const api = (host) => getJson(`https://${host}/v1/boards/${k.board}/jobs/${k.id}`);
    // The second host counts only when it answers; its failure never replaces
    // the first host's verdict.
    let r = await api(k.eu ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io');
    if (r.err) { const alt = await api(k.eu ? 'boards-api.greenhouse.io' : 'boards-api.eu.greenhouse.io'); if (!alt.err) r = alt; }
    if (r.err) return unreached(out, 'greenhouse', r.err);
    const j = r.data;
    const content = String(j.content || '').replace(/<[^>]*>/g, ' ');
    const loc = (j.location && j.location.name) || '';
    // first_published is the original date; updated_at is restamped on every
    // edit or repost and would make an old requisition look fresh.
    return { ...out, status: 'ok', stillOpen: true, atsTitle: j.title, titleSim: +titleSim(p.title, j.title).toFixed(2),
      location: loc, ...remoteFields(loc, content, null, null, j.title), postedDate: j.first_published || j.updated_at || null,
      comp: (j.pay_input_ranges && j.pay_input_ranges[0]) ? `${j.pay_input_ranges[0].min_cents / 100}-${j.pay_input_ranges[0].max_cents / 100}` : null };
  }

  if (k.ats === 'ashby') {
    const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(k.board)}?includeCompensation=true`);
    if (r.err) return { ...out, status: 'board-error', stillOpen: null, detail: `ashby ${r.err}` };
    const job = (r.data.jobs || []).find((x) => String(x.jobUrl || '').includes(k.id));
    if (!job) return { ...out, status: 'gone', stillOpen: false, detail: 'not on ashby board' };
    // workplaceType (Remote | Hybrid | OnSite) is the stated mode; isRemote is
    // also true on the board's Hybrid jobs, so it only decides when the field is absent.
    return { ...out, status: 'ok', stillOpen: true, atsTitle: job.title, titleSim: +titleSim(p.title, job.title).toFixed(2),
      location: job.location || '', ...remoteFields(job.location, job.descriptionPlain || '', job.isRemote, job.workplaceType, job.title),
      postedDate: job.publishedAt || null, comp: job.compensation && job.compensation.compensationTierSummary || null };
  }

  if (k.ats === 'lever') {
    const r = await getJson(`https://api.lever.co/v0/postings/${k.board}/${k.id}`);
    if (r.err) return unreached(out, 'lever', r.err);
    const j = r.data;
    const loc = (j.categories && j.categories.location) || '';
    return { ...out, status: 'ok', stillOpen: true, atsTitle: j.text, titleSim: +titleSim(p.title, j.text).toFixed(2),
      location: loc, ...remoteFields(loc, j.descriptionPlain || '', null, j.workplaceType, j.text),
      postedDate: j.createdAt ? new Date(j.createdAt).toISOString() : null, comp: null };
  }

  // No JSON API: fetch the page and look for hard "gone" signals only.
  const t = await getText(url);
  if (t.status === 404 || t.status === 410) return { ...out, status: 'gone', stillOpen: false, detail: `http ${t.status}` };
  if (t.status === 0 || t.status === 429 || t.status >= 500) return { ...out, status: 'needs-agent', stillOpen: null, detail: t.err || `http ${t.status}` };
  const text = t.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const closed = /no longer accepting|position (has been )?(filled|closed)|job (is )?no longer available|posting has expired/i.test(text);
  if (closed) return { ...out, status: 'closed', stillOpen: false, detail: 'page says closed/filled' };
  if (text.length < 1500) return { ...out, status: 'needs-agent', stillOpen: null, detail: `thin page (${text.length}b), likely rendered by script` };
  return { ...out, status: 'ok-page', stillOpen: true, ...remoteFields('', text), detail: 'verified from rendered page text' };
}

async function main(argv) {
  const fileArg = argv.find((a) => !a.startsWith('--'));
  if (!fileArg) { console.error('usage: node scripts/verify-listing.js <listFile> [--write]'); process.exit(1); }
  const file = path.resolve(fileArg);
  // The hint goes to stderr: stdout is the JSON result array.
  if (!fs.existsSync(file)) { console.error(`no list at ${file}; run /jobe find first.`); return; }
  const write = argv.includes('--write');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const v = await verify(p);
    Object.assign(p, { verify: v });
    results.push({ company: p.employerCorrection || p.company, title: p.title, score: p.matchScore || p.quickScore, ...v });
    if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${list.length}`);
    await sleep(700);
  }
  if (write) fs.writeFileSync(file, JSON.stringify(list, null, 1));
  process.stdout.write(JSON.stringify(results, null, 1) + '\n');
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });

module.exports = { parseUrl, remoteFrom, remoteVerdict, titleSim, verify };
