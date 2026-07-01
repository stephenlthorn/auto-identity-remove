const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findRecaptchaCallback, buildHcaptchaScript } = require('../lib/captcha');

test('findRecaptchaCallback: returns a string containing the token', () => {
  const script = findRecaptchaCallback('TEST_TOKEN_123');
  assert.ok(typeof script === 'string' && script.length > 0);
  assert.ok(script.includes('TEST_TOKEN_123'));
});
test('findRecaptchaCallback: includes ___grecaptcha_cfg traversal', () => {
  assert.ok(findRecaptchaCallback('X').includes('___grecaptcha_cfg'));
});
test('findRecaptchaCallback: includes g-recaptcha-response input injection', () => {
  assert.ok(findRecaptchaCallback('X').includes('g-recaptcha-response'));
});
test('buildHcaptchaScript: returns a string containing the token', () => {
  const script = buildHcaptchaScript('HTOKEN_ABC');
  assert.ok(typeof script === 'string');
  assert.ok(script.includes('HTOKEN_ABC'));
});
test('buildHcaptchaScript: includes h-captcha-response', () => {
  assert.ok(buildHcaptchaScript('X').includes('h-captcha-response'));
});

// ── M5: sitekey extraction + hCaptcha no-execute ──────────────────────────────

test('M5: buildHcaptchaScript does NOT call hcaptcha.execute()', () => {
  const script = buildHcaptchaScript('HTOKEN');
  assert.ok(
    !script.includes('.execute('),
    'buildHcaptchaScript must not call hcaptcha.execute() - it can re-trigger interactive challenge'
  );
});

test('M5: solveRecaptcha page.evaluate script prefers form [data-sitekey] over page-level', async () => {
  // We test the sitekey extraction by verifying the source of solveRecaptcha
  // uses 'form [data-sitekey]' preference logic. Since we cannot run real Playwright,
  // we check that the evaluated string passed to page.evaluate contains the preference.
  const { solveRecaptcha } = require('../lib/captcha');
  let capturedEval = null;
  const fakePage = {
    url: () => 'https://example.com',
    evaluate: async (fnOrStr) => {
      capturedEval = fnOrStr.toString();
      return null; // no sitekey -> bail out early
    },
  };
  const fakeCapsolver = { apiKey: 'CAP-TESTKEY12345678' };
  await solveRecaptcha(fakePage, fakeCapsolver);
  assert.ok(capturedEval !== null, 'evaluate should have been called');
  assert.ok(
    capturedEval.includes('form') && capturedEval.includes('data-sitekey'),
    `evaluate script should prefer form [data-sitekey], got: ${capturedEval}`
  );
});

test('M5: solveHcaptcha page.evaluate script prefers form [data-sitekey] over page-level', async () => {
  const { solveHcaptcha } = require('../lib/captcha');
  let capturedEval = null;
  const fakePage = {
    url: () => 'https://example.com',
    evaluate: async (fnOrStr) => {
      capturedEval = fnOrStr.toString();
      return null;
    },
  };
  const fakeCapsolver = { apiKey: 'CAP-TESTKEY12345678' };
  await solveHcaptcha(fakePage, fakeCapsolver);
  assert.ok(capturedEval !== null, 'evaluate should have been called');
  assert.ok(
    capturedEval.includes('form') && capturedEval.includes('data-sitekey'),
    `evaluate script should prefer form [data-sitekey], got: ${capturedEval}`
  );
});

// ── end M5 ────────────────────────────────────────────────────────────────────

// ── Fix 5: pollCapSolver + isPlaceholderKey ───────────────────────────────────

test('Fix5: isPlaceholderKey returns true for CAP-YOUR_ prefix', () => {
  const { isPlaceholderKey } = require('../lib/captcha');
  assert.equal(isPlaceholderKey('CAP-YOUR_KEY_HERE'), true);
  assert.equal(isPlaceholderKey('CAP-YOUR_anything'), true);
  assert.equal(isPlaceholderKey('CAP-REAL_KEY_123'), false);
  assert.equal(isPlaceholderKey(''), false);
  assert.equal(isPlaceholderKey(null), false);
  assert.equal(isPlaceholderKey(undefined), false);
});

test('Fix5: isPlaceholderKey returns true when key starts with CAP-YOUR', () => {
  const { isPlaceholderKey } = require('../lib/captcha');
  assert.equal(isPlaceholderKey('CAP-YOUR'), true);
});

test('Fix5: pollCapSolver resolves with solution when status becomes ready', async () => {
  const { pollCapSolver } = require('../lib/captcha');

  let callCount = 0;
  const fakeAxios = {
    post: async (url, body) => {
      callCount++;
      // First call: still processing; second call: ready
      if (callCount === 1) return { data: { status: 'processing' } };
      return { data: { status: 'ready', solution: { gRecaptchaResponse: 'tok123' } } };
    },
  };

  const result = await pollCapSolver('task-abc', {
    clientKey: 'CAP-REAL',
    intervalMs: 1,
    maxTries: 10,
    axios: fakeAxios,
  });

  assert.ok(result !== null, 'should return solution');
  assert.equal(result.gRecaptchaResponse, 'tok123');
});

test('Fix5: pollCapSolver returns null when status is failed', async () => {
  const { pollCapSolver } = require('../lib/captcha');

  const fakeAxios = {
    post: async () => ({ data: { status: 'failed' } }),
  };

  const result = await pollCapSolver('task-fail', {
    clientKey: 'CAP-REAL',
    intervalMs: 1,
    maxTries: 5,
    axios: fakeAxios,
  });

  assert.equal(result, null, 'failed task should return null');
});

test('Fix5: pollCapSolver returns null after maxTries without ready', async () => {
  const { pollCapSolver } = require('../lib/captcha');

  const fakeAxios = {
    post: async () => ({ data: { status: 'processing' } }),
  };

  const result = await pollCapSolver('task-timeout', {
    clientKey: 'CAP-REAL',
    intervalMs: 1,
    maxTries: 3,
    axios: fakeAxios,
  });

  assert.equal(result, null, 'should timeout and return null after maxTries');
});

// ── end Fix 5 ─────────────────────────────────────────────────────────────────

// ── CAPTCHA routing fixes: B3, B4, B14, P3 ────────────────────────────────────
//
// These tests exercise the real detector callback passed to page.evaluate by
// detectAndSolveCaptcha. We build a tiny fake `document` that models the page's
// elements (tag + class + attributes + src) and implements just enough of
// querySelector to answer the specific selectors the detector uses. The detector
// callback takes no arguments and reads the ambient `document`, so we can run it
// directly against our mock by intercepting the first page.evaluate call.

function makeElement({ tag = 'div', classes = [], attrs = {}, src = null } = {}) {
  const attributes = { ...attrs };
  if (src !== null) attributes.src = src;
  return {
    tag,
    classes,
    attributes,
    src: src || attributes.src || '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
  };
}

// Minimal CSS selector engine covering the selector forms the detector uses:
//   tag, .class, #id, [attr], [attr*="substr"], [attr="val"], and combinations,
//   plus comma-separated selector lists (handled by the caller).
function elementMatches(el, selector) {
  const tokenRe = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:([*^$~|]?=)"([^"]*)")?\]/g;
  const tokens = Array.from(selector.trim().matchAll(tokenRe));
  if (tokens.length === 0) return false;
  for (const m of tokens) {
    if (m[1]) {
      if (el.tag !== m[1]) return false;
    } else if (m[2]) {
      if (!el.classes.includes(m[2])) return false;
    } else if (m[3]) {
      if (el.attributes.id !== m[3]) return false;
    } else if (m[4]) {
      const attrName = m[4];
      const op = m[5];
      const val = m[6];
      const have = el.attributes[attrName];
      if (op === undefined) {
        if (have === undefined) return false;
      } else if (op === '*=') {
        if (typeof have !== 'string' || !have.includes(val)) return false;
      } else if (op === '=') {
        if (have !== val) return false;
      }
    }
  }
  return true;
}

function makeFakeDocument(elements) {
  return {
    querySelector(selectorList) {
      const selectors = selectorList.split(',').map(s => s.trim());
      for (const sel of selectors) {
        const hit = elements.find(el => elementMatches(el, sel));
        if (hit) return hit;
      }
      return null;
    },
    querySelectorAll(selectorList) {
      const selectors = selectorList.split(',').map(s => s.trim());
      return elements.filter(el => selectors.some(sel => elementMatches(el, sel)));
    },
  };
}

// Runs the real detector callback (the first function passed to page.evaluate by
// detectAndSolveCaptcha) against a fake document and returns the captchaType.
async function classifyCaptcha(elements) {
  const { detectAndSolveCaptcha } = require('../lib/captcha');
  let captchaType = 'UNSET';
  const fakePage = {
    url: () => 'https://broker.example.com/opt-out',
    evaluate: async (fnOrStr, ...args) => {
      const savedDoc = global.document;
      global.document = makeFakeDocument(elements);
      try {
        captchaType = typeof fnOrStr === 'function' ? await fnOrStr(...args) : null;
      } finally {
        global.document = savedDoc;
      }
      return captchaType;
    },
  };
  // No capsolver -> solvers short-circuit to false; we only care about routing.
  await detectAndSolveCaptcha(fakePage, null);
  return captchaType;
}

// ── B3: reCAPTCHA v3 detector must EXCLUDE render=explicit ─────────────────────

test('B3: v2 explicit-render page (api.js?render=explicit) does NOT classify as recaptcha-v3', async () => {
  const type = await classifyCaptcha([
    makeElement({ tag: 'script', src: 'https://www.google.com/recaptcha/api.js?render=explicit' }),
    makeElement({ tag: 'div', classes: ['g-recaptcha'], attrs: { 'data-sitekey': '6Lc-KEY' } }),
  ]);
  assert.notEqual(type, 'recaptcha-v3', 'render=explicit must not route to the v3 solver');
  assert.equal(type, 'recaptcha', 'explicit-render v2 pages must fall through to the v2 solver');
});

test('B3: real v3 page (api.js?render=SITEKEY) still classifies as recaptcha-v3', async () => {
  const type = await classifyCaptcha([
    makeElement({ tag: 'script', src: 'https://www.google.com/recaptcha/api.js?render=6LdREAL_V3_KEY' }),
  ]);
  assert.equal(type, 'recaptcha-v3', 'a genuine v3 render=SITEKEY page must still route to v3');
});

// ── B14: hCAPTCHA div (class h-captcha + data-sitekey) must route to hCAPTCHA ──

test('B14: <div class="h-captcha" data-sitekey> routes to hcaptcha, not recaptcha', async () => {
  const type = await classifyCaptcha([
    makeElement({ tag: 'div', classes: ['h-captcha'], attrs: { 'data-sitekey': 'HCAP-KEY-123' } }),
  ]);
  assert.equal(type, 'hcaptcha', 'lazy hCAPTCHA div must be routed to the hCAPTCHA solver');
});

test('B14: a bare [data-sitekey] with no h-captcha class still routes to recaptcha v2', async () => {
  const type = await classifyCaptcha([
    makeElement({ tag: 'div', attrs: { 'data-sitekey': 'RECAP-KEY-123' } }),
  ]);
  assert.equal(type, 'recaptcha', 'a plain data-sitekey widget must still route to reCAPTCHA v2');
});

// ── B4: reCAPTCHA v3 action override via broker.recaptchaV3Action ──────────────

// Runs solveRecaptchaV3 against a stubbed axios (via axios.create) and a fake
// page, returning the pageAction sent in the createTask body.
async function captureV3PageAction(broker) {
  const { solveRecaptchaV3 } = require('../lib/captcha');
  let createTaskBody = null;
  const stubAxios = {
    post: async (url, body) => {
      if (url.includes('createTask')) {
        createTaskBody = body;
        return { data: { taskId: 'T1' } };
      }
      return { data: { status: 'ready', solution: { gRecaptchaResponse: 'v3tok' } } };
    },
  };
  const axios = require('axios');
  const origCreate = axios.create;
  axios.create = () => stubAxios;
  try {
    const fakePage = {
      url: () => 'https://broker.example.com',
      evaluate: async (fnOrStr) => {
        if (typeof fnOrStr === 'function') return { siteKey: '6LdV3', action: 'submit' };
        return undefined;
      },
    };
    await solveRecaptchaV3(fakePage, { apiKey: 'CAP-REALKEY' }, broker);
  } finally {
    axios.create = origCreate;
  }
  return createTaskBody && createTaskBody.task ? createTaskBody.task.pageAction : null;
}

test('B4: solveRecaptchaV3 defaults pageAction to "submit" when no broker override', async () => {
  assert.equal(await captureV3PageAction(undefined), 'submit');
  assert.equal(await captureV3PageAction({}), 'submit');
});

test('B4: solveRecaptchaV3 honors broker.recaptchaV3Action override', async () => {
  assert.equal(await captureV3PageAction({ recaptchaV3Action: 'homepage' }), 'homepage');
  assert.equal(await captureV3PageAction({ recaptchaV3Action: 'optout_request' }), 'optout_request');
});

test('B4: detectAndSolveCaptcha threads broker.recaptchaV3Action into solveRecaptchaV3', async () => {
  const { detectAndSolveCaptcha } = require('../lib/captcha');
  let createTaskBody = null;
  const stubAxios = {
    post: async (url, body) => {
      if (url.includes('createTask')) {
        createTaskBody = body;
        return { data: { taskId: 'T1' } };
      }
      return { data: { status: 'ready', solution: { gRecaptchaResponse: 'v3tok' } } };
    },
  };
  const axios = require('axios');
  const origCreate = axios.create;
  axios.create = () => stubAxios;
  try {
    const fakePage = {
      url: () => 'https://broker.example.com',
      evaluate: async (fnOrStr) => {
        if (typeof fnOrStr === 'function') {
          const savedDoc = global.document;
          global.document = makeFakeDocument([
            makeElement({ tag: 'script', src: 'https://www.google.com/recaptcha/api.js?render=6LdV3' }),
          ]);
          try {
            const out = await fnOrStr();
            if (out === 'recaptcha-v3') return out;
            return { siteKey: '6LdV3', action: 'submit' };
          } finally {
            global.document = savedDoc;
          }
        }
        return undefined;
      },
    };
    await detectAndSolveCaptcha(fakePage, { apiKey: 'CAP-REALKEY' }, { recaptchaV3Action: 'contact_form' });
  } finally {
    axios.create = origCreate;
  }
  assert.ok(createTaskBody, 'createTask should have been called');
  assert.equal(createTaskBody.task.pageAction, 'contact_form');
});

// ── P3: pollCapSolver polls immediately + enforces a wall-clock deadline ───────

test('P3: pollCapSolver polls once immediately without waiting the full interval', async () => {
  const { pollCapSolver } = require('../lib/captcha');
  const start = Date.now();
  let calls = 0;
  const fakeAxios = {
    post: async () => {
      calls++;
      return { data: { status: 'ready', solution: { gRecaptchaResponse: 'quick' } } };
    },
  };
  const result = await pollCapSolver('task-fast', {
    clientKey: 'CAP-REAL',
    intervalMs: 5000, // large interval; must NOT be slept before the first poll
    maxTries: 3,
    axios: fakeAxios,
  });
  const elapsed = Date.now() - start;
  assert.equal(calls, 1, 'should poll exactly once when the first poll is ready');
  assert.ok(result && result.gRecaptchaResponse === 'quick');
  assert.ok(elapsed < 2000, `first poll must be immediate, waited ${elapsed}ms`);
});

test('P3: pollCapSolver stops when the absolute wall-clock deadline is exceeded', async () => {
  const { pollCapSolver } = require('../lib/captcha');
  let calls = 0;
  const fakeAxios = {
    post: async () => {
      calls++;
      return { data: { status: 'processing' } };
    },
  };
  const start = Date.now();
  const result = await pollCapSolver('task-stuck', {
    clientKey: 'CAP-REAL',
    intervalMs: 20,
    maxTries: 100000, // effectively unlimited tries; the deadline must stop us
    deadlineMs: 120,
    axios: fakeAxios,
  });
  const elapsed = Date.now() - start;
  assert.equal(result, null, 'a stuck task must return null');
  assert.ok(elapsed < 2000, `deadline must bound total time, waited ${elapsed}ms`);
  assert.ok(calls < 100000, 'deadline must stop polling well before maxTries is exhausted');
});

// ── end CAPTCHA routing fixes ─────────────────────────────────────────────────
