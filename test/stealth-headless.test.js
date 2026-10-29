/**
 * test/stealth-headless.test.js
 *
 * R7: lib/browser.js removes "HeadlessChrome" from the user agent at launch.
 * lib/stealth.js is the second line, and has to agree with it: whatever JavaScript on a
 * page can read (navigator.userAgent, navigator.appVersion, the navigator.userAgentData
 * brands) must not say HeadlessChrome either, and must stay untouched when it already
 * looks like a regular Chrome (so the common path adds no detectable patching).
 *
 * The script is evaluated in a vm sandbox against a fake navigator whose prototype carries
 * accessors the way a real one does. test/browser-headless-ua.test.js runs the same script
 * in a real Chrome (opt-in).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { buildStealthScript } = require('../lib/stealth');

const HEADLESS_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.0.0 Safari/537.36';
const CHROME_UA = HEADLESS_UA.replace('HeadlessChrome', 'Chrome');
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeNavigator({ userAgent, brands, highEntropy } = {}) {
  class FakeUAData {
    get brands() { return brands; }
    get mobile() { return false; }
    get platform() { return 'Linux'; }
    getHighEntropyValues(hints) {
      return Promise.resolve({ brands, fullVersionList: highEntropy, mobile: false, platform: 'Linux', architecture: 'x86', requested: hints });
    }
    toJSON() { return { brands, mobile: false, platform: 'Linux' }; }
  }
  class FakeNavigator {
    get userAgent() { return userAgent; }
    get appVersion() { return userAgent.replace(/^Mozilla\//, ''); }
    get webdriver() { return true; }
  }
  const navigator = new FakeNavigator();
  if (brands) Object.defineProperty(navigator, 'userAgentData', { value: new FakeUAData(), configurable: true });
  return navigator;
}

const runStealth = (navigator) => vm.runInNewContext(buildStealthScript(), { navigator, window: {} });

const HEADLESS_BRANDS = [
  { brand: 'Not:A-Brand', version: '8' },
  { brand: 'HeadlessChrome', version: '148' },
  { brand: 'Chromium', version: '148' },
];
const HEADLESS_FULL = [
  { brand: 'Not:A-Brand', version: '8.0.0.0' },
  { brand: 'HeadlessChrome', version: '148.0.7778.96' },
  { brand: 'Chromium', version: '148.0.7778.96' },
];

describe('stealth: user agent', () => {
  test('a HeadlessChrome user agent and appVersion read as Chrome, everything else unchanged', () => {
    const navigator = makeNavigator({ userAgent: HEADLESS_UA });
    runStealth(navigator);
    assert.equal(navigator.userAgent, CHROME_UA);
    assert.equal(navigator.appVersion, CHROME_UA.replace(/^Mozilla\//, ''));
  });

  test('a user agent that is already regular Chrome is not patched at all', () => {
    const navigator = makeNavigator({ userAgent: CHROME_UA });
    const proto = Object.getPrototypeOf(navigator);
    const before = Object.getOwnPropertyDescriptor(proto, 'userAgent').get;
    runStealth(navigator);
    assert.equal(Object.getOwnPropertyDescriptor(proto, 'userAgent').get, before);
    assert.equal(navigator.userAgent, CHROME_UA);
  });

  test('the original webdriver masking still applies', () => {
    const navigator = makeNavigator({ userAgent: CHROME_UA });
    runStealth(navigator);
    assert.equal(navigator.webdriver, undefined);
  });
});

describe('stealth: navigator.userAgentData', () => {
  test('a HeadlessChrome brand becomes Google Chrome, keeping order, versions and the other brands', () => {
    const navigator = makeNavigator({ userAgent: HEADLESS_UA, brands: HEADLESS_BRANDS, highEntropy: HEADLESS_FULL });
    runStealth(navigator);
    assert.deepEqual(plain(navigator.userAgentData.brands), [
      { brand: 'Not:A-Brand', version: '8' },
      { brand: 'Google Chrome', version: '148' },
      { brand: 'Chromium', version: '148' },
    ]);
    assert.equal(navigator.userAgentData.mobile, false);
    assert.equal(navigator.userAgentData.platform, 'Linux');
  });

  test('getHighEntropyValues and toJSON are cleaned too, and pass the rest through', async () => {
    const navigator = makeNavigator({ userAgent: HEADLESS_UA, brands: HEADLESS_BRANDS, highEntropy: HEADLESS_FULL });
    runStealth(navigator);
    const high = plain(await navigator.userAgentData.getHighEntropyValues(['fullVersionList']));
    assert.ok(!JSON.stringify(high).includes('HeadlessChrome'));
    assert.deepEqual(high.fullVersionList[1], { brand: 'Google Chrome', version: '148.0.7778.96' });
    assert.equal(high.architecture, 'x86');
    assert.deepEqual(high.requested, ['fullVersionList']);
    assert.ok(!JSON.stringify(navigator.userAgentData.toJSON()).includes('HeadlessChrome'));
  });

  test('brands that already say Google Chrome are left exactly as the browser reports them', () => {
    const clean = [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }, { brand: 'Google Chrome', version: '156' }];
    const navigator = makeNavigator({ userAgent: CHROME_UA, brands: clean, highEntropy: clean });
    const proto = Object.getPrototypeOf(navigator.userAgentData);
    const originals = { brands: Object.getOwnPropertyDescriptor(proto, 'brands').get, hev: proto.getHighEntropyValues, toJSON: proto.toJSON };
    runStealth(navigator);
    assert.equal(Object.getOwnPropertyDescriptor(proto, 'brands').get, originals.brands);
    assert.equal(proto.getHighEntropyValues, originals.hev);
    assert.equal(proto.toJSON, originals.toJSON);
  });

  test('a browser without userAgentData (Firefox, an old Chrome) is fine', () => {
    const navigator = makeNavigator({ userAgent: HEADLESS_UA });
    assert.doesNotThrow(() => runStealth(navigator));
    assert.equal(navigator.userAgent, CHROME_UA);
  });

  test('a userAgentData that throws on read does not break the rest of the script', () => {
    class Hostile { get userAgent() { return CHROME_UA; } get userAgentData() { throw new Error('boom'); } }
    const navigator = new Hostile();
    assert.doesNotThrow(() => runStealth(navigator));
  });
});
