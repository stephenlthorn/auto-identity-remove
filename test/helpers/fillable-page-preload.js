/**
 * test/helpers/fillable-page-preload.js - a fake browser page that has a form.
 *
 * Preloaded AFTER fake-playwright.js. Pages the fake hands out can then be
 * navigated and answer every field lookup as a visible text box, recording each
 * value written to one as a `fill` event in AIDR_FAKE_LOG. That lets a test run the
 * real watcher.js through `aidr preview --fields` and see what the field report
 * says about what was typed. Everything else stays as the fake has it.
 *
 * Not a test file (no .test.js suffix).
 */

'use strict';

const fs = require('fs');
const Module = require('module');

function record(event, detail) {
  const file = process.env.AIDR_FAKE_LOG;
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({ event, ...detail }) + '\n'); } catch (_) { /* ignore */ }
}

function element(selector) {
  const el = {
    first: () => el,
    async count() { return 1; },
    async isVisible() { return true; },
    async evaluate(fn) { return fn({ tagName: 'INPUT', type: 'text', name: '', id: '', placeholder: '', getAttribute: () => null, labels: [] }); },
    async fill(value) { record('fill', { selector, value }); },
    async selectOption() {},
    async check() {},
    async click() {},
    locator: (inner) => element(inner),
  };
  return el;
}

function wrapPage(page) {
  page.goto = async () => ({ status: () => 200 });
  page.locator = (selector) => element(selector);
  page.getByLabel = () => ({ count: async () => 0, first: () => ({}) });
  page.url = () => 'https://fixture.example/optout';
  page.title = async () => 'Opt out';
  return page;
}

const wrapped = new WeakSet();
const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  const result = originalLoad.apply(this, arguments);
  if (request === 'playwright' && result && result.chromium && !wrapped.has(result.chromium)) {
    wrapped.add(result.chromium);
    const launch = result.chromium.launchPersistentContext.bind(result.chromium);
    result.chromium.launchPersistentContext = async (dir, options) => {
      const context = await launch(dir, options);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => wrapPage(await newPage());
      return context;
    };
  }
  return result;
};
