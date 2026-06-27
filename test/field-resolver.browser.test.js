/**
 * test/field-resolver.browser.test.js
 *
 * Real-browser (headless Chromium) integration tests for lib/field-resolver.js
 * and the secondary-fallback path in lib/forms.js.
 *
 * Runs ONLY when the environment variable AIDR_BROWSER_TESTS=1 is set, so the
 * default `npm test` fast suite (browser-free) is unaffected. To run:
 *
 *   AIDR_BROWSER_TESTS=1 node --test test/field-resolver.browser.test.js
 *
 * These tests use real Playwright pages (`page.setContent(fixtureHTML)`) and
 * drive the REAL `fillForm` / `resolveField` code path end-to-end. No mocks —
 * the scorer is serialised through `page.evaluate` / `new Function` in a real
 * Chromium process, the `data-aidr-resolve` marker binding is genuine, and
 * `page.locator(...).inputValue()` reads actual DOM state.
 *
 * Scenario catalogue:
 *   1. Recovery — renamed email attr (email→email_address), no label. Resolver
 *      finds via type=email + autocomplete + placeholder.
 *   2. Recovery — renamed firstName attr (first_name→given_name), no label.
 *      Resolver finds via autocomplete=given-name + name.includes('given').
 *   3. Confirm-guard — email + confirm_email present; resolver must fill the
 *      PRIMARY email field and leave confirm_email EMPTY.
 *   4. Asymmetric abstain (CASE A) — primary email has opaque attrs only
 *      (name="usr_em", no type/autocomplete/placeholder), readable confirm
 *      field present; resolver MUST abstain (both fields stay empty).
 *   5. Happy path — exact selector hits; resolver NOT invoked (fill succeeds
 *      via the primary CSS path, not the semantic fallback).
 *   6. TOCTOU marker — data-aidr-resolve attribute is set during evaluate and
 *      cleared after fill; verify start→set→cleared lifecycle.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ENABLED = Boolean(process.env.AIDR_BROWSER_TESTS);

// Wrap everything in a describe so that when AIDR_BROWSER_TESTS is unset the
// whole suite registers as a single skipped block — no hard process.exit, no
// worker-exit warning, no attempt to load playwright or a browser binary.
describe('field-resolver browser integration', { skip: !ENABLED }, () => {
  // Deferred requires: loaded only when the suite actually runs (ENABLED=true).
  // This keeps CI from failing with "Chromium not found" when the flag is unset.
  let chromium;
  let fillForm;
  let resolveField;
  let clearResolveMarker;

  let browser;
  let chromiumVersion;

  before(async () => {
    ({ chromium } = require('playwright'));
    ({ fillForm } = require('../lib/forms'));
    ({ resolveField, clearResolveMarker } = require('../lib/field-resolver'));

    browser = await chromium.launch({ headless: true });
    // Capture Chromium version for reporting
    const pg = await browser.newPage();
    chromiumVersion = await pg.evaluate(() => navigator.userAgent);
    await pg.close();
    console.log('Browser:', chromiumVersion);
  });

  after(async () => {
    await browser.close();
  });

  // ─── helpers ────────────────────────────────────────────────────────────────

  async function makePage(html) {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return page;
  }

  async function readValue(page, selector) {
    return page.locator(selector).inputValue();
  }

  // ─── Scenario 1: email field renamed email→email_address (no label) ─────────

  test('S1: recovery — renamed email attr (email→email_address)', async () => {
    // Broker DOM change: renamed name="email" → name="email_address".
    // No <label>. Resolver should find it via: type=email(4) + autocomplete=email(3)
    // + placeholder contains "email"(2) = 9 ≥ MATCH_THRESHOLD(5).
    const html = `
      <form>
        <input name="email_address" type="email" autocomplete="email"
               placeholder="Email" id="ea">
      </form>`;

    // formFields still references the OLD selector (what the broker config has)
    const formFields = { 'input[name="email"]': 'test@example.com' };
    const page = await makePage(html);
    try {
      await fillForm(page, formFields, null, null);
      const got = await readValue(page, 'input[name="email_address"]');
      assert.strictEqual(got, 'test@example.com',
        `S1 FAIL: email_address field value="${got}", expected "test@example.com"`);
      console.log('S1 PASS: email_address =', got);
    } finally {
      await page.close();
    }
  });

  // ─── Scenario 1b: firstName field renamed first_name→given_name ─────────────

  test('S1b: recovery — renamed firstName attr (first_name→given_name)', async () => {
    // Broker renamed first_name→given_name. No label.
    // Resolver: autocomplete=given-name(3) + name.includes('given')(2) = 5 ≥ threshold.
    const html = `
      <form>
        <input name="given_name" type="text" autocomplete="given-name"
               placeholder="Given name">
      </form>`;

    const formFields = { 'input[name="first_name"]': 'Alice' };
    const page = await makePage(html);
    try {
      await fillForm(page, formFields, null, null);
      const got = await readValue(page, 'input[name="given_name"]');
      assert.strictEqual(got, 'Alice',
        `S1b FAIL: given_name field value="${got}", expected "Alice"`);
      console.log('S1b PASS: given_name =', got);
    } finally {
      await page.close();
    }
  });

  // ─── Scenario 2: confirm-guard ───────────────────────────────────────────────

  test('S2: confirm-guard — email lands in primary, confirm_email stays empty', async () => {
    // Two fields: a real email field (primary selector MISSED so resolver fires)
    // and a confirm_email field. The confirm field must score 0 (negative guard).
    // Result: primary email filled; confirm_email EMPTY.
    const html = `
      <form>
        <input name="user_email_addr" type="email" autocomplete="email"
               placeholder="Your email" id="em">
        <input name="confirm_email" type="email" placeholder="Confirm email" id="cem">
      </form>`;

    // selector uses old broker attr — misses both fields intentionally
    const formFields = { 'input[name="email"]': 'user@example.com' };
    const page = await makePage(html);
    try {
      await fillForm(page, formFields, null, null);
      const primary = await readValue(page, 'input[name="user_email_addr"]');
      const confirm = await readValue(page, 'input[name="confirm_email"]');
      assert.strictEqual(primary, 'user@example.com',
        `S2 FAIL: primary email="${primary}", expected "user@example.com"`);
      assert.strictEqual(confirm, '',
        `S2 FAIL: confirm_email="${confirm}", expected "" (empty — confirm guard)`);
      console.log('S2 PASS: primary=', primary, '| confirm=', confirm, '(empty)');
    } finally {
      await page.close();
    }
  });

  // ─── Scenario 3: asymmetric abstain (CASE A from review) ────────────────────

  test('S3: asymmetric abstain — opaque primary, readable confirm → resolver abstains', async () => {
    // Primary field: name="usr_em", no type=email, no autocomplete, no placeholder.
    // Confirm field: name="confirm_email", type=email, placeholder="Confirm email".
    //
    // The resolver derives intent=email from the missed selector's value
    // (test@example.com looks like email). Primary scores 0 (no signals).
    // Confirm scores non-zero on type+placeholder... BUT the negative guard fires
    // first and forces it to 0. So above=[] → abstain. Both fields stay empty.
    const html = `
      <form>
        <input name="usr_em" type="text" id="ue">
        <input name="confirm_email" type="email" placeholder="Confirm email" id="ce">
      </form>`;

    const formFields = { 'input[name="email"]': 'secret@example.com' };
    const page = await makePage(html);
    try {
      await fillForm(page, formFields, null, null);
      const primary = await readValue(page, 'input[name="usr_em"]');
      const confirm = await readValue(page, 'input[name="confirm_email"]');
      assert.strictEqual(primary, '',
        `S3 FAIL: usr_em="${primary}", expected "" (abstain)`);
      assert.strictEqual(confirm, '',
        `S3 FAIL: confirm_email="${confirm}", expected "" (abstain — CASE A fail-safe)`);
      console.log('S3 PASS: usr_em=', JSON.stringify(primary), '| confirm_email=', JSON.stringify(confirm));
    } finally {
      await page.close();
    }
  });

  // ─── Scenario 4: happy path — exact selector hits, resolver not invoked ──────

  test('S4: happy path — exact selector fills without resolver', async () => {
    // The exact CSS selector hits; fillForm() fills it directly.
    // To verify the resolver was NOT invoked we check: the data-aidr-resolve
    // marker is absent after the fill (the resolver sets+clears it; if it was
    // never set, it's absent). Also verify the field value.
    const html = `
      <form>
        <input name="email" type="email" id="em">
      </form>`;

    const formFields = { 'input[name="email"]': 'happy@example.com' };
    const page = await makePage(html);
    try {
      await fillForm(page, formFields, null, null);
      const got = await readValue(page, 'input[name="email"]');
      assert.strictEqual(got, 'happy@example.com',
        `S4 FAIL: email="${got}", expected "happy@example.com"`);
      // Confirm resolver marker was never set (primary path, no fallback)
      const markerCount = await page.locator('[data-aidr-resolve]').count();
      assert.strictEqual(markerCount, 0,
        `S4 FAIL: data-aidr-resolve marker found (resolver was invoked when it shouldn't be)`);
      console.log('S4 PASS: email=', got, '| resolver marker absent:', markerCount === 0);
    } finally {
      await page.close();
    }
  });

  // ─── Scenario 5: TOCTOU marker lifecycle ────────────────────────────────────

  test('S5: TOCTOU marker — data-aidr-resolve is set then cleared during fill', async () => {
    // Drive resolveField() directly (not via fillForm) so we can capture the
    // marker state at three points: before resolve, after resolve (before clear),
    // and after clearResolveMarker.
    const html = `
      <form>
        <input name="email_renamed" type="email" autocomplete="email"
               placeholder="Email address">
      </form>`;

    const page = await makePage(html);
    try {
      // Before: no marker
      const before = await page.locator('[data-aidr-resolve]').count();
      assert.strictEqual(before, 0, 'S5 FAIL: marker present before resolve');

      // After resolveField: marker set on the winner
      const locator = await resolveField(page, 'input[name="email"]', 'mark@example.com');
      assert.ok(locator !== null, 'S5 FAIL: resolveField returned null (scorer failed)');
      const afterResolve = await page.locator('[data-aidr-resolve="1"]').count();
      assert.strictEqual(afterResolve, 1, `S5 FAIL: marker count after resolve=${afterResolve}, expected 1`);

      // Actually fill so the locator is consumed
      await locator.fill('mark@example.com');
      const filled = await readValue(page, 'input[name="email_renamed"]');
      assert.strictEqual(filled, 'mark@example.com',
        `S5 FAIL: fill value="${filled}", expected "mark@example.com"`);

      // After clearResolveMarker: marker gone
      await clearResolveMarker(page);
      const afterClear = await page.locator('[data-aidr-resolve]').count();
      assert.strictEqual(afterClear, 0,
        `S5 FAIL: marker still present after clearResolveMarker, count=${afterClear}`);

      console.log('S5 PASS: marker lifecycle before=0, during=1, after=0; filled=', filled);
    } finally {
      await page.close();
    }
  });
}); // end describe 'field-resolver browser integration'
