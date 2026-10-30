/**
 * test/setup-read-secret.test.js
 *
 * CFG-2: askSecret listened with process.stdin.once('data') beside a live
 * terminal readline. Raw mode delivers one chunk per keypress, so the
 * "passphrase" was the first character only, the rest was echoed on screen and
 * leaked into the next prompt ("Schedule?" answered "no" by the leftover
 * letters). The config was then encrypted with a one-letter key and the
 * plaintext deleted: the user's real passphrase would never decrypt it.
 *
 * readSecret({ input, output }) uses readline with a muted output stream, and the
 * new-passphrase flow asks twice and requires a match before anything is
 * encrypted.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const { readSecret, createPrompter, askNewPassphrase } = require('../setup');

const tick = () => new Promise(resolve => setImmediate(resolve));

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const echoed = { text: '' };
  output.on('data', d => { echoed.text += d.toString(); });
  return { input, output, echoed };
}

async function typeKeys(input, text) {
  for (const ch of text) {
    input.write(ch);
    await tick();
  }
}

test('readSecret returns the WHOLE secret when keystrokes arrive one at a time (terminal mode)', async () => {
  const { input, output, echoed } = streams();
  const pending = readSecret({ input, output, prompt: 'PW> ', terminal: true });
  await typeKeys(input, 'zqxkjvbt');
  input.write('\r');
  assert.equal(await pending, 'zqxkjvbt');
  assert.ok(echoed.text.includes('PW> '), 'the prompt itself is shown');
  assert.doesNotMatch(echoed.text, /[zqxkjvbt]/, 'no typed character is echoed');
});

test('readSecret works with one keystroke per chunk in non-terminal mode too', async () => {
  const { input, output, echoed } = streams();
  const pending = readSecret({ input, output, prompt: 'PW> ', terminal: false });
  await typeKeys(input, 'zqxkjvbt');
  input.write('\n');
  assert.equal(await pending, 'zqxkjvbt');
  assert.doesNotMatch(echoed.text, /[zqxkjvbt]/);
});

test('backspace edits the secret like any line editor', async () => {
  const { input, output } = streams();
  const pending = readSecret({ input, output, prompt: '> ', terminal: true });
  await typeKeys(input, 'abcX');
  input.write('\x7f');
  await tick();
  await typeKeys(input, 'd');
  input.write('\r');
  assert.equal(await pending, 'abcd');
});

test('spaces and symbols are kept; only the line terminator is dropped', async () => {
  const { input, output } = streams();
  const pending = readSecret({ input, output, prompt: '> ', terminal: false });
  input.write('  correct horse: battery/staple!  \n');
  assert.equal(await pending, '  correct horse: battery/staple!  ');
});

test('a terminal that goes away mid-entry rejects instead of returning a partial secret', async () => {
  const { input, output } = streams();
  const pending = readSecret({ input, output, prompt: '> ', terminal: true });
  await typeKeys(input, 'half');
  input.end();
  await assert.rejects(pending, /closed|passphrase/i);
});

test('input that ends with nothing at all rejects', async () => {
  const { input, output } = streams();
  const pending = readSecret({ input, output, prompt: '> ', terminal: false });
  input.end();
  await assert.rejects(pending, /closed|passphrase/i);
});

test('piped input: a final line without a newline is a complete answer', async () => {
  const { input, output } = streams();
  const pending = readSecret({ input, output, prompt: '> ', terminal: false });
  input.end('piped-secret');
  assert.equal(await pending, 'piped-secret');
});

// -- the shared prompter used by main() -------------------------------------------

test('a secret read on the shared prompter is not echoed and does not leak into the next prompt', async () => {
  const { input, output, echoed } = streams();
  const prompter = createPrompter({ input, output, terminal: true });

  const name = prompter.ask('Name');
  await typeKeys(input, 'Ada');
  input.write('\r');
  assert.equal(await name, 'Ada');

  const secret = prompter.askSecret('Passphrase');
  await typeKeys(input, 'zqxkjvbt');
  input.write('\r');
  assert.equal(await secret, 'zqxkjvbt');

  const next = prompter.ask('Schedule?', 'y');
  await typeKeys(input, 'n');
  input.write('\r');
  assert.equal(await next, 'n', 'the next answer is only what was typed for it');

  prompter.close();
  assert.doesNotMatch(echoed.text, /[zqxkjvbt]/, 'the secret never reached the screen');
  assert.ok(echoed.text.includes('Name'), 'normal prompts are still shown');
});

test('prompter.ask returns the default for an empty answer and trims', async () => {
  const { input, output } = streams();
  const prompter = createPrompter({ input, output, terminal: false });
  const a = prompter.ask('City', 'Austin');
  input.write('\n');
  assert.equal(await a, 'Austin');
  const b = prompter.ask('City');
  input.write('  Boston  \n');
  assert.equal(await b, 'Boston');
  prompter.close();
});

// -- confirm-by-typing-twice ---------------------------------------------------------

function scripted(answers) {
  const asked = [];
  const read = async (q) => { asked.push(q); return answers.shift(); };
  return { read, asked };
}

test('a matching pair is returned', async () => {
  const { read } = scripted(['correct horse', 'correct horse']);
  assert.equal(await askNewPassphrase({ read, say: () => {} }), 'correct horse');
});

test('a mismatch asks again from the top and never returns the unconfirmed value', async () => {
  const said = [];
  const { read, asked } = scripted(['one', 'two', 'three', 'three']);
  assert.equal(await askNewPassphrase({ read, say: m => said.push(m) }), 'three');
  assert.equal(asked.length, 4);
  assert.ok(said.some(m => /match/i.test(m)));
});

test('after repeated mismatches it gives up with no passphrase (so nothing is encrypted)', async () => {
  const { read, asked } = scripted(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.equal(await askNewPassphrase({ read, say: () => {}, attempts: 3 }), '');
  assert.equal(asked.length, 6);
});

test('an empty first entry means "no encryption" and is not asked to confirm', async () => {
  const { read, asked } = scripted(['']);
  assert.equal(await askNewPassphrase({ read, say: () => {} }), '');
  assert.equal(asked.length, 1);
});
