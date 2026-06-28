// Normalize a discovered posting URL to the URL that actually shows the
// application FORM, so the harness lands on fillable fields on the first try
// (re-navigating/re-submitting the same posting is what trips ATS spam walls).
//
// Returns { url, ats, needsManual, reason }.
//   - Ashby JD page (jobs.ashbyhq.com/{org}/{id})  -> append /application
//   - Greenhouse careers WRAPPERS: company careers hosts that embed a
//     Greenhouse board and carry a gh_jid -> rewrite to the Greenhouse embed
//     job_app form, which has the real fields inline.
//   - Workday (*.myworkdayjobs.com) -> needsManual (multi-step + account
//     creation; never auto-create accounts).
//   - Greenhouse-direct (job-boards.greenhouse.io) + Lever -> unchanged.

// careers-wrapper host -> Greenhouse board token (the `for=` param).
// Add an entry per company careers host that embeds a Greenhouse board:
//   '<careers-host>': '<greenhouse-board-token>'
const WRAPPER_BOARD = {
  // 'careers.example.com': 'example',
  // 'www.example.com': 'example',
};

function ghJid(u) {
  const m = u.match(/[?&]gh_jid=(\d+)/) || u.match(/\/jobs\/(\d+)/);
  return m ? m[1] : null;
}

function normalizeApplyUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return { url, ats: 'unknown', needsManual: false, reason: 'empty' };
  let host = '';
  try { host = new URL(url).host; } catch { host = ''; }

  // Ashby: the bare posting URL is the JD page; the form is at /application.
  if (/jobs\.ashbyhq\.com/.test(host)) {
    const out = /\/application\/?($|\?)/.test(url) ? url : url.replace(/\/?(\?.*)?$/, '/application');
    return { url: out, ats: 'ashby', needsManual: false, reason: url === out ? 'ashby (already /application)' : 'ashby -> /application' };
  }

  // Workday: multi-step + frequent account-creation wall.
  if (/myworkdayjobs\.com/.test(host)) {
    return { url, ats: 'workday', needsManual: true, reason: 'workday: multi-step / account creation — apply manually or --paste' };
  }

  // Greenhouse careers wrappers: rewrite to the embed job_app form.
  const board = WRAPPER_BOARD[host];
  if (board) {
    const jid = ghJid(url);
    if (jid) return { url: `https://boards.greenhouse.io/embed/job_app?for=${board}&token=${jid}`, ats: 'greenhouse', needsManual: false, reason: `wrapper(${host}) -> greenhouse embed` };
    return { url, ats: 'greenhouse', needsManual: true, reason: `wrapper(${host}) but no gh_jid found` };
  }

  // Greenhouse-direct, Lever, others: leave as-is (form renders inline).
  let ats = 'unknown';
  if (/greenhouse\.io/.test(host)) ats = 'greenhouse';
  else if (/lever\.co/.test(host)) ats = 'lever';
  return { url, ats, needsManual: false, reason: 'unchanged' };
}

module.exports = { normalizeApplyUrl, WRAPPER_BOARD };
