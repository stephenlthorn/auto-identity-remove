/**
 * test/manual-captcha-harness.js - shared stubs for the manual-CAPTCHA tests.
 *
 * Not a test file (no .test.js suffix). Two pieces:
 *
 *   makeCaptchaPage(spec)  a page whose DOM is a small mutable model. The probes
 *                          in lib/captcha.js and lib/manual-captcha.js are told
 *                          apart by function name, so a "human" can change the
 *                          model (fill the hidden response field, close the tab,
 *                          navigate) and the code under test sees it on its next
 *                          poll - without a browser.
 *   makeClock(script)      a fake clock. sleep(ms) advances `now()` and runs the
 *                          scripted human actions that have become due, so a
 *                          3-minute wait finishes instantly and deterministically.
 */

'use strict';

/**
 * @param {object} [spec]
 * @param {string|null} [spec.type]        what the solver-side probe reports: 'recaptcha',
 *                                         'hcaptcha', 'turnstile', 'recaptcha-v3', 'aws-waf' or null
 * @param {string|null} [spec.unsupported] 'datadome' | 'arkose' | 'perimeterx' | 'akamai'
 * @param {object} [spec.state]            overrides for { ready, token, frame, humanText }
 * @param {string} [spec.url]
 * @param {number} [spec.evalFailures]     the first N evaluate() calls throw like a mid-navigation page
 * @param {string} [spec.bodyText]         what an innerText read returns
 */
function makeCaptchaPage(spec = {}) {
  const model = {
    type: spec.type === undefined ? null : spec.type,
    unsupported: spec.unsupported || null,
    state: { ready: true, token: false, frame: false, humanText: false, ...(spec.state || {}) },
    url: spec.url || 'https://example.test/optout',
    bodyText: spec.bodyText || '',
    closed: false,
    evalFailures: spec.evalFailures || 0,
    evaluations: [],
    broughtToFront: 0,
  };

  const unsupportedProbe = {
    pageHasDataDome: 'datadome',
    pageHasArkose: 'arkose',
    pageHasPerimeterX: 'perimeterx',
    pageHasAkamai: 'akamai',
  };

  const page = {
    model,
    url: () => model.url,
    isClosed: () => model.closed,
    async bringToFront() { model.broughtToFront += 1; },
    async evaluate(fn) {
      if (model.closed) throw new Error('Target page, context or browser has been closed');
      if (model.evalFailures > 0) {
        model.evalFailures -= 1;
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      }
      const name = typeof fn === 'function' ? fn.name : '';
      model.evaluations.push(name);
      if (name === 'pageCaptchaType') return model.type;
      if (name === 'readCaptchaState') return { ...model.state };
      if (Object.prototype.hasOwnProperty.call(unsupportedProbe, name)) {
        return model.unsupported === unsupportedProbe[name];
      }
      return model.bodyText;
    },
    async close() { model.closed = true; },
  };
  return page;
}

/**
 * @param {Array<{ at: number, run: (page: object) => void }>} [script] human actions, `at` in ms of fake time
 * @param {object} [page] the page the actions act on
 */
function makeClock(script = [], page = null) {
  const pending = [...script].sort((a, b) => a.at - b.at);
  const clock = {
    t: 0,
    sleeps: 0,
    now: () => clock.t,
    async sleep(ms) {
      clock.sleeps += 1;
      clock.t += ms;
      while (pending.length && pending[0].at <= clock.t) pending.shift().run(page);
    },
  };
  return clock;
}

/** The human ticks the box: the hidden response field fills. */
const humanSolves = (at) => ({ at, run: (page) => { page.model.state.token = true; } });

/** The widget goes away without a token (an interstitial that lets the visitor through). */
const widgetVanishes = (at) => ({ at, run: (page) => {
  page.model.type = null;
  page.model.unsupported = null;
  page.model.state.frame = false;
  page.model.state.humanText = false;
} });

module.exports = { makeCaptchaPage, makeClock, humanSolves, widgetVanishes };
