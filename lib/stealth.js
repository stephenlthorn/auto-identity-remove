/**
 * lib/stealth.js
 *
 * Returns a JavaScript string to inject via context.addInitScript() that masks
 * the most common Playwright automation fingerprints.
 *
 * This runs before any page JavaScript so the overrides are in place before
 * the WAF fingerprint probe executes. No new npm dependencies required.
 *
 * It also keeps what a page can read consistent with the regular Chrome user agent
 * lib/browser.js sends when headless: no "HeadlessChrome" in navigator.userAgent,
 * navigator.appVersion or the navigator.userAgentData brands.
 *
 * Does NOT guarantee bypass of enterprise-grade WAFs - it removes the trivially
 * detectable signals (navigator.webdriver = true, empty plugins, missing
 * languages) that cause instant blocks on many broker sites.
 */

const STEALTH_SCRIPT = `
(function () {
  // 1. Mask navigator.webdriver - the most common Playwright automation tell
  Object.defineProperty(navigator, 'webdriver', {
    get: function() { return undefined; },
    configurable: true,
  });

  // 2. Populate navigator.plugins with a minimal realistic stub.
  //    Empty plugins array is a strong headless signal.
  if (!navigator.plugins || navigator.plugins.length === 0) {
    var pluginData = [
      ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
      ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
      ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ];
    try {
      var fakePlugins = pluginData.map(function(d) {
        var p = { name: d[0], filename: d[1], description: d[2], length: 0 };
        return p;
      });
      Object.defineProperty(navigator, 'plugins', {
        get: function() { return fakePlugins; },
        configurable: true,
      });
    } catch(e) {}
  }

  // 3. Ensure navigator.languages is set (empty array is a headless signal)
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', {
        get: function() { return ['en-US', 'en']; },
        configurable: true,
      });
    }
  } catch(e) {}

  // 4. Add minimal chrome.runtime stub if missing (headless Chrome lacks it)
  try {
    if (window.chrome && !window.chrome.runtime) {
      window.chrome.runtime = {
        onMessage: { addListener: function() {}, removeListener: function() {} },
      };
    }
  } catch(e) {}

  // 5. Headless Chromium puts "HeadlessChrome" in navigator.userAgent. lib/browser.js
  //    already sends a regular Chrome UA at launch (and a headed browser never had
  //    the word), so this only acts when a launch could not: an unknown browser
  //    version, a custom executable. It must agree with the launch option, never
  //    contradict it, and it does nothing when the string is already clean.
  try {
    var navProto = Object.getPrototypeOf(navigator);
    var rawUa = navigator.userAgent;
    if (typeof rawUa === 'string' && rawUa.indexOf('HeadlessChrome') !== -1) {
      var cleanUa = rawUa.split('HeadlessChrome').join('Chrome');
      var cleanVersion = String(navigator.appVersion).split('HeadlessChrome').join('Chrome');
      Object.defineProperty(navProto, 'userAgent', {
        get: function() { return cleanUa; },
        configurable: true,
        enumerable: true,
      });
      Object.defineProperty(navProto, 'appVersion', {
        get: function() { return cleanVersion; },
        configurable: true,
        enumerable: true,
      });
    }
  } catch(e) {}

  // 6. The old headless shell also puts a "HeadlessChrome" brand in
  //    navigator.userAgentData. Rename just that brand to "Google Chrome" so the
  //    browser's own GREASE brand, ordering and versions stay real. Left alone
  //    when no brand says Headless (new headless and headed Chrome already
  //    report "Google Chrome"): the Sec-CH-UA request header comes from the
  //    browser and is not something a page script can change.
  try {
    var uaData = navigator.userAgentData;
    if (uaData && /headless/i.test(JSON.stringify(uaData.brands))) {
      var uaProto = Object.getPrototypeOf(uaData);
      var fixList = function(list) {
        return Array.prototype.map.call(list || [], function(entry) {
          return /^HeadlessChrome$/i.test(entry.brand)
            ? { brand: 'Google Chrome', version: entry.version }
            : entry;
        });
      };
      var fixValues = function(values) {
        if (values && values.brands) values.brands = fixList(values.brands);
        if (values && values.fullVersionList) values.fullVersionList = fixList(values.fullVersionList);
        return values;
      };
      var brandsAccessor = Object.getOwnPropertyDescriptor(uaProto, 'brands');
      if (brandsAccessor && brandsAccessor.get) {
        Object.defineProperty(uaProto, 'brands', {
          get: function() { return fixList(brandsAccessor.get.call(this)); },
          configurable: true,
          enumerable: true,
        });
      }
      var nativeHighEntropy = uaProto.getHighEntropyValues;
      if (typeof nativeHighEntropy === 'function') {
        uaProto.getHighEntropyValues = function(hints) {
          return nativeHighEntropy.call(this, hints).then(fixValues);
        };
      }
      var nativeToJSON = uaProto.toJSON;
      if (typeof nativeToJSON === 'function') {
        uaProto.toJSON = function() { return fixValues(nativeToJSON.call(this)); };
      }
    }
  } catch(e) {}
})();
`;

function buildStealthScript() {
  return STEALTH_SCRIPT;
}

module.exports = { buildStealthScript };
