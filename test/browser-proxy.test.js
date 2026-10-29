/**
 * test/browser-proxy.test.js
 *
 * R7: optional `browser.proxy` { server, username, password, bypass } in
 * config.json is handed to Playwright's launch options.
 *
 * Two properties matter more than the plumbing:
 *
 *   - FAIL CLOSED. A configured proxy that is malformed must stop the launch.
 *     Dropping it silently would send every broker request from the user's own
 *     address, which is exactly what a proxy is configured to prevent.
 *   - NO SECRETS IN TEXT. The password (and anything that embeds it, such as a
 *     server URL with credentials) never appears in an error, a log line or a
 *     masked description.
 */

'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildLaunchOptions,
  resolveProxy,
  browserConfigProblems,
  maskProxy,
  describeProxy,
  redactProxySecrets,
} = require('../lib/browser');

const PASSWORD = 'hunter2-s3cret';
const GOOD = { server: 'http://proxy.example:8080', username: 'alice', password: PASSWORD, bypass: '*.internal.example,localhost' };

const launchWith = (proxy) => buildLaunchOptions({ headless: false, platform: 'darwin', browser: { proxy } });

describe('buildLaunchOptions: proxy', () => {
  test('passes server, credentials and bypass to Playwright', () => {
    assert.deepEqual(launchWith(GOOD).proxy, {
      server: 'http://proxy.example:8080',
      username: 'alice',
      password: PASSWORD,
      bypass: '*.internal.example,localhost',
    });
  });

  test('server alone is enough, and unset optional fields are not sent as undefined', () => {
    const proxy = launchWith({ server: 'https://proxy.example:3128' }).proxy;
    assert.deepEqual(proxy, { server: 'https://proxy.example:3128' });
    assert.deepEqual(Object.keys(proxy), ['server']);
  });

  test('no proxy block, null, or the blank example placeholder means no proxy at all', () => {
    for (const proxy of [undefined, null, {}, { server: '' }, { server: '  ', username: '', password: '' }]) {
      assert.ok(!('proxy' in launchWith(proxy)), JSON.stringify(proxy));
    }
    assert.ok(!('proxy' in buildLaunchOptions({ headless: false, platform: 'darwin' })));
  });

  test('an explicit proxy option beats browser.proxy', () => {
    const opts = buildLaunchOptions({
      headless: false,
      proxy: { server: 'http://explicit.example:1' },
      browser: { proxy: { server: 'http://config.example:2' } },
    });
    assert.equal(opts.proxy.server, 'http://explicit.example:1');
  });

  test('the returned proxy is a copy: editing launch options cannot edit the config', () => {
    const config = { server: 'http://proxy.example:8080', password: 'x', username: 'u' };
    const opts = launchWith(config);
    opts.proxy.server = 'http://elsewhere.example';
    assert.equal(config.server, 'http://proxy.example:8080');
  });

  test('building options logs nothing', () => {
    const spies = ['log', 'info', 'warn', 'error'].map((m) => mock.method(console, m, () => {}));
    try {
      launchWith(GOOD);
      assert.throws(() => launchWith({ server: 'ftp://nope.example', password: PASSWORD }));
    } finally {
      const calls = spies.flatMap((s) => s.mock.calls.map((c) => c.arguments.join(' ')));
      mock.restoreAll();
      assert.deepEqual(calls, []);
    }
  });
});

describe('proxy.server validation', () => {
  test('http, https and socks5 are accepted', () => {
    for (const server of ['http://proxy.example:8080', 'https://proxy.example:8443', 'socks5://proxy.example:1080', 'HTTP://Proxy.Example:80']) {
      assert.doesNotThrow(() => resolveProxy({ server }), server);
    }
  });

  test('any other scheme, or no scheme, is refused', () => {
    for (const server of ['socks4://proxy.example:1080', 'ftp://proxy.example', 'file:///etc/passwd', 'javascript:alert(1)', 'proxy.example:8080', 'proxy.example', '//proxy.example:8080']) {
      assert.throws(() => resolveProxy({ server }), /browser\.proxy\.server must start with http:\/\/, https:\/\/ or socks5:\/\//, server);
    }
  });

  test('a malformed or hostless URL is refused', () => {
    for (const server of ['http://', 'http://:8080', 'http:// proxy.example']) {
      assert.throws(() => resolveProxy({ server }), /browser\.proxy\.server/, server);
    }
  });

  test('credentials belong in username and password, not inside the server URL', () => {
    assert.throws(() => resolveProxy({ server: `http://alice:${PASSWORD}@proxy.example:8080` }), /username and password/);
  });

  test('a server that is not a string is refused', () => {
    assert.throws(() => resolveProxy({ server: 8080 }), /browser\.proxy\.server must be a string/);
  });
});

describe('proxy credentials and the other fields', () => {
  test('Chromium cannot authenticate to a SOCKS5 proxy, so that combination is refused up front', () => {
    assert.throws(
      () => resolveProxy({ server: 'socks5://proxy.example:1080', username: 'alice', password: PASSWORD }),
      /Chromium does not support SOCKS5 proxy authentication/,
    );
    assert.doesNotThrow(() => resolveProxy({ server: 'socks5://proxy.example:1080' }));
  });

  test('a password without a username is refused (it would be sent to nobody)', () => {
    assert.throws(() => resolveProxy({ server: 'http://proxy.example:8080', password: PASSWORD }), /password is set but browser\.proxy\.username is not/);
  });

  test('username, password and bypass must be strings', () => {
    assert.throws(() => resolveProxy({ server: 'http://p.example:1', username: 5 }), /browser\.proxy\.username must be a string/);
    assert.throws(() => resolveProxy({ server: 'http://p.example:1', username: 'a', password: 5 }), /browser\.proxy\.password must be a string/);
    assert.throws(() => resolveProxy({ server: 'http://p.example:1', bypass: ['a'] }), /browser\.proxy\.bypass must be a string/);
  });

  test('a misspelt key is an error, not a silently unauthenticated proxy', () => {
    assert.throws(() => resolveProxy({ server: 'http://p.example:1', usename: 'alice', password: PASSWORD }), /unknown browser\.proxy key "usename"/);
  });

  test('keys that start with an underscore are comments and are ignored', () => {
    const proxy = resolveProxy({ _comment: 'my provider', server: 'http://p.example:1' });
    assert.deepEqual(proxy, { server: 'http://p.example:1' });
  });

  test('credentials with a blank username and password are the same as none', () => {
    assert.deepEqual(resolveProxy({ server: 'http://p.example:1', username: '', password: '' }), { server: 'http://p.example:1' });
  });

  test('credentials without a server are refused rather than ignored', () => {
    assert.throws(() => resolveProxy({ server: '', username: 'alice', password: PASSWORD }), /browser\.proxy\.server is required when/);
  });

  test('a proxy block that is not an object is refused', () => {
    for (const bad of ['http://p.example:1', 5, true, ['http://p.example:1']]) {
      assert.throws(() => resolveProxy(bad), /browser\.proxy must be an object/, JSON.stringify(bad));
    }
  });
});

describe('fail closed', () => {
  test('a malformed proxy stops buildLaunchOptions instead of launching without it', () => {
    assert.throws(() => launchWith({ server: 'proxy.example:8080' }), /browser\.proxy/);
    assert.throws(() => launchWith('http://proxy.example:8080'), /browser\.proxy/);
  });
});

describe('secrets never reach text', () => {
  const BAD_CONFIGS = [
    { server: `http://alice:${PASSWORD}@proxy.example:8080` },
    { server: `socks4://alice:${PASSWORD}@proxy.example:1080`, username: 'alice', password: PASSWORD },
    { server: 'socks5://proxy.example:1080', username: 'alice', password: PASSWORD },
    { server: 'http://proxy.example:8080', password: PASSWORD },
    { server: 'http://proxy.example:8080', username: 'alice', password: PASSWORD, usename: 'x' },
    { server: `proxy.example:8080?token=${PASSWORD}`, username: 'alice', password: PASSWORD },
    { server: `http://:${PASSWORD}@`, username: 'alice', password: PASSWORD },
  ];

  test('no error message contains the password or a credential-bearing URL', () => {
    for (const config of BAD_CONFIGS) {
      let message;
      try { resolveProxy(config); } catch (err) { message = err.message; }
      assert.ok(message, `expected ${JSON.stringify(config.server)} to be refused`);
      assert.ok(!message.includes(PASSWORD), `password leaked: ${message}`);
      assert.ok(!message.includes('alice'), `username leaked: ${message}`);
    }
  });

  test('browserConfigProblems reports the same problems without the secrets', () => {
    for (const config of BAD_CONFIGS) {
      const problems = browserConfigProblems({ proxy: config });
      assert.ok(problems.length > 0, JSON.stringify(config.server));
      assert.ok(!problems.join('\n').includes(PASSWORD));
    }
    assert.deepEqual(browserConfigProblems({ proxy: GOOD }), []);
    assert.deepEqual(browserConfigProblems(undefined), []);
    assert.deepEqual(browserConfigProblems({ proxy: { server: '' } }), []);
  });

  test('maskProxy keeps the host (useful in a log) and hides the credentials', () => {
    const masked = maskProxy(GOOD);
    assert.equal(masked.server, 'http://proxy.example:8080');
    assert.equal(masked.password, '***');
    assert.equal(masked.username, '***');
    assert.ok(!JSON.stringify(masked).includes(PASSWORD));
    assert.ok(!JSON.stringify(masked).includes('alice'));
  });

  test('maskProxy strips credentials a server URL carries, and leaves unset fields unset', () => {
    const masked = maskProxy({ server: `http://alice:${PASSWORD}@proxy.example:8080` });
    assert.ok(!JSON.stringify(masked).includes(PASSWORD));
    assert.ok(!('password' in masked));
    assert.equal(maskProxy(undefined), null);
  });

  test('describeProxy is one safe line for the start-of-run banner', () => {
    assert.equal(describeProxy(GOOD), 'proxy http://proxy.example:8080 (authenticated)');
    assert.equal(describeProxy({ server: 'socks5://proxy.example:1080' }), 'proxy socks5://proxy.example:1080');
    assert.equal(describeProxy(undefined), 'no proxy');
  });

  test('redactProxySecrets scrubs an arbitrary error text, including URL-encoded forms', () => {
    const text = `connect failed via http://alice:${PASSWORD}@proxy.example:8080 (pw ${PASSWORD}, enc ${encodeURIComponent(PASSWORD)})`;
    const out = redactProxySecrets(text, { server: 'http://proxy.example:8080', username: 'alice', password: PASSWORD });
    assert.ok(!out.includes(PASSWORD));
    assert.ok(!out.includes(encodeURIComponent(PASSWORD)));
    assert.ok(out.includes('proxy.example:8080'), 'the host stays so the log is still useful');
    assert.equal(redactProxySecrets('plain text', undefined), 'plain text');
    assert.equal(redactProxySecrets('plain text', { server: 'http://p.example:1' }), 'plain text');
  });
});

describe('the browser section as a whole', () => {
  test('browserConfigProblems also checks userAgent is a string', () => {
    assert.deepEqual(browserConfigProblems({ userAgent: 'Mozilla/5.0 (x) Chrome/1.0.0.0' }), []);
    assert.match(browserConfigProblems({ userAgent: 5 }).join('\n'), /browser\.userAgent must be a string/);
  });

  test('a misspelt section key is flagged and stops the launch: "proxxy" must not mean "no proxy"', () => {
    const browser = { proxxy: { server: 'http://proxy.example:8080' } };
    assert.match(browserConfigProblems(browser).join('\n'), /unknown browser key "proxxy"/);
    assert.throws(() => buildLaunchOptions({ headless: false, browser }), /unknown browser key "proxxy"/);
  });

  test('underscore keys in the browser section are comments', () => {
    assert.deepEqual(browserConfigProblems({ _comment: 'x', proxy: { _comment: 'y', server: '' }, userAgent: '' }), []);
  });

  test('a launch error carries a code the caller can recognise', () => {
    try { launchWith({ server: 'ftp://nope.example' }); assert.fail('should throw'); } catch (err) { assert.equal(err.code, 'EBROWSERCONFIG'); }
  });

  test('a browser section that is not an object is a problem, an absent one is not', () => {
    assert.match(browserConfigProblems('chrome').join('\n'), /browser must be an object/);
    assert.deepEqual(browserConfigProblems(null), []);
  });
});

describe('config.example.json', () => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));

  test('ships a browser section that validates and means "no proxy, default user agent"', () => {
    assert.ok(example.browser && example.browser.proxy, 'the browser.proxy block is documented in the example');
    assert.deepEqual(browserConfigProblems(example.browser), []);
    assert.ok(!('proxy' in buildLaunchOptions({ headless: false, browser: example.browser })));
    assert.ok(!('userAgent' in buildLaunchOptions({ headless: false, browser: example.browser })));
  });

  test('every key under browser.proxy and browser is a known key or a comment', () => {
    for (const key of Object.keys(example.browser)) assert.ok(key.startsWith('_') || ['proxy', 'userAgent'].includes(key), key);
    for (const key of Object.keys(example.browser.proxy)) assert.ok(key.startsWith('_') || ['server', 'username', 'password', 'bypass'].includes(key), key);
    assert.ok(example.browser.proxy._comment, 'browser.proxy carries a _comment');
  });
});
