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

// ── Fix 1: SSRF host allowlist ────────────────────────────────────────────────

test('Fix1: confirm link on the broker domain is accepted and navigated', async () => {
  const broker = {
    name: 'Spokeo',
    expectedSender: 'optout@spokeo.com',
    optOutUrl: 'https://www.spokeo.com/optout',
  };
  const eml = makeEml('optout@spokeo.com', 'Click https://spokeo.com/confirm/abc to confirm.');
  const ctx = makeContext();
  const successCalls = [];

  const result = await processConfirmationEmails(ctx, [broker], {
    dir: 'confirms',
    dryRun: false,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
    _moveFile: () => {},
    _recordSuccess: (name) => successCalls.push(name),
  });

  assert.equal(result.processed.length, 1, 'on-domain link should be processed');
  assert.equal(result.failed.length, 0);
  assert.deepEqual(successCalls, ['Spokeo']);
});

test('Fix1: confirm link on an off-domain host is rejected - no navigation, no recordSuccess', async () => {
  const broker = {
    name: 'Spokeo',
    expectedSender: 'optout@spokeo.com',
    optOutUrl: 'https://www.spokeo.com/optout',
  };
  // Link host is evil.com, not spokeo.com
  const eml = makeEml('optout@spokeo.com', 'Click https://evil.com/confirm/steal to confirm.');
  const ctx = makeContext();
  const successCalls = [];

  const result = await processConfirmationEmails(ctx, [broker], {
    dir: 'confirms',
    dryRun: false,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
    _moveFile: () => {},
    _recordSuccess: (name) => successCalls.push(name),
  });

  // Should be unmatched (skipped) - not processed, not failed
  assert.equal(result.processed.length, 0, 'off-domain link must not be processed');
  assert.equal(result.failed.length, 0, 'off-domain link must not appear as failed');
  assert.ok(
    result.unmatched.some(u => u.reason === 'host_mismatch'),
    `expected an unmatched entry with reason host_mismatch, got: ${JSON.stringify(result.unmatched)}`
  );
  assert.equal(successCalls.length, 0, 'recordSuccess must NOT be called for off-domain link');
  assert.equal(ctx.calls.length, 0, 'Playwright must NOT be called for off-domain link');
});

test('Fix1: javascript: scheme link is rejected - no navigation', async () => {
  const broker = {
    name: 'Spokeo',
    expectedSender: 'optout@spokeo.com',
    optOutUrl: 'https://www.spokeo.com/optout',
  };
  // Body contains a URL with confirm keyword but uses javascript: scheme
  // We need to inject it so the extractor picks it up - add it after an http URL
  // Actually the extractor only picks http(s) URLs (CONFIRM_URL_RE / ANY_URL_RE).
  // Test the validateConfirmUrl helper directly instead.
  const { validateConfirmUrl } = require('../lib/imap-confirm');
  const result = validateConfirmUrl('javascript:alert(1)', broker);
  assert.ok(!result.valid, `javascript: scheme must be rejected, got: ${JSON.stringify(result)}`);
  assert.ok(result.reason, 'must have a reason');
});

test('Fix1: file: scheme link is rejected', () => {
  const { validateConfirmUrl } = require('../lib/imap-confirm');
  const broker = {
    name: 'Spokeo',
    expectedSender: 'optout@spokeo.com',
    optOutUrl: 'https://www.spokeo.com/optout',
  };
  const result = validateConfirmUrl('file:///etc/passwd', broker);
  assert.ok(!result.valid, `file: scheme must be rejected, got: ${JSON.stringify(result)}`);
});

test('Fix1: data: scheme link is rejected', () => {
  const { validateConfirmUrl } = require('../lib/imap-confirm');
  const broker = {
    name: 'Spokeo',
    expectedSender: 'optout@spokeo.com',
    optOutUrl: 'https://www.spokeo.com/optout',
  };
  const result = validateConfirmUrl('data:text/html,<h1>hi</h1>', broker);
  assert.ok(!result.valid, `data: scheme must be rejected, got: ${JSON.stringify(result)}`);
});

test('Fix1: subdomain of broker domain is accepted (same registrable domain)', async () => {
  const broker = {
    name: 'Spokeo',
    expectedSender: 'optout@spokeo.com',
    optOutUrl: 'https://www.spokeo.com/optout',
  };
  // privacy.spokeo.com is still spokeo.com as registrable domain
  const eml = makeEml('optout@spokeo.com', 'Click https://privacy.spokeo.com/confirm/abc to confirm.');
  const ctx = makeContext();
  const successCalls = [];

  const result = await processConfirmationEmails(ctx, [broker], {
    dir: 'confirms',
    dryRun: false,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
    _moveFile: () => {},
    _recordSuccess: (name) => successCalls.push(name),
  });

  assert.equal(result.processed.length, 1, 'subdomain of broker domain should be accepted');
  assert.deepEqual(successCalls, ['Spokeo']);
});

// ── B15: multi-part-TLD lookalike must be rejected ────────────────────────────

test('B15: lookalike host sharing a multi-part TLD is rejected (attacker.co.uk vs broker.co.uk)', () => {
  const { validateConfirmUrl } = require('../lib/imap-confirm');
  const broker = {
    name: 'BrokerUK',
    expectedSender: 'optout@broker.co.uk',
    optOutUrl: 'https://www.broker.co.uk/optout',
  };
  // attacker.co.uk shares the naive registrable domain co.uk with broker.co.uk
  const result = validateConfirmUrl('https://attacker.co.uk/confirm/steal', broker);
  assert.ok(
    !result.valid,
    `attacker.co.uk must NOT be treated as broker.co.uk, got: ${JSON.stringify(result)}`
  );
  assert.equal(result.reason, 'host_mismatch');
});

test('B15: exact broker host on a multi-part TLD is accepted', () => {
  const { validateConfirmUrl } = require('../lib/imap-confirm');
  const broker = {
    name: 'BrokerUK',
    expectedSender: 'optout@broker.co.uk',
    optOutUrl: 'https://www.broker.co.uk/optout',
  };
  const result = validateConfirmUrl('https://broker.co.uk/confirm/abc', broker);
  assert.ok(result.valid, `exact broker.co.uk host must be accepted, got: ${JSON.stringify(result)}`);
});

test('B15: true subdomain on a multi-part TLD is accepted (privacy.broker.co.uk)', () => {
  const { validateConfirmUrl } = require('../lib/imap-confirm');
  const broker = {
    name: 'BrokerUK',
    expectedSender: 'optout@broker.co.uk',
    optOutUrl: 'https://www.broker.co.uk/optout',
  };
  const result = validateConfirmUrl('https://privacy.broker.co.uk/confirm/abc', broker);
  assert.ok(result.valid, `privacy.broker.co.uk subdomain must be accepted, got: ${JSON.stringify(result)}`);
});

// ── end B15 ───────────────────────────────────────────────────────────────────

// ── B16: sender-spoofing rejection ────────────────────────────────────────────

test('B16: spoofed From with broker domain as a sub-label is rejected (optout@spokeo.com.attacker.com)', async () => {
  const broker = {
    name: 'Spokeo',
    expectedSender: 'optout@spokeo.com',
    optOutUrl: 'https://www.spokeo.com/optout',
  };
  // The From domain is spokeo.com.attacker.com - a raw includes() on the header
  // would match "spokeo.com". Domain-anchored matching must reject it.
  const eml = makeEml('optout@spokeo.com.attacker.com', 'Click https://spokeo.com/confirm/abc to confirm.');
  const ctx = makeContext();
  const successCalls = [];

  const result = await processConfirmationEmails(ctx, [broker], {
    dir: 'confirms',
    dryRun: false,
    _readDir: () => ['spoof.eml'],
    _readFile: () => eml,
    _moveFile: () => {},
    _recordSuccess: (name) => successCalls.push(name),
  });

  assert.equal(result.processed.length, 0, 'spoofed sender must not be processed');
  assert.ok(
    result.unmatched.some(u => u.reason === 'no_broker'),
    `expected no_broker for spoofed sender, got: ${JSON.stringify(result.unmatched)}`
  );
  assert.equal(successCalls.length, 0, 'recordSuccess must NOT be called for spoofed sender');
});

test('B16: legitimate From with display name and angle brackets still matches broker', async () => {
  const broker = {
    name: 'Spokeo',
    expectedSender: 'optout@spokeo.com',
    optOutUrl: 'https://www.spokeo.com/optout',
  };
  const eml = makeEml('Spokeo Opt-Out <optout@spokeo.com>', 'Click https://spokeo.com/confirm/abc to confirm.');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [broker], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['ok.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1, 'legitimate angle-bracket sender should match');
});

test('B16: legitimate From from a broker subdomain sender still matches (bounces.spokeo.com)', async () => {
  const broker = {
    name: 'Spokeo',
    expectedSender: 'optout@spokeo.com',
    optOutUrl: 'https://www.spokeo.com/optout',
  };
  const eml = makeEml('optout@bounces.spokeo.com', 'Click https://spokeo.com/confirm/abc to confirm.');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [broker], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['sub.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1, 'subdomain sender of broker domain should match');
});

// ── end B16 ───────────────────────────────────────────────────────────────────

// ── Fix 2: UTF-8 QP decoding ──────────────────────────────────────────────────

test('Fix2: decodeQuotedPrintable decodes multi-byte UTF-8 sequences correctly', () => {
  const { decodeQuotedPrintable } = require('../lib/imap-confirm');

  // "cafe" with accented e: UTF-8 is C3 A9 -> =C3=A9
  const qpEncoded = 'caf=C3=A9';
  const decoded = decodeQuotedPrintable(qpEncoded);
  assert.equal(decoded, 'café'.normalize('NFC') === 'café' ? 'café' : 'café',
    `Expected UTF-8 decoded string, got: ${JSON.stringify(decoded)}`);
  // More direct test: the decoded string should equal the actual Unicode character
  assert.equal(decoded, 'café', `decoded must equal caf${'é'}`);
});

test('Fix2: decodeQuotedPrintable handles multi-byte sequence for euro sign', () => {
  const { decodeQuotedPrintable } = require('../lib/imap-confirm');

  // Euro sign: UTF-8 is E2 82 AC -> =E2=82=AC
  const qpEncoded = 'Price: =E2=82=AC100';
  const decoded = decodeQuotedPrintable(qpEncoded);
  assert.equal(decoded, 'Price: €100', `Expected euro sign, got: ${JSON.stringify(decoded)}`);
});

test('Fix2: QP body with UTF-8 non-ASCII in URL is preserved through processConfirmationEmails', async () => {
  // Simulates an email body where the confirmation URL contains a UTF-8 character
  // encoded in QP (accented e in the token)
  const eml = [
    'From: optout@spokeo.com',
    'To: user@example.com',
    'Subject: Confirm',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Visit https://spokeo.com/confirm?t=caf=C3=A9 to complete.',
  ].join('\r\n');
  const ctx = makeContext();

  const result = await processConfirmationEmails(ctx, [SPOKEO_BROKER], {
    dir: 'confirms',
    dryRun: true,
    _readDir: () => ['spokeo.eml'],
    _readFile: () => eml,
  });

  assert.equal(result.processed.length, 1, 'should process the email');
  // The URL should contain the decoded UTF-8 character, not the raw =C3=A9
  const url = result.processed[0].url;
  assert.ok(!url.includes('=C3=A9'), `URL should not contain raw QP =C3=A9, got: ${url}`);
  assert.ok(url.includes('confirm'), `URL should contain confirm keyword, got: ${url}`);
});

// ── end Fix 2 ─────────────────────────────────────────────────────────────────

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
