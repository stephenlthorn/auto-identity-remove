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

const page = (body, title = 'Opt out') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const ROUTES = {
  '/ok': () => ({ body: page(FORM) }),
  '/drifted': () => ({ body: page(FORM.replace('<input name="email" type="email">', '<input name="addr" type="text">')) }),
  '/wall': () => ({
    body: page('<div id="challenge-form"></div><h1>Just a moment...</h1><p>Checking your browser before accessing the site.</p>', 'Just a moment...'),
  }),
  '/wall-403': () => ({ status: 403, body: page('<h1>Access denied</h1>', 'Access denied') }),
  '/gone': () => ({ status: 404, body: page('<h1>Not found</h1>', 'Not found') }),
  '/broken': () => ({ status: 500, body: page('<h1>Oops</h1>', 'Oops') }),
  '/captcha-form': () => ({ body: page(`${FORM}<div class="g-recaptcha" data-sitekey="fixture-key"></div>`) }),
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
    const spec = route();
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

module.exports = { startFixtureServer, findChromium };
