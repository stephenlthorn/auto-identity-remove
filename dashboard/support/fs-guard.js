'use strict';
/*
 * dashboard/support/fs-guard.js - test support, never loaded by the server.
 *
 * Makes any write, rename, copy or delete of the REAL repo-root config.json,
 * config.json.enc, state.json, their .bak/.lock/.tmp siblings, logs/,
 * dashboard/.auth.json and data/*history* throw. The dashboard tests used to
 * overwrite the maintainer's real config.json and state.json (real PII) and
 * restore them afterwards, so a Ctrl-C mid-test left fixtures where the real
 * files had been. With this loaded a test that points at the real root fails at
 * the first write instead of silently clobbering it.
 *
 * Load it first thing in a test file (require('./support/fs-guard')) or for a
 * whole run with NODE_OPTIONS=--require=<this file>. AIDR_GUARD_ROOT overrides
 * the protected root.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.AIDR_GUARD_ROOT || path.join(__dirname, '..', '..'));

const PROTECTED = [
  /^config\.json(\..*)?$/,
  /^state\.json(\..*)?$/,
  /^logs(\/|$)/,
  /^dashboard\/\.auth\.json(\..*)?$/,
  /^data\/[^/]*history[^/]*$/,
];

function isProtected(target) {
  if (typeof target !== 'string' && !Buffer.isBuffer(target) && !(target instanceof URL)) return false;
  let abs;
  try { abs = path.resolve(target instanceof URL ? target.pathname : String(target)); } catch (_) { return false; }
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..')) return false;
  return PROTECTED.some(re => re.test(rel));
}

function refuse(op, target) {
  const err = new Error(`fs-guard: refusing to ${op} protected repo file ${String(target)} - tests must use a temp dir`);
  err.code = 'EAIDRGUARD';
  throw err;
}

const WRITE_FLAGS = /[wa+]/;

// [method, indexes of the path arguments that are written to]
const GUARDED = [
  ['writeFileSync', [0]], ['appendFileSync', [0]], ['unlinkSync', [0]], ['rmSync', [0]],
  ['renameSync', [0, 1]], ['copyFileSync', [1]], ['truncateSync', [0]], ['chmodSync', [0]],
  ['createWriteStream', [0]], ['writeFile', [0]], ['appendFile', [0]], ['unlink', [0]],
  ['rm', [0]], ['rename', [0, 1]], ['copyFile', [1]],
];

function install() {
  if (fs.__aidrGuardInstalled) return;
  fs.__aidrGuardInstalled = true;
  for (const [method, indexes] of GUARDED) {
    const original = fs[method];
    if (typeof original !== 'function') continue;
    fs[method] = function guarded(...args) {
      for (const i of indexes) if (isProtected(args[i])) refuse(method, args[i]);
      return original.apply(this, args);
    };
  }
  const openSync = fs.openSync;
  fs.openSync = function guardedOpen(file, flags, ...rest) {
    if (isProtected(file) && (typeof flags === 'string' ? WRITE_FLAGS.test(flags) : typeof flags === 'number' && (flags & 3) !== 0)) {
      refuse('open for writing', file);
    }
    return openSync.call(this, file, flags, ...rest);
  };
  for (const method of ['writeFile', 'appendFile', 'unlink', 'rm', 'rename', 'copyFile']) {
    const original = fs.promises[method];
    fs.promises[method] = async function guarded(...args) {
      const indexes = method === 'rename' ? [0, 1] : method === 'copyFile' ? [1] : [0];
      for (const i of indexes) if (isProtected(args[i])) refuse(method, args[i]);
      return original.apply(this, args);
    };
  }
}

install();

module.exports = { isProtected, install, ROOT };
