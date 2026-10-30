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
 *     freeze, installScheduler, scheduleStatus, uninstallScheduler, configCheck,
 *     purge, captchas, verify, encryptConfig, decryptConfig,
 *     allow, unallow }
 *   All default to false/undefined. allow and unallow are the broker NAMES the flags
 *   were given (a string, or null when absent): a name is truthy, so they count as a
 *   mode exactly when the flag was used.
 *
 * @returns {{ mode: string|null, conflict: string|null }}
 *   mode     - the active mode name, or null for a normal run
 *   conflict - human-readable error when more than one exclusive mode is set
 */
function resolveMode(flags = {}) {
  const MODES = [
    { key: 'encryptConfig',    name: 'encrypt-config' },
    { key: 'decryptConfig',    name: 'decrypt-config' },
    { key: 'freeze',           name: 'freeze' },
    // Edits the config allowlist. It was missing here, so `--list --allow X` ran only
    // --list, exited 0 and added nothing (CLI2-11).
    { key: 'allow',            name: 'allow' },
    { key: 'unallow',          name: 'unallow' },
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
    { key: 'scheduleStatus',   name: 'schedule-status' },
    { key: 'uninstallScheduler', name: 'uninstall-scheduler' },
    { key: 'configCheck',      name: 'config-check' },
    { key: 'purge',            name: 'purge' },
    // A run variant rather than a separate command, but it picks its own brokers
    // and opens a visible browser, so it cannot be mixed with another mode.
    { key: 'captchas',         name: 'captchas' },
    { key: 'verify',           name: 'verify' },
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
