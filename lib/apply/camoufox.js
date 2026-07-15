// Camoufox launcher.
//
// Why Camoufox and not Chrome-over-CDP: sites flag automation via the
// navigator.webdriver flag and the DevTools-protocol traces that a
// CDP-driven Chrome leaves behind. Camoufox patches Firefox at the C++
// level so those leaks never reach JS, and adds human-like cursor/timing
// (humanize) plus IP-consistent timezone/locale (geoip). That is the layer
// that was tripping the "confirm it's you" email walls.
//
// camoufox-js is ESM-only; this repo is CommonJS, so we load it via a
// dynamic import() inside an async function (require() would throw
// ERR_REQUIRE_ESM).

const os = require('os');

function hostOs() {
  const p = process.platform;
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

/**
 * Launch a stealth Firefox (Camoufox) browser.
 * @param {object} opts
 * @param {boolean} [opts.headless=true] HEADLESS by default: empirically a real
 *   display leaks signals that conflict with the spoofed fingerprint and
 *   TRIGGERS security/spam checks — headless runs cleaner. Pass headless:false
 *   only to watch a run or clear a visible wall.
 * @param {string}  [opts.userDataDir] Persist the browser profile to this dir.
 *   Ashby job boards run invisible reCAPTCHA v3, which grades the SESSION's
 *   cookie/history warmth — a fresh fingerprint every run (the default that
 *   beats Greenhouse's email-confirm wall) scores cold and gets "possible
 *   spam". A persistent profile accumulates Google/reCAPTCHA cookies across
 *   runs so the score climbs. When set, Camoufox returns a persistent
 *   BrowserContext (not a Browser); newStealthPage() handles both. MUST be
 *   used one-at-a-time — two processes sharing a profile dir corrupt it.
 * @param {object}  [opts.proxy] Playwright proxy object {server,username,password}.
 * @returns {Promise<import('playwright-core').Browser|import('playwright-core').BrowserContext>}
 */
async function launchCamoufox(opts = {}) {
  const camoufox = await import('camoufox-js');
  const cfg = {
    headless: opts.headless ?? true,
    humanize: true,            // human-like cursor movement + dwell timing
    geoip: true,               // derive timezone / locale / screen geo from exit IP
    os: hostOs(),              // present a plausible desktop OS consistent with fonts
    locale: ['en-US'],
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  };
  if (opts.userDataDir) {
    // Persistent profile. camoufox-js's Camoufox({user_data_dir}) calls
    // launchPersistentContext WITHOUT viewport, and playwright-core then sends
    // Browser.setDefaultViewport, which the Camoufox Juggler build rejects (the
    // same isMobile skew newStealthPage dodges with viewport:null). The wrapper
    // gives us no way to inject viewport, so build camoufox's launch options
    // ourselves and drive launchPersistentContext with viewport:null.
    const { firefox } = require('playwright-core');
    const launchOpts = await camoufox.launchOptions({ ...cfg, headless: cfg.headless });
    return firefox.launchPersistentContext(opts.userDataDir, { ...launchOpts, viewport: null });
  }
  return camoufox.Camoufox(cfg);
}

// The in-page error swallower (see newStealthPage): stops a career page's own
// uncaught JS errors from reaching the Camoufox/playwright-core skew crash.
function installErrorGuard(ctx) {
  return ctx.addInitScript(() => {
    try {
      window.addEventListener('error', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
      window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
      window.onerror = () => true;
    } catch (_) { /* non-fatal */ }
  }).catch(() => {});
}

/**
 * Create a page without tripping the viewport protocol mismatch.
 *
 * playwright-core (1.61+) sends an `isMobile` field in Browser.setDefaultViewport
 * that the Camoufox Juggler build does not describe in its scheme, so a plain
 * browser.newPage() throws. Passing viewport:null makes Playwright skip
 * setDefaultViewport altogether (the window keeps Camoufox's own fingerprinted
 * size). Returns {context, page}.
 *
 * The in-page error guard (installErrorGuard) is the root-cause fix for the
 * Camoufox/playwright-core skew crash: heavy career pages throw their own
 * uncaught JS errors, and playwright-core (newer than Camoufox's Juggler)
 * crashes deserializing the resulting pageerror event (`reading 'url'`), which
 * tears the page down -> "Target page closed". We do not care about the target
 * site's JS errors, so swallow them in-page BEFORE they surface as pageerror
 * events.
 *
 * Accepts EITHER a Browser (fresh-fingerprint default) or a persistent
 * BrowserContext (userDataDir path): a persistent context is already a context
 * with its own initial page, so there is no newContext() to call on it.
 */
async function newStealthPage(browserOrContext) {
  // A Browser exposes newContext(); a (persistent) BrowserContext does not.
  if (typeof browserOrContext.newContext === 'function') {
    const context = await browserOrContext.newContext({ viewport: null });
    await installErrorGuard(context);
    const page = await context.newPage();
    return { context, page };
  }
  // Persistent BrowserContext: reuse its existing page (init script applies to
  // the next navigation, which is our goto).
  const context = browserOrContext;
  await installErrorGuard(context);
  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}

module.exports = { launchCamoufox, newStealthPage, hostOs };
