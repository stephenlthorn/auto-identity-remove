/**
 * test/doctor-sanitized-parse.test.js
 *
 * `aidr doctor` prints its findings to be pasted into a bug report. A JSON syntax
 * error from Node can quote the bytes it choked on ("Unexpected token 'b',
 * ...\"zebediah@example.net\" bad }\" is not valid JSON"), and in config.json or
 * state.json those bytes are a person's name or address. doctor now words a parse
 * failure the way `aidr config check` does: where the parser stopped, never what
 * it read. It also reports a bad browser section, which stops a run.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkConfig, checkState } = require('../lib/doctor');

const SECRET_BYTES = 'zebediah.quillfeather@example.net';

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-doctor-parse-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a config that does not parse is reported without quoting the file', async () => withRoot(async (root) => {
  fs.writeFileSync(path.join(root, 'config.json'), `{ "person": { "email": "${SECRET_BYTES}" bad } }`);
  const result = await checkConfig(root);
  assert.equal(result.ok, false);
  assert.match(result.hint, /failed to parse.*not valid JSON/);
  assert.ok(!result.hint.includes(SECRET_BYTES), `the hint quoted the file: ${result.hint}`);
  assert.ok(!result.hint.includes('quillfeather'), result.hint);
}));

test('a state file that does not parse is reported without quoting the file', () => withRoot((root) => {
  fs.writeFileSync(path.join(root, 'state.json'), `{ "optOuts": { "Spokeo|Zebediah Quillfeather": ${SECRET_BYTES} } }`);
  const result = checkState(root);
  assert.equal(result.ok, false);
  assert.match(result.hint, /failed to parse.*not valid JSON/);
  assert.ok(!result.hint.includes('Quillfeather'), result.hint);
  assert.ok(!result.hint.includes(SECRET_BYTES), result.hint);
}));

test('a bad browser section is a config problem', async () => withRoot(async (root) => {
  const person = { firstName: 'Zebediah', lastName: 'Quillfeather', email: SECRET_BYTES, zip: '27312', phone: '3365550177', city: 'Pittsboro', state: 'NC', country: 'US' };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ person, browser: { proxy: { server: 'ftp://proxy.example.net:21', password: 'proxy-pass-7731' } } }));
  const result = await checkConfig(root);
  assert.equal(result.ok, false);
  assert.match(result.hint, /proxy/i);
  assert.ok(!result.hint.includes('proxy-pass-7731'));
}));
