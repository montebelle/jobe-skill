#!/usr/bin/env node
// Camoufox auto-apply orchestrator (single long-lived process per job).
//
// The browser stays alive for the whole job so form state survives the
// pre-submit glance and the post-submit email-confirmation step. The agent
// drives sequencing through a tiny file channel:
//
//   signals/apply/<slug>/state.json    <- written by THIS script (phase + report)
//   signals/apply/<slug>/control.json  <- written by the AGENT to advance:
//        {action:"submit"}            click submit
//        {action:"skip"}              abandon this job
//        {action:"answers", answers:{<idx>:"text"}}  fill custom Q's, re-screenshot
//        {action:"confirm", link:"https://..."}      open an email confirm link
//
// Usage:
//   node scripts/camoufox-apply.js run <slug> [--url U] [--headless] [--no-submit]
//   node scripts/camoufox-apply.js confirm <url> [--headless]   # open a link standalone

const fs = require('fs');
const path = require('path');
const { launchCamoufox, newStealthPage } = require('../lib/apply/camoufox');
const { buildAnswers } = require('../lib/apply/answers');
const { detectAts, fillForm, fillQuestions, clickApplyIfPresent, submitLocator } = require('../lib/apply/filler');
const { normalizeApplyUrl } = require('../lib/apply/url-normalize');
const { parseLocation, classifyRemote, classifyUs } = require('../lib/posting');

const REPO = path.resolve(__dirname, '..');

// playwright-core (newer than the Camoufox Juggler build) crashes while parsing
// a page-level JS error event whose shape it does not expect — it reads
// `pageError.location.url` when `location` is undefined. That error originates
// in the target site's own JS (common on heavy career pages), is unrelated to
// our fill, and would otherwise kill the process. Swallow ONLY that exact
// library bug; let every other uncaught exception fail loudly.
process.on('uncaughtException', (err) => {
  if (err && /reading 'url'/.test(err.message || '')) {
    console.error('[cfx] ignored benign page JS error (playwright/Camoufox version skew)');
    return;
  }
  console.error('[cfx] uncaughtException:', err);
  process.exit(1);
});

function args() {
  const a = process.argv.slice(2);
  const cmd = a[0];
  const positional = a.slice(1).filter((x) => !x.startsWith('--'));
  const flags = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--url') flags.url = a[++i];
    else if (a[i] === '--headless') flags.headless = true;
    else if (a[i] === '--no-submit') flags.noSubmit = true;
    else if (a[i] === '--allow-onsite') flags.allowOnsite = true;
    else if (a[i] === '--salary') flags.salary = a[++i];
  }
  return { cmd, positional, flags };
}

function ctrlDir(slug) {
  const d = path.join(REPO, 'signals', 'apply', slug);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writeState(slug, state) {
  fs.writeFileSync(path.join(ctrlDir(slug), 'state.json'), JSON.stringify(state, null, 2));
}
function readControl(slug) {
  const f = path.join(ctrlDir(slug), 'control.json');
  if (!fs.existsSync(f)) return null;
  try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); fs.unlinkSync(f); return c; } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForControl(slug, { timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const c = readControl(slug);
    if (c) return c;
    await sleep(1000);
  }
  return { action: 'timeout' };
}

function urlForSlug(slug) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'apply-queue.json'), 'utf8'));
    const e = q.find((x) => x.slug === slug);
    return e ? e.primaryUrl : null;
  } catch { return null; }
}

async function screenshot(page, slug, tag) {
  const p = path.join(ctrlDir(slug), `${tag}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  return p;
}

function logBlock(title, obj) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(obj, null, 2));
}

// Greenhouse (and some other ATS) gate submission behind an emailed security
// code: the first submit emails a code and the page shows a "security code"
// field that must be filled before re-submitting. This is an email-verification
// step, NOT a missing form field — detect it so the run stays alive and the
// agent can read the code from email and inject it.
const CODE_RE = /security code|verification code|enter the code we (sent|emailed)|we (sent|emailed) you a (security |verification )?code|check your (inbox|email) for (the |a |your )?(security |verification )?code|copy and paste this code/i;

// Fill the emailed security/verification code field. Targets security/
// verification/confirmation inputs specifically so it never lands in a
// country/zip "code" field; falls back to a label-text scan.
async function fillSecurityCode(page, code) {
  const codeStr = String(code).trim();
  // Segmented OTP input FIRST: Greenhouse renders the security code as N
  // single-character boxes (input maxlength=1), not one text field. Focus the
  // first box and type the whole code (these auto-advance); fall back to
  // filling each box explicitly if auto-advance does not stick.
  try {
    const otp = page.locator('input[maxlength="1"]');
    const n = await otp.count();
    if (n >= 4 && n >= codeStr.length) {
      await otp.first().scrollIntoViewIfNeeded().catch(() => {});
      await otp.first().click();
      await page.keyboard.type(codeStr, { delay: 60 });
      await page.waitForTimeout(300);
      const firstVal = await otp.first().inputValue().catch(() => '');
      if (!firstVal) {
        for (let i = 0; i < codeStr.length && i < n; i++) {
          try { await otp.nth(i).fill(codeStr[i]); } catch { /* next */ }
        }
      }
      return true;
    }
  } catch { /* fall through to single-field */ }
  const sels = [
    'input[name*="security" i]', 'input[id*="security" i]', 'input[aria-label*="security" i]', 'input[placeholder*="security" i]',
    'input[name*="verification" i]', 'input[id*="verification" i]', 'input[placeholder*="verification" i]',
    'input[name*="confirmation" i]', 'input[placeholder*="confirmation code" i]',
  ];
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    try { if (await loc.count()) { await loc.scrollIntoViewIfNeeded().catch(() => {}); await loc.fill(String(code)); return true; } } catch { /* next */ }
  }
  // label/context fallback: an input whose nearby text names a security code
  const found = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    const wants = /security code|verification code|confirmation code|enter the code|code we (sent|emailed)/i;
    for (const el of inputs) {
      const lbl = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.placeholder || '';
      const p = el.closest('div,section,fieldset,form');
      const ctx = lbl + ' ' + ((p && p.innerText) || '').slice(0, 200);
      if (wants.test(ctx)) { el.setAttribute('data-cfx-code', '1'); return true; }
    }
    return false;
  }).catch(() => false);
  if (found) { try { await page.locator('[data-cfx-code="1"]').first().fill(String(code)); return true; } catch { /* fall through */ } }
  return false;
}

// Robust submit-button click shared by the submit and security-code paths.
async function clickSubmit(page) {
  const btn = submitLocator(page);
  if (!(await btn.count())) return false;
  await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  try { await btn.click({ timeout: 15000 }); return true; }
  catch { try { await btn.click({ force: true, timeout: 8000 }); return true; }
  catch { try { await btn.evaluate((el) => el.click()); return true; } catch { return false; } } }
}

async function run() {
  const { positional, flags } = args();
  const slug = positional[0];
  if (!slug) { console.error('usage: run <slug> [--url U] [--headless] [--no-submit]'); process.exit(2); }

  const { answers, meta } = buildAnswers(slug);
  if (flags.salary) answers.salaryExpectation = flags.salary; // batch: top-of-range per posting
  const rawUrl = flags.url || meta.postingUrl || urlForSlug(slug);
  if (!rawUrl) { console.error('no URL: pass --url or ensure the slug is in the queue / report.'); process.exit(2); }
  // Normalize to the URL that actually shows the application FORM (Ashby
  // /application, careers-wrapper -> Greenhouse embed), and bail out cleanly on
  // Workday (account-creation wall) so we never burn a navigation that can't be
  // filled. Landing on the form first try also avoids the re-navigate/re-submit
  // churn that trips ATS spam detection.
  const norm = normalizeApplyUrl(rawUrl);
  if (norm.needsManual) {
    writeState(slug, { phase: 'needs-manual', slug, url: rawUrl, ats: norm.ats, reason: norm.reason, ts: Date.now() });
    console.log(`[cfx] needs-manual: ${norm.reason}`);
    return;
  }
  const url = norm.url;
  const ats = norm.ats !== 'unknown' ? norm.ats : detectAts(url);

  console.log(`[cfx] slug=${slug} ats=${ats} headless=${!!flags.headless}`);
  if (norm.reason !== 'unchanged') console.log(`[cfx] url normalized (${norm.reason})`);
  console.log(`[cfx] url=${url}`);
  if (!meta.hasReport) console.log('[cfx] WARNING: no tailored report for this slug — filling contact fields only, no resume/cover.');

  const browser = await launchCamoufox({ headless: flags.headless });
  let page;
  try {
    ({ page } = await newStealthPage(browser));
    page.setDefaultTimeout(8000); // stale React-re-rendered locators should fail fast, not hang 30s
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Defense-in-depth location guard: discovery can leak a non-remote / non-US
    // role (an onsite posting slipped through once). Verify from the LIVE page
    // before tailoring/submitting. Precision-first: block only when clearly
    // onsite/hybrid or non-US; 'unknown' proceeds (the glance still catches it).
    if (!flags.allowOnsite) {
      const li = await page.evaluate(() => {
        const sels = ['.posting-categories', '.location', '.job__location', '[class*="location" i]', '.posting-category'];
        const parts = [];
        for (const s of sels) document.querySelectorAll(s).forEach((e) => parts.push(e.innerText));
        return { loc: parts.join(' | ').replace(/\s+/g, ' ').trim().slice(0, 240), title: document.title || ((document.querySelector('h1,h2') || {}).innerText || '') };
      }).catch(() => ({ loc: '', title: '' }));
      const pl = parseLocation(li.loc);
      const remoteV = classifyRemote(pl.remote, li.title, '');
      const usV = classifyUs(pl.us, li.title);
      if (remoteV === 'onsite' || remoteV === 'hybrid' || usV === false) {
        writeState(slug, { phase: 'blocked-location', slug, url, locationText: li.loc, remote: remoteV, us: usV, ts: Date.now() });
        console.log(`[cfx] BLOCKED: location "${li.loc}" -> remote=${remoteV} us=${usV}. Violates remote-only + US-only. Re-run with --allow-onsite to override.`);
        return;
      }
      console.log(`[cfx] location ok: "${li.loc || '(none found)'}" -> remote=${remoteV} us=${usV}`);
    }

    const navigated = await clickApplyIfPresent(page);
    if (navigated) await page.waitForTimeout(1500);

    const report = await fillForm(page, answers);
    const shot = await screenshot(page, slug, 'preview');

    writeState(slug, { phase: 'filled', slug, ats, url, ...report, screenshot: shot, ts: Date.now() });
    logBlock('FILLED', { ...report, screenshot: shot });

    console.log('\n=== GLANCE ===');
    console.log(`Company: ${meta.company || '?'}   Role: ${meta.role || '?'}`);
    console.log(`Filled ${report.filled.length}/${report.totalFields} fields. Resume uploaded: ${report.resumeUploaded}`);
    if (report.questions.length) console.log(`Custom questions needing answers: ${report.questions.length}`);
    if (report.unfilled.length) console.log(`Could not fill: ${report.unfilled.length} (see state.json)`);
    console.log(`Screenshot: ${shot}`);

    if (flags.noSubmit) {
      console.log('\n[cfx] --no-submit: fill-only smoke test complete. Leaving form filled, closing in 4s.');
      await page.waitForTimeout(4000);
      return;
    }

    // drive submit / answers / skip / confirm via the control channel
    let submitted = false;
    let rescans = 0;
    while (!submitted) {
      console.log(`\n[cfx] awaiting control.json in ${path.join('signals/apply', slug)} (submit | skip | answers | confirm) ...`);
      const c = await waitForControl(slug, { timeoutMs: 30 * 60 * 1000 });
      // Containment: a residual transient page error inside an action must NOT
      // propagate to the outer catch (which closes the browser and ends the
      // run). If the page object is still usable, write a recoverable state and
      // let the agent retry; only a genuinely closed page falls through to exit.
      try {
      if (c.action === 'skip' || c.action === 'timeout') {
        writeState(slug, { phase: c.action, slug, ts: Date.now() });
        console.log(`[cfx] ${c.action} — closing.`);
        return;
      }
      if (c.action === 'answers') {
        const done = await fillQuestions(page, c.answers || {});
        const s2 = await screenshot(page, slug, 'preview');
        writeState(slug, { phase: 'filled', slug, ats, url, answeredIdx: done, screenshot: s2, ts: Date.now() });
        console.log(`[cfx] filled ${done.length} custom answers; re-screenshot ${s2}`);
        continue;
      }
      // Emailed security code (Greenhouse anti-spam): fill it, then re-submit.
      if (c.action === 'security-code') {
        if (!c.code) { console.log('[cfx] security-code action missing code'); continue; }
        const filledCode = await fillSecurityCode(page, c.code);
        if (!filledCode) {
          const s = await screenshot(page, slug, 'preview');
          writeState(slug, { phase: 'needs-security-code', slug, ats, url, error: 'security code field not found on page', screenshot: s, ts: Date.now() });
          console.log('[cfx] security code field not found'); continue;
        }
        const clickedCode = await clickSubmit(page);
        if (!clickedCode) { writeState(slug, { phase: 'needs-security-code', slug, error: 'resubmit click failed after code', screenshot: await screenshot(page, slug, 'preview').catch(() => null), ts: Date.now() }); continue; }
        await page.waitForTimeout(4500);
        const afterC = await page.innerText('body').catch(() => '');
        const sC = await screenshot(page, slug, 'submitted');
        const successC = /(thank you|thanks for applying|thank you for applying|application (has been )?(received|submitted|sent)|successfully (applied|submitted|sent)|we('| ha)ve received your application|your application (has been (submitted|received)|is in)|we('| ha)ve got it|got it from here|application is in|we appreciate your interest)/i.test(afterC);
        if (successC) {
          writeState(slug, { phase: 'submitted', slug, postSubmitExcerpt: afterC.slice(0, 600), needsEmailConfirm: false, screenshot: sC, ts: Date.now() });
          console.log('[cfx] submitted (success after security code).');
          submitted = true; continue;
        }
        if (CODE_RE.test(afterC)) {
          writeState(slug, { phase: 'needs-security-code', slug, ats, url, error: 'code rejected or a new code was issued — read the latest email', postSubmitExcerpt: afterC.replace(/\s+/g, ' ').slice(0, 400), screenshot: sC, ts: Date.now() });
          console.log('[cfx] security code not accepted — awaiting a fresh code.'); continue;
        }
        const errC = await page.locator('[role="alert"], [class*="error" i], [aria-invalid="true"]').allInnerTexts().catch(() => []);
        writeState(slug, { phase: 'submit-failed', slug, error: (errC.join(' | ') || 'no success after security code').replace(/\s+/g, ' ').slice(0, 400), postSubmitExcerpt: afterC.slice(0, 400), screenshot: sC, ts: Date.now() });
        console.log('[cfx] submit not confirmed after security code.'); return;
      }
      if (c.action === 'submit') {
        // Robust submit click: a sticky-footer Submit button often fails the
        // default click's "stable" wait (animation / lazy scroll) — clickSubmit
        // scrolls then falls back to force/DOM click so a settling button does
        // not abort the submit and orphan the browser.
        if (!(await submitLocator(page).count())) { writeState(slug, { phase: 'error', error: 'no submit button found', ts: Date.now() }); console.log('[cfx] no submit button found'); return; }
        const clicked = await clickSubmit(page);
        if (!clicked) {
          const s = await screenshot(page, slug, 'submitted').catch(() => null);
          writeState(slug, { phase: 'submit-failed', slug, error: 'submit button click did not land (not stable/clickable)', screenshot: s, ts: Date.now() });
          console.log('[cfx] submit click failed after 3 strategies'); continue;
        }
        await page.waitForTimeout(4500);
        const after = await page.innerText('body').catch(() => '');
        const s3 = await screenshot(page, slug, 'submitted');
        // Verify SUCCESS before claiming submitted — a validation error leaves
        // the form up, and silently recording a failed submit as "applied" is
        // worse than reporting the failure.
        // Success banners vary widely by ATS/company ("Thanks for applying",
        // "we've got it from here", "your application is in", etc.). A too-narrow
        // regex false-negatives a real submit and the run records it as failed —
        // keep these variants broad.
        const success = /(thank you|thanks for applying|thank you for applying|application (has been )?(received|submitted|sent)|successfully (applied|submitted|sent)|we('| ha)ve received your application|your application (has been (submitted|received)|is in)|we('| ha)ve got it|got it from here|application is in|we appreciate your interest)/i.test(after);
        // Anti-abuse / spam wall is a DISTINCT terminal state: the agent must
        // NOT retry it (re-submitting is exactly what escalates the flag and
        // can blacklist the candidate's email/IP across the ATS network).
        const spam = /flagged as (possible )?spam|couldn'?t submit your application|detected as spam|too many (attempts|requests)|unusual activity/i.test(after);
        if (spam) {
          writeState(slug, { phase: 'submit-blocked-spam', slug, postSubmitExcerpt: after.replace(/\s+/g, ' ').slice(0, 400), screenshot: s3, ts: Date.now() });
          console.log('[cfx] SUBMIT BLOCKED (spam/anti-abuse) — do NOT retry this posting; back off.');
          return;
        }
        // Emailed security code required (Greenhouse anti-spam): keep the
        // browser ALIVE and wait for the agent to read the code from email and
        // inject {action:"security-code", code:"..."}. Do NOT treat as failure.
        if (!success && CODE_RE.test(after)) {
          writeState(slug, { phase: 'needs-security-code', slug, ats, url, postSubmitExcerpt: after.replace(/\s+/g, ' ').slice(0, 400), screenshot: s3, ts: Date.now() });
          console.log('[cfx] needs emailed SECURITY CODE — awaiting {action:"security-code", code:"..."} (browser stays open).');
          continue;
        }
        if (!success) {
          const errText = await page.locator('[role="alert"], [class*="error" i], [aria-invalid="true"]').allInnerTexts().catch(() => []);
          const errStr = (errText.join(' | ') || 'no success message after submit — likely a missing required field').replace(/\s+/g, ' ').slice(0, 600);
          // Re-scan on rejection: conditional/lazy required fields only render
          // after a submit attempt (and a re-render can wipe a committed value).
          // Re-run fillForm (skip the already-done resume upload) so it re-fills
          // contact/EEO, RE-COMMITS wiped comboboxes, and surfaces every
          // now-required field with options — the agent answers them in ONE pass
          // and re-submits, instead of failing one field at a time. Capped so a
          // form that always rejects can't loop forever.
          if (rescans < 6) {
            rescans++;
            const re = await fillForm(page, answers, { skipResume: true }).catch(() => null);
            const s4 = await screenshot(page, slug, 'preview');
            writeState(slug, { phase: 'filled', slug, ats, url, ...(re || {}), submitRejected: true, submitError: errStr, screenshot: s4, ts: Date.now() });
            console.log(`[cfx] submit rejected (rescan ${rescans}); re-surfaced ${(re ? re.questions.length : 0)} question(s) + ${(re ? re.unfilled.length : 0)} unfilled. Awaiting answers + re-submit. Error: ${errStr.slice(0, 160)}`);
            continue;
          }
          writeState(slug, { phase: 'submit-failed', slug, error: errStr, postSubmitExcerpt: after.slice(0, 400), screenshot: s3, ts: Date.now() });
          console.log(`[cfx] SUBMIT NOT CONFIRMED after ${rescans} rescans — ${errStr.slice(0, 160)}`);
          return; // leave browser to close; do NOT mark submitted
        }
        const confirmHint = /confirm|verify your email|check your (inbox|email)|we sent/i.test(after);
        writeState(slug, { phase: 'submitted', slug, postSubmitExcerpt: after.slice(0, 600), needsEmailConfirm: confirmHint, screenshot: s3, ts: Date.now() });
        console.log(`[cfx] submitted (success confirmed). needsEmailConfirm=${confirmHint}. screenshot ${s3}`);
        submitted = true;
      }
      } catch (loopErr) {
        const msg = (loopErr && loopErr.message) || '';
        const closed = /target (page|closed)|context or browser has been closed|page has been closed|crash/i.test(msg);
        let stillOpen = false; try { stillOpen = !page.isClosed(); } catch { stillOpen = false; }
        if (closed && stillOpen) {
          const s = await screenshot(page, slug, 'preview').catch(() => null);
          writeState(slug, { phase: 'filled', slug, ats, url, transient: true, error: msg.split('\n')[0].slice(0, 160), screenshot: s, ts: Date.now() });
          console.log('[cfx] transient page error caught; staying alive for retry:', msg.split('\n')[0]);
          await page.waitForTimeout(1500);
          continue;
        }
        throw loopErr; // genuine error / page truly closed -> outer catch closes cleanly
      }
    }

    // post-submit: optional email-confirmation link injected by the agent
    console.log('\n[cfx] awaiting optional {action:"confirm", link} (or skip to finish) ...');
    const c2 = await waitForControl(slug, { timeoutMs: 10 * 60 * 1000 });
    if (c2.action === 'confirm' && c2.link) {
      await page.goto(c2.link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      const s4 = await screenshot(page, slug, 'confirmed');
      writeState(slug, { phase: 'confirmed', slug, link: c2.link, screenshot: s4, ts: Date.now() });
      console.log(`[cfx] opened confirm link; screenshot ${s4}`);
    } else {
      writeState(slug, { phase: 'done', slug, ts: Date.now() });
      console.log('[cfx] done (no confirm link).');
    }
  } catch (e) {
    writeState(slug, { phase: 'error', error: e.message, stack: e.stack, ts: Date.now() });
    console.error('[cfx] ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function confirm() {
  const { positional, flags } = args();
  const link = positional[0];
  if (!link) { console.error('usage: confirm <url>'); process.exit(2); }
  const browser = await launchCamoufox({ headless: flags.headless });
  try {
    const { page } = await newStealthPage(browser);
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const out = path.join(REPO, 'signals', 'apply', `confirm-${Date.now()}.png`);
    await page.screenshot({ path: out, fullPage: true }).catch(() => {});
    console.log('[cfx] opened confirm link; screenshot', out);
  } finally { await browser.close().catch(() => {}); }
}

(async () => {
  const { cmd } = args();
  if (cmd === 'run') return run();
  if (cmd === 'confirm') return confirm();
  console.error('commands: run <slug> [--url U] [--headless] [--no-submit] | confirm <url>');
  process.exit(2);
})();
