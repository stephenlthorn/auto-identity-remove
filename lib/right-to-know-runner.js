/**
 * lib/right-to-know-runner.js
 *
 * Orchestrates right-to-know (data access / disclosure) requests for
 * email-capable brokers.
 *
 * Public API:
 *   sendKnowRequests(brokers, cfg, opts) -> { sent, manual, errors }
 *
 * Routing mirrors lib/email.js:
 *   cfg.email.smtp set (and not dry-run) -> nodemailer (lazy-required)
 *   no smtp -> logResult(..., 'manual', <template>) so the user can copy-paste
 *
 * On a real send (or a manual print) the broker is recorded via
 * configMod.recordKnowRequest. In dry-run nothing is sent and no state is
 * written (dry-run promises no persisted state), but a preview is still logged.
 */

const configMod = require('./config');
const loggerMod = require('./logger');
const { buildKnowRequest } = require('./right-to-know');

/**
 * Send one know-request via SMTP using nodemailer (lazy-required).
 * Returns true on success, false on failure (failure is logged).
 *
 * @param {object} broker
 * @param {{ subject: string, body: string }} request
 * @param {object} smtpCfg
 * @returns {Promise<boolean>}
 */
async function _sendViaSMTP(broker, request, smtpCfg) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    loggerMod.logResult(broker.name, 'error', 'nodemailer not installed - run: npm install nodemailer');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: smtpCfg.host,
    port: smtpCfg.port || 587,
    secure: (smtpCfg.port || 587) === 465,
    auth: { user: smtpCfg.user, pass: smtpCfg.pass },
  });

  try {
    await transporter.sendMail({
      from: smtpCfg.from || smtpCfg.user,
      to: broker.emailTo,
      subject: request.subject,
      text: request.body,
    });
    loggerMod.logResult(broker.name, 'success', `Know request -> ${broker.emailTo}`);
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
 * Send right-to-know requests for all email-method brokers.
 *
 * @param {object[]} brokers - full broker list (filtered internally)
 * @param {object}   cfg      - full config (cfg.person/cfg.persons, cfg.email.smtp)
 * @param {object}   [opts]
 * @param {boolean}  [opts.dryRun] - when true, print previews but do not send or record
 * @returns {Promise<{ sent: string[], manual: string[], errors: {name:string,error:string}[] }>}
 */
async function sendKnowRequests(brokers, cfg, opts = {}) {
  const dryRun = !!opts.dryRun;
  const persons = _getPersons(cfg);
  const smtpCfg = cfg && cfg.email && cfg.email.smtp;
  const emailBrokers = brokers.filter(b => b.method === 'email');

  const sent = [];
  const manual = [];
  const errors = [];

  for (const broker of emailBrokers) {
    for (const person of persons) {
      const request = buildKnowRequest({ person, broker });

      if (dryRun) {
        loggerMod.logResult(
          broker.name,
          'skipped',
          `[preview] Right-to-know -> ${broker.emailTo} (${request.subject})`
        );
        continue;
      }

      if (smtpCfg) {
        const ok = await _sendViaSMTP(broker, request, smtpCfg);
        if (ok) {
          // Thread person + count so multi-person runs key per person via
          // stateKey, matching recordSuccess / the verify-loop (B6).
          configMod.recordKnowRequest(broker.name, person, persons.length);
          sent.push(broker.name);
        } else {
          errors.push({ name: broker.name, error: 'send failed' });
        }
      } else {
        loggerMod.logResult(
          broker.name,
          'manual',
          `Right-to-know -> ${broker.emailTo} - ${request.subject}\n${request.body}`
        );
        configMod.recordKnowRequest(broker.name, person, persons.length);
        manual.push(broker.name);
      }
    }
  }

  return { sent, manual, errors };
}

module.exports = {
  sendKnowRequests,
  _sendViaSMTP,
  _getPersons,
};
