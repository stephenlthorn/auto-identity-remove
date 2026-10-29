/**
 * test/captcha-capsolver-errors.test.js
 *
 * BRK-13 (captcha part): pollCapSolver ignored `errorId`, so a hard CapSolver
 * error ("insufficient balance", "key denied") was polled 30 times and surfaced
 * as a generic "no solution". It now fails fast with CapSolver's own
 * errorDescription. The API key must never reach the log.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const captcha = require('../lib/captcha');

const KEY = 'CAP-SECRETKEY-0123456789';

function axiosReturning(...responses) {
  const calls = [];
  const stub = {
    calls,
    post: async (url, body) => {
      calls.push({ url, body });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (next instanceof Error) throw next;
      return { data: next };
    },
  };
  return stub;
}

async function captureConsole(fn) {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(real)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { Object.assign(console, real); }
  return lines.join('\n');
}

test('BRK-13: pollCapSolver fails fast on errorId with CapSolver\'s errorDescription', async () => {
  const axios = axiosReturning({ errorId: 1, errorCode: 'ERROR_ZERO_BALANCE', errorDescription: 'Insufficient balance' });

  await assert.rejects(
    () => captcha.pollCapSolver('t1', { clientKey: KEY, axios, intervalMs: 0, maxTries: 30 }),
    /Insufficient balance/,
  );
  assert.equal(axios.calls.length, 1, 'a hard error must not be polled 30 times');
});

test('BRK-13: errorId 0 is not an error', async () => {
  const axios = axiosReturning({ errorId: 0, status: 'ready', solution: { token: 'x' } });
  const solution = await captcha.pollCapSolver('t1', { clientKey: KEY, axios, intervalMs: 0 });
  assert.deepEqual(solution, { token: 'x' });
});

test('BRK-13: an errorDescription that echoes the key is redacted', async () => {
  const axios = axiosReturning({ errorId: 1, errorDescription: `Key ${KEY} denied` });
  await assert.rejects(
    () => captcha.pollCapSolver('t1', { clientKey: KEY, axios, intervalMs: 0 }),
    (err) => !err.message.includes(KEY) && /denied/.test(err.message),
  );
});

test('BRK-13: a createTask errorId is reported by the solver and never polled', async () => {
  const stub = axiosReturning({ errorId: 1, errorCode: 'ERROR_KEY_DENIED_ACCESS', errorDescription: 'Key denied access' });
  const axiosLib = require('axios');
  const origCreate = axiosLib.create;
  axiosLib.create = () => stub;
  let result;
  let output;
  try {
    const page = {
      url: () => 'https://broker.example.com',
      evaluate: async () => ({ siteKey: '6LdV3' }),
    };
    output = await captureConsole(async () => {
      result = await captcha.solveRecaptchaV3(page, { apiKey: KEY }, {});
    });
  } finally {
    axiosLib.create = origCreate;
  }

  assert.equal(result, false);
  assert.match(output, /Key denied access/, 'the operator sees why it failed');
  assert.ok(!output.includes(KEY), 'the API key must not be logged');
  assert.equal(stub.calls.filter(c => c.url.includes('getTaskResult')).length, 0, 'no polling after a createTask error');
});

test('BRK-13: a transport error that carries the key in its text is redacted in the log', async () => {
  const stub = axiosReturning(new Error(`Request failed for clientKey=${KEY}`));
  const axiosLib = require('axios');
  const origCreate = axiosLib.create;
  axiosLib.create = () => stub;
  let output;
  try {
    const page = {
      url: () => 'https://broker.example.com',
      evaluate: async () => ({ siteKey: '6LdV3' }),
    };
    output = await captureConsole(() => captcha.solveRecaptchaV3(page, { apiKey: KEY }, {}));
  } finally {
    axiosLib.create = origCreate;
  }
  assert.ok(!output.includes(KEY), `the API key leaked: ${output}`);
});
