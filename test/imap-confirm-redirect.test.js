/**
 * test/imap-confirm-redirect.test.js
 *
 * NET-10 / codex #9 (P2): only the initial confirm URL was validated; redirects
 * were followed unchecked inside the persistent profile. A broker-hosted open
 * redirect or a dangling subdomain could steer the browser to a LAN or cloud
 * metadata address, and the run still recorded success.
 *
 * The page stub below replays a redirect chain through whatever route handler
 * the code registers, exactly the way Playwright invokes it per hop.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { processConfirmationEmails, isPrivateHost } = require('../lib/imap-confirm');

const SPOKEO = { name: 'Spokeo', expectedSender: 'optout@spokeo.com', optOutUrl: 'https://www.spokeo.com/optout' };
const START = 'https://spokeo.com/confirm?t=1';

function memStore() {
  const ids = new Set();
  return { has: (id) => ids.has(id), add: (id) => { ids.add(id); } };
}

function eml(extraHeaders = []) {
  return [
    'From: optout@spokeo.com',
    'To: user@example.com',
    'Subject: Confirm',
    ...extraHeaders,
    '',
    `Confirm: ${START}`,
  ].join('\r\n');
}

/**
 * A context/page whose goto walks `hops` (START plus any redirect targets)
 * through the registered route handler. A hop the handler aborts makes goto
 * reject, like net::ERR_BLOCKED_BY_CLIENT. `where` picks context vs page route.
 */
function makeGuardedContext({ hops = [START], where = 'page', status = 200, subresources = [] } = {}) {
  const log = { aborted: [], continued: [], gotos: [] };
  let handler = null;
  let unrouted = false;

  const fakeRoute = (url, navigation) => ({
    request: () => ({ url: () => url, isNavigationRequest: () => navigation }),
    abort: async () => { log.aborted.push(url); },
    continue: async () => { log.continued.push(url); },
    fallback: async () => { log.continued.push(url); },
  });

  const routeApi = {
    route: async (_pattern, h) => { handler = h; },
    unroute: async () => { unrouted = true; },
  };

  const page = {
    ...(where === 'page' ? routeApi : {}),
    goto: async (url) => {
      log.gotos.push(url);
      let last = url;
      for (const hop of hops) {
        const before = log.aborted.length;
        if (handler) await handler(fakeRoute(hop, true));
        if (log.aborted.length > before) throw new Error('net::ERR_BLOCKED_BY_CLIENT at ' + hop);
        last = hop;
      }
      for (const sub of subresources) {
        if (handler) await handler(fakeRoute(sub, false));
      }
      page._url = last;
      return { status: () => status, url: () => last };
    },
    url: () => page._url,
    textContent: async () => 'You are confirmed.',
    close: async () => {},
    _url: 'about:blank',
  };

  const ctx = {
    log,
    get unrouted() { return unrouted; },
    ...(where === 'context' ? routeApi : {}),
    newPage: async () => page,
  };
  return ctx;
}

async function run(ctx, { content = eml(), resolveHost = async () => ['93.184.216.34'], broker = SPOKEO } = {}) {
  const successes = [];
  const result = await processConfirmationEmails(ctx, [broker], {
    dir: 'confirms',
    _readDir: () => ['m.eml'],
    _readFile: () => content,
    _moveFile: () => true,
    _recordSuccess: (key) => successes.push(key),
    _isPending: () => true,
    _processedStore: memStore(),
    _resolveHost: resolveHost,
  });
  return { result, successes };
}

// -- redirects / final URL ----------------------------------------------------

for (const target of [
  'http://169.254.169.254/latest/meta-data/',
  'http://127.0.0.1:8080/admin',
  'http://10.0.0.5/',
  'http://192.168.1.1/',
  'http://172.16.4.4/',
  'http://[::1]:3000/',
  'http://[::ffff:7f00:1]/',
  'http://[fe80::1]/',
  'http://[fd00::1234]/',
  'http://localhost:9000/',
  'https://evil.example.org/phish',
  'https://spokeo.com.evil.example.org/confirm',
  'https://notspokeo.com/confirm',
]) {
  test(`redirect to ${target} is blocked and nothing is recorded (page.route)`, async () => {
    const ctx = makeGuardedContext({ hops: [START, target] });

    const { result, successes } = await run(ctx);

    assert.deepEqual(ctx.log.aborted, [target]);
    assert.equal(successes.length, 0, 'recordSuccess must not be called after a bad redirect');
    assert.equal(result.processed.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].reason, 'blocked_navigation');
  });
}

test('the guard is installed on the context when the context supports route()', async () => {
  const ctx = makeGuardedContext({ hops: [START, 'http://169.254.169.254/'], where: 'context' });

  const { result, successes } = await run(ctx);

  assert.deepEqual(ctx.log.aborted, ['http://169.254.169.254/']);
  assert.equal(successes.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(ctx.unrouted, true, 'the per-message handler must be removed again');
});

test('a redirect to a subdomain of the broker host is allowed and recorded', async () => {
  const ctx = makeGuardedContext({ hops: [START, 'https://privacy.spokeo.com/done'] });

  const { result, successes } = await run(ctx);

  assert.deepEqual(ctx.log.aborted, []);
  assert.deepEqual(successes, ['Spokeo']);
  assert.equal(result.processed.length, 1);
});

test('a broker subdomain whose DNS points at a private address is blocked', async () => {
  const ctx = makeGuardedContext({ hops: [START, 'https://dangling.spokeo.com/x'] });
  const resolveHost = async (host) => (host === 'dangling.spokeo.com' ? ['10.1.2.3'] : ['93.184.216.34']);

  const { result, successes } = await run(ctx, { resolveHost });

  assert.deepEqual(ctx.log.aborted, ['https://dangling.spokeo.com/x']);
  assert.equal(successes.length, 0);
  assert.equal(result.failed.length, 1);
});

test('DNS failure fails closed (navigation aborted)', async () => {
  const ctx = makeGuardedContext({ hops: [START] });

  const { successes } = await run(ctx, { resolveHost: async () => { throw new Error('ENOTFOUND'); } });

  assert.deepEqual(ctx.log.aborted, [START]);
  assert.equal(successes.length, 0);
});

test('third-party sub-resources are allowed but a private-address sub-resource is blocked', async () => {
  const ctx = makeGuardedContext({
    hops: [START],
    subresources: ['https://cdn.example-assets.net/app.js', 'http://169.254.169.254/latest/api/token'],
  });

  const { result, successes } = await run(ctx);

  assert.deepEqual(ctx.log.aborted, ['http://169.254.169.254/latest/api/token']);
  assert.ok(ctx.log.continued.includes('https://cdn.example-assets.net/app.js'));
  assert.equal(successes.length, 0, 'a page that tried to reach a private address is not trusted as evidence');
  assert.equal(result.failed[0].reason, 'blocked_navigation');
});

// -- final URL check (works even without route support) ----------------------

test('stub whose goto ends on http://169.254.169.254/ is a failure (final page.url() check)', async () => {
  const ctx = {
    newPage: async () => ({
      goto: async () => ({ status: () => 200 }),
      url: () => 'http://169.254.169.254/',
      textContent: async () => 'metadata',
      close: async () => {},
    }),
  };

  const { result, successes } = await run(ctx);

  assert.equal(successes.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, 'redirected_off_host');
});

test('final URL on an unrelated public host is a failure', async () => {
  const ctx = {
    newPage: async () => ({
      goto: async () => ({ status: () => 200 }),
      url: () => 'https://evil.example.org/landing',
      textContent: async () => 'hello',
      close: async () => {},
    }),
  };

  const { successes, result } = await run(ctx);

  assert.equal(successes.length, 0);
  assert.equal(result.failed[0].reason, 'redirected_off_host');
});

test('a chrome error page as the final URL is a failure', async () => {
  const ctx = {
    newPage: async () => ({
      goto: async () => ({ status: () => 200 }),
      url: () => 'chrome-error://chromewebdata/',
      textContent: async () => '',
      close: async () => {},
    }),
  };

  const { successes } = await run(ctx);

  assert.equal(successes.length, 0);
});

// -- initial URL: private hosts ----------------------------------------------

test('a confirm link whose host is a private IP is rejected before any navigation', async () => {
  const broker = { name: 'Odd', expectedSender: 'optout@10.0.0.5', optOutUrl: 'http://10.0.0.5/optout' };
  const content = [
    'From: optout@10.0.0.5',
    'To: user@example.com',
    '',
    'Confirm: http://10.0.0.5/confirm?t=1',
  ].join('\r\n');
  const ctx = makeGuardedContext({ hops: ['http://10.0.0.5/confirm?t=1'] });

  const { result, successes } = await run(ctx, { content, broker });

  assert.equal(ctx.log.gotos.length, 0, 'never navigate to a private address even when it is the broker host');
  assert.equal(successes.length, 0);
  assert.equal(result.unmatched[0].reason, 'private_host');
});

// -- Authentication-Results ---------------------------------------------------

test('Authentication-Results dkim=fail for the broker domain: refused, nothing clicked', async () => {
  const ctx = makeGuardedContext();
  const content = eml(['Authentication-Results: mx.example.com; dkim=fail header.d=spokeo.com; spf=pass smtp.mailfrom=spokeo.com']);

  const { result, successes } = await run(ctx, { content });

  assert.equal(ctx.log.gotos.length, 0);
  assert.equal(successes.length, 0);
  assert.equal(result.unmatched[0].reason, 'auth_failed');
});

test('Authentication-Results spf=fail for the broker domain: refused', async () => {
  const ctx = makeGuardedContext();
  const content = eml(['Authentication-Results: mx.example.com;', ' spf=fail (domain of spokeo.com does not designate 1.2.3.4) smtp.mailfrom=optout@spokeo.com']);

  const { result } = await run(ctx, { content });

  assert.equal(ctx.log.gotos.length, 0);
  assert.equal(result.unmatched[0].reason, 'auth_failed');
});

test('dkim=pass spf=pass is accepted', async () => {
  const ctx = makeGuardedContext();
  const content = eml(['Authentication-Results: mx.example.com; dkim=pass header.d=spokeo.com; spf=pass smtp.mailfrom=spokeo.com']);

  const { successes } = await run(ctx, { content });

  assert.deepEqual(successes, ['Spokeo']);
});

test('no Authentication-Results header at all is accepted (local .eml exports often strip it)', async () => {
  const ctx = makeGuardedContext();

  const { successes } = await run(ctx, { content: eml() });

  assert.deepEqual(successes, ['Spokeo']);
});

test('a dkim=fail for an unrelated domain does not block a mail that is otherwise fine', async () => {
  const ctx = makeGuardedContext();
  const content = eml(['Authentication-Results: mx.example.com; dkim=fail header.d=listserv.example.net; dkim=pass header.d=spokeo.com']);

  const { successes } = await run(ctx, { content });

  assert.deepEqual(successes, ['Spokeo']);
});

// -- isPrivateHost table ------------------------------------------------------

test('isPrivateHost classifies IPv4, IPv6 and internal names', () => {
  const priv = [
    '127.0.0.1', '127.9.9.9', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    '169.254.169.254', '169.254.170.2', '100.64.0.1', '100.100.100.200', '192.0.0.192', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fd12:3456::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '[::1]',
    'localhost', 'LOCALHOST.', 'foo.localhost', 'printer.local', 'metadata.google.internal', 'intranet', 'db',
  ];
  const pub = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '::ffff:5db8:d822', 'spokeo.com', 'privacy.broker.co.uk'];

  for (const h of priv) assert.equal(isPrivateHost(h), true, `${h} must be private`);
  for (const h of pub) assert.equal(isPrivateHost(h), false, `${h} must be public`);
});
