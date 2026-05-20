/**
 * lib/stealth.js
 *
 * Returns a JavaScript string to inject via context.addInitScript() that masks
 * the most common Playwright automation fingerprints.
 *
 * This runs before any page JavaScript so the overrides are in place before
 * the WAF fingerprint probe executes. No new npm dependencies required.
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
})();
`;

function buildStealthScript() {
  return STEALTH_SCRIPT;
}

module.exports = { buildStealthScript };
