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

// EU country codes (EU member states) + GB (UK GDPR)
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'GB',
]);

/**
 * Build the GDPR-flavored opt-out email body (EU + UK users).
 * Cites Article 17 (right to erasure) and Article 20 (data portability).
 * @param {object} person
 * @returns {string}
 */
function _buildBodyGDPR(person) {
  return [
    'To Whom It May Concern,',
    '',
    'I am writing to exercise my rights under the General Data Protection Regulation',
    '(GDPR). Specifically, I am requesting erasure of all personal data you hold',
    'about me, pursuant to Article 17 (right to erasure / "right to be forgotten").',
    'I also request a copy of any data held about me under Article 20 (right to',
    'data portability) before deletion.',
    '',
    `Name: ${person.fullName}`,
    `Location: ${person.city}, ${person.state} ${person.zip}`,
    `Email: ${person.email}`,
    `Phone: ${person.phoneFormatted}`,
    '',
    'Please confirm in writing that all profiles, records, and personally identifiable',
    'information have been removed. Under GDPR you are required to respond within',
    '30 days of receipt of this request.',
    '',
    'Thank you,',
    `${person.fullName}`,
  ].join('\n');
}

/**
 * Build the CCPA-flavored opt-out email body (US and other non-EU users).
 * @param {object} person
 * @returns {string}
 */
function _buildBodyCCPA(person) {
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
  ].join('\n');
}

/**
 * Return the appropriate template builder function based on country code.
 * @param {string|undefined} country - ISO 3166-1 alpha-2 country code
 * @returns {function} Template builder: (person) => string
 */
function _pickTemplate(country) {
  if (country && EU_COUNTRIES.has(country.toUpperCase())) {
    return _buildBodyGDPR;
  }
  return _buildBodyCCPA;
}

/**
 * Build the plain-text opt-out email body from person data.
 * Routes to GDPR or CCPA template based on person.country.
 * @param {object} person
 * @returns {string}
 */
function _buildBody(person) {
  return _pickTemplate(person.country)(person);
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

  const body = _pickTemplate(person.country)(person);

  try {
    await transporter.sendMail({
      from: smtpCfg.from || smtpCfg.user,
      to: broker.emailTo,
      subject: `Personal Data Removal Request - ${person.fullName}`,
      text: body,
    });
    loggerMod.logResult(broker.name, 'success', `Email → ${broker.emailTo}`);
    configMod.recordSuccess(broker.name, `email to ${broker.emailTo}`);
  } catch (err) {
    loggerMod.logResult(broker.name, 'error', `SMTP failed: ${err.message.slice(0, 60)}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the list of persons from cfg.
 * - If cfg.persons is a non-empty array, return it.
 * - If cfg.person exists (single-person legacy), return [cfg.person].
 * - Otherwise return [] (no persons configured).
 *
 * @param {object} cfg
 * @returns {object[]}
 */
function _getPersons(cfg) {
  if (Array.isArray(cfg?.persons) && cfg.persons.length > 0) return cfg.persons;
  if (cfg?.person) return [cfg.person];
  return [];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send opt-out emails for all brokers with method:'email'.
 *
 * Supports both single-person (cfg.person) and multi-person (cfg.persons)
 * configuration. When cfg.persons is a non-empty array, one email is sent
 * per (broker, person) pair. Falls back to cfg.person for backward compat.
 *
 * @param {object[]} brokers   - Full broker list (filtered internally)
 * @param {object}   cfg       - Full config object (cfg.person/cfg.persons, cfg.email.smtp)
 * @param {string}   [_platform] - Injected for testing; defaults to process.platform
 */
async function sendOptOutEmails(brokers, cfg, _platform) {
  const platform = getPlatform(_platform || process.platform);
  const persons = _getPersons(cfg);
  const smtpCfg = cfg?.email?.smtp;

  const emailBrokers = brokers.filter(b => b.method === 'email');

  for (const broker of emailBrokers) {
    if (configMod.lastOptOutDaysAgo(broker.name) < configMod.RECHECK_DAYS) {
      loggerMod.logResult(broker.name, 'skipped', 'Email already sent recently');
      continue;
    }

    for (const person of persons) {
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
}

module.exports = {
  sendOptOutEmails,
  // Internal exports for unit-testing
  _buildBody,
  _buildBodyGDPR,
  _buildBodyCCPA,
  _pickTemplate,
  _sendViaSMTP,
  _getPersons,
};
