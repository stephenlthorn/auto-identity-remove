'use strict';
/*
 * lib/cli-map.js - pure argument-to-target mapping for the `aidr` CLI.
 *
 * resolveCommand(args) takes everything after `node bin/aidr.js` and returns a
 * descriptor of what to spawn. It performs NO spawning, NO filesystem access,
 * and NO network - it is a pure function so it can be unit-tested directly.
 *
 * Subcommand flags are verified against watcher.js argv parsing and
 * dashboard/server.js MODE_ARGS.
 */

const path = require('path');
const { parseWatcherArgs, ArgError } = require('./args');

const PROGRAM = 'aidr';

// name -> { file, flags, cwd, desc, usage?, sub?, defaultSub? }
// flags are the watcher.js flags this subcommand injects before passthrough.
// A two-word command (`schedule <verb>`, `config check`) lists its verbs in `sub`
// (verb -> extra flags); `defaultSub` is the verb used when none is given, and a
// command with `sub` and no `defaultSub` insists on one. `usage` is how the help
// text spells the command.
const COMMANDS = {
  setup:            { file: 'setup.js',            flags: [],                   cwd: 'root',      desc: 'Interactive first-run setup (creates config.json, schedules monthly job)' },
  run:              { file: 'watcher.js',          flags: [],                   cwd: 'root',      desc: 'Run the opt-out pass now (submits forms)' },
  preview:          { file: 'watcher.js',          flags: ['--preview'],        cwd: 'root',      desc: 'Dry-run: fill forms but submit nothing' },
  captchas:         { file: 'watcher.js',          flags: ['--captchas'],       cwd: 'root',      desc: 'Re-run only the brokers that ended on a CAPTCHA, in a visible browser, so you can solve them' },
  verify:           { file: 'watcher.js',          flags: ['--verify'],         cwd: 'root',      desc: 'Re-search brokers and report whether you still appear' },
  score:            { file: 'watcher.js',          flags: ['--score'],          cwd: 'root',      desc: 'Print your 0-100 exposure score and its trend' },
  report:           { file: 'watcher.js',          flags: ['--report'],         cwd: 'root',      desc: 'Generate the monthly PDF + email report' },
  pending:          { file: 'watcher.js',          flags: ['--pending'],        cwd: 'root',      desc: 'List brokers awaiting an email-confirmation click' },
  serp:             { file: 'watcher.js',          flags: ['--serp-scan'],      cwd: 'root',      desc: 'Scan search engines for where your name still ranks' },
  'serp-watch':     { file: 'watcher.js',          flags: ['--serp-watch'],     cwd: 'root',      desc: 'Scan and alert when your name appears on a NEW domain' },
  breach:           { file: 'watcher.js',          flags: ['--breach-check'],   cwd: 'root',      desc: 'Check Have I Been Pwned for breaches and recommend freezes' },
  freeze:           { file: 'watcher.js',          flags: ['--freeze'],         cwd: 'root',      desc: 'Show the credit/identity-freeze checklist and its status' },
  complaints:       { file: 'watcher.js',          flags: ['--complaints'],     cwd: 'root',      desc: 'Generate regulator complaints for brokers past the legal deadline' },
  know:             { file: 'watcher.js',          flags: ['--know'],           cwd: 'root',      desc: 'Send CCPA/GDPR right-to-know requests' },
  'update-brokers': { file: 'watcher.js',          flags: ['--update-brokers'], cwd: 'root',      desc: 'Refresh the broker list from the CA + Vermont registries' },
  list:             { file: 'watcher.js',          flags: ['--list'],           cwd: 'root',      desc: 'List configured brokers and their last-known status' },
  dashboard:        { file: 'dashboard/server.js', flags: [],                   cwd: 'dashboard', desc: 'Start the local web dashboard and print its URL + login' },
  doctor:           { file: 'watcher.js',          flags: ['--doctor'],         cwd: 'root',      desc: 'Self-diagnose environment and configuration' },
  config:           { file: 'watcher.js',          flags: [],                   cwd: 'root',      desc: 'Check config.json, passphrase source and state location (exit 1 on problems)', usage: 'config check', sub: { check: ['--config-check'] } },
  schedule:         { file: 'watcher.js',          flags: [],                   cwd: 'root',      desc: 'Show, install or remove the monthly job (status | install | uninstall)', usage: 'schedule [verb]', sub: { status: ['--schedule-status'], install: ['--install-scheduler'], uninstall: ['--uninstall-scheduler'] }, defaultSub: 'status' },
  purge:            { file: 'watcher.js',          flags: ['--purge'],          cwd: 'root',      desc: 'Delete old PII logs, audit reports and screenshots (never complaints or the latest run)' },
};

const HELP_FLAGS = new Set(['--help', '-h', 'help']);
const HELP_ANYWHERE = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-v']);

function resolveCommand(args) {
  const list = Array.isArray(args) ? args : [];
  const first = list[0];

  // --help / -h anywhere is help. It used to count only as the first argument,
  // so `aidr run --help` started a REAL submission run (CORE-6).
  if (first === undefined || HELP_FLAGS.has(first) || list.some(a => HELP_ANYWHERE.has(a))) {
    return { ok: true, target: 'help' };
  }
  if (VERSION_FLAGS.has(first)) {
    return { ok: true, target: 'version' };
  }

  const spec = COMMANDS[first];
  if (!spec) {
    return { ok: false, target: 'help', error: `unknown command: ${first}` };
  }

  let flags = spec.flags;
  let passthrough = list.slice(1);

  if (spec.sub) {
    // The verb is the first word after the command; a flag there (`schedule
    // --json`) is not a verb and leaves the default in place.
    const verb = passthrough[0] !== undefined && !String(passthrough[0]).startsWith('-') ? String(passthrough[0]) : null;
    const chosen = verb !== null ? verb : spec.defaultSub;
    const verbs = Object.keys(spec.sub);
    if (chosen === undefined) {
      return { ok: false, target: 'help', error: `${first} needs a subcommand: ${verbs.join(', ')}` };
    }
    if (!Object.prototype.hasOwnProperty.call(spec.sub, chosen)) {
      const expected = verbs.length > 1 ? `${verbs.slice(0, -1).join(', ')} or ${verbs[verbs.length - 1]}` : verbs[0];
      return { ok: false, target: 'help', error: `unknown ${first} subcommand: ${verb} (expected ${expected})` };
    }
    flags = [...spec.flags, ...spec.sub[chosen]];
    if (verb !== null) passthrough = passthrough.slice(1);
  }

  // Refuse before spawning when watcher.js would not recognise a flag: it
  // ignored unknown ones, so `aidr run --dryrun` submitted for real (CORE-6).
  // Validated with the flags the subcommand injects, i.e. exactly what the
  // watcher will see.
  if (spec.file === 'watcher.js') {
    try {
      parseWatcherArgs([...flags, ...passthrough]);
    } catch (err) {
      if (err instanceof ArgError) return { ok: false, target: 'help', error: err.message };
      throw err;
    }
  }

  return {
    ok: true,
    target: 'node',
    command: first,
    file: spec.file,
    cwd: spec.cwd,
    args: [spec.file, ...flags, ...passthrough],
  };
}

/**
 * Turn a resolveCommand() descriptor into the exact spawn arguments.
 *
 * spec.file is relative to the repo root, but the dashboard runs with cwd set
 * to <root>/dashboard, so spawning the relative path there resolved to
 * <root>/dashboard/dashboard/server.js. Absolutising the script against the
 * root makes the cwd purely a working-directory choice and never part of
 * module resolution.
 *
 * @param {object} resolved  a { target: 'node', file, cwd, args } descriptor
 * @param {string} root      absolute path to the repo root
 * @returns {{ script: string, cwd: string, args: string[] }}
 */
function resolveSpawnTarget(resolved, root) {
  const script = path.resolve(root, resolved.file);
  const cwd = resolved.cwd === 'dashboard' ? path.join(root, 'dashboard') : root;
  return { script, cwd, args: [script, ...resolved.args.slice(1)] };
}

function buildHelp() {
  const lines = [];
  lines.push(`${PROGRAM} - automated data-broker opt-out runner`);
  lines.push('');
  lines.push(`Usage: ${PROGRAM} <command> [options]`);
  lines.push('');
  lines.push('Commands:');
  const label = name => COMMANDS[name].usage || name;
  const width = Math.max(...Object.keys(COMMANDS).map(k => label(k).length));
  for (const name of Object.keys(COMMANDS)) {
    lines.push(`  ${label(name).padEnd(width)}  ${COMMANDS[name].desc}`);
  }
  lines.push('');
  lines.push('Other:');
  lines.push(`  --help, -h     Show this help`);
  lines.push(`  --version, -v  Show the installed version`);
  lines.push('');
  lines.push('Examples:');
  lines.push(`  ${PROGRAM} setup`);
  lines.push(`  ${PROGRAM} preview`);
  lines.push(`  ${PROGRAM} run --only Spokeo`);
  lines.push(`  ${PROGRAM} captchas`);
  lines.push(`  ${PROGRAM} schedule status --json`);
  lines.push(`  ${PROGRAM} purge --older-than 180d --dry-run`);
  lines.push(`  ${PROGRAM} dashboard`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { PROGRAM, COMMANDS, resolveCommand, resolveSpawnTarget, buildHelp };
