'use strict';
/**
 * test/broker-health-classify.test.js
 *
 * The pure half of the broker health check: given the facts gathered from one
 * page load, which label does the broker get? The rule that matters most is
 * that a bot wall is NEVER reported as drift: a CI address is blocked by some
 * sites, and filing "the selectors are gone" for a page we never saw would send
 * a maintainer after a bug that does not exist.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyHealth } = require('../lib/broker-health');

const page = (over = {}) => ({
  outcome: 'response',
  status: 200,
  url: 'https://www.example.com/optout',
  title: 'Opt out of Example',
  text: 'Remove your listing from Example. Enter your email address below and press the button to continue. '.repeat(3),
  textLength: 300,
  markers: [],
  captchaPresent: false,
  headers: {},
  selectors: ['input[name="email"]', 'button[type="submit"]'],
  missing: [],
  ...over,
});
const failed = (message) => ({ outcome: 'error', message });

describe('ok', () => {
  test('the page loads and every selector matches', () => {
    const r = classifyHealth(page());
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /2 selectors/);
  });

  test('a manual broker only has to answer', () => {
    const r = classifyHealth(page({ selectors: [], missing: [] }));
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /answers/);
  });

  test('a CAPTCHA widget beside a complete form is part of the form, not a wall', () => {
    const r = classifyHealth(page({ captchaPresent: true }));
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /CAPTCHA/);
  });
});

describe('drifted', () => {
  test('names every missing selector', () => {
    const r = classifyHealth(page({ missing: ['input[name="email"]'] }));
    assert.equal(r.status, 'drifted');
    assert.deepEqual(r.missing, ['input[name="email"]']);
    assert.match(r.detail, /input\[name="email"\]/);
  });

  test('a selector list that matches nothing is drift, with the whole list named', () => {
    const r = classifyHealth(page({ missing: ['a, b', 'button[type="submit"]'] }));
    assert.equal(r.status, 'drifted');
    assert.equal(r.missing.length, 2);
  });

  test('a page that moved to another host reports where it went', () => {
    const r = classifyHealth(page({ requestedUrl: 'https://www.example.com/optout', url: 'https://privacy.other.example/request', missing: ['x'] }));
    assert.equal(r.status, 'drifted');
    assert.match(r.detail, /privacy\.other\.example/);
  });
});

describe('a page on another domain (H5)', () => {
  const moved = (over = {}) => page({
    requestedUrl: 'https://www.example.com/optout', url: 'https://parked.example.net/for-sale', ...over,
  });

  test('a final URL on a different registrable domain is drifted, and the detail says where', () => {
    const r = classifyHealth(moved());
    assert.equal(r.status, 'drifted');
    assert.match(r.detail, /redirected to parked\.example\.net/);
    assert.equal(r.redirectedTo, 'parked.example.net');
  });

  test('for every method: a manual broker (no selectors) that lands on a parking page is drifted too', () => {
    const r = classifyHealth(moved({ selectors: [], missing: [], method: 'manual' }));
    assert.equal(r.status, 'drifted');
    assert.match(r.detail, /redirected to parked\.example\.net/);
  });

  test('another subdomain of the same site is not a redirect off the site', () => {
    const r = classifyHealth(page({ requestedUrl: 'https://www.example.com/optout', url: 'https://privacy.example.com/request' }));
    assert.equal(r.status, 'ok');
  });

  test('two unrelated .co.uk sites are two sites', () => {
    const r = classifyHealth(page({ requestedUrl: 'https://www.one.co.uk/optout', url: 'https://www.two.co.uk/optout' }));
    assert.equal(r.status, 'drifted');
  });

  test('a redirect to a challenge page is still blocked: the wall wins', () => {
    const r = classifyHealth(moved({ url: 'https://other.example.net/captcha?x=1' }));
    assert.equal(r.status, 'blocked');
  });

  test('the missing selectors are not reported for a page on another domain: they were never looked for on the right page', () => {
    const r = classifyHealth(moved({ missing: ['input[name="email"]'] }));
    assert.equal(r.status, 'drifted');
    assert.equal(r.missing, undefined);
  });
});

describe('a manual broker is only checked for answering (H5)', () => {
  test('the label stays ok, but the detail says what was and was not checked', () => {
    const r = classifyHealth(page({ selectors: [], missing: [], method: 'manual' }));
    assert.equal(r.status, 'ok');
    assert.match(r.detail, /the page answers; a manual broker's form is not checked/);
  });
});

describe('blocked, never drifted', () => {
  test('a Cloudflare interstitial', () => {
    const r = classifyHealth(page({ markers: ['cloudflare-challenge'], missing: ['x', 'y'] }));
    assert.equal(r.status, 'blocked');
    assert.equal(r.missing, undefined);
  });

  test('wall wording on a short page, with every selector missing', () => {
    const r = classifyHealth(page({ title: 'Just a moment...', text: 'checking your browser before accessing example.com', textLength: 50, missing: ['x', 'y'] }));
    assert.equal(r.status, 'blocked');
  });

  test('403 and 429', () => {
    assert.equal(classifyHealth(page({ status: 403, missing: ['x'] })).status, 'blocked');
    assert.equal(classifyHealth(page({ status: 429, missing: ['x'] })).status, 'blocked');
  });

  test('a challenge-style 503 (cloudflare mitigation header, or wall text)', () => {
    assert.equal(classifyHealth(page({ status: 503, headers: { 'cf-mitigated': 'challenge' }, missing: ['x'] })).status, 'blocked');
    assert.equal(classifyHealth(page({ status: 503, markers: ['datadome'], missing: ['x'] })).status, 'blocked');
    assert.equal(classifyHealth(page({ status: 503, title: 'Attention Required! | Cloudflare', missing: ['x'] })).status, 'blocked');
  });

  test('a CAPTCHA on a page where EVERY selector is missing: the widget may be hiding the form', () => {
    const r = classifyHealth(page({ captchaPresent: true, selectors: ['input[name="email"]', 'button[type="submit"]'], missing: ['input[name="email"]', 'button[type="submit"]'] }));
    assert.equal(r.status, 'blocked');
    assert.match(r.detail, /CAPTCHA/);
  });

  test('a visible CAPTCHA widget alone, with every selector missing, is also blocked', () => {
    const r = classifyHealth(page({ markers: ['recaptcha'], selectors: ['a', 'b'], missing: ['a', 'b'] }));
    assert.equal(r.status, 'blocked');
  });

  test('a redirect to a challenge path', () => {
    const r = classifyHealth(page({ url: 'https://www.example.com/captcha?from=%2Foptout', missing: ['x'] }));
    assert.equal(r.status, 'blocked');
  });
});

describe('drift beside a CAPTCHA widget is still drift (H1)', () => {
  // A normal opt-out form carries its usual reCAPTCHA or Turnstile widget. If the
  // site renamed two of four fields, some selectors still match, so the form IS
  // visible: that is drift, and the issue must open.
  test('some selectors match and some do not, with a CAPTCHA widget on the page: drifted', () => {
    const r = classifyHealth(page({
      captchaPresent: true,
      selectors: ['input[name="a"]', 'input[name="b"]', 'input[name="c"]', 'button[type="submit"]'],
      missing: ['input[name="a"]', 'input[name="b"]'],
    }));
    assert.equal(r.status, 'drifted');
    assert.deepEqual(r.missing, ['input[name="a"]', 'input[name="b"]']);
  });

  test('the same with a visible CAPTCHA frame marker (a weak wall) is drifted', () => {
    const r = classifyHealth(page({
      markers: ['turnstile'],
      selectors: ['input[name="a"]', 'button[type="submit"]'],
      missing: ['input[name="a"]'],
    }));
    assert.equal(r.status, 'drifted');
  });

  test('a strong wall still wins over partly matching selectors', () => {
    const r = classifyHealth(page({
      markers: ['cloudflare-challenge'], captchaPresent: true,
      selectors: ['a', 'b'], missing: ['a'],
    }));
    assert.equal(r.status, 'blocked');
  });
});

describe('dead', () => {
  test('a host that does not resolve', () => {
    for (const message of ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.example/', 'getaddrinfo ENOTFOUND x.example']) {
      assert.equal(classifyHealth(failed(message)).status, 'dead', message);
    }
  });

  test('a refused connection', () => {
    for (const message of ['page.goto: net::ERR_CONNECTION_REFUSED at https://x.example/', 'connect ECONNREFUSED 127.0.0.1:9']) {
      assert.equal(classifyHealth(failed(message)).status, 'dead', message);
    }
  });

  test('404 and 410', () => {
    assert.equal(classifyHealth(page({ status: 404, missing: ['x'] })).status, 'dead');
    assert.equal(classifyHealth(page({ status: 410, missing: ['x'] })).status, 'dead');
  });
});

describe('error: shown, never opens an issue', () => {
  test('a timeout is not a dead site', () => {
    const r = classifyHealth(failed('page.goto: Timeout 20000ms exceeded.'));
    assert.equal(r.status, 'error');
    assert.match(r.detail, /timed out/);
  });

  test('a 5xx that is not a challenge', () => {
    for (const status of [500, 502, 503, 504]) {
      assert.equal(classifyHealth(page({ status, missing: ['x'] })).status, 'error', String(status));
    }
  });

  test('a reset connection or a certificate problem', () => {
    assert.equal(classifyHealth(failed('net::ERR_CONNECTION_RESET')).status, 'error');
    assert.equal(classifyHealth(failed('net::ERR_CERT_DATE_INVALID')).status, 'error');
  });

  test('an unexpected 4xx', () => {
    assert.equal(classifyHealth(page({ status: 400, missing: ['x'] })).status, 'error');
  });

  test('a page that rendered nothing at all is not evidence of drift', () => {
    const r = classifyHealth(page({ text: '', textLength: 0, missing: ['x', 'y'] }));
    assert.equal(r.status, 'error');
    assert.match(r.detail, /no content/);
  });

  test('error details never echo the URL (it can carry a person)', () => {
    const r = classifyHealth(failed('page.goto: Timeout 20000ms exceeded. at https://x.example/Jane-Sample/Austin'));
    assert.doesNotMatch(r.detail, /Jane/);
  });
});
