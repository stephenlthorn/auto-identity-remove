'use strict';
/**
 * test/helpers/health-fixture-server.js
 *
 * A local http server on 127.0.0.1 that plays "a broker's opt-out page" for the
 * broker health tests, and keeps a request log so a test can assert that the
 * check only ever issued GETs for the opt-out page. Also finds a Chromium to
 * drive. Not a test file (no .test.js suffix).
 */

const http = require('node:http');
const fs = require('node:fs');

const FORM = `
  <h1>Remove my listing</h1>
  <p>Enter the email address you used and press the button. We will remove the listing within ten days
  and send a confirmation message to that address. This page is a fixture for the test suite.</p>
  <form method="post" action="/submit">
    <input name="email" type="email">
    <button type="submit">Remove</button>
  </form>`;

// Every fixture page records the events a person (or a script acting as one) would cause, in
// the capture phase on window, so a test can read window.__events afterwards and assert that
// the health check caused none. A click, a keystroke or a submit that sends no request would
// leave nothing in the server's request log; here it is still seen.
const EVENT_TYPES = ['input', 'beforeinput', 'change', 'click', 'mousedown', 'mouseup', 'pointerdown', 'keydown', 'keypress', 'keyup', 'submit', 'focusin'];
const RECORDER = `<script>window.__events = []; ${JSON.stringify(EVENT_TYPES)}.forEach(function (type) {
  window.addEventListener(type, function (e) { window.__events.push(type + ' ' + ((e.target && (e.target.name || e.target.tagName)) || '')); }, true);
});</script>`;

const page = (body, title = 'Opt out') => `<!doctype html><html><head><title>${title}</title>${RECORDER}</head><body>${body}</body></html>`;

const hiddenForm = (emailInput) => page(FORM.replace('<input name="email" type="email">', emailInput));
const hiddenSubmit = (style) => page(FORM.replace('<button type="submit">Remove</button>', `<button type="submit" ${style}>Remove</button>`));

const ROUTES = {
  // The email field is in the DOM but nobody can see it (a bot trap, a template left behind, a hidden step).
  '/hidden/display': () => ({ body: hiddenForm('<input name="email" type="email" style="display:none">') }),
  '/hidden/visibility': () => ({ body: hiddenForm('<input name="email" type="email" style="visibility:hidden">') }),
  '/hidden/offscreen': () => ({ body: hiddenForm('<input name="email" type="email" style="position:absolute;left:-9999px">') }),
  '/hidden/aria': () => ({ body: hiddenForm('<div aria-hidden="true"><input name="email" type="email"></div>') }),
  '/hidden/tiny': () => ({ body: hiddenForm('<input name="email" type="email" style="width:1px;height:1px;padding:0;border:0">') }),
  '/hidden/tabindex': () => ({ body: hiddenForm('<input name="email" type="email" tabindex="-1">') }),
  '/hidden/parent': () => ({ body: hiddenForm('<div style="display:none"><input name="email" type="email"></div>') }),
  '/hidden/submit': () => ({ body: hiddenSubmit('style="display:none"') }),
  // Keeps its box but cannot be seen or clicked: only the visibility test catches it (a button is not a text field).
  '/hidden/submit-visibility': () => ({ body: hiddenSubmit('style="visibility:hidden"') }),
  // A hidden duplicate first, the real field second: a visible match exists.
  '/hidden/duplicate-first': () => ({ body: hiddenForm('<input name="email" type="email" style="display:none"><input name="email" type="email">') }),
  '/redirect-offsite': (req) => ({ status: 302, headers: { location: `http://localhost:${req.headers.host.split(':')[1]}/ok` }, body: '' }),
  '/redirect-same-site': () => ({ status: 302, headers: { location: '/ok' }, body: '' }),
  '/ok': () => ({ body: page(FORM) }),
  '/drifted': () => ({ body: page(FORM.replace('<input name="email" type="email">', '<input name="addr" type="text">')) }),
  '/wall': () => ({
    body: page('<div id="challenge-form"></div><h1>Just a moment...</h1><p>Checking your browser before accessing the site.</p>', 'Just a moment...'),
  }),
  '/wall-403': () => ({ status: 403, body: page('<h1>Access denied</h1>', 'Access denied') }),
  '/gone': () => ({ status: 404, body: page('<h1>Not found</h1>', 'Not found') }),
  '/broken': () => ({ status: 500, body: page('<h1>Oops</h1>', 'Oops') }),
  '/captcha-form': () => ({ body: page(`${FORM}<div class="g-recaptcha" data-sitekey="fixture-key"></div>`) }),
  // 2 of 4 fields renamed, with the form's usual reCAPTCHA widget beside it.
  '/captcha-drifted': () => ({
    body: page(`<h1>Remove my listing</h1><p>Enter the details you used and press the button. We will remove the listing within ten days and send a confirmation message to that address.</p>
      <form method="post" action="/submit">
        <input name="first" type="text"><input name="last" type="text">
        <input name="mail_addr" type="text"><input name="zip_code" type="text">
        <div class="g-recaptcha" data-sitekey="fixture-key"></div>
        <button type="submit">Remove</button>
      </form>`),
  }),
  '/late-form': () => ({
    body: page(`<h1>Remove my listing</h1><p>${'Loading the form, one moment please. '.repeat(4)}</p><div id="slot"></div>
      <script>setTimeout(function () { document.getElementById('slot').innerHTML = '<form method="post" action="/submit"><input name="email" type="email"><button type="submit">Remove</button></form>'; }, 700);</script>`),
  }),
  '/hang': () => ({ hang: true }),
};

/**
 * @returns {Promise<{ origin: string, requests: Array<{ method: string, path: string }>, close: () => Promise<void> }>}
 */
function startFixtureServer() {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    const route = ROUTES[req.url.split('?')[0]];
    if (!route) { res.writeHead(404, { 'content-type': 'text/html' }); res.end(page('<h1>No such fixture</h1>')); return; }
    const spec = route(req);
    if (spec.hang) return; // never answers: the check's own timeout must end it
    res.writeHead(spec.status || 200, { 'content-type': 'text/html', ...(spec.headers || {}) });
    res.end(spec.body);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((done) => { sockets.forEach((s) => s.destroy()); server.close(() => done()); }),
      });
    });
  });
}

/** Path to a Chromium/Chrome to drive, or null when this machine has none. */
function findChromium() {
  const candidates = [process.env.AIDR_CHROME_PATH];
  try { candidates.push(require('playwright').chromium.executablePath()); } catch (_) { /* no playwright */ }
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  );
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

module.exports = { startFixtureServer, findChromium, EVENT_TYPES };
