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
 * Returns true when a CapSolver API key is a known placeholder (not a real key).
 * Centralised here so captcha.js and doctor.js can share the same check.
 *
 * @param {string|null|undefined} key
 * @returns {boolean}
 */
function isPlaceholderKey(key) {
  if (!key) return false;
  return String(key).startsWith('CAP-YOUR');
}

/**
 * Poll the CapSolver getTaskResult endpoint until the task is ready or failed.
 * Returns the solution object on success, or null on failure / timeout.
 *
 * @param {string} taskId
 * @param {{ clientKey: string, intervalMs?: number, maxTries?: number, deadlineMs?: number, axios: object }} opts
 *   - axios: an axios-compatible instance (injected for testability)
 *   - intervalMs: ms between polls (default 3000)
 *   - maxTries: max poll attempts (default 30)
 *   - deadlineMs: absolute wall-clock budget in ms; polling stops once exceeded
 *       so a stuck task cannot consume the full budget. Defaults to the sleep
 *       budget (intervalMs * maxTries) plus a per-try request allowance, so
 *       normal polling is never cut short by request latency; pass an explicit
 *       value for a tighter cap. The first poll always fires immediately - we
 *       never sleep before it.
 * @returns {Promise<object|null>}
 */
async function pollCapSolver(taskId, opts) {
  const { clientKey, axios, intervalMs = 3000, maxTries = 30 } = opts;
  // Per-try request allowance matches the injected axios timeout (30s) so a
  // legitimately slow request is not mistaken for a runaway task.
  const REQUEST_BUDGET_MS = 30000;
  const deadlineMs = opts.deadlineMs ?? (intervalMs + REQUEST_BUDGET_MS) * maxTries;
  const start = Date.now();
  for (let i = 0; i < maxTries; i++) {
    // Poll once immediately; only sleep between subsequent attempts. This avoids
    // burning intervalMs (3-5s) before the very first check.
    if (i > 0 && intervalMs > 0) await sleep(intervalMs);
    // Absolute wall-clock guard: never let a stuck task consume the full budget.
    if (Date.now() - start >= deadlineMs) return null;
    const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey, taskId });
    if (data.status === 'ready') return data.solution;
    if (data.status === 'failed') return null;
  }
  return null;
}

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
  if (!key || isPlaceholderKey(key)) {
    console.log('     info  No CapSolver key - add one to config.json to auto-solve CAPTCHAs');
    return false;
  }
  try {
    const axios   = require('axios').create({ timeout: 30000 });
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

    const solution = await pollCapSolver(taskId, { clientKey: key, axios });
    if (!solution) return false;
    await page.evaluate(findRecaptchaCallback(solution.gRecaptchaResponse));
    console.log('     reCAPTCHA solved');
    return true;
  } catch (err) {
    console.log(`     CapSolver reCAPTCHA error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

async function solveHcaptcha(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || isPlaceholderKey(key)) {
    console.log('     info  No CapSolver key - cannot solve hCAPTCHA automatically');
    return false;
  }
  try {
    const axios   = require('axios').create({ timeout: 30000 });
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

    const solution = await pollCapSolver(taskId, { clientKey: key, axios });
    if (!solution) return false;
    const token = solution.gRecaptchaResponse || '';
    await page.evaluate(buildHcaptchaScript(token));
    console.log('     hCAPTCHA solved');
    return true;
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
  if (!key || isPlaceholderKey(key)) {
    console.log('     info  No CapSolver key - cannot solve Turnstile automatically');
    return false;
  }
  try {
    const axios   = require('axios').create({ timeout: 30000 });
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

    const solution = await pollCapSolver(taskId, { clientKey: key, axios });
    if (!solution) return false;
    const token = solution.token || '';
    await page.evaluate(buildTurnstileScript(token));
    console.log('     Turnstile solved');
    return true;
  } catch (err) {
    console.log(`     CapSolver Turnstile error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

/**
 * Solves invisible reCAPTCHA v3 via CapSolver ReCaptchaV3TaskProxyLess.
 *
 * v3 scores are action-scoped, so the pageAction sent to CapSolver must match
 * what the site expects. A broker config may override it via
 * `broker.recaptchaV3Action`; otherwise we default to 'submit'.
 *
 * @param {import('playwright').Page} page
 * @param {{ apiKey: string }} capsolver
 * @param {{ recaptchaV3Action?: string }} [broker]
 * @returns {Promise<boolean>}
 */
async function solveRecaptchaV3(page, capsolver, broker) {
  const key = capsolver?.apiKey;
  if (!key || isPlaceholderKey(key)) {
    console.log('     info  No CapSolver key - cannot solve reCAPTCHA v3 automatically');
    return false;
  }
  try {
    const axios   = require('axios').create({ timeout: 30000 });
    const pageUrl = page.url();
    const result = await page.evaluate(() => {
      // Extract sitekey from render= query param in the v3 script tag
      const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha/api.js"]'));
      for (const s of scripts) {
        const m = (s.src || '').match(/[?&]render=([^&]+)/);
        if (m && m[1] && m[1] !== 'explicit') return { siteKey: m[1] };
      }
      return null;
    });
    if (!result) return false;
    const { siteKey } = result;
    const action = broker?.recaptchaV3Action || 'submit';

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

    const solution = await pollCapSolver(taskId, { clientKey: key, axios });
    if (!solution) return false;
    const token = solution.gRecaptchaResponse || '';
    await page.evaluate(buildRecaptchaV3Script(token));
    console.log('     reCAPTCHA v3 solved');
    return true;
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
  if (!key || isPlaceholderKey(key)) {
    console.log('     info  No CapSolver key - cannot solve AWS WAF CAPTCHA automatically');
    return false;
  }
  try {
    const axios   = require('axios').create({ timeout: 30000 });
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

    // AWS WAF takes longer than reCAPTCHA - use 5s interval
    const solution = await pollCapSolver(taskId, { clientKey: key, axios, intervalMs: 5000 });
    if (!solution) return false;
    const token = solution.cookie || solution.token || '';
    await page.evaluate(buildAwsWafScript(token));
    console.log('     AWS WAF CAPTCHA solved');
    return true;
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
 * @param {{ recaptchaV3Action?: string }} [broker] optional broker config for
 *   solver overrides (e.g. reCAPTCHA v3 pageAction)
 * @returns {Promise<boolean>} true = no captcha or solved; false = failed/unsolvable
 */
async function detectAndSolveCaptcha(page, capsolver, broker) {
  const captchaType = await page.evaluate(() => {
    // Cloudflare Turnstile
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
        document.querySelector('.cf-turnstile[data-sitekey]') ||
        document.querySelector('[data-sitekey][class*="cf-turnstile"]')) {
      return 'turnstile';
    }
    // hCAPTCHA (check before reCAPTCHA since both use data-sitekey). Covers the
    // iframe/widget-id forms AND the lazy-loaded <div class="h-captcha"
    // data-sitekey> form, which would otherwise be caught by the reCAPTCHA v2
    // [data-sitekey] catch-all below and mis-solved as reCAPTCHA.
    if (document.querySelector('iframe[src*="hcaptcha"],[data-hcaptcha-widget-id]') ||
        document.querySelector('.h-captcha[data-sitekey]') ||
        document.querySelector('[data-sitekey][class*="h-captcha"]')) {
      return 'hcaptcha';
    }
    // reCAPTCHA v3 invisible (script with render=SITEKEY param, no visible
    // widget). Exclude render=explicit, which is standard v2 explicit-render and
    // must fall through to the v2 branch below.
    const v3Scripts = Array.from(document.querySelectorAll('script[src*="recaptcha/api.js"]'));
    if (v3Scripts.some(s => /[?&]render=(?!explicit(?:&|$))[^&]+/.test(s.src || s.getAttribute('src') || ''))) {
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
    if (captchaType === 'recaptcha-v3') return solveRecaptchaV3(page, capsolver, broker);
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
  // Shared helpers
  isPlaceholderKey,
  pollCapSolver,
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
