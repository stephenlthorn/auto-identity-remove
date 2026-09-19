'use strict';

/**
 * lib/mode-dispatch.js
 *
 * Pure mode-resolution helper for watcher.js.
 *
 * resolveMode(flags) identifies which single mutually-exclusive operating mode
 * is active given the parsed CLI flags, and detects conflicts when more than
 * one is set simultaneously.
 *
 * @param {object} flags  Parsed flag booleans:
 *   { list, score, report, doctor, breachCheck, updateBrokers, pending,
 *     know, knowStatus, complaints, confirmEmails, serpScan, serpWatch,
 *     freeze, installScheduler, encryptConfig, decryptConfig }
 *   All default to false/undefined.
 *
 * @returns {{ mode: string|null, conflict: string|null }}
 *   mode     - the active mode name, or null for a normal run
 *   conflict - human-readable error when more than one exclusive mode is set
 */
function resolveMode(flags = {}) {
  const MODES = [
    { key: 'encryptConfig',    name: 'encrypt-config' },
    { key: 'decryptConfig',    name: 'decrypt-config' },
    { key: 'reverify',         name: 'reverify' },
    { key: 'freeze',           name: 'freeze' },
    { key: 'list',             name: 'list' },
    { key: 'score',            name: 'score' },
    { key: 'pending',          name: 'pending' },
    { key: 'knowStatus',       name: 'know-status' },
    { key: 'breachCheck',      name: 'breach-check' },
    { key: 'complaints',       name: 'complaints' },
    { key: 'confirmEmails',    name: 'confirm-emails' },
    { key: 'report',           name: 'report' },
    { key: 'doctor',           name: 'doctor' },
    { key: 'updateBrokers',    name: 'update-brokers' },
    { key: 'installScheduler', name: 'install-scheduler' },
    { key: 'serpScan',         name: 'serp-scan' },
    { key: 'serpWatch',        name: 'serp-watch' },
    { key: 'know',             name: 'know' },
  ];

  const active = MODES.filter(m => !!flags[m.key]);

  if (active.length > 1) {
    const names = active.map(m => `--${m.name}`).join(', ');
    return {
      mode: null,
      conflict: `Mutually exclusive modes cannot be combined: ${names}. Use one at a time.`,
    };
  }

  return {
    mode: active.length === 1 ? active[0].name : null,
    conflict: null,
  };
}

module.exports = { resolveMode };
