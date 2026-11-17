'use strict';
/**
 * test/helpers/no-npm-requires.js
 *
 * Preloaded with `node -r`: refuses every require() that is not a Node built-in
 * or a relative / absolute path. The publish job of the broker health workflow
 * runs without `npm ci`, so a script it runs must not need a package. Not a test
 * file (no .test.js suffix).
 */

const Module = require('node:module');

const original = Module._load;
Module._load = function guarded(request, parent, isMain) {
  const bare = !request.startsWith('.') && !request.startsWith('/') && !Module.isBuiltin(request);
  if (bare) throw new Error(`require('${request}') is not allowed in the publish job (no npm ci there)`);
  return original.call(this, request, parent, isMain);
};
