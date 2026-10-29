/**
 * test/browser-person-contexts.test.js
 *
 * R7 wiring helper. watcher.js launched ONE persistent context for the whole run; isolation
 * needs one per person. createPersonContexts() hands out the context for persons[index],
 * relaunching (close the old one first, then launch on the new person's profile directory)
 * only when the person changes, and owns the single shutdown hook that closes whichever
 * context is current. watcher.js is a script and cannot be unit tested; this can.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPersonContexts, buildLaunchOptions } = require('../lib/browser');

const PERSONS = [
  { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', zip: '73301', phone: '5125550000' },
  { firstName: 'John', lastName: 'Roe', email: 'john@example.com', zip: '10001', phone: '2125550000' },
];

function fakeChromium({ failLaunch } = {}) {
  const events = [];
  let n = 0;
  return {
    events,
    chromium: {
      async launchPersistentContext(dir, options) {
        if (failLaunch) throw new Error(failLaunch(options));
        const id = ++n;
        events.push({ type: 'launch', id, dir, options });
        const onClose = [];
        const context = {
          id,
          closed: false,
          on(event, handler) { if (event === 'close') onClose.push(handler); },
          async close() {
            events.push({ type: 'close', id });
            context.closed = true;
            for (const handler of onClose) handler();
          },
        };
        return context;
      },
    },
  };
}

const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-contexts-'));
const make = (extra = {}) => {
  const fake = fakeChromium(extra.fake);
  const prepared = [];
  const provider = createPersonContexts({
    chromium: fake.chromium,
    baseDir: tmpBase(),
    persons: PERSONS,
    launchOptions: () => buildLaunchOptions({ headless: false, platform: 'darwin' }),
    prepare: async (context) => { prepared.push(context.id); },
    ...extra.options,
  });
  return { ...fake, prepared, provider };
};

describe('createPersonContexts', () => {
  test('launches person 0 on their own profile directory and prepares the context', async () => {
    const { provider, events, prepared } = make();
    const context = await provider.forPerson(0);
    assert.equal(events.filter((e) => e.type === 'launch').length, 1);
    assert.match(path.basename(events[0].dir), /^person-0-[0-9a-f]+$/);
    assert.deepEqual(prepared, [context.id]);
  });

  test('asking again for the same person reuses the running context', async () => {
    const { provider, events } = make();
    const first = await provider.forPerson(0);
    const again = await provider.forPerson(0);
    assert.equal(first, again);
    assert.equal(events.filter((e) => e.type === 'launch').length, 1);
  });

  test('a different person closes the previous context BEFORE launching on their own directory', async () => {
    const { provider, events } = make();
    await provider.forPerson(0);
    await provider.forPerson(1);
    assert.deepEqual(events.map((e) => e.type), ['launch', 'close', 'launch']);
    assert.notEqual(events[0].dir, events[2].dir);
    assert.match(path.basename(events[2].dir), /^person-1-/);
  });

  test('going back to an earlier person launches again on that person own (same) directory', async () => {
    const { provider, events } = make();
    await provider.forPerson(0);
    await provider.forPerson(1);
    await provider.forPerson(0);
    const launches = events.filter((e) => e.type === 'launch');
    assert.equal(launches.length, 3);
    assert.equal(launches[0].dir, launches[2].dir);
  });

  test('every launch gets a fresh options object', async () => {
    const { provider, events } = make();
    await provider.forPerson(0);
    await provider.forPerson(1);
    const [a, b] = events.filter((e) => e.type === 'launch');
    assert.notEqual(a.options, b.options);
  });

  test('close() closes the current context once and is safe to call again', async () => {
    const { provider, events } = make();
    await provider.forPerson(1);
    await provider.close();
    await provider.close();
    assert.deepEqual(events.map((e) => e.type), ['launch', 'close']);
  });

  test('close() with nothing launched does nothing', async () => {
    const { provider, events } = make();
    await provider.close();
    assert.deepEqual(events, []);
  });

  test('asking for a person after close() launches a new context', async () => {
    const { provider, events } = make();
    await provider.forPerson(0);
    await provider.close();
    await provider.forPerson(0);
    assert.equal(events.filter((e) => e.type === 'launch').length, 2);
  });

  test('a context that was closed behind our back is relaunched, not handed out dead', async () => {
    const { provider, events } = make();
    const first = await provider.forPerson(0);
    await first.close();
    const second = await provider.forPerson(0);
    assert.notEqual(first, second);
    assert.equal(events.filter((e) => e.type === 'launch').length, 2);
  });

  test('if closing the previous context fails, the next person still gets a browser', async () => {
    const { provider } = make();
    const first = await provider.forPerson(0);
    first.close = async () => { throw new Error('already gone'); };
    const second = await provider.forPerson(1);
    assert.ok(second && second !== first);
  });

  test('a prepare() failure closes the half-set-up context and is rethrown', async () => {
    const { provider, events } = make({ options: { prepare: async () => { throw new Error('init script rejected'); } } });
    await assert.rejects(provider.forPerson(0), /init script rejected/);
    assert.deepEqual(events.map((e) => e.type), ['launch', 'close']);
  });

  test('an index with no person is refused', async () => {
    const { provider } = make();
    await assert.rejects(provider.forPerson(2), /no person at index 2/);
    await assert.rejects(provider.forPerson(-1), /no person at index -1/);
    await assert.rejects(provider.forPerson('0'), /no person at index 0/);
  });

  test('a launch failure never carries the proxy password out in its message', async () => {
    const password = 'hunter2-s3cret';
    const { provider } = make({
      fake: { failLaunch: (options) => `browserType.launch: proxy ${options.proxy.server} rejected ${password} for user ${options.proxy.username}` },
      options: {
        launchOptions: () => buildLaunchOptions({
          headless: false,
          platform: 'darwin',
          browser: { proxy: { server: 'http://proxy.example:8080', username: 'alice', password } },
        }),
      },
    });
    await assert.rejects(provider.forPerson(0), (err) => {
      assert.ok(!err.message.includes(password), err.message);
      assert.ok(err.message.includes('proxy.example:8080'));
      return true;
    });
  });

  test('a launch failure leaves the provider with no current context', async () => {
    let fail = true;
    const events = [];
    const provider = createPersonContexts({
      chromium: {
        async launchPersistentContext(dir) {
          if (fail) throw new Error('no display');
          events.push(dir);
          return { async close() {} };
        },
      },
      baseDir: tmpBase(),
      persons: PERSONS,
      launchOptions: () => buildLaunchOptions({ headless: false }),
    });
    await assert.rejects(provider.forPerson(0), /no display/);
    fail = false;
    await provider.forPerson(0);
    assert.equal(events.length, 1);
  });
});
