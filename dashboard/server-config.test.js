/**
 * dashboard/server-config.test.js
 *
 * Config editing safety: DASH-1 (never replace an unreadable config), DASH-2
 * (persons[] configs), DASH-4 (blank optional sections), DASH-10 (locked state)
 * and DASH-14 (rename fallback, no plaintext temp files).
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHarness } = require('./support/harness');
const secrets = require('../lib/secrets');

async function withServer(opts, fn) {
  const h = await startHarness(opts);
  try { return await fn(h); } finally { await h.close(); }
}

const mode = file => fs.statSync(file).mode & 0o777;
const files = dir => fs.readdirSync(dir).sort();
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const put = (request, config, extra = {}) => request({ method: 'PUT', pathname: '/api/config', body: { config, ...extra } });

// ---- DASH-1 -------------------------------------------------------------------

test('DASH-1: PUT with a wrong passphrase is a 409 and the .enc file is byte-identical', async () => {
  const real = secrets.encryptConfig({ person: { firstName: 'Alice', lastName: 'Smith', email: 'a@example.org' } }, 'right');
  await withServer({ encContent: real, passphrase: 'a-typo' }, async ({ request, paths }) => {
    const before = fs.readFileSync(paths.enc);
    const r = await put(request, { notify: { textTo: '+15125550000' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'config_unreadable');
    assert.equal(r.json.locked, true);
    assert.ok(fs.readFileSync(paths.enc).equals(before), 'the encrypted config must not be touched');
    assert.deepEqual(files(paths.dir), ['config.json.enc'], 'no backup, no plaintext, no temp file');
  });
});

test('DASH-1: PUT onto a truncated plaintext config is a 409 and the file is untouched', async () => {
  await withServer({}, async ({ request, paths }) => {
    fs.writeFileSync(paths.config, '{"person":{"firstName":"Ali');
    const r = await put(request, { notify: { textTo: '+1' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'config_unreadable');
    assert.equal(r.json.locked, false);
    assert.equal(fs.readFileSync(paths.config, 'utf8'), '{"person":{"firstName":"Ali');
  });
});

test('DASH-1: an explicit overwrite replaces an unreadable config and keeps both the old bytes and a durable copy', async () => {
  await withServer({}, async ({ request, paths }) => {
    const broken = '{"person":{"firstName":"Ali';
    fs.writeFileSync(paths.config, broken);
    const r = await put(request, { notify: { textTo: '+1' } }, { overwrite: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(readJson(paths.config).notify.textTo, '+1');
    assert.equal(fs.readFileSync(paths.config + '.bak', 'utf8'), broken);
    const kept = files(paths.dir).filter(n => n.startsWith('config.json.unreadable-') && n.endsWith('.bak'));
    assert.equal(kept.length, 1, 'a timestamped copy of the unreadable file is kept');
    assert.equal(fs.readFileSync(path.join(paths.dir, kept[0]), 'utf8'), broken);

    // The very next save rolls config.json.bak forward but must not lose the original.
    const r2 = await put(request, { notify: { textTo: '+2' } });
    assert.equal(r2.status, 200);
    assert.equal(fs.readFileSync(path.join(paths.dir, kept[0]), 'utf8'), broken, 'the original survives a second save');
    assert.equal(readJson(paths.config + '.bak').notify.textTo, '+1');
  });
});

test('DASH-1: ?overwrite=1 is accepted as well as the body flag', async () => {
  await withServer({}, async ({ request, paths }) => {
    fs.writeFileSync(paths.config, '{ not json');
    const r = await request({ method: 'PUT', pathname: '/api/config?overwrite=1', body: { config: { notify: { textTo: '+9' } } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });
});

test('DASH-1: every replace keeps a 0600 .bak of the previous file', async () => {
  await withServer({ cfgContent: { person: { firstName: 'Bob' }, capsolver: { apiKey: 'K1' } } }, async ({ request, paths }) => {
    const before = fs.readFileSync(paths.config);
    const r = await put(request, { person: { firstName: 'Bobby' } });
    assert.equal(r.status, 200);
    assert.ok(fs.readFileSync(paths.config + '.bak').equals(before), '.bak holds the pre-write bytes');
    assert.equal(mode(paths.config + '.bak'), 0o600);
    assert.equal(mode(paths.config), 0o600);
  });
});

test('DASH-1: an encrypted config is backed up as config.json.enc.bak, still ciphertext', async () => {
  const env = secrets.encryptConfig({ person: { firstName: 'Cy' } }, 'pw');
  await withServer({ encContent: env, passphrase: 'pw' }, async ({ request, paths }) => {
    const before = fs.readFileSync(paths.enc);
    const r = await put(request, { person: { firstName: 'Cyrus' } });
    assert.equal(r.status, 200);
    assert.ok(fs.readFileSync(paths.enc + '.bak').equals(before));
    assert.doesNotMatch(fs.readFileSync(paths.enc + '.bak', 'utf8'), /Cy/);
    assert.equal(fs.existsSync(paths.config), false);
  });
});

test('DASH-1: the first save of a brand-new config makes no .bak', async () => {
  await withServer({}, async ({ request, paths }) => {
    const r = await put(request, { person: { firstName: 'New' } });
    assert.equal(r.status, 200);
    assert.deepEqual(files(paths.dir), ['config.json']);
  });
});

// ---- DASH-10 ------------------------------------------------------------------

test('DASH-10: an encrypted config with no passphrase reports locked, not "not configured"', async () => {
  const env = secrets.encryptConfig({ person: { firstName: 'Alice', lastName: 'Smith', email: 'a@example.org' } }, 'pw');
  await withServer({ encContent: env }, async ({ request }) => {
    const s = await request({ pathname: '/api/config/status' });
    assert.equal(s.json.locked, true);
    assert.equal(s.json.unreadable, true);
    const sum = await request({ pathname: '/api/summary' });
    assert.equal(sum.json.configLocked, true);
    const c = await request({ pathname: '/api/config' });
    assert.equal(c.json.locked, true);
    assert.deepEqual(c.json.config, {}, 'a locked config must not be shown as the example');
  });
});

test('DASH-10: a wrong passphrase is locked too', async () => {
  const env = secrets.encryptConfig({ person: { firstName: 'A' } }, 'right');
  await withServer({ encContent: env, passphrase: 'wrong' }, async ({ request }) => {
    assert.equal((await request({ pathname: '/api/config/status' })).json.locked, true);
  });
});

test('DASH-10: a truncated plaintext config is unreadable but not locked', async () => {
  await withServer({}, async ({ request, paths }) => {
    fs.writeFileSync(paths.config, '{"person":');
    const s = (await request({ pathname: '/api/config/status' })).json;
    assert.equal(s.unreadable, true);
    assert.equal(s.locked, false);
  });
});

test('DASH-10: an absent config is neither locked nor unreadable (the wizard is right)', async () => {
  await withServer({}, async ({ request }) => {
    const s = (await request({ pathname: '/api/config/status' })).json;
    assert.equal(s.configured, false);
    assert.equal(s.locked, false);
    assert.equal(s.unreadable, false);
  });
});

test('DASH-10: a readable config is not locked', async () => {
  await withServer({ cfgContent: { person: { firstName: 'Al', lastName: 'Sm', email: 'a@example.org' } } }, async ({ request }) => {
    const s = (await request({ pathname: '/api/config/status' })).json;
    assert.equal(s.configured, true);
    assert.equal(s.locked, false);
    assert.equal(s.unreadable, false);
  });
});

// ---- DASH-2 -------------------------------------------------------------------

const twoPeople = () => ({
  persons: [
    { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.org', city: 'Austin' },
    { firstName: 'Bob', lastName: 'Jones', email: 'bob@example.org', city: 'Boston' },
  ],
  email: { smtp: { host: 'smtp.example.org', user: 'u', pass: 'SECRET' } },
});

test('DASH-2: saving SMTP on a persons[] config never creates a blank person', async () => {
  // What the old Config tab sent: a blank `person` next to the smtp edit.
  const blankPerson = { firstName: '', lastName: '', fullName: '', aliases: [], city: '', state: '', zip: '', country: '', email: '', phone: '', phoneFormatted: '' };
  await withServer({ cfgContent: twoPeople() }, async ({ request, paths }) => {
    const r = await put(request, { person: blankPerson, email: { smtp: { host: 'smtp.new.org' } } });
    assert.equal(r.status, 200);
    const saved = readJson(paths.config);
    assert.equal('person' in saved, false, 'no top-level person may appear beside persons[]');
    assert.deepEqual(saved.persons, twoPeople().persons);
    assert.equal(saved.email.smtp.host, 'smtp.new.org');
    assert.equal(saved.email.smtp.pass, 'SECRET');
  });
});

test('DASH-2: a leftover blank person is dropped on the next save', async () => {
  const cfg = { ...twoPeople(), person: { firstName: '', lastName: '', email: '' } };
  await withServer({ cfgContent: cfg }, async ({ request, paths }) => {
    const r = await put(request, { notify: { textTo: '+1' } });
    assert.equal(r.status, 200);
    assert.equal('person' in readJson(paths.config), false);
  });
});

test('DASH-2: a person edit lands on persons[0] and the response shows it', async () => {
  await withServer({ cfgContent: twoPeople() }, async ({ request, paths }) => {
    const r = await put(request, { person: { firstName: 'Alicia', city: 'Dallas' } });
    assert.equal(r.status, 200);
    const saved = readJson(paths.config);
    assert.equal(saved.persons[0].firstName, 'Alicia');
    assert.equal(saved.persons[0].city, 'Dallas');
    assert.equal(saved.persons[0].lastName, 'Smith');
    assert.deepEqual(saved.persons[1], twoPeople().persons[1]);
    assert.equal('person' in saved, false);
    assert.equal(r.json.config.persons[0].firstName, 'Alicia');
  });
});

test('DASH-2: the first-run gate reads persons[0]', async () => {
  await withServer({ cfgContent: twoPeople() }, async ({ request }) => {
    const s = (await request({ pathname: '/api/config/status' })).json;
    assert.equal(s.configured, true);
  });
});

// ---- DASH-4 -------------------------------------------------------------------

test('DASH-4: a blank SMTP form on a config without email saves no email.smtp', async () => {
  await withServer({ cfgContent: { person: { firstName: 'Jane' } } }, async ({ request, paths }) => {
    const r = await put(request, { email: { smtp: { host: '', port: '', user: '', from: '' } }, relay: { apiKey: '' }, hibp: { apiKey: '' } });
    assert.equal(r.status, 200);
    const saved = readJson(paths.config);
    assert.equal(saved.email && saved.email.smtp, undefined);
    assert.equal('relay' in saved, false);
    assert.equal('hibp' in saved, false);
  });
});

test('DASH-4: a filled SMTP section is saved', async () => {
  await withServer({}, async ({ request, paths }) => {
    await put(request, { email: { smtp: { host: 'smtp.example.org', port: 587, user: '', from: '' } } });
    assert.equal(readJson(paths.config).email.smtp.host, 'smtp.example.org');
  });
});

// ---- DASH-14 ------------------------------------------------------------------

function withRenameFailing(code, fn) {
  const real = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error(code), { code }); };
  return Promise.resolve().then(fn).finally(() => { fs.renameSync = real; });
}

test('DASH-14: PUT survives EBUSY on rename (single-file mount) and strands no temp file', async () => {
  await withServer({ cfgContent: { person: { firstName: 'Old' } } }, async ({ request, paths }) => {
    await withRenameFailing('EBUSY', async () => {
      const r = await put(request, { person: { firstName: 'New' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    });
    assert.equal(readJson(paths.config).person.firstName, 'New');
    assert.deepEqual(files(paths.dir).filter(n => /\.tmp-/.test(n)), [], 'no plaintext temp copy may remain');
  });
});

test('DASH-14: freeze POST survives EBUSY too', async () => {
  await withServer({ stateContent: { optOuts: {} } }, async ({ request, paths }) => {
    await withRenameFailing('EXDEV', async () => {
      const r = await request({ method: 'POST', pathname: '/api/freeze', body: { key: 'equifax', action: 'done' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    });
    assert.ok(readJson(paths.state).freezes.equifax);
    assert.deepEqual(files(paths.dir).filter(n => /\.tmp-/.test(n)), []);
  });
});

test('DASH-14: a hard write failure leaves no temp file and reports a JSON error', async () => {
  await withServer({ cfgContent: { person: { firstName: 'Old' } } }, async ({ request, paths }) => {
    await withRenameFailing('EACCES', async () => {
      const r = await put(request, { person: { firstName: 'New' } });
      assert.equal(r.status, 500);
      assert.equal(typeof r.json.error, 'string');
    });
    assert.deepEqual(files(paths.dir).filter(n => /\.tmp-/.test(n)), []);
    assert.equal(readJson(paths.config).person.firstName, 'Old', 'the config is untouched');
  });
});
