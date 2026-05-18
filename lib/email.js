/**
 * lib/email.js
 *
 * Cross-platform email opt-out sender.
 *
 * Public API:
 *   sendOptOutEmails(brokers, cfg)
 *
 * Routing:
 *   cfg.email.smtp set → nodemailer (lazy-required, optional dep)
 *   no smtp configured → logResult(..., 'manual', ...) on all platforms
 *
 * nodemailer is listed as an optionalDependency in package.json. The lazy
 * require inside _sendViaSMTP means startup is never affected on machines that
 * lack the package.
 */

const { getPlatform } = require('./platform');
const configMod = require('./config');
const loggerMod = require('./logger');

/**
 * Build the plain-text opt-out email body from person data.
 * @param {object} person
 * @returns {string}
 */
function _buildBody(person) {
  return [
    'To Whom It May Concern,',
    '',
    'I am requesting the removal of all records associated with my personal information',
    'from your database, under CCPA and applicable privacy laws.',
    '',
    `Name: ${person.fullName}`,
    `Location: ${person.city}, ${person.state} ${person.zip}`,
    `Email: ${person.email}`,
    `Phone: ${person.phoneFormatted}`,
    '',
    'Please remove all profiles, records, and personally identifiable information',
    'and confirm removal within 30 days.',
    '',
    'Thank you,',
    `${person.fullName}`,
  ].join('\\n');
}

// ─── nodemailer path (any OS when cfg.email.smtp configured) ─────────────────

/**
 * Send a single opt-out email via SMTP using nodemailer (lazy-required).
 *
 * @param {object} broker
 * @param {object} person
 * @param {object} smtpCfg  - { host, port, user, pass, from }
 */
async function _sendViaSMTP(broker, person, smtpCfg) {
  // Lazy require — nodemailer is optional; avoids startup error when absent.
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    loggerMod.logResult(broker.name, 'error', 'nodemailer not installed — run: npm install nodemailer');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpCfg.host,
    port: smtpCfg.port || 587,
    secure: (smtpCfg.port || 587) === 465,
    auth: { user: smtpCfg.user, pass: smtpCfg.pass },
  });

  const bodyLines = [
    'To Whom It May Concern,',
    '',
    'I am requesting the removal of all records associated with my personal information',
    'from your database, under CCPA and applicable privacy laws.',
    '',
    `Name: ${person.fullName}`,
    `Location: ${person.city}, ${person.state} ${person.zip}`,
    `Email: ${person.email}`,
    `Phone: ${person.phoneFormatted}`,
    '',
    'Please remove all profiles, records, and personally identifiable information',
    'and confirm removal within 30 days.',
    '',
    'Thank you,',
    `${person.fullName}`,
  ];

  try {
    await transporter.sendMail({
      from: smtpCfg.from || smtpCfg.user,
      to: broker.emailTo,
      subject: `Personal Data Removal Request – ${person.fullName}`,
      text: bodyLines.join('\n'),
    });
    loggerMod.logResult(broker.name, 'success', `Email → ${broker.emailTo}`);
    configMod.recordSuccess(broker.name, `email to ${broker.emailTo}`);
  } catch (err) {
    loggerMod.logResult(broker.name, 'error', `SMTP failed: ${err.message.slice(0, 60)}`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send opt-out emails for all brokers with method:'email'.
 *
 * @param {object[]} brokers   - Full broker list (filtered internally)
 * @param {object}   cfg       - Full config object (cfg.person, cfg.email.smtp)
 * @param {string}   [_platform] - Injected for testing; defaults to process.platform
 */
async function sendOptOutEmails(brokers, cfg, _platform) {
  const platform = getPlatform(_platform || process.platform);
  const person = cfg?.person;
  const smtpCfg = cfg?.email?.smtp;

  const emailBrokers = brokers.filter(b => b.method === 'email');

  for (const broker of emailBrokers) {
    if (configMod.lastOptOutDaysAgo(broker.name) < configMod.RECHECK_DAYS) {
      loggerMod.logResult(broker.name, 'skipped', 'Email already sent recently');
      continue;
    }

    if (smtpCfg) {
      await _sendViaSMTP(broker, person, smtpCfg);
    } else {
      loggerMod.logResult(
        broker.name,
        'manual',
        `${broker.emailTo} — add email.smtp to config.json to send automatically`
      );
    }
  }
}

module.exports = {
  sendOptOutEmails,
  // Internal exports for unit-testing
  _buildBody,
  _sendViaSMTP,
};
