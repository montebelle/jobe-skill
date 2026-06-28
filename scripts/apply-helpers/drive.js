#!/usr/bin/env node
// Batch driver: run ONE application end-to-end and record it on success.
//   node scripts/apply-helpers/drive.js <slug> [answersFile.json] [--no-record]
// answersFile: JSON array of {label, option|text, nth?} injected once the form
// is filled. Omit for forms the harness fully auto-fills.
//
// Prints "RESULT: <phase>" plus details. Records (move folder + queue + tracker
// + follow-up) ONLY on phase==="submitted". Any other terminal phase
// (needs-security-code, submit-failed, submit-blocked-spam, blocked-location,
// needs-manual) is reported back for the agent to handle — never auto-recorded.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..');
const t = require(path.join(REPO, 'lib', 'tracker-writer.js'));

const slug = process.argv[2];
const answersFile = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
const noRecord = process.argv.includes('--no-record');
if (!slug) { console.error('usage: drive.js <slug> [answersFile] [--no-record]'); process.exit(2); }

const dir = path.join(REPO, 'signals', 'apply', slug);
fs.mkdirSync(dir, { recursive: true });
const statePath = path.join(dir, 'state.json');
const ctrlPath = path.join(dir, 'control.json');
const TODAY = new Date().toISOString().slice(0, 10);
const followUpDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } };
const writeCtrl = (o) => { try { fs.unlinkSync(ctrlPath); } catch {} fs.writeFileSync(ctrlPath, JSON.stringify(o)); };
async function waitPhase(phases, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const p = readState().phase; if (phases.includes(p)) return p; await sleep(4000); }
  return readState().phase || 'timeout';
}

(async () => {
  try { fs.unlinkSync(statePath); } catch {}
  try { fs.unlinkSync(ctrlPath); } catch {}
  const log = fs.openSync(path.join(dir, 'drive-run.log'), 'w');
  const child = spawn('node', [path.join(REPO, 'scripts', 'camoufox-apply.js'), 'run', slug], { detached: true, stdio: ['ignore', log, log] });
  child.unref();

  let ph = await waitPhase(['filled', 'blocked-location', 'needs-manual', 'error', 'submit-failed', 'needs-security-code'], 300000);
  if (ph !== 'filled') {
    // one recovery wait if a transient error fired during fill
    if (ph === 'error') { await sleep(4000); ph = await waitPhase(['filled', 'blocked-location', 'needs-manual', 'submit-failed', 'needs-security-code'], 60000); }
  }
  if (ph !== 'filled') { console.log('RESULT:', ph, '|', (readState().error || readState().reason || '').slice(0, 200)); process.exit(0); }

  const loadAnswers = () => (answersFile ? JSON.parse(fs.readFileSync(answersFile, 'utf8')) : []);
  const injectAnswers = async () => {
    const answers = loadAnswers();
    if (!answers.length) return;
    writeCtrl({ action: 'answers', answers });
    await sleep(Math.min(8000 + answers.length * 2500, 70000));
  };
  await injectAnswers();

  // Submit, riding the harness re-scan-on-rejection loop: a rejected submit
  // re-surfaces the now-required fields and returns to 'filled' with
  // submitRejected:true. Re-inject the (comprehensive) answer file to fill the
  // newly revealed fields, then re-submit — up to a few passes. The harness caps
  // its own rescans, so a form it can't satisfy ends in submit-failed.
  let result = 'filled';
  for (let pass = 0; pass < 7; pass++) {
    writeCtrl({ action: 'submit' });
    const end = Date.now() + 130000;
    result = 'timeout';
    while (Date.now() < end) {
      const st = readState();
      if (['submitted', 'submit-failed', 'submit-blocked-spam', 'needs-security-code'].includes(st.phase)) { result = st.phase; break; }
      if (st.phase === 'filled' && st.submitRejected) { result = 'rescan'; break; }
      await sleep(4000);
    }
    if (result !== 'rescan' && result !== 'error' && result !== 'timeout') break;
    if (result === 'rescan' && answersFile) { await injectAnswers(); continue; }
    if (result === 'error' || result === 'timeout') { await sleep(4000); continue; }
    break;
  }
  if (result === 'rescan') result = 'submit-failed';

  const s = readState();
  if (result === 'submitted') {
    if (!noRecord) {
      const q = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'apply-queue.json'), 'utf8'));
      const arr = Array.isArray(q) ? q : (q.queue || q.entries || []);
      const e = arr.find((x) => (x.slug || x.id) === slug) || {};
      try { t.moveReportFolder(slug, 'applied'); } catch (_) {}
      try { t.updateQueueEntry(slug, { applied: true, appliedDate: TODAY }); } catch (_) {}
      try {
        t.appendTrackerRow({ date: TODAY, company: e.company || '', role: e.role || e.title || '', score: e.score || '', status: 'Applied', reportDir: 'reports/applied/' + slug + '/', notes: 'Camoufox auto-apply; submitted ' + TODAY + '; EEO self-identified' });
      } catch (_) {}
      try {
        fs.appendFileSync(path.join(REPO, 'data', 'followups.md'), `\n## ${e.company || ''} — ${e.role || e.title || ''}\n- Applied: ${TODAY} (Camoufox auto-apply)\n- Next follow-up: ${followUpDate} (+7 days)\n- Status: Awaiting response\n`);
      } catch (_) {}
    }
    writeCtrl({ action: 'done' });
    console.log('RESULT: submitted | RECORDED |', (s.postSubmitExcerpt || '').replace(/\s+/g, ' ').slice(0, 110));
  } else {
    console.log('RESULT:', result, '|', (s.error || '').replace(/\s+/g, ' ').slice(0, 220));
  }
  process.exit(0);
})();
