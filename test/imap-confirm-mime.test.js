/**
 * test/imap-confirm-mime.test.js
 *
 * NET-1 (P1): any email from a broker's domain used to be recorded as a
 * successful opt-out. These tests pin the fix:
 *  - MIME is parsed per part (multipart, per-part Content-Transfer-Encoding,
 *    quoted-printable with soft breaks, base64, charset)
 *  - HTML entities in URLs are decoded (&amp; and double-encoded &amp;amp;)
 *  - the "first neutral link" fallback is gone: a promo mail never gets clicked
 *  - the broker must actually be pending confirmation before anything is clicked
 *  - a navigation response status >= 400 (or no response) is not a success
 *
 * No network, no real state.json: everything is injected.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { processConfirmationEmails, parseEml } = require('../lib/imap-confirm');

const SPOKEO = { name: 'Spokeo', expectedSender: 'optout@spokeo.com' };

function memStore() {
  const ids = new Set();
  return { has: (id) => ids.has(id), add: (id) => { ids.add(id); }, ids };
}

function eml(headers, body) {
  return [
    'From: optout@spokeo.com',
    'To: user@example.com',
    'Subject: Please confirm',
    ...headers,
    '',
    body,
  ].join('\r\n');
}

function makeContext({ status = 200, finalUrl } = {}) {
  const calls = [];
  return {
    calls,
    newPage: async () => {
      let current = 'about:blank';
      return {
        goto: async (url) => {
          calls.push(url);
          current = finalUrl || url;
          return status === null ? null : { status: () => status, url: () => current };
        },
        url: () => current,
        textContent: async () => 'Thanks, you are confirmed.',
        close: async () => {},
      };
    },
  };
}

async function run(content, { pending = true, status = 200, finalUrl, dryRun = false } = {}) {
  const ctx = makeContext({ status, finalUrl });
  const successes = [];
  const result = await processConfirmationEmails(ctx, [SPOKEO], {
    dir: 'confirms',
    dryRun,
    _readDir: () => ['m.eml'],
    _readFile: () => content,
    _moveFile: () => true,
    _recordSuccess: (key, detail) => successes.push({ key, detail }),
    _isPending: () => pending,
    _processedStore: memStore(),
  });
  return { result, ctx, successes };
}

// -- MIME parsing -------------------------------------------------------------

test('multipart/alternative with per-part QP: =3D and soft line breaks are decoded in the clicked URL', async () => {
  const content = eml(
    ['MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="BOUND"'],
    [
      '--BOUND',
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Confirm your removal: https://spokeo.com/confirm?token=3Dabc123def=',
      '456',
      '--BOUND',
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p><a href=3D"https://spokeo.com/confirm?token=3Dabc123def=',
      '456">Confirm</a></p>',
      '--BOUND--',
    ].join('\r\n')
  );

  const { ctx, successes } = await run(content);

  assert.deepEqual(ctx.calls, ['https://spokeo.com/confirm?token=abc123def456']);
  assert.equal(successes.length, 1);
});

test('HTML-only part: &amp; and double-encoded &amp;amp; in the href are decoded', async () => {
  const content = eml(
    ['Content-Type: text/html; charset=utf-8'],
    '<a href="https://spokeo.com/confirm?a=1&amp;b=2&amp;amp;c=3">Confirm</a>'
  );

  const { ctx } = await run(content);

  assert.deepEqual(ctx.calls, ['https://spokeo.com/confirm?a=1&b=2&c=3']);
});

test('base64 encoded text part is decoded', async () => {
  const text = 'Please confirm: https://spokeo.com/verify/zz9plural4';
  const b64 = Buffer.from(text, 'utf8').toString('base64').replace(/(.{40})/g, '$1\r\n');
  const content = eml(
    ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64'],
    b64
  );

  const { ctx } = await run(content);

  assert.deepEqual(ctx.calls, ['https://spokeo.com/verify/zz9plural4']);
});

test('nested multipart/mixed > multipart/alternative is walked, attachments are ignored', async () => {
  const content = eml(
    ['Content-Type: multipart/mixed; boundary="OUTER"'],
    [
      '--OUTER',
      'Content-Type: multipart/alternative; boundary="INNER"',
      '',
      '--INNER',
      'Content-Type: text/plain',
      '',
      'Confirm: https://spokeo.com/confirm/real',
      '--INNER--',
      '--OUTER',
      'Content-Type: text/plain; name="x.txt"',
      'Content-Disposition: attachment; filename="x.txt"',
      '',
      'https://spokeo.com/confirm/from-attachment',
      '--OUTER--',
    ].join('\r\n')
  );

  const { ctx } = await run(content);

  assert.deepEqual(ctx.calls, ['https://spokeo.com/confirm/real']);
});

test('parseEml decodes a latin-1 quoted-printable part with the declared charset', () => {
  const parsed = parseEml(eml(
    ['Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable'],
    'Caf=E9 confirm https://spokeo.com/confirm/x'
  ));

  assert.match(parsed.body, /Café confirm/);
});

test('parseEml unfolds folded headers and keeps From from the header block only', () => {
  const parsed = parseEml([
    'From: "Spokeo Privacy"',
    ' <optout@spokeo.com>',
    'Subject: hi',
    '',
    'From: attacker@evil.example',
    '',
  ].join('\r\n'));

  assert.equal(parsed.from, '"Spokeo Privacy" <optout@spokeo.com>');
});

// -- link selection -----------------------------------------------------------

test('promo-only body (no confirmation link) is NOT clicked and records nothing', async () => {
  const content = eml([], 'Check our plans: https://spokeo.com/pricing and https://spokeo.com/');

  const { result, ctx, successes } = await run(content);

  assert.equal(ctx.calls.length, 0, 'no navigation for a promo mail');
  assert.equal(successes.length, 0, 'recordSuccess must not be called');
  assert.equal(result.unmatched[0].reason, 'no_url');
});

test('a mail with only an unsubscribe link is not clicked', async () => {
  const content = eml([], 'Stop these: https://spokeo.com/unsubscribe?id=4');

  const { ctx, successes } = await run(content);

  assert.equal(ctx.calls.length, 0);
  assert.equal(successes.length, 0);
});

test('strong confirm/verify links are preferred over a generic opt-out landing link', async () => {
  const content = eml([], [
    'Opt out page: https://spokeo.com/optout',
    'Your confirmation link: https://spokeo.com/confirm?t=1',
  ].join('\r\n'));

  const { ctx } = await run(content);

  assert.deepEqual(ctx.calls, ['https://spokeo.com/confirm?t=1']);
});

test('trailing sentence punctuation is not part of the clicked URL', async () => {
  const content = eml([], 'Click https://spokeo.com/confirm?t=1.');

  const { ctx } = await run(content);

  assert.deepEqual(ctx.calls, ['https://spokeo.com/confirm?t=1']);
});

// -- pending gate -------------------------------------------------------------

test('a broker that is not pending confirmation is not clicked and records nothing', async () => {
  const content = eml([], 'Confirm: https://spokeo.com/confirm?t=1');

  const { result, ctx, successes } = await run(content, { pending: false });

  assert.equal(ctx.calls.length, 0);
  assert.equal(successes.length, 0);
  assert.equal(result.unmatched[0].reason, 'not_pending');
});

test('dryRun reports not_pending too, so the preview matches a real run', async () => {
  const content = eml([], 'Confirm: https://spokeo.com/confirm?t=1');

  const { result } = await run(content, { pending: false, dryRun: true });

  assert.equal(result.processed.length, 0);
  assert.equal(result.unmatched[0].reason, 'not_pending');
});

// -- navigation evidence ------------------------------------------------------

test('HTTP 404 on the confirm link is a failure, not a recorded success', async () => {
  const content = eml([], 'Confirm: https://spokeo.com/confirm?t=1');

  const { result, successes } = await run(content, { status: 404 });

  assert.equal(successes.length, 0, 'recordSuccess must not be called on 404');
  assert.equal(result.processed.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /404/);
});

test('HTTP 500 is a failure', async () => {
  const content = eml([], 'Confirm: https://spokeo.com/confirm?t=1');

  const { result, successes } = await run(content, { status: 500 });

  assert.equal(successes.length, 0);
  assert.equal(result.failed.length, 1);
});

test('goto resolving to null (no response) is a failure, not a success', async () => {
  const content = eml([], 'Confirm: https://spokeo.com/confirm?t=1');

  const { result, successes } = await run(content, { status: null });

  assert.equal(successes.length, 0);
  assert.equal(result.failed.length, 1);
});

test('HTTP 200 on a pending broker records exactly one success without leaking the token', async () => {
  const content = eml([], 'Confirm: https://spokeo.com/confirm?token=SECRET123');

  const { result, successes } = await run(content);

  assert.equal(result.processed.length, 1);
  assert.equal(successes.length, 1);
  assert.equal(successes[0].key, 'Spokeo');
  assert.ok(!successes[0].detail.includes('SECRET123'), 'state detail must not store the one-time token');
});

test('an "expired link" landing page is a failure: the broker stays pending', async () => {
  const content = eml([], 'Confirm: https://spokeo.com/confirm?t=1');
  const ctx = {
    newPage: async () => ({
      goto: async (url) => ({ status: () => 200, url: () => url }),
      url: () => 'https://spokeo.com/confirm?t=1',
      textContent: async () => 'Sorry, this confirmation link has expired.',
      close: async () => {},
    }),
  };
  const successes = [];

  const result = await processConfirmationEmails(ctx, [SPOKEO], {
    dir: 'confirms',
    _readDir: () => ['m.eml'],
    _readFile: () => content,
    _moveFile: () => true,
    _recordSuccess: (key) => successes.push(key),
    _isPending: () => true,
    _processedStore: memStore(),
  });

  assert.equal(successes.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, 'link_expired');
});
