'use strict';

/**
 * lib/email.js
 *
 * Cross-platform email opt-out sender.
 *
 * Public API:
 *   sendOptOutEmails(brokers, cfg)
 *
 * Routing:
 *   cfg.email.smtp.host set → nodemailer (lazy-required, optional dep)
 *   no smtp host configured → logResult(..., 'manual', ...) on all platforms
 *
 * nodemailer is listed as an optionalDependency in package.json. The lazy
 * require inside _sendViaSMTP means startup is never affected on machines that
 * lack the package.
 */

const { getPlatform } = require('./platform');
const configMod = require('./config');
const loggerMod = require('./logger');
const { smtpTransportOptions } = require('./smtp');
const { stateKey } = require('./config');
const { isAllowlisted } = require('./filter');
const { isGdprCountry, fullName, identityLines } = require('./regime');

/**
 * True only when cfg.email.smtp names a host. The dashboard used to save blank
 * inputs as { host: '', port: '', ... }; an object like that is truthy, so
 * every email broker moved from "manual" to a send that could only fail
 * (DASH-4). A missing or blank host means "no SMTP".
 * @param {object|null|undefined} smtpCfg
 * @returns {boolean}
 */
function smtpConfigured(smtpCfg) {
  return !!(smtpCfg && typeof smtpCfg === 'object'
    && typeof smtpCfg.host === 'string' && smtpCfg.host.trim() !== '');
}

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
    ...identityLines(person),
    '',
    'Please confirm in writing that all profiles, records, and personally identifiable',
    'information have been removed. Under GDPR you are required to respond within',
    '30 days of receipt of this request.',
    '',
    'Thank you,',
    fullName(person),
  ].join('\n');
}

/**
 * Build the CCPA-flavored opt-out email body (US and other non-EU users).
 * Only California residents have CCPA rights to invoke, so everyone else
 * cites the broker's own opt-out policy instead.
 * @param {object} person
 * @returns {string}
 */
function _buildBodyCCPA(person) {
  const basis = String(person.state || '').toUpperCase() === 'CA'
    ? 'from your database, under the California Consumer Privacy Act (CCPA).'
    : 'from your database, in accordance with your opt-out policy.';
  return [
    'To Whom It May Concern,',
    '',
    'I am requesting the removal of all records associated with my personal information',
    basis,
    '',
    ...identityLines(person),
    '',
    'Please remove all profiles, records, and personally identifiable information',
    'and confirm removal within 30 days.',
    '',
    'Thank you,',
    fullName(person),
  ].join('\n');
}

/**
 * Return the appropriate template builder function based on country code.
 * @param {string|undefined} country - ISO 3166-1 alpha-2 country code
 * @returns {function} Template builder: (person) => string
 */
function _pickTemplate(country) {
  if (isGdprCountry(country)) return _buildBodyGDPR;
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
 * @param {object} smtpCfg          - { host, port, user, pass, from, ca? }
 * @param {string} [submissionEmail] - masked/relay address to advertise to the
 *   broker; when set it replaces person.email in the body and sets replyTo.
 * @param {number} [personCount]    - total number of persons in the run; used
 *   to derive the correct composite state key (matches broker-runner keying).
 */
async function _sendViaSMTP(broker, person, smtpCfg, submissionEmail, personCount) {
  // Lazy require - nodemailer is optional; avoids startup error when absent.
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    loggerMod.logResult(broker.name, 'error', 'nodemailer not installed - run: npm install nodemailer');
    return;
  }

  const contactEmail = submissionEmail || person.email;
  const bodyPerson = contactEmail === person.email ? person : { ...person, email: contactEmail };
  const body = _pickTemplate(bodyPerson.country)(bodyPerson);

  const mail = {
    from: smtpCfg.from || smtpCfg.user,
    to: broker.emailTo,
    // Some brokers route privacy mail by subject (Hiya wants it to start with
    // "Advanced Data Management").
    subject: [broker.emailSubjectPrefix, `Personal Data Removal Request - ${fullName(person)}`]
      .filter(Boolean).join(' - '),
    text: body,
  };
  if (submissionEmail) mail.replyTo = submissionEmail;

  try {
    const transporter = nodemailer.createTransport(smtpTransportOptions(smtpCfg));
    await transporter.sendMail(mail);
    // SMTP acceptance is recorded as lastSuccess on purpose (codex #5): the
    // 90-day window is the re-send interval, and re-mailing a broker every
    // month would spam it. It proves the mail left, not that data was removed,
    // so the wording says so.
    loggerMod.logResult(broker.name, 'success', `Email sent to ${broker.emailTo} (removal not confirmed)`);
    const key = stateKey(broker.name, person, personCount);
    configMod.recordSuccess(key, `email sent to ${broker.emailTo}`);
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
 * @param {object}   [opts]
 * @param {(person: object) => (string|undefined)} [opts.submissionEmailFor]
 *   Resolver returning a masked/relay email for a person; when it returns a
 *   value, that address is advertised to the broker instead of person.email.
 * @param {object}   [opts.onlyPerson]
 *   Restrict this call to a single person instead of every person in cfg.
 *   Callers that already loop over persons themselves (e.g. watcher.js,
 *   once per person to resolve that person's relay alias) must pass this -
 *   otherwise each call re-sends to every person in cfg, multiplying real
 *   sends by the number of persons configured.
 * @param {boolean}  [opts.dryRun]
 *   Log what would be sent and send nothing. --dry-run promises "nothing
 *   sent", and an email is as real a submission as a form.
 * @param {(brokerName: string) => boolean} [opts.include]
 *   Broker predicate (lib/filter.makeBrokerPredicate). Brokers it rejects are
 *   skipped before anything else happens. Default: include everything.
 *   Brokers on cfg.allowlist are logged 'allowlisted' and never emailed.
 */
async function sendOptOutEmails(brokers, cfg, _platform, opts = {}) {
  const platform = getPlatform(_platform || process.platform);
  const allPersons = _getPersons(cfg);
  const persons = opts.onlyPerson ? [opts.onlyPerson] : allPersons;
  const smtpCfg = smtpConfigured(cfg?.email?.smtp) ? cfg.email.smtp : null;
  const submissionEmailFor = opts.submissionEmailFor || (() => undefined);
  // Broker predicate from lib/filter.makeBrokerPredicate (--only/--skip/
  // --retry-failed). Applied first so an excluded broker costs nothing: no
  // mail, no log line, no state write (CORE-4).
  const include = typeof opts.include === 'function' ? opts.include : () => true;

  const emailBrokers = brokers.filter(b => b.method === 'email' && include(b.name));
  // Must reflect the total persons in the whole run (not persons.length,
  // which is 1 when onlyPerson restricts this call) so state keys stay
  // consistent whether this is called once per run or once per person.
  const personCount = allPersons.length;

  for (const broker of emailBrokers) {
    // The user chose to STAY listed here, so never mail an opt-out. The form
    // runners already honour this; the email path ignored it (CORE-4).
    if (isAllowlisted(broker.name, cfg)) {
      loggerMod.logResult(broker.name, 'allowlisted', 'on allowlist - keeping listing, no opt-out emailed');
      continue;
    }
    for (const person of persons) {
      // Look up the same key _sendViaSMTP records under. Checking the bare
      // broker name never matched in multi-person mode (successes are stored
      // as "Broker|First Last"), so every run re-sent every email.
      if (configMod.lastOptOutDaysAgo(stateKey(broker.name, person, personCount)) < configMod.RECHECK_DAYS) {
        loggerMod.logResult(broker.name, 'skipped', 'Email already sent recently');
        continue;
      }
      const submissionEmail = submissionEmailFor(person);
      if (opts.dryRun) {
        loggerMod.logResult(broker.name, 'skipped', `dry-run - would email ${broker.emailTo}, not sent`);
      } else if (smtpCfg) {
        await _sendViaSMTP(broker, person, smtpCfg, submissionEmail, personCount);
      } else {
        const subjectHint = broker.emailSubjectPrefix
          ? ` (subject must start "${broker.emailSubjectPrefix}")`
          : '';
        loggerMod.logResult(
          broker.name,
          'manual',
          `${broker.emailTo}${subjectHint} - add email.smtp to config.json to send automatically`
        );
      }
    }
  }
}

module.exports = {
  sendOptOutEmails,
  smtpConfigured,
  // Internal exports for unit-testing
  _buildBody,
  _buildBodyGDPR,
  _buildBodyCCPA,
  _pickTemplate,
  _sendViaSMTP,
  _getPersons,
};
