#!/usr/bin/env node
/**
 * scripts/ci/docker-state-check.js
 *
 * Runs inside the built image and writes through whatever mount the CI step set up:
 *
 *   - state.json bind-mounted as a single FILE (AIDR_STATE_PATH=/app/state.json).
 *     rename() onto a bind mount returns EBUSY, so before the _renameOrRewrite
 *     fallback every state write in Docker was silently discarded and each scheduled
 *     run resubmitted every broker from scratch.
 *
 *   - ONE directory mounted at /home/aidr, with no per-file variable at all: the image
 *     sets AIDR_HOME=/home/aidr, so the state path comes from lib/paths.js. In that
 *     mode the check also writes what a real run leaves besides state (the heartbeat
 *     and a file under the log directory), so the CI step can prove that the whole
 *     home survives the container, not just state.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('/app/lib/config');

// AIDR_STATE_PATH when the step sets it; otherwise wherever the app resolved it
// (AIDR_HOME/state.json in the one-mount recipe).
const target = process.env.AIDR_STATE_PATH || cfg.getStatePath();

cfg.recordSuccess('CiProbe', 'submitted');
cfg.saveState();

const saved = fs.readFileSync(target, 'utf8');
if (!saved.includes('CiProbe')) {
  console.error('state was lost. file contains:', saved);
  process.exit(1);
}
console.log(`state write OK (${target})`);

if (process.env.AIDR_HOME) {
  const { resolvePaths } = require('/app/lib/paths');
  const { startHeartbeat, defaultHeartbeatPath } = require('/app/lib/heartbeat');
  const { mkdirPrivate, writePrivateFile } = require('/app/lib/private-fs');

  const beat = startHeartbeat(defaultHeartbeatPath());
  beat.finish({ outcome: 'ok', counts: { succeeded: 1 } });

  const logs = resolvePaths().logs;
  mkdirPrivate(logs);
  writePrivateFile(path.join(logs, 'run-2026-01-01T00-00-00.json'), '{"ci":"CiProbe"}');
  console.log(`home write OK (${path.dirname(target)}: heartbeat and ${logs})`);
}
