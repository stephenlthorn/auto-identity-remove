#!/usr/bin/env node
'use strict';
/*
 * bin/aidr.js - friendly CLI dispatcher for auto-identity-remove.
 *
 * Maps subcommands (setup, run, preview, verify, dashboard, score, report,
 * doctor) to the existing entrypoints via lib/cli-map.js, then spawns them.
 * The dashboard subcommand generates one-time credentials so the local web UI
 * is never unauthenticated, and prints the URL + login once.
 *
 * Usage: aidr <command> [options]   (run `aidr --help` for the full list)
 */

const path = require('path');
const { spawn } = require('child_process');
const { resolveCommand, buildHelp } = require('../lib/cli-map');
const { generateDashboardCreds } = require('../lib/dashboard-creds');

const ROOT = path.resolve(__dirname, '..');

function printHelp() {
  process.stdout.write(buildHelp() + '\n');
}

function printVersion() {
  const pkg = require('../package.json');
  process.stdout.write(`${pkg.name} v${pkg.version} (node ${process.version})\n`);
}

function spawnNode(resolved) {
  const cwd = resolved.cwd === 'dashboard' ? path.join(ROOT, 'dashboard') : ROOT;
  const env = { ...process.env };
  let onSpawn = null;

  if (resolved.command === 'dashboard') {
    // Boot the dashboard authenticated. server.js reads AIDR_USER/AIDR_PASS
    // (see dashboard/server.js) and stays open if neither is set.
    if (!env.AIDR_USER || !env.AIDR_PASS) {
      const creds = generateDashboardCreds();
      env.AIDR_USER = creds.user;
      env.AIDR_PASS = creds.pass;
      const host = env.AIDR_HOST || '127.0.0.1';
      const port = env.AIDR_PORT || '8080';
      onSpawn = () => {
        process.stdout.write('\n  Dashboard starting...\n');
        process.stdout.write(`  URL:      http://${host}:${port}\n`);
        process.stdout.write(`  Username: ${creds.user}\n`);
        process.stdout.write(`  Password: ${creds.pass}\n`);
        process.stdout.write('  (these credentials are shown once; re-run to get new ones)\n\n');
      };
    }
  }

  const child = spawn(process.execPath, resolved.args, { cwd, env, stdio: 'inherit' });
  if (onSpawn) child.on('spawn', onSpawn);
  child.on('exit', (code, signal) => {
    if (signal) { process.exit(1); }
    process.exit(code === null ? 1 : code);
  });
  child.on('error', err => {
    process.stderr.write(`aidr: failed to start ${resolved.file}: ${err.message}\n`);
    process.exit(1);
  });
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
