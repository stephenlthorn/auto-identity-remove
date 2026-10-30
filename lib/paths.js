/**
 * lib/paths.js
 *
 * The one place that decides where every runtime file lives (R0).
 *
 * Config and state could already move out of the app directory
 * (AIDR_CONFIG_PATH, AIDR_STATE_PATH), but logs, snapshots, reports and the
 * SERP/exposure/breach/feeds caches were still hardcoded under it, so a Docker
 * or NAS install needed one mount per directory and lost the rest with the
 * container. AIDR_HOME collapses that to a single directory:
 *
 *   AIDR_HOME             base for everything below (default: the app directory)
 *   AIDR_CONFIG_PATH      config.json            (default <home>/config.json)
 *   AIDR_CONFIG_ENC_PATH  encrypted envelope     (default <config path>.enc)
 *   AIDR_STATE_PATH       state.json             (default <home>/state.json)
 *   AIDR_LOG_DIR          run logs               (default <home>/logs)
 *   AIDR_DATA_DIR         mutable history caches (default <home>/data)
 *
 * The state lock, resume checkpoint and .bak already sit beside the state file;
 * snapshots, reports and complaints sit under the log directory. The inbox of
 * confirmation .eml files follows AIDR_HOME and has no variable of its own.
 *
 * With none of these set every path is exactly what it was before this module
 * existed, so an existing install keeps reading the files it already has.
 *
 * The SHIPPED read-only datasets (data/markup-parsed.json, badbool-extra.json,
 * dead-urls.json) are not here on purpose: they are part of the app and keep
 * loading from the app directory whatever AIDR_HOME says. Only the data
 * directory a run WRITES into moves.
 *
 * Nothing in this file touches the disk; callers create directories when they
 * write (mkdirPrivate and friends), so resolving a path is always safe.
 */

'use strict';

const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

// Empty counts as unset (matches how AIDR_CONFIG_PATH has always been read).
const fromEnv = (env, name) => (env[name] ? path.resolve(env[name]) : null);

/**
 * Resolve every runtime path together with the reason each one has its value.
 * @returns {{ paths: object, sources: Record<string, string> }}
 */
function resolveWithSources(env, root) {
  const homeEnv = fromEnv(env, 'AIDR_HOME');
  const home = homeEnv || root;
  const base = homeEnv ? 'AIDR_HOME' : 'default: app directory';

  const pick = (name, fallback) => {
    const value = fromEnv(env, name);
    return value ? { value, source: name } : { value: fallback, source: base };
  };

  const config = pick('AIDR_CONFIG_PATH', path.join(home, 'config.json'));
  const state = pick('AIDR_STATE_PATH', path.join(home, 'state.json'));
  const logs = pick('AIDR_LOG_DIR', path.join(home, 'logs'));
  const data = pick('AIDR_DATA_DIR', path.join(home, 'data'));

  const encEnv = fromEnv(env, 'AIDR_CONFIG_ENC_PATH');
  const configEnc = encEnv
    ? { value: encEnv, source: 'AIDR_CONFIG_ENC_PATH' }
    : { value: config.value + '.enc', source: 'beside config' };

  const paths = {
    home,
    config: config.value,
    configEnc: configEnc.value,
    state: state.value,
    logs: logs.value,
    snapshots: path.join(logs.value, 'snapshots'),
    reports: path.join(logs.value, 'reports'),
    complaints: path.join(logs.value, 'complaints'),
    data: data.value,
    inbox: path.join(home, 'inbox'),
  };
  const sources = {
    home: base,
    config: config.source,
    configEnc: configEnc.source,
    state: state.source,
    logs: logs.source,
    snapshots: 'under logs',
    reports: 'under logs',
    complaints: 'under logs',
    data: data.source,
    inbox: base,
  };
  return { paths, sources };
}

/**
 * Where every runtime file lives for this environment.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {string} [root]  the app directory (default: this repo's root)
 * @returns {Readonly<{ home: string, config: string, configEnc: string, state: string,
 *   logs: string, snapshots: string, reports: string, complaints: string,
 *   data: string, inbox: string }>}
 */
function resolvePaths(env = process.env, root = APP_ROOT) {
  return Object.freeze(resolveWithSources(env, root).paths);
}

const LABEL_WIDTH = 12;
const line = (label, value, source) => `  ${label.padEnd(LABEL_WIDTH)}${value}  [${source}]`;

/**
 * Printable lines for `aidr doctor`: every resolved path and what decided it.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {string} [root]
 * @returns {string[]}
 */
function describePaths(env = process.env, root = APP_ROOT) {
  const { paths: p, sources: s } = resolveWithSources(env, root);
  return [
    line('home', p.home, s.home),
    line('config', p.config, s.config),
    line('config.enc', p.configEnc, s.configEnc),
    line('state', p.state, s.state),
    line('state lock', p.state + '.lock', 'beside state'),
    line('checkpoint', p.state + '.checkpoint', 'beside state'),
    line('logs', p.logs, s.logs),
    line('snapshots', p.snapshots, s.snapshots),
    line('reports', p.reports, s.reports),
    line('complaints', p.complaints, s.complaints),
    line('data', p.data, s.data),
    line('inbox', p.inbox, s.inbox),
    line('shipped data', path.join(root, 'data'), 'app directory, read-only'),
  ];
}

module.exports = { resolvePaths, describePaths };
