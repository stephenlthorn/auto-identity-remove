// test/serp-engines-usable.test.js
/**
 * NET-5: a blocked or unparseable search engine used to look exactly like a
 * clean one - three blocked engines gave total_brokers_appearing 0 and the CLI
 * said "Your opt-outs appear to be effective at the SERP level". Now:
 *   - each engine is tracked as usable only if it answered without a bot wall
 *     AND parsed at least one result (or showed a known "no results" page);
 *   - the summary exposes enginesUsable / inconclusive;
 *   - isBlocked looks at known interstitial markers and visible text, so a
 *     result snippet that merely says "blocked" or "captcha" cannot discard an
 *     engine's real hits.
 *
 * No network, no browser: a stub Playwright context, history path injected.
 */

'use strict';

// lib/timing reads this at load time: skip the 5-15s pause between engines.
process.env.TURBO = '1';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let origLog;
beforeEach(() => { origLog = console.log; console.log = () => {}; });
afterEach(() => { console.log = origLog; });

const {
  runSerpScan,
  isBlocked,
  describeScanOutcome,
} = require('../lib/serp-scan');

const BROKERS = [
  { name: 'Spokeo', optOutUrl: 'https://www.spokeo.com/optout' },
  { name: 'Radaris', optOutUrl: 'https://radaris.com/control/privacy' },
];
const PERSON = { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', city: 'Austin', state: 'TX', email: 'j@example.com' };

const DDG_HITS = `
  <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">Spokeo</a>
  <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fexample.com%2F">Other</a>`;
const BING_HITS = `<li class="b_algo"><h2><a href="https://radaris.com/p/Jane">Radaris</a></h2></li>`;
const GOOGLE_HITS = `<div class="g"><a href="https://news.example.org/a">News</a></div>`;
const GOOGLE_WALL = '<div>Our systems have detected unusual traffic from your computer network.</div>';
const BING_WALL = '<h1>One last step</h1><p>Please solve the challenge below to continue</p>';
const DDG_WALL = '<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>';

// pages: { ddg, bing, google } -> html | { html, status } | Error
function makeContext(pages) {
  const engineOf = (url) => (url.includes('duckduckgo.com') ? 'ddg' : url.includes('bing.com') ? 'bing' : 'google');
  return {
    newPage: async () => {
      let engine = null;
      return {
        goto: async (url) => {
          engine = engineOf(url);
          const spec = pages[engine];
          if (spec instanceof Error) throw spec;
          if (spec && typeof spec === 'object' && spec.status) return { status: () => spec.status };
          return undefined;
        },
        content: async () => {
          const spec = pages[engine];
          return typeof spec === 'string' ? spec : (spec && spec.html) || '<html></html>';
        },
        close: async () => {},
      };
    },
  };
}

const scan = (pages, persons = [PERSON]) =>
  runSerpScan(makeContext(pages), persons, BROKERS, { _skipWrite: true });

test('NET-5: three blocked engines are inconclusive, not clean', async () => {
  const summary = await scan({ ddg: DDG_WALL, bing: BING_WALL, google: GOOGLE_WALL });

  assert.equal(summary.total_brokers_appearing, 0);
  assert.deepEqual(summary.enginesUsable, []);
  assert.equal(summary.inconclusive, true);
  assert.deepEqual([...summary.blocked].sort(), ['bing', 'ddg', 'google']);

  const text = describeScanOutcome(summary).join('\n');
  assert.match(text, /INCONCLUSIVE/);
  assert.doesNotMatch(text, /effective/i);
});

test('NET-5: engines that answer but parse zero results are not "usable"', async () => {
  const summary = await scan({ ddg: '<html></html>', bing: '<html></html>', google: '<html></html>' });
  assert.deepEqual(summary.enginesUsable, []);
  assert.equal(summary.inconclusive, true);
  assert.deepEqual(summary.blocked, [], 'unreadable is not the same as blocked');
  assert.deepEqual([...summary.unparsed].sort(), ['bing', 'ddg', 'google']);
});

test('NET-5: an engine that parsed results is usable, a clean scan with usable engines is conclusive', async () => {
  const summary = await scan({
    ddg: '<a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fexample.com%2F">x</a>',
    bing: '<li class="b_algo"><h2><a href="https://example.org/">y</a></h2></li>',
    google: GOOGLE_HITS,
  });
  assert.deepEqual(summary.enginesUsable.sort(), ['bing', 'ddg', 'google']);
  assert.equal(summary.inconclusive, false);
  assert.equal(summary.total_brokers_appearing, 0);

  const text = describeScanOutcome(summary).join('\n');
  assert.match(text, /effective/i);
  assert.doesNotMatch(text, /INCONCLUSIVE/);
});

test('NET-5: a known "no results" page counts as usable (a quiet name is not an error)', async () => {
  const summary = await scan({
    ddg: '<div class="no-results">No  results.</div>',
    bing: '<html><body>There are no results for "Jane Doe"</body></html>',
    google: '<html><body>Your search did not match any documents.</body></html>',
  });
  assert.deepEqual(summary.enginesUsable.sort(), ['bing', 'ddg', 'google']);
  assert.equal(summary.inconclusive, false);
});

test('NET-5: one usable engine with no hits is conclusive but flagged as partial', async () => {
  const summary = await scan({
    ddg: '<a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fexample.com%2F">x</a>',
    bing: BING_WALL,
    google: GOOGLE_WALL,
  });
  assert.deepEqual(summary.enginesUsable, ['ddg']);
  assert.equal(summary.inconclusive, false);

  const text = describeScanOutcome(summary).join('\n');
  assert.match(text, /1 of 3/);
  assert.match(text, /bing, google|google, bing/);
});

test('NET-5: a navigation error and an HTTP 403 are not usable either', async () => {
  const summary = await scan({
    ddg: new Error('net::ERR_CONNECTION_RESET'),
    bing: { html: BING_HITS, status: 403 },
    google: { html: GOOGLE_HITS, status: 429 },
  });
  assert.deepEqual(summary.enginesUsable, []);
  assert.equal(summary.inconclusive, true);
  assert.deepEqual([...summary.blocked].sort(), ['bing', 'ddg', 'google']);
});

test('NET-5: results are still reported when only some engines are blocked', async () => {
  const summary = await scan({ ddg: DDG_HITS, bing: BING_WALL, google: GOOGLE_WALL });
  assert.equal(summary.total_brokers_appearing, 1);
  assert.equal(summary.results[0].broker, 'Spokeo');
  assert.deepEqual(summary.enginesUsable, ['ddg']);
});

test('NET-5: with two persons, an engine must be usable for BOTH to count; a person with none is inconclusive', async () => {
  let call = 0;
  const context = {
    newPage: async () => {
      const mine = call++;            // 0-2 = person 1 (ddg, bing, google), 3-5 = person 2
      return {
        goto: async () => {},
        content: async () => (mine < 3 ? '<a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fexample.com%2F">x</a>' : GOOGLE_WALL),
        close: async () => {},
      };
    },
  };
  const two = [PERSON, { ...PERSON, firstName: 'Bob', lastName: 'Roe', fullName: 'Bob Roe', email: 'b@example.com' }];
  const summary = await runSerpScan(context, two, BROKERS, { _skipWrite: true });
  assert.equal(summary.inconclusive, true, 'person 2 had no usable engine');
});

// -- isBlocked ------------------------------------------------------------------

test('NET-5: isBlocked recognises real interstitials', () => {
  assert.equal(isBlocked(GOOGLE_WALL), true);
  assert.equal(isBlocked(BING_WALL), true);
  assert.equal(isBlocked(DDG_WALL), true);
  assert.equal(isBlocked('<form id="captcha-form" action="/sorry/index"></form>'), true);
  assert.equal(isBlocked('<div class="g-recaptcha" data-sitekey="x"></div>'), true);
});

test('NET-5: isBlocked ignores the word "blocked" or "captcha" in script, style or snippet text', () => {
  assert.equal(isBlocked('<script>var s = "captcha blocked";</script><p>fine</p>'), false);
  assert.equal(isBlocked('<style>.captcha { display: none }</style><p>fine</p>'), false);
  assert.equal(isBlocked('<div class="result__snippet">Her account was blocked after the captcha failed.</div>'), false);
});

test('NET-5: a snippet saying "blocked" does not discard the engine\'s real hits', async () => {
  const ddg = `
    <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">Spokeo</a>
    <div class="result__snippet">Access blocked? Solve this captcha to continue reading about Jane Doe</div>`;
  const summary = await scan({ ddg, bing: '<html></html>', google: '<html></html>' });

  assert.equal(summary.total_brokers_appearing, 1, 'the Spokeo hit survives');
  assert.ok(!summary.blocked.includes('ddg'));
  assert.deepEqual(summary.enginesUsable, ['ddg']);
});

test('NET-5: even a snippet that quotes an interstitial phrase cannot hide results that parsed', async () => {
  const bing = `
    <li class="b_algo"><h2><a href="https://radaris.com/p/Jane">Radaris</a></h2>
      <p>Our systems have detected unusual traffic - a forum thread</p></li>`;
  const summary = await scan({ ddg: '<html></html>', bing, google: '<html></html>' });
  assert.equal(summary.total_brokers_appearing, 1);
  assert.deepEqual(summary.enginesUsable, ['bing']);
});

// -- history: scan ids and markers ----------------------------------------------

test('NET-5/NET-13: every history row carries the scan id, and a conclusive scan leaves a marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-serp-'));
  const historyPath = path.join(dir, 'serp-history.json');
  try {
    await runSerpScan(
      makeContext({ ddg: DDG_HITS, bing: '<html></html>', google: '<html></html>' }),
      [PERSON], BROKERS, { _historyPath: historyPath }
    );
    const rows = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const hit = rows.find(r => r.broker === 'Spokeo');
    const marker = rows.find(r => r.scan === true);
    assert.ok(hit && hit.scanId, 'appearance row has scanId');
    assert.ok(marker, 'scan marker row exists');
    assert.equal(marker.scanId, hit.scanId);
    assert.equal(marker.conclusive, true);
    assert.deepEqual(marker.enginesUsable, ['ddg']);
    assert.equal(marker.broker, undefined, 'a marker is not a broker appearance');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NET-5/NET-13: an inconclusive scan is recorded as inconclusive so it cannot erase earlier hits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-serp-'));
  const historyPath = path.join(dir, 'serp-history.json');
  try {
    await runSerpScan(
      makeContext({ ddg: DDG_WALL, bing: BING_WALL, google: GOOGLE_WALL }),
      [PERSON], BROKERS, { _historyPath: historyPath }
    );
    const rows = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const marker = rows.find(r => r.scan === true);
    assert.equal(marker.conclusive, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
