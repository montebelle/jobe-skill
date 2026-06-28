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
 * @param {boolean} [opts.headless=false] headful by default so a human can
 *   watch and step in on a CAPTCHA / login wall.
 * @param {object}  [opts.proxy] Playwright proxy object {server,username,password}.
 * @returns {Promise<import('playwright-core').Browser>}
 */
async function launchCamoufox(opts = {}) {
  const { Camoufox } = await import('camoufox-js');
  const browser = await Camoufox({
    headless: opts.headless ?? false,
    humanize: true,            // human-like cursor movement + dwell timing
    geoip: true,               // derive timezone / locale / screen geo from exit IP
    os: hostOs(),              // present a plausible desktop OS consistent with fonts
    locale: ['en-US'],
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });
  return browser;
}

/**
 * Create a page without tripping the viewport protocol mismatch.
 *
 * playwright-core (1.61+) sends an `isMobile` field in Browser.setDefaultViewport
 * that the Camoufox Juggler build does not describe in its scheme, so a plain
 * browser.newPage() throws. Passing viewport:null makes Playwright skip
 * setDefaultViewport altogether (the window keeps Camoufox's own fingerprinted
 * size). Returns {context, page}.
 */
async function newStealthPage(browser) {
  const context = await browser.newContext({ viewport: null });
  // Root-cause guard for the Camoufox/playwright-core skew crash: heavy career
  // pages throw their own uncaught JS errors, and playwright-core (newer than
  // Camoufox's Juggler) crashes deserializing the resulting pageerror event
  // (`reading 'url'`), which tears the page down -> "Target page closed". We do
  // not care about the target site's JS errors, so swallow them in-page BEFORE
  // they surface as pageerror events: window.onerror returning true and
  // preventDefault on unhandledrejection stop them reaching Juggler.
  await context.addInitScript(() => {
    try {
      window.addEventListener('error', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
      window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
      window.onerror = () => true;
    } catch (_) { /* non-fatal */ }
  }).catch(() => {});
  const page = await context.newPage();
  return { context, page };
}

module.exports = { launchCamoufox, newStealthPage, hostOs };
