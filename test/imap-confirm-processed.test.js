/**
 * test/imap-confirm-processed.test.js
 *
 * NET imap minor: moveToProcessed swallowed rename errors, so on a read-only
 * mount the same message stayed in the inbox and was re-clicked on every run
 * (and, once the broker became pending again, would have been recorded as a
 * fresh success from a stale token). A processed-message ledger keyed by
 * Message-ID / content hash makes a message impossible to process twice even
 * when it cannot be moved.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { processConfirmationEmails, createProcessedStore } = require('../lib/imap-confirm');

const SPOKEO = { name: 'Spokeo', expectedSender: 'optout@spokeo.com' };

function eml({ messageId, token = '1' } = {}) {
  return [
    'From: optout@spokeo.com',
    'To: user@example.com',
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    'Subject: Confirm',
    '',
    `Confirm: https://spokeo.com/confirm?t=${token}`,
  ].join('\r\n');
}

function makeContext() {
  const calls = [];
  return {
    calls,
    newPage: async () => ({
      goto: async (url) => { calls.push(url); return { status: () => 200 }; },
      url: () => calls[calls.length - 1],
      textContent: async () => 'Confirmed.',
      close: async () => {},
    }),
  };
}

function memStore() {
  const ids = new Set();
  return { has: (id) => ids.has(id), add: (id) => { ids.add(id); } };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-'));
}

async function runOnce(ctx, files, extra) {
  const successes = [];
  const result = await processConfirmationEmails(ctx, [SPOKEO], {
    dir: 'confirms',
    _readDir: () => Object.keys(files),
    _readFile: (f) => files[require('node:path').basename(f)],
    _recordSuccess: (key) => successes.push(key),
    _isPending: () => true,
    ...extra,
  });
  return { result, successes };
}

test('a message that cannot be moved (read-only mount) is not clicked again on the next run', async () => {
  const ctx = makeContext();
  const store = memStore();
  const files = { 'a.eml': eml() };
  const unmovable = () => { throw new Error('EROFS: read-only file system'); };

  const first = await runOnce(ctx, files, { _moveFile: unmovable, _processedStore: store });
  const second = await runOnce(ctx, files, { _moveFile: unmovable, _processedStore: store });

  assert.equal(first.result.processed.length, 1, 'the click itself succeeded');
  assert.equal(first.result.processed[0].moved, false, 'the entry says the move failed');
  assert.deepEqual(first.successes, ['Spokeo'], 'a throwing mover must not turn a recorded success into a failure');
  assert.equal(second.result.processed.length, 0);
  assert.equal(second.result.unmatched[0].reason, 'already_processed');
  assert.equal(ctx.calls.length, 1, 'navigated exactly once across both runs');
  assert.equal(second.successes.length, 0);
});

test('the same Message-ID in a differently named file is recognised as processed', async () => {
  const ctx = makeContext();
  const store = memStore();

  await runOnce(ctx, { 'a.eml': eml({ messageId: '<abc@spokeo.com>', token: '1' }) }, { _moveFile: () => false, _processedStore: store });
  const again = await runOnce(ctx, { 'copy.eml': eml({ messageId: '<abc@spokeo.com>', token: '2' }) }, { _moveFile: () => false, _processedStore: store });

  assert.equal(again.result.unmatched[0].reason, 'already_processed');
  assert.equal(ctx.calls.length, 1);
});

test('different messages are both processed', async () => {
  const ctx = makeContext();
  const store = memStore();

  const { result } = await runOnce(
    ctx,
    { 'a.eml': eml({ token: '1' }), 'b.eml': eml({ token: '2' }) },
    { _moveFile: () => true, _processedStore: store }
  );

  assert.equal(result.processed.length, 2);
});

test('failed clicks are NOT recorded as processed (a later run may retry)', async () => {
  const store = memStore();
  const failing = { newPage: async () => ({ goto: async () => { throw new Error('timeout'); }, url: () => '', close: async () => {} }) };
  const files = { 'a.eml': eml() };

  const first = await runOnce(failing, files, { _moveFile: () => true, _processedStore: store });
  const ok = makeContext();
  const second = await runOnce(ok, files, { _moveFile: () => true, _processedStore: store });

  assert.equal(first.result.failed.length, 1);
  assert.equal(second.result.processed.length, 1);
});

test('dryRun never writes to the processed ledger', async () => {
  const store = memStore();
  const ctx = makeContext();
  const files = { 'a.eml': eml() };

  await runOnce(ctx, files, { dryRun: true, _processedStore: store });
  const real = await runOnce(ctx, files, { _moveFile: () => true, _processedStore: store });

  assert.equal(real.result.processed.length, 1);
});

test('file-backed ledger persists across runs, lives at processedFile, is mode 0600', async () => {
  const dir = tmpDir();
  const processedFile = path.join(dir, 'confirm-processed.json');
  const files = { 'a.eml': eml({ messageId: '<persist@spokeo.com>' }) };
  const ctx = makeContext();

  await runOnce(ctx, files, { _moveFile: () => false, processedFile });
  const again = await runOnce(ctx, files, { _moveFile: () => false, processedFile });

  assert.equal(again.result.unmatched[0].reason, 'already_processed');
  assert.equal(ctx.calls.length, 1);
  assert.ok(fs.existsSync(processedFile));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(processedFile).mode & 0o777, 0o600);
  }
});

test('createProcessedStore survives a corrupt file and an unwritable location', () => {
  const dir = tmpDir();
  const corrupt = path.join(dir, 'p.json');
  fs.writeFileSync(corrupt, '{not json');

  const store = createProcessedStore(corrupt);
  assert.equal(store.has('mid:x'), false);
  store.add('mid:x');
  assert.equal(store.has('mid:x'), true);

  const blocked = createProcessedStore(path.join(dir, 'file-not-dir', 'nested', 'p.json'));
  fs.writeFileSync(path.join(dir, 'file-not-dir'), 'x');
  assert.doesNotThrow(() => blocked.add('mid:y'));
  assert.equal(blocked.has('mid:y'), true, 'still remembered in memory for the rest of the run');
});
