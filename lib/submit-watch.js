/**
 * lib/submit-watch.js
 *
 * Did something submit this form while the runner was not looking? (BRK2-3)
 *
 * The runner fills a form, then waits for a CAPTCHA: a person solves it by hand, or
 * CapSolver injects a token and fires the page's callback. Either can SUBMIT the form
 * (the person presses Send; the site's callback calls form.submit()). The runner then
 * clicked submit a second time, and the broker received two requests; when the form
 * was replaced by a confirmation it reported "nothing was submitted" although the
 * request had been sent.
 *
 * armSubmitWatch() installs listeners in the page before the wait; observed() says
 * afterwards whether the submit control was clicked or a submit happened. It is
 * evidence of a submission only: callers combine it with "the control is gone" and
 * "result wording appeared" before deciding not to click.
 */

'use strict';

const MARK_ATTR = 'data-aidr-submit-watch';

/**
 * Page-side. Counts clicks on the marked submit control, every `submit` event and
 * every programmatic form.submit() / requestSubmit(). Runs INSIDE the page, so it
 * stays self-contained; installing twice is a no-op.
 */
function installSubmitWatch(markAttr) {
  if (window.__aidrSubmitWatch) return true;
  var watch = { count: 0 };
  window.__aidrSubmitWatch = watch;
  var bump = function () { watch.count += 1; };
  document.addEventListener('submit', bump, true);
  document.addEventListener('click', function (event) {
    var target = event.target;
    var marked = target && target.closest ? target.closest('[' + markAttr + ']') : null;
    if (marked) bump();
  }, true);
  ['submit', 'requestSubmit'].forEach(function (name) {
    var native = HTMLFormElement.prototype[name];
    if (typeof native !== 'function') return;
    HTMLFormElement.prototype[name] = function () {
      bump();
      return native.apply(this, arguments);
    };
  });
  return true;
}

/** Page-side: how many submissions the watch has seen, or -1 when it is not installed. */
function readSubmitWatch() {
  return window.__aidrSubmitWatch ? window.__aidrSubmitWatch.count : -1;
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator|null} [control] the submit control the runner will click
 * @returns {Promise<{ armed: boolean, observed: () => Promise<boolean> }>}
 *   never throws: a page that cannot be instrumented (a stub, a closing page) is simply not watched
 */
async function armSubmitWatch(page, control) {
  if (control && typeof control.evaluate === 'function') {
    try {
      await control.evaluate((el, attr) => el.setAttribute(attr, '1'), MARK_ATTR);
    } catch (_) {
      // Not markable: submit events and form.submit() are still watched.
    }
  }
  let armed = false;
  try {
    armed = (await page.evaluate(installSubmitWatch, MARK_ATTR)) === true;
  } catch (_) {
    armed = false;
  }
  return {
    armed,
    async observed() {
      if (!armed) return false;
      try {
        const count = await page.evaluate(readSubmitWatch);
        return typeof count === 'number' && count > 0;
      } catch (_) {
        // The page navigated away: the caller's URL / control checks cover that.
        return false;
      }
    },
  };
}

module.exports = { armSubmitWatch, installSubmitWatch, readSubmitWatch, MARK_ATTR };
