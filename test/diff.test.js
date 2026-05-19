'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { diffResults, loadPreviousLog } = require('../lib/diff');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const prevResults = {
  runAt: '2026-05-18T10:00:00.000Z',
  succeeded: [
    { broker: 'Spokeo', status: 'success', detail: '' },
    { broker: 'Radaris', status: 'success', detail: '' },
    { broker: 'BeenVerified', status: 'success', detail: '' },
  ],
  notFound: [
    { broker: 'PeopleFinder', status: 'notFound', detail: '' },
  ],
  errors: [],
  skipped: [],
  captchaFailed: [],
  pendingConfirm: [],
};

const currResults = {
  runAt: '2026-05-19T10:00:00.000Z',
  succeeded: [
    { broker: 'Spokeo', status: 'success', detail: '' },     // still succeeded
    { broker: 'PeopleFinder', status: 'success', detail: '' }, // newly removed (was notFound)
  ],
  notFound: [
    { broker: 'Radaris', status: 'notFound', detail: '' },   // new exposure (was succeeded)
  ],
  errors: [
    { broker: 'BeenVerified', status: 'error', detail: '' }, // regressed (was succeeded)
  ],
  skipped: [],
  captchaFailed: [],
  pendingConfirm: [],
};

// ── diffResults tests ─────────────────────────────────────────────────────────

describe('diffResults', () => {
  it('detects new exposures — brokers previously succeeded but now in notFound', () => {
    const diff = diffResults(prevResults, currResults);
    assert.deepEqual(diff.newExposures, ['Radaris']);
  });

  it('detects newly removed — brokers now succeeded that were not previously succeeded', () => {
    const diff = diffResults(prevResults, currResults);
    assert.deepEqual(diff.newlyRemoved, ['PeopleFinder']);
  });

  it('detects regressions — brokers previously succeeded but now in errors', () => {
    const diff = diffResults(prevResults, currResults);
    assert.deepEqual(diff.regressed, ['BeenVerified']);
  });

  it('formats a human-readable summary line', () => {
    const diff = diffResults(prevResults, currResults);
    assert.equal(
      diff.summary,
      'Since last run: +1 new exposures, +1 newly removed, 1 regressed.'
    );
  });

  it('no changes returns zeroed summary', () => {
    const same = { ...prevResults, runAt: '2026-05-19T00:00:00.000Z' };
    const diff = diffResults(prevResults, same);
    assert.deepEqual(diff.newExposures, []);
    assert.deepEqual(diff.newlyRemoved, []);
    assert.deepEqual(diff.regressed, []);
    assert.equal(diff.summary, 'Since last run: +0 new exposures, +0 newly removed, 0 regressed.');
  });

  it('when prev is null, treats all current brokers as newly attempted', () => {
    const diff = diffResults(null, currResults);
    const allCurrent = [
      ...currResults.succeeded,
      ...currResults.notFound,
      ...currResults.errors,
    ].map(r => r.broker).sort();
    assert.deepEqual(diff.newlyRemoved.sort(), allCurrent);
    assert.deepEqual(diff.newExposures, []);
    assert.deepEqual(diff.regressed, []);
    assert.match(diff.summary, /newly attempted/);
  });
});

// ── loadPreviousLog tests ─────────────────────────────────────────────────────

describe('loadPreviousLog', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no run-*.json files exist in the directory', () => {
    const result = loadPreviousLog(tmpDir, 'run-2026-05-19.json');
    assert.equal(result, null);
  });

  it('returns null when only the current file exists', () => {
    const current = path.join(tmpDir, 'run-2026-05-19.json');
    fs.writeFileSync(current, JSON.stringify(currResults));
    const result = loadPreviousLog(tmpDir, 'run-2026-05-19.json');
    assert.equal(result, null);
  });

  it('returns the newest run-*.json that is not the current file', () => {
    const older = path.join(tmpDir, 'run-2026-05-17.json');
    const newer = path.join(tmpDir, 'run-2026-05-18.json');
    const current = path.join(tmpDir, 'run-2026-05-19.json');
    fs.writeFileSync(older, JSON.stringify({ ...prevResults, runAt: '2026-05-17T10:00:00.000Z' }));
    fs.writeFileSync(newer, JSON.stringify(prevResults));
    fs.writeFileSync(current, JSON.stringify(currResults));

    const result = loadPreviousLog(tmpDir, 'run-2026-05-19.json');
    assert.ok(result !== null, 'Expected a previous log, got null');
    assert.equal(result.runAt, prevResults.runAt);
  });

  it('accepts an absolute current file path and still matches by basename', () => {
    const current = path.join(tmpDir, 'run-2026-05-19.json');
    const result = loadPreviousLog(tmpDir, current);
    assert.ok(result !== null);
  });
});
