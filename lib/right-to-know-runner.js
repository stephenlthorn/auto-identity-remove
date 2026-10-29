/**
 * lib/right-to-know-runner.js
 *
 * Orchestrates right-to-know (data access / disclosure) requests for
 * email-capable brokers.
 *
 * Public API:
 *   sendKnowRequests(brokers, cfg, opts) -> { sent, manual, errors, skipped }
 *
 * Routing mirrors lib/email.js:
 *   cfg.email.smtp.host set (and not dry-run) -> nodemailer (lazy-required)
 *   no smtp host -> logResult(..., 'manual', <template>) so the user can copy-paste
 *
 * A request is recorded via configMod.recordKnowRequest ONLY after a real
 * send. A 'manual' print is not a send: recording it started the response
 * timer for a request nobody mailed (NET-11). A request already sent inside
 * its legal response window is not sent again, so repeated --know runs do not
 * spam a broker or keep resetting the timer. In dry-run nothing is sent and no
 * state is written, but a preview is still logged.
 */

const configMod = require('./config');
const loggerMod = require('./logger');
const { smtpTransportOptions } = require('./smtp');
const { buildKnowRequest } = require('./right-to-know');
const { smtpConfigured } = require('./email');
const { regimeFor, responseDays } = require('./regime');

/**
 * Send one know-request via SMTP using nodemailer (lazy-required).
 * Returns true on success, false on failure (failure is logged).
 *
 * @param {object} broker
 * @param {{ subject: string, body: string }} request
 * @param {object} smtpCfg
 * @param {string} [replyTo] - relay alias to receive the broker's reply
 * @returns {Promise<boolean>}
 */
async function _sendViaSMTP(broker, request, smtpCfg, replyTo) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    loggerMod.logResult(broker.name, 'error', 'nodemailer not installed - run: npm install nodemailer');
    return false;
  }

  try {
    const transporter = nodemailer.createTransport(smtpTransportOptions(smtpCfg));
    const mail = {
      from: smtpCfg.from || smtpCfg.user,
      to: broker.emailTo,
      subject: request.subject,
      text: request.body,
    };
    if (replyTo) mail.replyTo = replyTo;
    await transporter.sendMail(mail);
    loggerMod.logResult(broker.name, 'success', `Know request sent to ${broker.emailTo}`);
    return true;
  } catch (err) {
    loggerMod.logResult(broker.name, 'error', `SMTP failed: ${err.message.slice(0, 60)}`);
    return false;
  }
}

/**
 * Resolve persons from cfg. Reuses configMod.getPersonsFromConfig so the set
 * matches what watcher.js iterates over.
 * @param {object} cfg
 * @returns {object[]}
 */
function _getPersons(cfg) {
  try {
    return configMod.getPersonsFromConfig(cfg);
  } catch (_) {
    return [];
  }
}

/**
 * Days since each state key's know request was recorded, as a Map(key -> days).
 * Built once per run from the live state via getPendingKnowRequests (whose
 * `name` is the state key, composite in multi-person mode).
 * @returns {Map<string, number>}
 */
function _knowRequestAges() {
  try {
    const rows = configMod.getPendingKnowRequests([], { olderThanDays: 0 });
    return new Map(rows.map(r => [r.name, r.daysAgo]));
  } catch (_) {
    return new Map();
  }
}

/**
 * Send right-to-know requests for all email-method brokers.
 *
 * @param {object[]} brokers - full broker list (filtered internally)
 * @param {object}   cfg      - full config (cfg.person/cfg.persons, cfg.email.smtp)
 * @param {object}   [opts]
 * @param {boolean}  [opts.dryRun] - when true, print previews but do not send or record
 * @param {(person: object) => (string|undefined)} [opts.submissionEmailFor]
 *   Resolver returning a masked/relay address for a person; when it returns a
 *   value that address replaces person.email in the request and becomes the
 *   replyTo, exactly as for opt-out emails.
 * @returns {Promise<{ sent: string[], manual: string[], errors: {name:string,error:string}[], skipped: string[] }>}
 */
async function sendKnowRequests(brokers, cfg, opts = {}) {
  const dryRun = !!opts.dryRun;
  const persons = _getPersons(cfg);
  const smtpCfg = smtpConfigured(cfg && cfg.email && cfg.email.smtp) ? cfg.email.smtp : null;
  const submissionEmailFor = opts.submissionEmailFor || (() => undefined);
  const emailBrokers = brokers.filter(b => b.method === 'email');
  const ages = _knowRequestAges();

  const sent = [];
  const manual = [];
  const errors = [];
  const skipped = [];

  for (const broker of emailBrokers) {
    for (const person of persons) {
      // Same key recordKnowRequest writes under (bare name for one person,
      // "Broker|First Last" for several).
      const key = configMod.stateKey(broker.name, person, persons.length);
      const windowDays = responseDays(regimeFor(person));
      const sentDaysAgo = ages.has(key) ? ages.get(key) : Infinity;
      if (sentDaysAgo < windowDays) {
        loggerMod.logResult(
          broker.name,
          'skipped',
          `Right-to-know already sent ${Math.floor(sentDaysAgo)} day(s) ago - waiting out the ${windowDays}-day response window`
        );
        skipped.push(broker.name);
        continue;
      }

      // getSubmissionEmail returns person.email itself when no relay is set,
      // so only a different address counts as an alias.
      const resolved = submissionEmailFor(person);
      const relayEmail = resolved && resolved !== person.email ? resolved : undefined;
      const requestPerson = relayEmail ? { ...person, email: relayEmail } : person;
      const request = buildKnowRequest({ person: requestPerson, broker });

      if (dryRun) {
        loggerMod.logResult(
          broker.name,
          'skipped',
          `[preview] Right-to-know -> ${broker.emailTo} (${request.subject})`
        );
        continue;
      }

      if (smtpCfg) {
        const ok = await _sendViaSMTP(broker, request, smtpCfg, relayEmail);
        if (ok) {
          // Thread person + count so multi-person runs key per person via
          // stateKey, matching recordSuccess / the verify-loop (B6).
          configMod.recordKnowRequest(broker.name, person, persons.length);
          sent.push(broker.name);
        } else {
          errors.push({ name: broker.name, error: 'send failed' });
        }
      } else {
        // Printed for the user to send by hand. Deliberately NOT recorded: no
        // email left this machine, so no response clock has started.
        loggerMod.logResult(
          broker.name,
          'manual',
          `Right-to-know -> ${broker.emailTo} - ${request.subject}\n${request.body}`
        );
        manual.push(broker.name);
      }
    }
  }

  return { sent, manual, errors, skipped };
}

module.exports = {
  sendKnowRequests,
  _sendViaSMTP,
  _getPersons,
};
