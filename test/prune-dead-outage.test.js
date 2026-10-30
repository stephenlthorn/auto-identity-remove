/**
 * test/prune-dead-outage.test.js
 *
 * Review finding: prune-dead.js had no sanity cap. A run made while the machine was
 * offline (or behind a resolver that was down) shows EVERY host failing with
 * ERR_NAME_NOT_RESOLVED, and three such runs would have written the whole broker
 * list into dead-urls.json, silently turning the opt-outs off. A run in which most
 * hosts failed hard is an outage, not evidence about any one host, and is left out.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pruneDeadUrls } = require('../scripts/prune-dead');

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-09-01T03:00:00Z');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-outage-'));
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  const dead = path.join(dir, 'dead-urls.json');
  fs.writeFileSync(dead, JSON.stringify({ hosts: [] }));
  const write = (name, entries, day) => {
    const file = path.join(logs, name);
    fs.writeFileSync(file, JSON.stringify(entries));
    const at = new Date(T0 + day * DAY);
    fs.utimesSync(file, at, at);
  };
  return { dir, logs, dead, write, read: () => JSON.parse(fs.readFileSync(dead, 'utf8')).hosts };
}

const hard = (host) => ({ broker: host, status: 'dead', detail: 'ERR_NAME_NOT_RESOLVED', host });
const fine = (host) => ({ broker: host, status: 'manual', detail: `https://${host}/optout`, host });
const hosts = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}.example`);

test('three outage runs in which nearly every host failed prune nothing', () => {
  const f = fixture();
  try {
    const all = hosts(30, 'site');
    for (const day of [0, 10, 20]) f.write(`run-${day}.json`, all.map(hard), day);
    const result = pruneDeadUrls(f.logs, f.dead);
    assert.deepEqual(result.added, []);
    assert.deepEqual(f.read(), []);
    assert.equal(result.ignoredRuns, 3);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a genuinely dead host is still pruned when the rest of the runs were healthy', () => {
  const f = fixture();
  try {
    const healthy = hosts(30, 'ok');
    for (const day of [0, 10, 20]) f.write(`run-${day}.json`, [hard('gone.example'), ...healthy.map(fine)], day);
    const result = pruneDeadUrls(f.logs, f.dead);
    assert.deepEqual(result.added, ['gone.example']);
    assert.equal(result.ignoredRuns, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('an outage run in the middle neither supports nor breaks the streak of a host that really is gone', () => {
  const f = fixture();
  try {
    const healthy = hosts(30, 'ok');
    f.write('run-0.json', [hard('gone.example'), ...healthy.map(fine)], 0);
    f.write('run-10.json', hosts(30, 'site').concat(['gone.example']).map(hard), 10); // offline that day
    f.write('run-20.json', [hard('gone.example'), ...healthy.map(fine)], 20);
    f.write('run-30.json', [hard('gone.example'), ...healthy.map(fine)], 30);
    const result = pruneDeadUrls(f.logs, f.dead);
    assert.deepEqual(result.added, ['gone.example'], 'three healthy runs over 30 days are evidence enough');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a small run that is all dead is not mistaken for an outage (too few hosts to tell)', () => {
  const f = fixture();
  try {
    for (const day of [0, 10, 20]) f.write(`run-${day}.json`, [hard('a.example'), hard('b.example')], day);
    assert.deepEqual(pruneDeadUrls(f.logs, f.dead).added, ['a.example', 'b.example']);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
