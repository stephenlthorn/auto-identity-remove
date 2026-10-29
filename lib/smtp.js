/**
 * lib/smtp.js
 *
 * Builds nodemailer transport options from cfg.email.smtp, shared by every
 * place that sends mail (opt-out emails, right-to-know requests, the report).
 *
 * Optional `ca`: path to a PEM certificate to trust for this server. Local
 * bridges such as Proton Mail Bridge serve a self-signed certificate, which
 * Node rejects ("self-signed certificate"). Pointing `ca` at the exported
 * cert trusts exactly that certificate, so verification stays on - never
 * reach for rejectUnauthorized: false instead. A relative path resolves
 * against the project root, where config.json lives.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

/**
 * @param {object} smtpCfg - { host, port, user, pass, from, ca? }
 * @param {string} [rootDir] - base for a relative `ca` path (injected for tests)
 * @returns {object} options for nodemailer.createTransport
 * @throws {Error} when `ca` is set but the file cannot be read
 */
function smtpTransportOptions(smtpCfg, rootDir = ROOT_DIR) {
  const port = smtpCfg.port || 587;
  const opts = {
    host: smtpCfg.host,
    port,
    secure: port === 465,
    auth: { user: smtpCfg.user, pass: smtpCfg.pass },
  };
  if (smtpCfg.ca) {
    const caPath = path.resolve(rootDir, smtpCfg.ca);
    let ca;
    try {
      ca = fs.readFileSync(caPath, 'utf8');
    } catch (e) {
      // Code first: callers truncate SMTP errors, and the path is the long part.
      throw new Error(`email.smtp.ca unreadable (${e.code || e.message}): ${caPath}`);
    }
    opts.tls = { ca };
  }
  return opts;
}

module.exports = { smtpTransportOptions };
