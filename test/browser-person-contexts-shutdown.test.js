/**
 * test/browser-person-contexts-shutdown.test.js
 *
 * A signal (docker stop, Ctrl-C, a scheduler unload) can arrive while a person's
 * browser is still being prepared: launched, but its init script not yet added.
 * The shutdown calls provider.close() once; it must close THAT context too. The
 * previous single-context code registered the close hook right after the launch,
 * so the browser went with the run; handing out contexts lazily must not turn
 * "a browser mid-launch" into a Chromium left running after the tool exits.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPersonContexts, buildLaunchOptions } = require('../lib/browser');

const PERSONS = [
  { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', zip: '73301', phone: '5125550000' },
  { firstName: 'John', lastName: 'Roe', email: 'john@example.com', zip: '10001', phone: '2125550000' },
];

function fakeChromium() {
  const closed = [];
  let n = 0;
  return {
    closed,
    chromium: {
      async launchPersistentContext() {
        const id = ++n;
        return {
          id,
          on() {},
          async close() { closed.push(id); },
        };
      },
    },
  };
}

const baseDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-contexts-sd-'));

test('close() during prepare closes the context that is being prepared', async () => {
  const { chromium, closed } = fakeChromium();
  let release;
  const stuck = new Promise((resolve) => { release = resolve; });
  const provider = createPersonContexts({
    chromium,
    baseDir: baseDir(),
    persons: PERSONS,
    launchOptions: () => buildLaunchOptions({ headless: true, platform: 'darwin' }),
    prepare: () => stuck,
  });

  const pending = provider.forPerson(0).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  await provider.close();
  assert.deepEqual(closed, [1], 'the browser that was mid-prepare is closed by the shutdown hook');

  release();
  await pending;
});

test('a prepare that fails closes the context and leaves nothing to close twice', async () => {
  const { chromium, closed } = fakeChromium();
  const provider = createPersonContexts({
    chromium,
    baseDir: baseDir(),
    persons: PERSONS,
    launchOptions: () => buildLaunchOptions({ headless: true, platform: 'darwin' }),
    prepare: async () => { throw new Error('init script refused'); },
  });
  await assert.rejects(() => provider.forPerson(0), /init script refused/);
  assert.deepEqual(closed, [1]);
  await provider.close();
  assert.deepEqual(closed, [1], 'closing again does not close the same context twice');
});

test('a context that finished preparing is still reused and closed once', async () => {
  const { chromium, closed } = fakeChromium();
  const provider = createPersonContexts({
    chromium,
    baseDir: baseDir(),
    persons: PERSONS,
    launchOptions: () => buildLaunchOptions({ headless: true, platform: 'darwin' }),
    prepare: async () => {},
  });
  const first = await provider.forPerson(0);
  assert.equal(await provider.forPerson(0), first);
  await provider.close();
  await provider.close();
  assert.deepEqual(closed, [1]);
});
