#!/usr/bin/env node
'use strict';
/**
 * Apply gate classification. Run it BEFORE generating resumes, so effort goes
 * first to the postings the apply harness can actually complete.
 *
 * NOT GATED = the form filler (lib/apply/filler.js) can complete a guest
 *   application: Greenhouse, Lever, Ashby, and a careers site on the employer's
 *   own domain that fronts Greenhouse (its URL carries gh_jid), which applies
 *   through the Greenhouse embed form.
 * GATED = an account wall, a multi step wizard, or an ATS the filler does not
 *   support (Workday, iCIMS, SmartRecruiters, BambooHR and the like), plus any
 *   unknown careers site. A human finishes these (the `manual` report bucket).
 * Job board and aggregator links are UNRESOLVED: find the employer's own
 *   listing first. They cannot be applied to as they are.
 *
 *   node scripts/classify-gate.js [rankedFile] [minScore]
 *
 * rankedFile defaults to today's ranked-enriched.json in the active workspace.
 * minScore: the argument, else discovery.minScore in data/profile.json, else
 * no floor.
 */
const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('../lib/config');
const { loadProfile, discoveryFilters } = require('../lib/profile');
const { normalizeApplyUrl } = require('../lib/apply/url-normalize');

// Keep in step with what lib/apply/filler.js can complete. Order matters.
const GATED = [
  [/myworkdayjobs\.com/i, 'workday', 'account creation + multi-step wizard'],
  [/icims\.com/i, 'icims', 'multi-step + account'],
  [/smartrecruiters\.com/i, 'smartrecruiters', 'unsupported ATS'],
  [/bamboohr\.com/i, 'bamboohr', 'unsupported ATS'],
  [/workable\.com/i, 'workable', 'unsupported ATS'],
  [/recruitee\.com/i, 'recruitee', 'unsupported ATS'],
  [/personio\.(?:com|de)/i, 'personio', 'unsupported ATS'],
  [/breezy\.hr/i, 'breezy', 'unsupported ATS'],
  [/jobvite\.com/i, 'jobvite', 'unsupported ATS'],
  [/jobs\.gem\.com/i, 'gem', 'unsupported ATS'],
  [/applytojob\.com|jazzhr/i, 'jazzhr', 'unsupported ATS'],
  [/paylocity/i, 'paylocity', 'account/multi-step'],
  [/pageuppeople/i, 'pageup', 'account gateway'],
  [/eightfold/i, 'eightfold', 'unsupported ATS'],
  [/phenom/i, 'phenom', 'account/multi-step'],
  [/successfactors|rmkcdn/i, 'successfactors', 'sign-in required'],
];
const AGGREGATOR = /himalayas\.app|builtin\.com|indeed\.com|linkedin\.com|aijobs\.net|remotive\.com|remoteok\.com|weworkremotely\.com|jobicy\.com|themuse\.com|workingnomads\.com|arbeitnow\.com|adzuna\.|jooble\.org|findwork\.dev|hiring\.cafe|ziprecruiter\.com|glassdoor\.com|dice\.com|jaabz|bebee|tealhq/i;

function classify(url = '') {
  const u = String(url);
  const ghJid = (u.match(/[?&]gh_jid=(\d+)/) || [])[1];

  if (/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io/i.test(u)) {
    const board = (u.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?&]+)/i) || [])[1];
    return { gated: false, gateType: 'greenhouse', applyUrl: u, board };
  }
  if (/jobs\.lever\.co/i.test(u)) return { gated: false, gateType: 'lever', applyUrl: u };
  if (/jobs\.ashbyhq\.com/i.test(u)) return { gated: false, gateType: 'ashby', applyUrl: u, note: 'Ashby reCAPTCHA v3: run warm mode, one at a time' };

  // A careers site on the employer's own domain fronting Greenhouse (gh_jid
  // present) applies through the embed form. The board slug is NOT reliably the
  // host name: careers.example.com may front board "example", "exampleinc" or
  // something unrelated. A wrong slug 404s the embed and looks like a dead
  // listing, so callers MUST confirm with verifyGreenhouseBoard().
  if (ghJid) {
    const host = (u.match(/https?:\/\/([^/]+)/) || [])[1] || '';
    const bare = host.replace(/^(www|careers|jobs|search-careers)\./, '').split('.')[0];
    // lib/apply owns the host to board mapping (the user's wrapper map, else a
    // token derived from the domain); its answer is the first candidate.
    const embed = normalizeApplyUrl(u).url;
    const mapped = (embed.match(/embed\/job_app\?for=([^&]+)/) || [])[1];
    const candidates = [...new Set([mapped, bare, bare.replace(/careers$/, ''), bare.replace(/^with/, '')].filter(Boolean))];
    return { gated: false, gateType: 'greenhouse-embed', ghJid, boardCandidates: candidates,
      applyUrl: mapped ? embed : `https://job-boards.greenhouse.io/embed/job_app?for=${candidates[0]}&token=${ghJid}`,
      note: 'own domain fronting Greenhouse; VERIFY the board slug before applying' };
  }

  for (const [re, gateType, reason] of GATED) if (re.test(u)) return { gated: true, gateType, reason };
  if (AGGREGATOR.test(u)) {
    return { gated: true, gateType: 'aggregator-unresolved', reason: 'not an employer listing; resolve to the employer board first' };
  }
  return { gated: true, gateType: 'custom-site', reason: 'unknown careers site; check the apply flow by hand' };
}

/** Confirm which Greenhouse board slug actually serves this job id (the working slug, or null). */
async function verifyGreenhouseBoard(candidates, jobId) {
  for (const c of candidates || []) {
    for (const host of ['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io']) {
      try {
        const r = await fetch(`https://${host}/v1/boards/${c}/jobs/${jobId}`, { signal: AbortSignal.timeout(12000) });
        if (r.ok) return c;
      } catch { /* next */ }
    }
  }
  return null;
}

function main(argv) {
  const [fileArg, scoreArg] = argv.filter((a) => !a.startsWith('--'));
  const file = fileArg ? path.resolve(fileArg)
    : path.join(getProjectRoot(), 'signals', 'discovered', new Date().toISOString().slice(0, 10), 'ranked-enriched.json');
  if (!fs.existsSync(file)) { console.log(`no ranked list at ${file}; run /jobe find first.`); return; }
  const minScore = scoreArg !== undefined ? Number(scoreArg) : (discoveryFilters(loadProfile()).minScore ?? 0);
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sc = (p) => p.matchScore || p.quickScore || 0;
  const rows = list.filter((p) => sc(p) >= minScore).map((p) => ({ p, g: classify(p.canonicalUrl || p.url) }));
  const line = ({ p, g }) => `  ${String(sc(p)).padStart(3)} ${String(p.employerCorrection || p.company).slice(0, 24).padEnd(24)} ${g.gateType.padEnd(21)} ${String(p.title).slice(0, 44)}`;
  const byScore = (a, b) => sc(b.p) - sc(a.p);
  const open = rows.filter((r) => !r.g.gated).sort(byScore);
  const gated = rows.filter((r) => r.g.gated).sort(byScore);
  console.log(`NOT GATED (the harness can apply): ${open.length}`);
  open.forEach((r) => console.log(line(r)));
  console.log(`\nGATED (manual, or not supported by the filler): ${gated.length}`);
  const byType = {};
  gated.forEach(({ g }) => { byType[g.gateType] = (byType[g.gateType] || 0) + 1; });
  console.log(`  by type: ${JSON.stringify(byType)}`);
  gated.forEach((r) => console.log(line(r)));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { classify, verifyGreenhouseBoard };
