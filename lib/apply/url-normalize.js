// Normalize a discovered posting URL to the URL that actually shows the
// application FORM, so the harness lands on fillable fields on the first try
// (re-navigating/re-submitting the same posting is what trips ATS spam walls).
//
// Returns { url, ats, needsManual, reason }.
//   - Ashby JD page (jobs.ashbyhq.com/{org}/{id})  -> append /application
//   - Greenhouse careers WRAPPERS: any host carrying a gh_jid param -> the
//     Greenhouse embed job_app form, which has the real fields inline. The
//     board token comes from WRAPPER_BOARD when the token differs from the
//     domain label, else it is DERIVED from the registrable domain label
//     (careers.example.com -> example). The career-site wrapper often renders
//     0 fillable fields; the embed form fills fully. The embed form also
//     renders choice questions as react-select comboboxes (fillable) rather
//     than the wrapper's hidden-native-select + checkbox (unregisterable).
//   - Greenhouse-direct board page (job-boards.greenhouse.io/{board}/jobs/{id})
//     -> the /embed/job_app form; the board page wraps the form in the board's
//     careers chrome + a job-search widget whose facet checkboxes the scanner
//     fights. The embed form is JUST the application and submits cleanly.
//   - Workday (*.myworkdayjobs.com) -> needsManual (multi-step + account
//     creation; never auto-create accounts).
//   - Lever -> unchanged (form renders inline).

// careers-wrapper host -> Greenhouse board token (the `for=` param). ONLY needed
// when the token differs from the derived domain label; hosts whose token equals
// the domain label are handled generically by deriveBoardToken.
// Add an entry per company careers host whose board token differs from its domain:
//   '<careers-host>': '<greenhouse-board-token>'
const WRAPPER_BOARD = {
  // 'careers.example.com': 'exampleboard',
};

// A gh_jid query param is an unambiguous Greenhouse signal. The `/jobs/(\d+)`
// path is NOT — many ATSs use it — so it only counts for explicit WRAPPER_BOARD
// hosts we already know are Greenhouse.
function ghJidParam(u) {
  const m = u.match(/[?&]gh_jid=(\d+)/);
  return m ? m[1] : null;
}
function ghJid(u) {
  const m = u.match(/[?&]gh_jid=(\d+)/) || u.match(/\/jobs\/(\d+)/);
  return m ? m[1] : null;
}

// Derive a candidate Greenhouse board token from a wrapper host: drop common
// sub-labels (www, careers, jobs, apply, boards, job) and the public suffix,
// keep the registrable domain's main label. careers.example.com -> "example",
// www.example.com -> "example". A wrong guess is no worse than today: the embed
// 404s and the form is empty, same as the un-rewritten wrapper — so an
// optimistic rewrite only ever helps.
const SUB_DROP = new Set(['www', 'careers', 'career', 'jobs', 'job', 'apply', 'boards', 'work', 'join']);
function deriveBoardToken(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return '';
  // Strip the public suffix: last label always, plus a second label for the
  // common multi-part suffixes (.co.uk, .com.au). Most job hosts are single.
  let core = parts.slice(0, -1);
  if (core.length >= 2 && /^(co|com|org|net|gov|ac)$/.test(core[core.length - 1])) core = core.slice(0, -1);
  // Drop leading sub-labels like "careers"/"www"; the remaining LAST label is
  // the registrable domain (example).
  while (core.length > 1 && SUB_DROP.has(core[0])) core = core.slice(1);
  return core[core.length - 1] || '';
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

  // Greenhouse-direct: the board page (job-boards.greenhouse.io/{board}/jobs/{id})
  // wraps the form in the board's careers chrome + a job-search widget whose
  // facet checkboxes the scanner fights. The /embed/job_app form is JUST the
  // application and submits cleanly — rewrite to it. Already-embed and non-job
  // paths pass through unchanged. (Must come before the generic gh_jid rewrite
  // so we never rewrite a greenhouse host onto itself.)
  if (/greenhouse\.io/.test(host)) {
    const m = url.match(/(?:job-)?boards\.greenhouse\.io\/([^\/?#]+)\/jobs\/(\d+)/);
    if (m && m[1] !== 'embed') {
      return { url: `https://job-boards.greenhouse.io/embed/job_app?for=${m[1]}&token=${m[2]}`, ats: 'greenhouse', needsManual: false, reason: `greenhouse board(${m[1]}) -> embed job_app` };
    }
    return { url, ats: 'greenhouse', needsManual: false, reason: 'unchanged' };
  }
  if (/lever\.co/.test(host)) return { url, ats: 'lever', needsManual: false, reason: 'unchanged' };

  // Greenhouse careers wrappers: rewrite to the embed job_app form. Known
  // token-differs hosts use WRAPPER_BOARD; otherwise derive the token from the
  // domain. The `/jobs/(\d+)` fallback only applies to explicit wrapper hosts.
  const knownBoard = WRAPPER_BOARD[host];
  if (knownBoard) {
    const jid = ghJid(url);
    if (jid) return { url: `https://boards.greenhouse.io/embed/job_app?for=${knownBoard}&token=${jid}`, ats: 'greenhouse', needsManual: false, reason: `wrapper(${host}) -> greenhouse embed` };
    return { url, ats: 'greenhouse', needsManual: true, reason: `wrapper(${host}) but no gh_jid found` };
  }
  // General wrapper: any host carrying a gh_jid param -> derive board token.
  const jidParam = ghJidParam(url);
  if (jidParam) {
    const board = deriveBoardToken(host);
    if (board) return { url: `https://boards.greenhouse.io/embed/job_app?for=${board}&token=${jidParam}`, ats: 'greenhouse', needsManual: false, reason: `gh_jid wrapper(${host}) -> greenhouse embed (derived board=${board})` };
  }

  return { url, ats: 'unknown', needsManual: false, reason: 'unchanged' };
}

module.exports = { normalizeApplyUrl, WRAPPER_BOARD, deriveBoardToken };
