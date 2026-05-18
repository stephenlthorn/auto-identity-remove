/**
 * lib/captcha.js
 *
 * CapSolver-backed reCAPTCHA/hCAPTCHA detection and solving. Verbatim move
 * from the monolith. `capsolver` config is passed in (was a closed-over
 * module var) to keep these as pure functions and avoid a config import.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function solveRecaptcha(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     ℹ  No CapSolver key — add one to config.json to auto-solve CAPTCHAs');
    return false;
  }

  try {
    const axios  = require('axios');
    const pageUrl = page.url();
    const siteKey = await page.evaluate(() =>
      document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null
    );
    if (!siteKey) return false;

    console.log('     🔑 Solving CAPTCHA via CapSolver…');

    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: { type: 'ReCaptchaV2TaskProxyless', websiteURL: pageUrl, websiteKey: siteKey },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        const token = data.solution.gRecaptchaResponse;
        await page.evaluate(t => {
          const el = document.querySelector('#g-recaptcha-response');
          if (el) el.value = t;
          try { window.___grecaptcha_cfg.clients[0].aa.l.callback(t); } catch(_) {}
        }, token);
        console.log('     ✓ CAPTCHA solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     ⚠  CapSolver: ${err.message.slice(0, 60)}`);
    return false;
  }
}

async function detectAndSolveCaptcha(page, capsolver) {
  const hasCaptcha = await page.evaluate(() => !!(
    document.querySelector('.g-recaptcha,[data-sitekey],#recaptcha,iframe[src*="recaptcha"]') ||
    document.querySelector('iframe[src*="hcaptcha"],[data-hcaptcha-widget-id]')
  ));
  if (!hasCaptcha) return true;
  return solveRecaptcha(page, capsolver);
}

module.exports = { solveRecaptcha, detectAndSolveCaptcha };
