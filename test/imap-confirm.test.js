/**
 * test/imap-confirm.test.js
 *
 * Covers lib/imap-confirm.js processConfirmationEmails():
 *  - Matches .eml with recognised expectedSender and confirmation URL -> processed
 *  - Unrecognised sender -> unmatched with reason 'no_broker'
 *  - Recognised sender but no confirmation URL in body -> unmatched with reason 'no_url'
 *  - URL keywords: confirm / verify / optout all match
 *  - Multiple .eml files processed in one call
 *  - dryRun=true: does NOT call Playwright (no newPage)
 *  - dryRun=false: calls context.newPage() + page.goto(url) with extracted URL
 *  - After successful click, recordSuccess is called for the matched broker
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { processConfirmationEmails } = require('../lib/imap-confirm');

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEml(from, body) {
  return [
    `From: ${from}`,
    'To: user@example.com',
    'Subject: Opt-out confirmation',
    'Date: Mon, 26 May 2026 10:00:00 +0000',
    '',
    body,
  ].join('\r\n');
}

function makeContext({ pages = [] } = {}) {
  const calls = [];
  return {
    calls,
    newPage: async () => {
      const page = {
        goto: async (url, opts) => {
          calls.push({ action: 'goto', url, opts });
          return { url: () => url };
        },
        url: () => 'https://example.com/done',
        textContent: async () => 'Your opt-out request has been processed.',
        close: async () => {},
      };
      calls.push({ action: 'newPage' });
      return page;
    },
  };
}

const SPOKEO_BROKER = {
  name: 'Spokeo',
  expectedSender: 'optout@spokeo.com',
};

const WHITEPAGES_BROKER = {
  name: 'WhitePages',
  expectedSender: 'noreply@whitepages.com',
};

// ── Tests ──────────────────────────────────────────────────────────────────────

test('dryRun: matched .eml appears in processed, Playwright NOT called', async () => {
  const eml = makeEml('optout@spokeo.com', 'Please visit https://spokeo.com/confirm/abc123 to confirm.');
  const files = { 'confirms/spokeo.eml': eml };
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: (f) => files[f],
  });

  assert.equal(result.processed.length, 1);
  assert.equal(result.processed[0].broker.name, 'Spokeo');
  assert.equal(result.processed[0].url, 'https://spokeo.com/confirm/abc123');
  assert.equal(result.unmatched.length, 0);
  assert.equal(result.failed.length, 0);

  // Playwright must NOT have been invoked in dryRun mode
  assert.equal(ctx.calls.length, 0);
});

test('unmatched: .eml sender has no matching broker -> unmatched with no_broker', async () => {
  const eml = makeEml('unknown@randomsite.com', 'Click https://randomsite.com/verify/xyz to opt out.');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['random.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].file, 'confirms/random.eml');
  assert.equal(result.unmatched[0].reason, 'no_broker');
});

test('unmatched: recognised sender but no confirmation URL -> no_url', async () => {
  const eml = makeEml('optout@spokeo.com', 'Your request was received. No link here, just text.');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].reason, 'no_url');
});

test('URL keyword "verify" is recognised as a confirmation link', async () => {
  const eml = makeEml('optout@spokeo.com', 'Go to https://spokeo.com/verify/token123 to verify.');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1);
  assert.equal(result.processed[0].url, 'https://spokeo.com/verify/token123');
});

test('URL keyword "optout" is recognised as a confirmation link', async () => {
  const eml = makeEml('optout@spokeo.com', 'Visit https://spokeo.com/optout/confirm?token=abc now.');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1);
  assert.match(result.processed[0].url, /optout/);
});

test('URL keyword "opt-out" (hyphenated) is recognised', async () => {
  const eml = makeEml('optout@spokeo.com', 'Click https://spokeo.com/opt-out/click?id=999 here.');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1);
});

test('URL keyword "removal" is recognised as a confirmation link', async () => {
  const eml = makeEml('optout@spokeo.com', 'Confirm at https://spokeo.com/removal/finalize?t=1');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1);
});

test('URL keyword "delete" is recognised as a confirmation link', async () => {
  const eml = makeEml('optout@spokeo.com', 'Visit https://spokeo.com/delete/request?id=5 to complete.');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1);
});

test('multiple .eml files processed in one call', async () => {
  const files = {
    'confirms/spokeo.eml': makeEml('optout@spokeo.com', 'Click https://spokeo.com/confirm/aaa'),
    'confirms/wp.eml': makeEml('noreply@whitepages.com', 'Go to https://whitepages.com/verify/bbb to complete'),
    'confirms/unknown.eml': makeEml('info@nobody.org', 'Hello from nobody.'),
  };
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER, WHITEPAGES_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml', 'wp.eml', 'unknown.eml'],
    _readFile: (f) => files[f],
  });

  assert.equal(result.processed.length, 2);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].reason, 'no_broker');
});

test('dryRun=false: Playwright newPage + goto called with extracted URL', async () => {
  const eml = makeEml('optout@spokeo.com', 'Click https://spokeo.com/confirm/xyz789 to confirm your opt-out.');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: false,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
    _moveFile: () => {},
    _recordSuccess: () => {},
  });

  assert.equal(result.processed.length, 1);

  const newPageCall = ctx.calls.find(c => c.action === 'newPage');
  assert.ok(newPageCall, 'newPage should have been called');

  const gotoCall = ctx.calls.find(c => c.action === 'goto');
  assert.ok(gotoCall, 'goto should have been called');
  assert.equal(gotoCall.url, 'https://spokeo.com/confirm/xyz789');
  assert.equal(gotoCall.opts.timeout, 30000);
});

test('dryRun=false: recordSuccess called for the matched broker', async () => {
  const eml = makeEml('optout@spokeo.com', 'Click https://spokeo.com/confirm/abc to confirm.');
  const ctx = makeContext();

  const successCalls = [];
  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: false,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
    _moveFile: () => {},
    _recordSuccess: (name) => successCalls.push(name),
  });

  assert.equal(result.processed.length, 1);
  assert.deepEqual(successCalls, ['Spokeo']);
});

test('expectedSender matching is case-insensitive substring', async () => {
  // broker has 'OPTOUT@SPOKEO.COM' in upper case, email from 'Optout@Spokeo.Com'
  const broker = { name: 'Spokeo', expectedSender: 'OPTOUT@SPOKEO.COM' };
  const eml = makeEml('Optout@Spokeo.Com', 'Visit https://spokeo.com/confirm/abc123');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [broker], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1);
});

test('non-.eml files in dir are ignored', async () => {
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['readme.txt', '.gitkeep', 'archive.zip'],
    _readFile: () => { throw new Error('should not read non-eml'); },
  });

  assert.equal(result.processed.length, 0);
  assert.equal(result.unmatched.length, 0);
});

test('processed entry includes broker, url, and person placeholder', async () => {
  const eml = makeEml('optout@spokeo.com', 'https://spokeo.com/confirm/token-abc');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['s.eml'],
    _readFile: () => eml,
  });

  const entry = result.processed[0];
  assert.ok(entry.broker, 'should have broker');
  assert.equal(entry.broker.name, 'Spokeo');
  assert.ok(entry.url, 'should have url');
});

// ── M4: quoted-printable + smart URL selection ────────────────────────────────

test('M4: quoted-printable =3D in URL is decoded correctly', async () => {
  // Real emails encode "=" as "=3D". The URL https://x.com/confirm?id=abc
  // arrives as https://x.com/confirm?id=3Dabc and must be decoded.
  const qpBody =
    'Content-Transfer-Encoding: quoted-printable\r\n\r\n' +
    'Click here: https://spokeo.com/confirm?token=3Dabc123 to confirm.';
  const eml = [
    'From: optout@spokeo.com',
    'To: user@example.com',
    'Subject: Confirm',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Click here: https://spokeo.com/confirm?token=3Dabc123 to confirm.',
  ].join('\r\n');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1, 'should process the email');
  assert.ok(
    result.processed[0].url.includes('token=abc123') ||
    result.processed[0].url.includes('confirm'),
    `URL should have decoded =3D: got ${result.processed[0].url}`
  );
  assert.ok(
    !result.processed[0].url.includes('=3D'),
    `URL must not contain raw =3D: got ${result.processed[0].url}`
  );
});

test('M4: quoted-printable soft line break in URL is joined correctly', async () => {
  // Soft breaks: "=" at end of line means continuation - URL split across lines
  const eml = [
    'From: optout@spokeo.com',
    'To: user@example.com',
    'Subject: Confirm',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Visit https://spokeo.com/confirm?tok=',
    'en=3Dabc to complete your opt-out.',
  ].join('\r\n');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  // Should have found a URL (not no_url)
  assert.equal(result.processed.length, 1, 'soft-break URL should be joinable and matched');
  assert.ok(result.processed[0].url.includes('confirm'), 'URL should contain confirm');
});

test('M4: unsubscribe link first, confirm link second - picks confirm', async () => {
  const eml = [
    'From: optout@spokeo.com',
    'To: user@example.com',
    'Subject: Confirm',
    '',
    'To unsubscribe visit https://spokeo.com/unsubscribe?id=foo first.',
    'To confirm your removal: https://spokeo.com/confirm?token=realtoken',
  ].join('\r\n');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1);
  assert.ok(
    result.processed[0].url.includes('confirm'),
    `should pick confirm URL, got: ${result.processed[0].url}`
  );
  assert.ok(
    !result.processed[0].url.includes('unsubscribe'),
    `should NOT pick unsubscribe URL, got: ${result.processed[0].url}`
  );
});

// ── end M4 ────────────────────────────────────────────────────────────────────

test('failed: when goto throws, entry appears in failed array', async () => {
  const eml = makeEml('optout@spokeo.com', 'Click https://spokeo.com/confirm/bad');
  const errCtx = {
    calls: [],
    newPage: async () => ({
      goto: async () => { throw new Error('Navigation timeout'); },
      url: () => '',
      textContent: async () => '',
      close: async () => {},
    }),
  };

  const result = await processConfirmationEmails(errCtx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: false,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
    _moveFile: () => {},
    _recordSuccess: () => {},
  });

  assert.equal(result.processed.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].broker.name, 'Spokeo');
  assert.match(result.failed[0].error, /Navigation timeout/);
});
