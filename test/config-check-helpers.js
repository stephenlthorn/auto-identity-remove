'use strict';
/**
 * Shared fixtures for the config-check tests: a temp install root, a config that
 * validates, and writers for the plain, encrypted and passphrase-file layouts.
 * Every name, address and key here is made up and distinctive on purpose, so a
 * test can assert that none of it ever reaches the output.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../lib/secrets');

const PASSPHRASE = 'correct-horse-battery-staple-4417';

const person = (over = {}) => ({
  firstName: 'Zebediah',
  lastName: 'Quillfeather',
  fullName: 'Zebediah Quillfeather',
  address: '12 Quillfeather Lane',
  city: 'Pittsboro',
  state: 'NC',
  country: 'US',
  zip: '27312',
  email: 'zebediah.quillfeather@example.net',
  phone: '3365550177',
  phoneFormatted: '(336) 555-0177',
  ...over,
});

const goodConfig = (over = {}) => ({
  person: person(),
  capsolver: { apiKey: 'CAP-SECRETKEY-98127' },
  relay: { apiKey: 'relay-secret-key-55231' },
  email: { smtp: { host: 'smtp.example.net', user: 'smtp-user-zq', pass: 'smtp-secret-pass-90210', from: 'zq@example.net' } },
  ...over,
});

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-cfgcheck-'));
}

function writeFile(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { mode });
  fs.chmodSync(file, mode);
  return file;
}

const writePlain = (root, cfg = goodConfig(), mode = 0o600) => writeFile(path.join(root, 'config.json'), cfg, mode);

const writeEncFile = (root, cfg = goodConfig(), passphrase = PASSPHRASE) =>
  writeFile(path.join(root, 'config.json.enc'), secrets.encryptConfig(cfg, passphrase));

const writeEnvelopeInPlace = (root, cfg = goodConfig(), passphrase = PASSPHRASE) =>
  writeFile(path.join(root, 'config.json'), secrets.encryptConfig(cfg, passphrase));

const writePassphraseFile = (root, passphrase = PASSPHRASE, mode = 0o600) =>
  writeFile(path.join(root, 'passphrase.txt'), passphrase + '\n', mode);

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

// Every string a result could echo: its JSON plus the formatted lines.
function everything(result, format) {
  return JSON.stringify(result) + '\n' + format(result).join('\n');
}

module.exports = {
  PASSPHRASE, person, goodConfig, makeRoot, writeFile, writePlain, writeEncFile,
  writeEnvelopeInPlace, writePassphraseFile, cleanup, everything,
};
