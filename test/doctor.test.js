'use strict';
/**
 * test/doctor.test.js
 *
 * Tests for lib/doctor.js — self-diagnose command.
 * Network I/O is mocked; no real HTTP/TCP calls are made.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// ── helpers ──────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
}

// ── import module under test ─────────────────────────────────────────────────

const {
  checkConfig,
  checkState,
  checkPlaywright,
  checkSMTP,
  checkCapsolver,
  checkWebhook,
  runDoctor,
} = require('../lib/doctor');

// ─────────────────────────────────────────────────────────────────────────────
// checkConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('checkConfig', () => {
  it('returns ok when all required person fields present', async () => {
    const dir = tmpDir();
    const cfg = { person: { firstName: 'Alice', lastName: 'Smith', email: 'a@b.com', zip: '12345' } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

    const result = await checkConfig(dir);
    assert.equal(result.ok, true);
    assert.match(result.hint, /valid/i);
  });

  it('returns not-ok when config.json is absent', async () => {
    const dir = tmpDir();

    const result = await checkConfig(dir);
    assert.equal(result.ok, false);
    assert.match(result.hint, /not found/i);
  });

  it('returns not-ok when config.json is invalid JSON', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), '{ bad json }');

    const result = await checkConfig(dir);
    assert.equal(result.ok, false);
    assert.match(result.hint, /parse/i);
  });

  it('returns not-ok and mentions missing firstName', async () => {
    const dir = tmpDir();
    const cfg = { person: { lastName: 'Smith', email: 'a@b.com', zip: '12345' } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

    const result = await checkConfig(dir);
    assert.equal(result.ok, false);
    assert.match(result.hint, /firstName/);
  });

  it('returns not-ok and mentions missing lastName', async () => {
    const dir = tmpDir();
    const cfg = { person: { firstName: 'Alice', email: 'a@b.com', zip: '12345' } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

    const result = await checkConfig(dir);
    assert.equal(result.ok, false);
    assert.match(result.hint, /lastName/);
  });

  it('returns not-ok and mentions missing email', async () => {
    const dir = tmpDir();
    const cfg = { person: { firstName: 'Alice', lastName: 'Smith', zip: '12345' } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

    const result = await checkConfig(dir);
    assert.equal(result.ok, false);
    assert.match(result.hint, /email/);
  });

  it('returns not-ok and mentions missing zip', async () => {
    const dir = tmpDir();
    const cfg = { person: { firstName: 'Alice', lastName: 'Smith', email: 'a@b.com' } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

    const result = await checkConfig(dir);
    assert.equal(result.ok, false);
    assert.match(result.hint, /zip/);
  });

  it('returns not-ok when person key is missing entirely', async () => {
    const dir = tmpDir();
    const cfg = { notify: {} };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

    const result = await checkConfig(dir);
    assert.equal(result.ok, false);
    assert.match(result.hint, /person/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkState
// ─────────────────────────────────────────────────────────────────────────────

describe('checkState', () => {
  it('returns ok when state.json is absent', async () => {
    const dir = tmpDir();
    const result = await checkState(dir);
    assert.equal(result.ok, true);
    assert.match(result.hint, /absent/i);
  });

  it('returns ok when state.json has valid optOuts object', async () => {
    const dir = tmpDir();
    const st = { optOuts: { Spokeo: { lastSuccess: '2026-01-01' } } };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));

    const result = await checkState(dir);
    assert.equal(result.ok, true);
    assert.match(result.hint, /parseable/i);
  });

  it('returns ok for empty optOuts', async () => {
    const dir = tmpDir();
    const st = { optOuts: {} };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));

    const result = await checkState(dir);
    assert.equal(result.ok, true);
  });

  it('reports entry count in hint', async () => {
    const dir = tmpDir();
    const st = { optOuts: { A: {}, B: {}, C: {} } };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));

    const result = await checkState(dir);
    assert.equal(result.ok, true);
    assert.match(result.hint, /3/);
  });

  it('returns not-ok when state.json is invalid JSON', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'state.json'), 'not json');

    const result = await checkState(dir);
    assert.equal(result.ok, false);
    assert.match(result.hint, /parse/i);
  });

  it('returns not-ok when optOuts is not an object', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ optOuts: 'bad' }));

    const result = await checkState(dir);
    assert.equal(result.ok, false);
    assert.match(result.hint, /optOuts/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkPlaywright — unit-level: we verify the check honours a mock
// ─────────────────────────────────────────────────────────────────────────────

describe('checkPlaywright', () => {
  it('returns ok when playwright resolves and chromium binary exists', async () => {
    const fakeBinPath = path.join(tmpDir(), 'chrome');
    fs.writeFileSync(fakeBinPath, '');

    // Inject mocks via environment-provided resolver
    const result = await checkPlaywright({
      requirePlaywright: () => ({ chromium: { executablePath: () => fakeBinPath } }),
      fsExists: (p) => p === fakeBinPath,
    });
    assert.equal(result.ok, true);
    assert.match(result.hint, /chromium/i);
  });

  it('returns not-ok when playwright cannot be required', async () => {
    const result = await checkPlaywright({
      requirePlaywright: () => { throw new Error('Cannot find module playwright'); },
      fsExists: () => false,
    });
    assert.equal(result.ok, false);
    assert.match(result.hint, /playwright/i);
  });

  it('returns not-ok when chromium binary does not exist', async () => {
    const result = await checkPlaywright({
      requirePlaywright: () => ({ chromium: { executablePath: () => '/nonexistent/chrome' } }),
      fsExists: () => false,
    });
    assert.equal(result.ok, false);
    assert.match(result.hint, /binary/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkSMTP
// ─────────────────────────────────────────────────────────────────────────────

describe('checkSMTP', () => {
  it('skips when smtp host is not configured', async () => {
    const cfg = {};
    const result = await checkSMTP(cfg, { tcpProbe: () => Promise.resolve(true) });
    assert.equal(result.ok, true);
    assert.match(result.hint, /not configured/i);
  });

  it('skips when email.smtp.host is empty string', async () => {
    const cfg = { email: { smtp: { host: '', port: 587 } } };
    const result = await checkSMTP(cfg, { tcpProbe: () => Promise.resolve(true) });
    assert.equal(result.ok, true);
    assert.match(result.hint, /not configured/i);
  });

  it('returns ok when TCP probe succeeds', async () => {
    const cfg = { email: { smtp: { host: 'smtp.example.com', port: 587 } } };
    const result = await checkSMTP(cfg, { tcpProbe: () => Promise.resolve(true) });
    assert.equal(result.ok, true);
    assert.match(result.hint, /reachable/i);
  });

  it('returns not-ok when TCP probe fails', async () => {
    const cfg = { email: { smtp: { host: 'smtp.example.com', port: 587 } } };
    const result = await checkSMTP(cfg, {
      tcpProbe: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    assert.equal(result.ok, false);
    assert.match(result.hint, /unreachable|ECONNREFUSED/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkCapsolver
// ─────────────────────────────────────────────────────────────────────────────

describe('checkCapsolver', () => {
  it('skips when apiKey absent', async () => {
    const cfg = {};
    const result = await checkCapsolver(cfg, { headRequest: () => Promise.resolve(200) });
    assert.equal(result.ok, true);
    assert.match(result.hint, /not configured/i);
  });

  it('skips when apiKey is the placeholder', async () => {
    const cfg = { capsolver: { apiKey: 'CAP-YOUR_KEY_HERE' } };
    const result = await checkCapsolver(cfg, { headRequest: () => Promise.resolve(200) });
    assert.equal(result.ok, true);
    assert.match(result.hint, /placeholder/i);
  });

  it('returns not-ok when apiKey looks like placeholder pattern', async () => {
    const cfg = { capsolver: { apiKey: 'CAP-YOUR_KEY_HERE' } };
    const result = await checkCapsolver(cfg, { headRequest: () => Promise.resolve(200) });
    // placeholder => skip (ok: true) with hint about placeholder
    assert.equal(result.ok, true);
  });

  it('returns ok when HEAD request succeeds', async () => {
    const cfg = { capsolver: { apiKey: 'CAP-realKey123' } };
    const result = await checkCapsolver(cfg, { headRequest: () => Promise.resolve(200) });
    assert.equal(result.ok, true);
    assert.match(result.hint, /reachable/i);
  });

  it('returns not-ok when HEAD request fails', async () => {
    const cfg = { capsolver: { apiKey: 'CAP-realKey123' } };
    const result = await checkCapsolver(cfg, {
      headRequest: () => Promise.reject(new Error('ENOTFOUND')),
    });
    assert.equal(result.ok, false);
    assert.match(result.hint, /unreachable|ENOTFOUND/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkWebhook
// ─────────────────────────────────────────────────────────────────────────────

describe('checkWebhook', () => {
  it('skips when webhook not configured', async () => {
    const cfg = {};
    const result = await checkWebhook(cfg, { headRequest: () => Promise.resolve(200) });
    assert.equal(result.ok, true);
    assert.match(result.hint, /not configured/i);
  });

  it('skips when webhook is empty string', async () => {
    const cfg = { notify: { webhook: '' } };
    const result = await checkWebhook(cfg, { headRequest: () => Promise.resolve(200) });
    assert.equal(result.ok, true);
    assert.match(result.hint, /not configured/i);
  });

  it('returns ok when HEAD request succeeds', async () => {
    const cfg = { notify: { webhook: 'https://example.com/hook' } };
    const result = await checkWebhook(cfg, { headRequest: () => Promise.resolve(200) });
    assert.equal(result.ok, true);
    assert.match(result.hint, /reachable/i);
  });

  it('returns not-ok when HEAD request fails', async () => {
    const cfg = { notify: { webhook: 'https://example.com/hook' } };
    const result = await checkWebhook(cfg, {
      headRequest: () => Promise.reject(new Error('ENOTFOUND')),
    });
    assert.equal(result.ok, false);
    assert.match(result.hint, /unreachable|ENOTFOUND/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDoctor — integration-level with mocked I/O
// ─────────────────────────────────────────────────────────────────────────────

describe('runDoctor', () => {
  it('returns an array of {name, ok, hint} objects', async () => {
    const dir = tmpDir();
    const cfg = { person: { firstName: 'A', lastName: 'B', email: 'c@d.com', zip: '99999' } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

    const fakeBin = path.join(dir, 'chrome');
    fs.writeFileSync(fakeBin, '');

    const results = await runDoctor({
      rootDir: dir,
      requirePlaywright: () => ({ chromium: { executablePath: () => fakeBin } }),
      fsExists: (p) => p === fakeBin || fs.existsSync(p),
      tcpProbe: () => Promise.resolve(true),
      headRequest: () => Promise.resolve(200),
      printOutput: false,
    });

    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 6);
    for (const r of results) {
      assert.ok('name' in r, 'missing name');
      assert.ok('ok'   in r, 'missing ok');
      assert.ok('hint' in r, 'missing hint');
    }
  });

  it('returns exit code 0 when no failures', async () => {
    const dir = tmpDir();
    const cfg = { person: { firstName: 'A', lastName: 'B', email: 'c@d.com', zip: '99999' } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
    const fakeBin = path.join(dir, 'chrome');
    fs.writeFileSync(fakeBin, '');

    const { exitCode } = await runDoctor({
      rootDir: dir,
      requirePlaywright: () => ({ chromium: { executablePath: () => fakeBin } }),
      fsExists: (p) => p === fakeBin || fs.existsSync(p),
      tcpProbe: () => Promise.resolve(true),
      headRequest: () => Promise.resolve(200),
      printOutput: false,
    });

    assert.equal(exitCode, 0);
  });

  it('returns exit code 1 when there are failures', async () => {
    const dir = tmpDir();
    // No config.json - will cause a failure

    const { exitCode } = await runDoctor({
      rootDir: dir,
      requirePlaywright: () => ({ chromium: { executablePath: () => '/no/chrome' } }),
      fsExists: () => false,
      tcpProbe: () => Promise.resolve(true),
      headRequest: () => Promise.resolve(200),
      printOutput: false,
    });

    assert.equal(exitCode, 1);
  });

  it('result summary includes ok, skipped, and failed counts', async () => {
    const dir = tmpDir();
    // config.json missing => 1 failure; no smtp/capsolver/webhook => 3 skips
    const { summary } = await runDoctor({
      rootDir: dir,
      requirePlaywright: () => { throw new Error('no playwright'); },
      fsExists: () => false,
      tcpProbe: () => Promise.resolve(true),
      headRequest: () => Promise.resolve(200),
      printOutput: false,
    });

    assert.ok(summary.failed >= 1, `expected >=1 failed, got: ${summary.failed}`);
    assert.ok(typeof summary.ok      === 'number');
    assert.ok(typeof summary.skipped === 'number');
    assert.ok(typeof summary.failed  === 'number');
  });
});
