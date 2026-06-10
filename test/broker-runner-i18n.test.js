/**
 * test/broker-runner-i18n.test.js
 *
 * Verifies broker-runner reads the page <html lang> attribute after submit and
 * threads it into classifyPostSubmit(body, lang) and
 * detectConfirmationRequired(page, lang).
 *
 * A Spanish success page (which the English-only classifier would mark
 * 'unverified') must be logged 'success' and recorded once the lang is wired.
 *
 * Uses the Module._load interception pattern from broker-runner-buckets.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

const logged = [];
const recorded = { success: [], failure: [], pending: [] };

// Capture the lang argument the runner passes into each classifier.
const seen = { classifyLang: undefined, confirmLang: undefined, classifyBody: undefined };

const SPANISH_BODY = 'Hemos recibido su solicitud de eliminación. Sus datos han sido eliminados.';

const configMock = {
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,
  shouldSkip: () => null,
  isPendingConfirmation: () => false,
  recordSuccess: (name, detail) => recorded.success.push({ name, detail }),
  recordPendingConfirmation: (name, snippet) => recorded.pending.push({ name, snippet }),
  recordFailure: (name, kind) => recorded.failure.push({ name, kind }),
  loadState: () => ({ optOuts: {} }),
  saveCheckpoint: () => {},
  stateKey: (brokerName) => brokerName,
};

// Real locale patterns + real success classifier so the union is exercised
// end to end. We only stub the language-detection / confirm modules to record
// what the runner passes, and forms/captcha/etc to avoid a real browser.
const realSuccess = originalLoad('../lib/success', module, false);

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
  if (request === './config') return configMock;
  if (request === './logger') return {
    logResult: (name, status, detail) => logged.push({ name, status, detail }),
    STATUS_BUCKET: {},
  };
  if (request === './forms') return {
    fillForm: async () => {},
    findListingUrl: async () => 'https://example.com/listing/123',
  };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
  if (request === './confirm') return {
    detectConfirmationRequired: async (_page, lang) => {
      seen.confirmLang = lang;
      return { pending: false, snippet: '' };
    },
  };
  if (request === './success') return {
    classifyPostSubmit: (body, lang) => {
      seen.classifyLang = lang;
      seen.classifyBody = body;
      return realSuccess.classifyPostSubmit(body, lang);
    },
  };
  if (request === './retry') return { withRetry: fn => fn() };
  if (request === './timing') return { jitterSleep: async () => {} };
  if (request === './snapshot') return { captureSubmitSnapshot: async () => null };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBrokerWithPerson } = require('../lib/broker-runner');
Module._load = originalLoad;

// -- Page / context mocks --

function makePage(body, htmlLang) {
  return {
    async goto() {},
    locator() {
      return {
        first() { return this; },
        async fill() {},
        async count() { return 1; },
        async isVisible() { return true; },
        async click() {},
      };
    },
    async evaluate(fn) {
      // The runner calls evaluate twice in the relevant region: once for the
      // <html lang> attribute, once for document.body.innerText. We dispatch by
      // running the supplied function against a tiny fake DOM.
      const fakeDoc = {
        documentElement: { getAttribute: (name) => (name === 'lang' ? htmlLang : null) },
        body: { innerText: body },
        querySelectorAll: () => [],
      };
      const globalDocument = global.document;
      global.document = fakeDoc;
      try {
        return fn();
      } finally {
        global.document = globalDocument;
      }
    },
    async close() {},
  };
}

function makeContext(page) {
  return { async newPage() { return page; } };
}

const PERSON = { firstName: 'Ana', lastName: 'Lopez', fullName: 'Ana Lopez', country: 'ES' };

const SPANISH_BROKER = {
  name: 'SitioES',
  method: 'search-form',
  searchUrl: 'https://example.com/search',
  optOutUrl: 'https://example.com/opt-out',
  submitSelector: 'button[type="submit"]',
  formFields: { 'input[name="name"]': 'Ana Lopez' },
};

function reset() {
  logged.length = 0;
  recorded.success.length = 0;
  recorded.failure.length = 0;
  recorded.pending.length = 0;
  seen.classifyLang = undefined;
  seen.confirmLang = undefined;
  seen.classifyBody = undefined;
  configure({ dryRun: false, person: PERSON, capsolver: null, noCapsolver: true, snapshot: false, personCount: 1 });
}

test('broker-runner threads normalized html lang into classifyPostSubmit', async () => {
  reset();
  const page = makePage(SPANISH_BODY, 'es-ES');
  await processBrokerWithPerson(makeContext(page), SPANISH_BROKER, PERSON);
  assert.equal(seen.classifyLang, 'es');
  assert.equal(seen.classifyBody, SPANISH_BODY);
});

test('broker-runner threads normalized html lang into detectConfirmationRequired', async () => {
  reset();
  const page = makePage(SPANISH_BODY, 'es-ES');
  await processBrokerWithPerson(makeContext(page), SPANISH_BROKER, PERSON);
  assert.equal(seen.confirmLang, 'es');
});

test('Spanish success page is logged success and recorded (was unverified before wiring)', async () => {
  reset();
  const page = makePage(SPANISH_BODY, 'es-ES');
  await processBrokerWithPerson(makeContext(page), SPANISH_BROKER, PERSON);
  assert.equal(recorded.success.length, 1, 'recordSuccess should be called once');
  assert.equal(recorded.success[0].name, 'SitioES');
  const successLog = logged.find(l => l.status === 'success');
  assert.ok(successLog, 'expected a success log entry');
});

test('missing html lang yields empty string lang (English-only path)', async () => {
  reset();
  const page = makePage('Your request has been received.', null);
  await processBrokerWithPerson(makeContext(page), { ...SPANISH_BROKER, name: 'SiteEN' }, PERSON);
  assert.equal(seen.classifyLang, '');
  assert.equal(recorded.success.length, 1);
});
