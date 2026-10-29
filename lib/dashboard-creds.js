'use strict';
/*
 * lib/dashboard-creds.js - credentials and start-up messaging for the local
 * dashboard so `aidr dashboard` never starts unauthenticated.
 *
 * The password is a URL-safe base64url string derived from 18 random bytes
 * (24 chars), safe to drop into an HTTP Basic credential and a localhost URL.
 *
 * Everything here is pure or a single existsSync, so bin/aidr.js and the server
 * share one answer to "where do saved credentials live" and tests need no server.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function generateDashboardCreds() {
  const pass = crypto.randomBytes(18).toString('base64url');
  return { user: 'admin', pass };
}

/**
 * Where the dashboard keeps credentials changed from its Admin tab. These
 * override AIDR_USER/AIDR_PASS, which is why the CLI must not invent a password
 * once the file exists: the printed one would simply 401.
 *
 * AIDR_AUTH_FILE relocates it (a read-only install directory cannot hold it).
 *
 * @param {object} env
 * @param {string} dashboardDir  absolute path of <root>/dashboard
 * @returns {string}
 */
function resolveAuthFile(env, dashboardDir) {
  const override = env && env.AIDR_AUTH_FILE;
  return override ? path.resolve(override) : path.join(dashboardDir, '.auth.json');
}

function hasSavedCredentials(authFile) {
  return fs.existsSync(authFile);
}

/**
 * Can `express` be resolved the way dashboard/server.js will resolve it?
 * The dashboard has its own manifest, so a fresh clone that only ran the root
 * `npm install` has no express and the server died with MODULE_NOT_FOUND right
 * after the CLI had already printed a password.
 *
 * @param {string} dashboardDir
 * @returns {boolean}
 */
function findExpress(dashboardDir) {
  try {
    require.resolve('express', { paths: [dashboardDir] });
    return true;
  } catch (_) {
    return false;
  }
}

function expressMissingMessage() {
  return [
    'aidr: the dashboard needs the "express" package, which is not installed.',
    '      Install it with:  cd dashboard && npm install',
    '',
  ].join('\n');
}

/**
 * The text `aidr dashboard` prints once the server is actually listening.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number|string} opts.port
 * @param {{ user: string, pass: string }|null} [opts.generated]  one-time creds we invented
 * @param {boolean} [opts.savedCredentials]  dashboard/.auth.json exists
 * @param {boolean} [opts.envCredentials]    AIDR_USER/AIDR_PASS came from the environment
 * @returns {string}
 */
function formatBanner({ host, port, generated = null, savedCredentials = false, envCredentials = false }) {
  const bare = String(host || '').replace(/^\[|\]$/g, '');
  const name = !bare || bare === '0.0.0.0' || bare === '::' ? 'localhost' : bare;
  const shown = name.includes(':') ? `[${name}]` : name;
  const lines = ['', '  Dashboard ready', `  URL:      http://${shown}:${port}`];
  if (generated) {
    lines.push(`  Username: ${generated.user}`);
    lines.push(`  Password: ${generated.pass}`);
    lines.push('  (these credentials are shown once; re-run to get new ones)');
  } else if (savedCredentials) {
    lines.push('  Login:    use your saved credentials (the ones you set in the Admin tab)');
  } else if (envCredentials) {
    lines.push('  Login:    use AIDR_USER / AIDR_PASS from your environment');
  }
  lines.push('', '');
  return lines.join('\n');
}

module.exports = {
  generateDashboardCreds,
  resolveAuthFile,
  hasSavedCredentials,
  findExpress,
  expressMissingMessage,
  formatBanner,
};
