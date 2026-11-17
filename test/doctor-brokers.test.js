'use strict';
/**
 * test/doctor-brokers.test.js
 *
 * `aidr doctor --brokers`: the broker health check from the user's own machine.
 * Like the rest of lib/doctor.js it takes its dependencies by injection, so no
 * browser starts and no site is touched here. It prints one line per broker and
 * the totals, uses the launch options a normal run uses, and writes nothing.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runBrokerHealthDoctor } = require('../lib/doctor');
const { buildLaunchOptions, BASE_ARGS } = require('../lib/browser');

const LIST = [
  { name: 'Good', method: 'manual', optOutUrl: 'https://good.example/x' },
  { name: 'Gone', method: 'manual', optOutUrl: 'https://gone.example/x' },
  { name: 'Mail', method: 'email', emailTo: 'x@example.com' },
];

function fakeBrowser(log, { status = (url) => (url.includes('gone') ? 404 : 200) } = {}) {
  return async (options) => {
    log.launch = options;
    return {
      async newContext(contextOptions) {
        log.context = contextOptions;
        return {
          async newPage() {
            return {
              async goto(url) { log.gotos.push(url); return { status: () => status(url), headers: () => ({}) }; },
              async evaluate() { return null; },
              async waitForTimeout() {},
              async close() {},
            };
          },
        };
      },
      async close() { log.closed = true; },
    };
  };
}

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-doctor-brokers-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const run = (extra = {}) => {
  const log = { gotos: [], launch: null, context: null, closed: false };
  const lines = [];
  return runBrokerHealthDoctor({
    rootDir: root,
    brokers: LIST,
    launch: fakeBrowser(log),
    print: (line) => lines.push(line),
    pauseMs: 0,
    ...extra,
  }).then((outcome) => ({ outcome, log, lines }));
};

describe('runBrokerHealthDoctor', () => {
  it('prints one line per broker and the totals', async () => {
    const { lines, outcome } = await run();
    const joined = lines.join('\n');
    assert.match(joined, /ok\s+Good/);
    assert.match(joined, /dead\s+Gone/);
    assert.match(joined, /n\/a\s+Mail/);
    assert.match(joined, /1 ok, 0 drifted, 0 blocked, 1 dead, 0 error, 1 n\/a/);
    assert.equal(outcome.summary.ok, 1);
    assert.equal(outcome.summary.dead, 1);
  });

  it('uses the launch options a normal run uses (buildLaunchOptions), split into browser and context options', async () => {
    const { log } = await run();
    const expected = buildLaunchOptions({});
    assert.deepEqual(log.launch.args, expected.args);
    assert.ok(log.launch.args.includes(BASE_ARGS[0]));
    assert.deepEqual(log.launch.ignoreDefaultArgs, expected.ignoreDefaultArgs);
    assert.equal(log.launch.headless, expected.headless);
    assert.equal('viewport' in log.launch, false, 'viewport belongs to the context');
    assert.deepEqual(log.context.viewport, expected.viewport);
  });

  it("honours the configured proxy and user agent from the person's config.json", async () => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      person: { firstName: 'Jane', lastName: 'Sample', email: 'jane@example.com', zip: '90001' },
      browser: { proxy: { server: 'http://127.0.0.1:3128' }, userAgent: 'Mozilla/5.0 Test' },
    }));
    const { log } = await run();
    assert.equal(log.launch.proxy.server, 'http://127.0.0.1:3128');
    assert.equal(log.context.userAgent, 'Mozilla/5.0 Test');
  });

  it('never prints or loads anything from the config: sentinel person, the real broker list, real broker URLs', async () => {
    // A distinct person (not the placeholder), and the REAL explicit broker list, built in a child
    // process whose config is the sentinel config: brokers.js reads its config at first require, so
    // a leak from the config into a URL or a printed line would show up here.
    const SENTINELS = ['Zqfirst', 'Zqlast', 'zq.sentinel@zq.invalid', '9990001111', 'Zqcity', '99999', 'Zqalias'];
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
    const config = {
      ...example,
      person: {
        ...example.person, firstName: 'Zqfirst', lastName: 'Zqlast', fullName: 'Zqfirst Zqlast', aliases: ['Zqalias'],
        email: 'zq.sentinel@zq.invalid', phone: '9990001111', phoneFormatted: '9990001111', city: 'Zqcity', state: 'ZQ', zip: '99999',
      },
    };
    delete config.persons;
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-doctor-probe-')), 'probe.js');
    fs.writeFileSync(script, `
      const { runBrokerHealthDoctor } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'doctor'))});
      const gotos = []; const lines = [];
      const launch = async () => ({
        async newContext() { return { async newPage() { return {
          async goto(url) { gotos.push(url); return { status: () => 200, headers: () => ({}) }; },
          async evaluate() { return null; }, async waitForTimeout() {}, async close() {},
        }; } }; },
        async close() {},
      });
      runBrokerHealthDoctor({ rootDir: ${JSON.stringify(root)}, launch, print: (l) => lines.push(l), pauseMs: 0 })
        .then((outcome) => process.stdout.write(JSON.stringify({ gotos, lines, exitCode: outcome.exitCode })));
    `);
    const out = spawnSync(process.execPath, [script], {
      encoding: 'utf8', env: { ...process.env, AIDR_CONFIG_PATH: configPath, AIDR_HOME: root },
    });
    assert.equal(out.status, 0, out.stderr);
    const seen = JSON.parse(out.stdout);
    assert.equal(seen.exitCode, 0);
    assert.ok(seen.gotos.length >= 40, 'the real broker list was used');
    const haystack = [...seen.lines, ...seen.gotos].join('\n');
    for (const value of SENTINELS) {
      assert.equal(haystack.toLowerCase().includes(value.toLowerCase()), false, `leaked ${value}`);
      assert.equal(haystack.includes(encodeURIComponent(value)), false, `leaked ${value} (encoded)`);
    }
    assert.ok(seen.gotos.some((u) => /Jane/.test(u)), 'the placeholder person is what reaches a URL');
  });

  it('the sentinel config really would reach a URL if the list were built from it (so the test above can fail)', () => {
    const forReal = require('../brokers').forPerson({ firstName: 'Zqfirst', lastName: 'Zqlast', state: 'ZQ', zip: '99999', email: 'zq@zq.invalid' });
    assert.ok(forReal.some((b) => /Zqfirst/.test(String(b.optOutUrl))), 'a broker URL embeds the person');
  });

  it('loads each opt-out page once, and none for an email broker', async () => {
    const { log } = await run();
    assert.deepEqual(log.gotos, ['https://good.example/x', 'https://gone.example/x']);
  });

  it('writes nothing: the directory it was given is unchanged', async () => {
    const before = fs.readdirSync(root);
    await run();
    assert.deepEqual(fs.readdirSync(root), before);
  });

  it('closes the browser', async () => {
    const { log } = await run();
    assert.equal(log.closed, true);
  });

  it('works without a config at all', async () => {
    const { outcome } = await run();
    assert.equal(outcome.exitCode, 0);
  });

  it('drifted or blocked brokers are findings, not a failed run (exit 0)', async () => {
    const { outcome } = await run({ launch: fakeBrowser({ gotos: [] }, { status: () => 403 }) });
    assert.equal(outcome.summary.blocked, 2);
    assert.equal(outcome.exitCode, 0);
  });

  it('a browser that will not start is a failed run with a hint', async () => {
    const lines = [];
    const outcome = await runBrokerHealthDoctor({
      rootDir: root, brokers: LIST, print: (l) => lines.push(l),
      launch: async () => { throw new Error('Executable does not exist'); },
    });
    assert.equal(outcome.exitCode, 1);
    assert.match(lines.join('\n'), /could not start a browser/);
    assert.match(lines.join('\n'), /playwright install/);
  });

  it('a malformed browser section is reported, not launched without its proxy', async () => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      person: { firstName: 'Jane', lastName: 'Sample', email: 'jane@example.com', zip: '90001' },
      browser: { proxy: 'not a url' },
    }));
    const lines = [];
    let launched = false;
    const outcome = await runBrokerHealthDoctor({
      rootDir: root, brokers: LIST, print: (l) => lines.push(l),
      launch: async () => { launched = true; throw new Error('should not launch'); },
    });
    assert.equal(launched, false);
    assert.equal(outcome.exitCode, 1);
  });

  it('says what the check cannot tell you', async () => {
    const { lines } = await run();
    assert.match(lines.join('\n'), /shape of the form/);
  });
});
