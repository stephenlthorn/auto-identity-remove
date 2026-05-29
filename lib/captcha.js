/**
 * lib/captcha.js
 *
 * CapSolver-backed CAPTCHA detection and solving.
 * Supports: reCAPTCHA v2, reCAPTCHA v3 (invisible), hCAPTCHA, Cloudflare Turnstile,
 *           AWS WAF CAPTCHA.
 * Detect-only (no auto-solver): DataDome, Arkose Labs FunCaptcha, PerimeterX, Akamai.
 *
 * Exported for testing: findRecaptchaCallback, buildHcaptchaScript,
 *                       buildTurnstileScript, buildRecaptchaV3Script, buildAwsWafScript
 *
 * NOTE: AWS WAF CapSolver pricing is significantly higher than reCAPTCHA/hCAPTCHA.
 *       See https://capsolver.com/pricing for current rates before enabling at scale.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Builds a JavaScript string that injects a reCAPTCHA token and fires known
 * callback paths. The original single-path approach only worked on roughly
 * 30% of integrations. This tries multiple known accessor shapes.
 * @param {string} token
 * @returns {string}
 */
function findRecaptchaCallback(token) {
  const t = JSON.stringify(String(token));
  return `
(function(token) {
  // 1. Set hidden input (required by all reCAPTCHA v2 integrations)
  var el = document.querySelector('#g-recaptcha-response');
  if (el) { el.value = token; el.style.display = 'block'; }
  document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(function(e) {
    e.value = token;
  });

  // 2. Traverse ___grecaptcha_cfg.clients to find and call all callback functions
  try {
    var clients = window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients;
    if (clients) {
      Object.keys(clients).forEach(function(key) {
        var client = clients[key];
        Object.keys(client).forEach(function(k) {
          var obj = client[k];
          if (obj && typeof obj.callback === 'function') {
            try { obj.callback(token); } catch(e) {}
          }
          if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach(function(k2) {
              if (obj[k2] && typeof obj[k2].callback === 'function') {
                try { obj[k2].callback(token); } catch(e) {}
              }
            });
          }
        });
      });
    }
  } catch(e) {}

  // 3. Dispatch change + input events so React/Vue/Angular bindings fire
  try {
    if (el) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }
  } catch(e) {}
})(${t});
`;
}

/**
 * Builds a JavaScript string that injects an hCAPTCHA solution token.
 * @param {string} token
 * @returns {string}
 */
function buildHcaptchaScript(token) {
  const t = JSON.stringify(String(token));
  return `
(function(token) {
  var el = document.querySelector('[name="h-captcha-response"]');
  if (!el) el = document.querySelector('textarea[name="h-captcha-response"]');
  if (el) { el.value = token; }
  // Do NOT call hcaptcha execute - it can re-trigger an interactive challenge.
  // Just set the value and dispatch change/input events (mirrors the reCAPTCHA approach).
  try {
    if (el) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }
  } catch(e) {}
})(${t});
`;
}

/**
 * Builds a JavaScript string that injects a Cloudflare Turnstile token.
 * @param {string} token
 * @returns {string}
 */
function buildTurnstileScript(token) {
  const t = JSON.stringify(String(token));
  return `
(function(token) {
  // Inject into the hidden cf-turnstile-response input
  var el = document.querySelector('[name="cf-turnstile-response"]');
  if (!el) el = document.querySelector('input[name="cf-turnstile-response"]');
  if (el) {
    el.value = token;
    try {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    } catch(e) {}
  }
  // Also try the Turnstile JS API callback if available
  try {
    if (window.turnstile) {
      var widget = document.querySelector('[data-sitekey][class*="cf-turnstile"]') ||
                   document.querySelector('.cf-turnstile[data-sitekey]');
      if (widget && typeof window.turnstile.reset === 'function') {
        // no-op: we injected the token directly
      }
    }
  } catch(e) {}
})(${t});
`;
}

/**
 * Builds a JavaScript string that injects a reCAPTCHA v3 token.
 * Reuses the same ___grecaptcha_cfg callback traversal as v2.
 * @param {string} token
 * @returns {string}
 */
function buildRecaptchaV3Script(token) {
  const t = JSON.stringify(String(token));
  return `
(function(token) {
  // 1. Set hidden textarea (standard injection point for v3 as well)
  document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(function(e) {
    e.value = token;
  });
  var el = document.querySelector('[name="g-recaptcha-response"]');
  if (el) {
    el.value = token;
    try {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    } catch(e) {}
  }

  // 2. Traverse ___grecaptcha_cfg.clients to fire all callbacks (v3 style)
  try {
    var clients = window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients;
    if (clients) {
      Object.keys(clients).forEach(function(key) {
        var client = clients[key];
        Object.keys(client).forEach(function(k) {
          var obj = client[k];
          if (obj && typeof obj.callback === 'function') {
            try { obj.callback(token); } catch(e) {}
          }
          if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach(function(k2) {
              if (obj[k2] && typeof obj[k2].callback === 'function') {
                try { obj[k2].callback(token); } catch(e) {}
              }
            });
          }
        });
      });
    }
  } catch(e) {}
})(${t});
`;
}

/**
 * Builds a JavaScript string that injects an AWS WAF CAPTCHA token.
 * @param {string} token
 * @returns {string}
 */
function buildAwsWafScript(token) {
  const t = JSON.stringify(String(token));
  return `
(function(token) {
  // Inject the AWS WAF token - the WAF SDK checks this attribute on the page
  try {
    var el = document.querySelector('[data-amzn-waf-token]');
    if (el) { el.setAttribute('data-amzn-waf-token', token); }
  } catch(e) {}
  // Also expose on window for scripts that read it directly
  try {
    window.AwsWafIntegration = window.AwsWafIntegration || {};
    window.AwsWafIntegration.token = token;
  } catch(e) {}
})(${t});
`;
}

async function solveRecaptcha(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     info  No CapSolver key - add one to config.json to auto-solve CAPTCHAs');
    return false;
  }
  try {
    const axios   = require('axios');
    const pageUrl = page.url();
    const siteKey = await page.evaluate(() => {
      // Prefer a sitekey inside a form with a submit button or input (avoids header widgets)
      const formEl = Array.from(document.querySelectorAll('form')).find(
        f => f.querySelector('[data-sitekey]') &&
             (f.querySelector('input[type="submit"],button[type="submit"],button,input[type="text"],input[type="email"]'))
      );
      if (formEl) return formEl.querySelector('[data-sitekey]').getAttribute('data-sitekey');
      // Fall back to page-level first [data-sitekey]
      return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null;
    });
    if (!siteKey) return false;

    console.log('     Solving reCAPTCHA via CapSolver...');
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
        await page.evaluate(findRecaptchaCallback(data.solution.gRecaptchaResponse));
        console.log('     reCAPTCHA solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     CapSolver reCAPTCHA error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

async function solveHcaptcha(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     info  No CapSolver key - cannot solve hCAPTCHA automatically');
    return false;
  }
  try {
    const axios   = require('axios');
    const pageUrl = page.url();
    const siteKey = await page.evaluate(() => {
      // Prefer a sitekey inside a form with a submit button or input (avoids header widgets)
      const formEl = Array.from(document.querySelectorAll('form')).find(
        f => f.querySelector('[data-sitekey]') &&
             (f.querySelector('input[type="submit"],button[type="submit"],button,input[type="text"],input[type="email"]'))
      );
      if (formEl) return formEl.querySelector('[data-sitekey]').getAttribute('data-sitekey');
      // Fall back to page-level [data-sitekey] or iframe src
      return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ||
        (document.querySelector('iframe[src*="hcaptcha"]')?.src || '').match(/sitekey=([^&]+)/)?.[1] || null;
    });
    if (!siteKey) return false;

    console.log('     Solving hCAPTCHA via CapSolver...');
    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: { type: 'HCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: siteKey },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        const token = data.solution.gRecaptchaResponse || '';
        await page.evaluate(buildHcaptchaScript(token));
        console.log('     hCAPTCHA solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     CapSolver hCAPTCHA error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

/**
 * Solves Cloudflare Turnstile via CapSolver AntiTurnstileTaskProxyLess.
 * @param {import('playwright').Page} page
 * @param {{ apiKey: string }} capsolver
 * @returns {Promise<boolean>}
 */
async function solveTurnstile(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     info  No CapSolver key - cannot solve Turnstile automatically');
    return false;
  }
  try {
    const axios   = require('axios');
    const pageUrl = page.url();
    const siteKey = await page.evaluate(() => {
      // Turnstile div carries data-sitekey
      const div = document.querySelector('.cf-turnstile[data-sitekey]') ||
                  document.querySelector('[data-sitekey][class*="cf-turnstile"]');
      if (div) return div.getAttribute('data-sitekey');
      // Fallback: extract from iframe src
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      if (iframe) {
        const m = (iframe.src || '').match(/[?&]sitekey=([^&]+)/);
        if (m) return m[1];
      }
      return null;
    });
    if (!siteKey) return false;

    console.log('     Solving Cloudflare Turnstile via CapSolver...');
    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: pageUrl, websiteKey: siteKey },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        const token = data.solution.token || '';
        await page.evaluate(buildTurnstileScript(token));
        console.log('     Turnstile solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     CapSolver Turnstile error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

/**
 * Solves invisible reCAPTCHA v3 via CapSolver ReCaptchaV3TaskProxyLess.
 * @param {import('playwright').Page} page
 * @param {{ apiKey: string }} capsolver
 * @returns {Promise<boolean>}
 */
async function solveRecaptchaV3(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     info  No CapSolver key - cannot solve reCAPTCHA v3 automatically');
    return false;
  }
  try {
    const axios   = require('axios');
    const pageUrl = page.url();
    const result = await page.evaluate(() => {
      // Extract sitekey from render= query param in the v3 script tag
      const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha/api.js"]'));
      for (const s of scripts) {
        const m = (s.src || '').match(/[?&]render=([^&]+)/);
        if (m && m[1] && m[1] !== 'explicit') return { siteKey: m[1], action: 'submit' };
      }
      return null;
    });
    if (!result) return false;
    const { siteKey, action } = result;

    console.log('     Solving reCAPTCHA v3 via CapSolver...');
    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: {
        type: 'ReCaptchaV3TaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: siteKey,
        pageAction: action,
      },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        const token = data.solution.gRecaptchaResponse || '';
        await page.evaluate(buildRecaptchaV3Script(token));
        console.log('     reCAPTCHA v3 solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     CapSolver reCAPTCHA v3 error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

/**
 * Solves AWS WAF CAPTCHA via CapSolver AntiAwsWafTask.
 *
 * NOTE: AWS WAF CapSolver pricing is significantly higher than reCAPTCHA/hCAPTCHA.
 *       See https://capsolver.com/pricing before enabling at scale.
 *
 * @param {import('playwright').Page} page
 * @param {{ apiKey: string }} capsolver
 * @returns {Promise<boolean>}
 */
async function solveAwsWaf(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     info  No CapSolver key - cannot solve AWS WAF CAPTCHA automatically');
    return false;
  }
  try {
    const axios   = require('axios');
    const pageUrl = page.url();
    // Extract AWS WAF parameters from the page - these are injected by the WAF script
    const wafParams = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="awswaf.com/captcha"]');
      if (!iframe) return null;
      const src = iframe.src || '';
      const awsKey  = src.match(/key=([^&]+)/)?.[1]    || null;
      const iv      = src.match(/iv=([^&]+)/)?.[1]     || null;
      const context = src.match(/context=([^&]+)/)?.[1] || null;
      if (!awsKey) return null;
      return { awsKey, iv, context };
    });
    if (!wafParams) return false;

    console.log('     Solving AWS WAF CAPTCHA via CapSolver...');
    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: {
        type: 'AntiAwsWafTask',
        websiteURL: pageUrl,
        awsKey:     wafParams.awsKey,
        awsIv:      wafParams.iv      || '',
        awsContext: wafParams.context || '',
        awsChallengeJS: '',
      },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(5000); // AWS WAF takes longer than reCAPTCHA
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        const token = data.solution.cookie || data.solution.token || '';
        await page.evaluate(buildAwsWafScript(token));
        console.log('     AWS WAF CAPTCHA solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     CapSolver AWS WAF error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

/**
 * Detect-only: DataDome challenge detection.
 * @param {import('playwright').Page} page
 * @returns {Promise<'datadome'|null>}
 */
async function detectDataDome(page) {
  const found = await page.evaluate(() => {
    return !!(document.querySelector('iframe[src*="captcha-delivery.com"]') ||
              document.querySelector('script[src*="datadome"]'));
  });
  return found ? 'datadome' : null;
}

/**
 * Detect-only: Arkose Labs FunCaptcha detection.
 * @param {import('playwright').Page} page
 * @returns {Promise<'arkose'|null>}
 */
async function detectArkose(page) {
  const found = await page.evaluate(() => {
    return !!(document.querySelector('iframe[src*="arkoselabs.com"]') ||
              document.querySelector('iframe[src*="funcaptcha"]'));
  });
  return found ? 'arkose' : null;
}

/**
 * Detect-only: PerimeterX bot manager detection.
 * @param {import('playwright').Page} page
 * @returns {Promise<'perimeterx'|null>}
 */
async function detectPerimeterX(page) {
  const found = await page.evaluate(() => {
    return !!document.querySelector('script[src*="perimeterx.net"]');
  });
  return found ? 'perimeterx' : null;
}

/**
 * Detect-only: Akamai Bot Manager detection.
 * @param {import('playwright').Page} page
 * @returns {Promise<'akamai'|null>}
 */
async function detectAkamai(page) {
  const found = await page.evaluate(() => {
    return !!document.querySelector('script[src*="akamaihd.net/sd/"]');
  });
  return found ? 'akamai' : null;
}

/**
 * Detects and attempts to solve any supported CAPTCHA on the page.
 * Probes in order: Turnstile -> hCAPTCHA -> reCAPTCHA v2 -> reCAPTCHA v3 -> AWS WAF
 * Then detect-only: DataDome, Arkose, PerimeterX, Akamai (returns false so the
 * broker is logged as 'captcha_failed' rather than silently passing).
 *
 * @param {import('playwright').Page} page
 * @param {{ apiKey: string }|null} capsolver
 * @returns {Promise<boolean>} true = no captcha or solved; false = failed/unsolvable
 */
async function detectAndSolveCaptcha(page, capsolver) {
  const captchaType = await page.evaluate(() => {
    // Cloudflare Turnstile
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
        document.querySelector('.cf-turnstile[data-sitekey]') ||
        document.querySelector('[data-sitekey][class*="cf-turnstile"]')) {
      return 'turnstile';
    }
    // hCAPTCHA (check before reCAPTCHA since both use data-sitekey)
    if (document.querySelector('iframe[src*="hcaptcha"],[data-hcaptcha-widget-id]')) {
      return 'hcaptcha';
    }
    // reCAPTCHA v3 invisible (script with render= param, no visible widget)
    if (document.querySelector('script[src*="recaptcha/api.js?render="]') ||
        document.querySelector('script[src*="recaptcha/api.js"][src*="render="]')) {
      return 'recaptcha-v3';
    }
    // reCAPTCHA v2 (visible widget)
    if (document.querySelector('.g-recaptcha,[data-sitekey],#recaptcha,iframe[src*="recaptcha"]')) {
      return 'recaptcha';
    }
    // AWS WAF CAPTCHA
    if (document.querySelector('iframe[src*="awswaf.com/captcha"]') ||
        document.querySelector('[data-amzn-waf-token]')) {
      return 'aws-waf';
    }
    return null;
  });

  if (captchaType) {
    console.log(`     captcha detected: ${captchaType}`);
    if (captchaType === 'turnstile')    return solveTurnstile(page, capsolver);
    if (captchaType === 'hcaptcha')     return solveHcaptcha(page, capsolver);
    if (captchaType === 'recaptcha-v3') return solveRecaptchaV3(page, capsolver);
    if (captchaType === 'recaptcha')    return solveRecaptcha(page, capsolver);
    if (captchaType === 'aws-waf')      return solveAwsWaf(page, capsolver);
  }

  // Detect-only challenges - no auto-solver available
  const detectOnly = await Promise.all([
    detectDataDome(page),
    detectArkose(page),
    detectPerimeterX(page),
    detectAkamai(page),
  ]);
  const unsolvable = detectOnly.find(t => t !== null);
  if (unsolvable) {
    console.log(`     captcha detected: ${unsolvable} (unsupported - no auto-solver)`);
    return false;
  }

  return true; // no captcha detected
}

module.exports = {
  // Solvers
  solveRecaptcha,
  solveHcaptcha,
  solveTurnstile,
  solveRecaptchaV3,
  solveAwsWaf,
  // Detect-only helpers
  detectDataDome,
  detectArkose,
  detectPerimeterX,
  detectAkamai,
  // Orchestrator
  detectAndSolveCaptcha,
  // Script builders (exported for testing)
  findRecaptchaCallback,
  buildHcaptchaScript,
  buildTurnstileScript,
  buildRecaptchaV3Script,
  buildAwsWafScript,
};
