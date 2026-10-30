'use strict';
/**
 * test/scheduler-status-runner.test.js
 *
 * R4: the real runner behind status and uninstall, exercised with node itself
 * (never crontab, launchctl, systemctl or schtasks). What matters is its
 * contract: argv with no shell, stdin delivered, exit status and output
 * returned, and a command that is not installed answering 127 instead of
 * throwing, because a missing crontab has to read as "no job", not as a crash.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { _realRunner } = require('../lib/scheduler');

describe('the real runner', () => {
  it('returns the exit status, stdout and stderr of the command', () => {
    const r = _realRunner(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    assert.deepEqual(r, { status: 3, stdout: 'out', stderr: 'err' });
  });

  it('delivers stdin to the command', () => {
    const r = _realRunner(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'line one\nline two\n');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'line one\nline two\n');
  });

  it('passes arguments as argv, not through a shell', () => {
    const r = _realRunner(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected); `id` && true']);
    assert.equal(r.stdout, '$(echo injected); `id` && true');
  });

  it('answers 127, not an exception, for a command that is not installed', () => {
    const r = _realRunner('aidr-no-such-command-4f1c', ['--version']);
    assert.equal(r.status, 127);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.length > 0);
  });
});
