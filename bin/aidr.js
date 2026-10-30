#!/usr/bin/env node
'use strict';
/*
 * bin/aidr.js - friendly CLI dispatcher for auto-identity-remove.
 *
 * Maps subcommands (setup, run, preview, verify, dashboard, score, report,
 * doctor) to the existing entrypoints via lib/cli-map.js, then spawns them.
 * The dashboard subcommand generates one-time credentials so the local web UI
 * is never unauthenticated, and prints the URL (+ the login, when it made one)
 * once the server is actually listening.
 *
 * Usage: aidr <command> [options]   (run `aidr --help` for the full list)
 */

const path = require('path');
const { spawn } = require('child_process');
const { resolveCommand, resolveSpawnTarget, absolutizePathEnv, buildHelp } = require('../lib/cli-map');
const {
  generateDashboardCreds, resolveAuthFile, hasSavedCredentials,
  findExpress, expressMissingMessage, formatBanner,
} = require('../lib/dashboard-creds');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE_PASSWORD = 'change-me';

function printHelp() {
  process.stdout.write(buildHelp() + '\n');
}

function printVersion() {
  const pkg = require('../package.json');
  process.stdout.write(`${pkg.name} v${pkg.version} (node ${process.version})\n`);
}

// Stopping the dispatcher (systemd stop, `kill`, Ctrl-C) must stop what it
// started: a watcher left running unsupervised is mid-submission with nothing
// left to stop it.
function forwardSignals(child) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch (_) { /* already gone */ } });
  }
}

function superviseChild(child, resolved) {
  child.on('exit', (code, signal) => {
    if (signal) { process.exit(1); }
    process.exit(code === null ? 1 : code);
  });
  child.on('error', err => {
    process.stderr.write(`aidr: failed to start ${resolved.file}: ${err.message}\n`);
    process.exit(1);
  });
  forwardSignals(child);
}

// `aidr dashboard`: boot the dashboard authenticated, and only announce it once it
// is actually listening. The banner used to print on the child's `spawn` event,
// i.e. before the server had bound anything, so a port already in use or a
// missing express printed a URL and a password and then crashed.
function startDashboard(resolved) {
  const { cwd, args } = resolveSpawnTarget(resolved, ROOT);
  const dashboardDir = path.join(ROOT, 'dashboard');

  if (!findExpress(dashboardDir)) {
    process.stderr.write(expressMissingMessage());
    process.exit(1);
  }

  // Relative AIDR_* paths mean "relative to where the user ran this", as they do for
  // run.sh, not to the dashboard directory the child starts in (CLI2-12).
  const env = absolutizePathEnv(process.env, process.cwd());
  // dashboard/.auth.json (credentials changed in the Admin tab) overrides
  // AIDR_USER/AIDR_PASS, so inventing a password next to one would print a login
  // that 401s. With a saved file, or credentials already in the environment,
  // generate nothing and say which one applies.
  const savedCredentials = hasSavedCredentials(resolveAuthFile(env, dashboardDir));
  // AIDR_PASS=change-me is the old example value: the server refuses it, so counting
  // it as "credentials already in the environment" printed a login that always 401s.
  const envCredentials = !!(env.AIDR_USER && env.AIDR_PASS && env.AIDR_PASS !== EXAMPLE_PASSWORD);
  let generated = null;
  if (!savedCredentials && !envCredentials) {
    generated = generateDashboardCreds();
    env.AIDR_USER = generated.user;
    env.AIDR_PASS = generated.pass;
  }

  // server.js sends { type: 'aidr-dashboard-listening', host, port } over IPC once
  // listen() has succeeded; a bind failure exits instead and prints its own reason.
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  child.on('message', msg => {
    if (!msg || msg.type !== 'aidr-dashboard-listening') return;
    process.stdout.write(formatBanner({ host: msg.host, port: msg.port, generated, savedCredentials, envCredentials }));
  });
  superviseChild(child, resolved);
}

function spawnNode(resolved) {
  if (resolved.command === 'dashboard') return startDashboard(resolved);
  const { cwd, args } = resolveSpawnTarget(resolved, ROOT);
  // The child starts in the repo root; a relative AIDR_* path must not follow it there (CLI2-12).
  superviseChild(spawn(process.execPath, args, { cwd, env: absolutizePathEnv(process.env, process.cwd()), stdio: 'inherit' }), resolved);
}

function main() {
  const args = process.argv.slice(2);
  const resolved = resolveCommand(args);

  if (resolved.target === 'help') {
    if (!resolved.ok && resolved.error) {
      process.stderr.write(`aidr: ${resolved.error}\n\n`);
      printHelp();
      process.exit(2);
    }
    printHelp();
    process.exit(0);
  }
  if (resolved.target === 'version') {
    printVersion();
    process.exit(0);
  }
  spawnNode(resolved);
}

main();
