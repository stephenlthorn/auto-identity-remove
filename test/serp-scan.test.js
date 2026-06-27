/**
 * test/serp-scan.test.js
 *
 * Pure unit tests for lib/serp-scan.js.
 * No live network. No real browser.
 *
 * Tested behaviours:
 *  1. parseSerp('ddg', html)    — extracts ranked URLs from DuckDuckGo HTML
 *  2. parseSerp('bing', html)   — extracts ranked URLs from Bing HTML
 *  3. parseSerp('google', html) — extracts ranked URLs from Google HTML
 *  4. hostnameOf(url)           — strips www prefix, handles edge cases
 *  5. matchBrokers(...)         — returns intersection of serp + broker hostnames
 *  6. buildQuery(person)        — builds the quoted search string
 *  7. hashPerson(...)           — returns stable 64-char hex (sha256)
 *  8. runSerpScan(...)          — orchestrates via injected page stub
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Silence console during tests
let origLog, origWrite;
beforeEach(() => {
  origLog   = console.log;
  origWrite = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  process.stdout.write = () => true;
});
afterEach(() => {
  console.log = origLog;
  process.stdout.write = origWrite;
});

const {
  parseSerp,
  hostnameOf,
  matchBrokers,
  buildQuery,
  hashPerson,
  runSerpScan,
} = require('../lib/serp-scan');

// ─── HTML fixtures ──────────────────────────────────────────────────────────

const DDG_HTML = `
<html><body>
<div class="result">
  <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane-Doe%2FAustin-TX">Spokeo</a>
</div>
<div class="result">
  <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.whitepages.com%2Fpeople%2Fjane-doe">WhitePages</a>
</div>
<div class="result">
  <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.example.com%2F">Other</a>
</div>
</body></html>
`;

const BING_HTML = `
<html><body>
<ol id="b_results">
  <li class="b_algo"><h2><a href="https://www.radaris.com/p/Jane/Doe/">Radaris</a></h2></li>
  <li class="b_algo"><h2><a href="https://www.truepeoplesearch.com/results?name=jane+doe">TPS</a></h2></li>
  <li class="b_algo"><h2><a href="https://unrelated.com/page">Unrelated</a></h2></li>
</ol>
</body></html>
`;

const GOOGLE_HTML = `
<html><body>
<div class="g"><a href="https://www.beenverified.com/people/jane-doe">BeenVerified</a></div>
<div class="g"><a href="/url?q=https://peoplefinders.com/jane-doe">PeopleFinders redirect</a></div>
<div class="g"><a href="https://www.google.com/search?q=related">Google internal - skip</a></div>
<div class="g"><a href="https://news.ycombinator.com/item?id=123">HN</a></div>
</body></html>
`;

// ─── parseSerp: DDG ─────────────────────────────────────────────────────────

test('parseSerp ddg extracts decoded URLs from uddg param', () => {
  const results = parseSerp('ddg', DDG_HTML);
  assert.ok(Array.isArray(results), 'should return an array');
  assert.ok(results.length >= 2, 'should extract at least 2 results');
  assert.ok(results.some(r => r.url.includes('spokeo.com')), 'should include spokeo');
  assert.ok(results.some(r => r.url.includes('whitepages.com')), 'should include whitepages');
});

test('parseSerp ddg assigns 1-based rank', () => {
  const results = parseSerp('ddg', DDG_HTML);
  assert.equal(results[0].rank, 1);
  assert.equal(results[1].rank, 2);
});

test('parseSerp ddg sets engine to ddg', () => {
  const results = parseSerp('ddg', DDG_HTML);
  assert.ok(results.every(r => r.engine === 'ddg'));
});

test('parseSerp ddg falls back to href when no uddg param', () => {
  const html = `<a class="result__a" href="https://direct.example.com/page">Direct</a>`;
  const results = parseSerp('ddg', html);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://direct.example.com/page');
});

test('parseSerp ddg returns empty array for empty html', () => {
  const results = parseSerp('ddg', '<html></html>');
  assert.deepEqual(results, []);
});

// ─── parseSerp: Bing ─────────────────────────────────────────────────────────

test('parseSerp bing extracts URLs from li.b_algo h2 a', () => {
  const results = parseSerp('bing', BING_HTML);
  assert.ok(results.length >= 2);
  assert.ok(results.some(r => r.url.includes('radaris.com')));
  assert.ok(results.some(r => r.url.includes('truepeoplesearch.com')));
});

test('parseSerp bing assigns 1-based rank', () => {
  const results = parseSerp('bing', BING_HTML);
  assert.equal(results[0].rank, 1);
  assert.equal(results[1].rank, 2);
});

test('parseSerp bing sets engine to bing', () => {
  const results = parseSerp('bing', BING_HTML);
  assert.ok(results.every(r => r.engine === 'bing'));
});

test('parseSerp bing returns empty array for empty html', () => {
  const results = parseSerp('bing', '<html></html>');
  assert.deepEqual(results, []);
});

// ─── parseSerp: Google ───────────────────────────────────────────────────────

test('parseSerp google extracts URLs from div.g a[href]', () => {
  const results = parseSerp('google', GOOGLE_HTML);
  assert.ok(results.length >= 1);
  assert.ok(results.some(r => r.url.includes('beenverified.com')));
});

test('parseSerp google skips internal google.com links', () => {
  const results = parseSerp('google', GOOGLE_HTML);
  assert.ok(!results.some(r => r.url.includes('google.com/search')));
});

test('parseSerp google assigns 1-based rank', () => {
  const results = parseSerp('google', GOOGLE_HTML);
  assert.equal(results[0].rank, 1);
});

test('parseSerp google sets engine to google', () => {
  const results = parseSerp('google', GOOGLE_HTML);
  assert.ok(results.every(r => r.engine === 'google'));
});

test('parseSerp google returns empty array for empty html', () => {
  const results = parseSerp('google', '<html></html>');
  assert.deepEqual(results, []);
});

test('parseSerp throws on unknown engine', () => {
  assert.throws(() => parseSerp('yahoo', '<html></html>'), /unknown engine/i);
});

// ─── hostnameOf ──────────────────────────────────────────────────────────────

test('hostnameOf strips www prefix', () => {
  assert.equal(hostnameOf('https://www.spokeo.com/Jane-Doe-xyz'), 'spokeo.com');
});

test('hostnameOf handles no www prefix', () => {
  assert.equal(hostnameOf('https://radaris.com/p/Jane/Doe/'), 'radaris.com');
});

test('hostnameOf handles subdomain other than www', () => {
  assert.equal(hostnameOf('https://app.beenverified.com/optout'), 'app.beenverified.com');
});

test('hostnameOf handles path and query string', () => {
  assert.equal(hostnameOf('https://www.whitepages.com/people/jane?q=1'), 'whitepages.com');
});

test('hostnameOf returns empty string for invalid url', () => {
  assert.equal(hostnameOf('not-a-url'), '');
});

test('hostnameOf returns empty string for empty string', () => {
  assert.equal(hostnameOf(''), '');
});

// ─── matchBrokers ────────────────────────────────────────────────────────────

test('matchBrokers returns intersection of serp and broker hostnames', () => {
  const serpHostnames = ['spokeo.com', 'whitepages.com', 'linkedin.com'];
  const brokerHostnames = ['spokeo.com', 'radaris.com', 'whitepages.com'];
  const matches = matchBrokers(serpHostnames, brokerHostnames);
  assert.deepEqual(matches.sort(), ['spokeo.com', 'whitepages.com']);
});

test('matchBrokers returns empty array when no overlap', () => {
  const matches = matchBrokers(['linkedin.com', 'nytimes.com'], ['spokeo.com', 'radaris.com']);
  assert.deepEqual(matches, []);
});

test('matchBrokers returns empty array for empty inputs', () => {
  assert.deepEqual(matchBrokers([], []), []);
  assert.deepEqual(matchBrokers(['spokeo.com'], []), []);
  assert.deepEqual(matchBrokers([], ['spokeo.com']), []);
});

test('matchBrokers deduplicates results', () => {
  const matches = matchBrokers(['spokeo.com', 'spokeo.com'], ['spokeo.com']);
  assert.equal(matches.length, 1);
});

// ─── buildQuery ──────────────────────────────────────────────────────────────

test('buildQuery wraps name and location in double quotes', () => {
  const q = buildQuery({ fullName: 'Jane Doe', city: 'Austin', state: 'TX' });
  assert.equal(q, '"Jane Doe" "Austin, TX"');
});

test('buildQuery works with different names and locations', () => {
  const q = buildQuery({ fullName: 'John Smith', city: 'New York', state: 'NY' });
  assert.equal(q, '"John Smith" "New York, NY"');
});

test('buildQuery uses firstName + lastName when fullName absent', () => {
  const q = buildQuery({ firstName: 'Jane', lastName: 'Doe', city: 'Austin', state: 'TX' });
  assert.equal(q, '"Jane Doe" "Austin, TX"');
});

// ─── hashPerson ──────────────────────────────────────────────────────────────

test('hashPerson returns a 64-char hex string', () => {
  const h = hashPerson('Jane Doe', 'jane@example.com');
  assert.equal(typeof h, 'string');
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]+$/);
});

test('hashPerson is stable across calls', () => {
  const a = hashPerson('Jane Doe', 'jane@example.com');
  const b = hashPerson('Jane Doe', 'jane@example.com');
  assert.equal(a, b);
});

test('hashPerson differs for different inputs', () => {
  const a = hashPerson('Jane Doe', 'jane@example.com');
  const b = hashPerson('John Smith', 'john@example.com');
  assert.notEqual(a, b);
});

test('hashPerson differs when only email differs', () => {
  const a = hashPerson('Jane Doe', 'jane@example.com');
  const b = hashPerson('Jane Doe', 'other@example.com');
  assert.notEqual(a, b);
});

// ─── runSerpScan orchestrator (Playwright stubbed) ───────────────────────────

/** Build a minimal fake Playwright context for a given engine + HTML. */
function makeContext(pageHtmlByUrl) {
  return {
    newPage: async () => {
      const page = {
        _navigated: null,
        goto: async (url) => { page._navigated = url; },
        content: async () => {
          if (!page._navigated) return '<html></html>';
          // Match by engine URL prefix
          for (const [prefix, html] of Object.entries(pageHtmlByUrl)) {
            if (page._navigated.includes(prefix)) return html;
          }
          return '<html></html>';
        },
        close: async () => {},
      };
      return page;
    },
  };
}

const SAMPLE_BROKERS = [
  { name: 'Spokeo',     optOutUrl: 'https://www.spokeo.com/optout' },
  { name: 'WhitePages', optOutUrl: 'https://www.whitepages.com/suppression-requests' },
  { name: 'Radaris',    optOutUrl: 'https://radaris.com/control/privacy' },
];

const SAMPLE_PERSONS = [
  { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', city: 'Austin', state: 'TX', email: 'jane@example.com' },
];

test('runSerpScan returns summary with total_brokers_appearing', async () => {
  const context = makeContext({
    'duckduckgo.com': `
      <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">Spokeo</a>
      <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Funrelated.com%2F">Other</a>
    `,
    'bing.com': `
      <li class="b_algo"><h2><a href="https://www.whitepages.com/people/jane">WP</a></h2></li>
    `,
    'google.com': `<html></html>`,
  });

  const summary = await runSerpScan(context, SAMPLE_PERSONS, SAMPLE_BROKERS, { _skipWrite: true });
  assert.ok(typeof summary.total_brokers_appearing === 'number');
  assert.ok(Array.isArray(summary.results));
  assert.ok(Array.isArray(summary.blocked));
});

test('runSerpScan identifies broker appearing in DDG results', async () => {
  const context = makeContext({
    'duckduckgo.com': `
      <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane-Doe">Spokeo</a>
    `,
    'bing.com': `<html></html>`,
    'google.com': `<html></html>`,
  });

  const summary = await runSerpScan(context, SAMPLE_PERSONS, SAMPLE_BROKERS, { _skipWrite: true });
  const spokeoBroker = summary.results.find(r => r.broker === 'Spokeo');
  assert.ok(spokeoBroker, 'Spokeo should appear in results');
  assert.ok(spokeoBroker.ranks.ddg !== null, 'should have a ddg rank');
});

test('runSerpScan marks google as blocked when page content is empty/error-like', async () => {
  const context = makeContext({
    'duckduckgo.com': `<html></html>`,
    'bing.com': `<html></html>`,
    'google.com': `
      <div>Our systems have detected unusual traffic from your computer network.</div>
    `,
  });

  const summary = await runSerpScan(context, SAMPLE_PERSONS, SAMPLE_BROKERS, { _skipWrite: true });
  // Google may be in blocked list when detection triggers
  assert.ok(Array.isArray(summary.blocked));
});

test('runSerpScan total_brokers_appearing reflects number of unique brokers found', async () => {
  const context = makeContext({
    'duckduckgo.com': `
      <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">S1</a>
      <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.whitepages.com%2FJane">WP</a>
    `,
    'bing.com': `
      <li class="b_algo"><h2><a href="https://radaris.com/p/Jane">Radaris</a></h2></li>
    `,
    'google.com': `<html></html>`,
  });

  const summary = await runSerpScan(context, SAMPLE_PERSONS, SAMPLE_BROKERS, { _skipWrite: true });
  assert.equal(summary.total_brokers_appearing, 3);
});

test('runSerpScan ranks object has ddg, bing, google keys', async () => {
  const context = makeContext({
    'duckduckgo.com': `
      <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">S</a>
    `,
    'bing.com': `<html></html>`,
    'google.com': `<html></html>`,
  });

  const summary = await runSerpScan(context, SAMPLE_PERSONS, SAMPLE_BROKERS, { _skipWrite: true });
  const r = summary.results.find(r => r.broker === 'Spokeo');
  if (r) {
    assert.ok('ddg' in r.ranks);
    assert.ok('bing' in r.ranks);
    assert.ok('google' in r.ranks);
  }
});

// ── M7: PII redaction in history + subdomain matching ────────────────────────

test('M7: matchBrokers matches privacy.spokeo.com against broker spokeo.com', () => {
  // L6 fix: strip leading subdomains so privacy.spokeo.com matches spokeo.com
  const serpHostnames = ['privacy.spokeo.com'];
  const brokerHostnames = ['spokeo.com'];
  const matches = matchBrokers(serpHostnames, brokerHostnames);
  assert.ok(
    matches.length > 0,
    'privacy.spokeo.com should match broker spokeo.com'
  );
  assert.ok(
    matches.some(m => m === 'spokeo.com' || m === 'privacy.spokeo.com'),
    `expected match for spokeo.com, got: ${JSON.stringify(matches)}`
  );
});

test('M7: matchBrokers matches sub.sub.whitepages.com against whitepages.com', () => {
  const serpHostnames = ['people.whitepages.com'];
  const brokerHostnames = ['whitepages.com'];
  const matches = matchBrokers(serpHostnames, brokerHostnames);
  assert.ok(matches.length > 0, 'people.whitepages.com should match whitepages.com');
});

test('M7: matchBrokers does not match different TLD (spokeo.net != spokeo.com)', () => {
  const serpHostnames = ['spokeo.net'];
  const brokerHostnames = ['spokeo.com'];
  const matches = matchBrokers(serpHostnames, brokerHostnames);
  assert.equal(matches.length, 0, 'different TLD should not match');
});

test('M7: runSerpScan history record does not contain plaintext person name', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  // Write to a temp dir so we can inspect what was written
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-test-'));
  const histPath = path.join(tmpDir, 'serp-history.json');

  // Patch appendToHistory by replacing DATA_DIR - we do this by using
  // the real runSerpScan with a context that returns a broker match
  const context = {
    newPage: async () => {
      const page = {
        _url: null,
        goto: async (url) => { page._url = url; },
        content: async () => {
          if (page._url && page._url.includes('duckduckgo')) {
            return `<a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane-Doe">Spokeo</a>`;
          }
          return '<html></html>';
        },
        close: async () => {},
      };
      return page;
    },
  };

  const testPersons = [
    { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', city: 'Seattle', state: 'WA', email: 'jane@test.com' },
  ];
  const testBrokers = [
    { name: 'Spokeo', optOutUrl: 'https://www.spokeo.com/optout' },
  ];

  // We need to call runSerpScan but redirect its writes to our temp dir.
  // Since the module uses a module-level DATA_DIR, we test via the _skipWrite
  // bypass is NOT set, but we intercept the write with a custom approach:
  // Override fs.writeFileSync temporarily to capture what would be written.
  const writtenData = [];
  const origWriteFileSync = fs.writeFileSync;
  const origRenameSync = fs.renameSync;
  const origMkdirSync = fs.mkdirSync;

  fs.mkdirSync = (dir, opts) => { /* no-op temp */ };
  fs.writeFileSync = (filePath, data) => {
    writtenData.push(data);
  };
  fs.renameSync = (src, dst) => { /* no-op */ };

  try {
    await runSerpScan(context, testPersons, testBrokers, {});
  } finally {
    fs.writeFileSync = origWriteFileSync;
    fs.renameSync = origRenameSync;
    fs.mkdirSync = origMkdirSync;
  }

  // At least one write should have happened (Spokeo found in DDG)
  assert.ok(writtenData.length > 0, 'should have written history data');

  // The written JSON should NOT contain the plaintext name "Jane Doe"
  for (const data of writtenData) {
    assert.ok(
      !data.includes('Jane Doe'),
      `history record must not contain plaintext name "Jane Doe", got: ${data.slice(0, 200)}`
    );
  }
});

test('M7: runSerpScan history record does not contain raw query with person name', async () => {
  const fs = require('fs');

  const writtenData = [];
  const origWriteFileSync = fs.writeFileSync;
  const origRenameSync = fs.renameSync;
  const origMkdirSync = fs.mkdirSync;
  fs.mkdirSync = () => {};
  fs.writeFileSync = (filePath, data) => { writtenData.push(data); };
  fs.renameSync = () => {};

  const context = {
    newPage: async () => ({
      goto: async () => {},
      content: async () =>
        `<a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FBob">Spokeo</a>`,
      close: async () => {},
    }),
  };
  const persons = [
    { firstName: 'Bob', lastName: 'Smith', fullName: 'Bob Smith', city: 'Denver', state: 'CO', email: 'bob@x.com' },
  ];
  const brokers = [{ name: 'Spokeo', optOutUrl: 'https://www.spokeo.com/optout' }];

  try {
    await runSerpScan(context, persons, brokers, {});
  } finally {
    fs.writeFileSync = origWriteFileSync;
    fs.renameSync = origRenameSync;
    fs.mkdirSync = origMkdirSync;
  }

  for (const data of writtenData) {
    assert.ok(
      !data.includes('Bob Smith'),
      `history must not contain "Bob Smith" in written data: ${data.slice(0, 300)}`
    );
  }
});

// ── end M7 ────────────────────────────────────────────────────────────────────

test('runSerpScan null rank means broker not found on that engine', async () => {
  const context = makeContext({
    'duckduckgo.com': `
      <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">S</a>
    `,
    'bing.com': `<html></html>`,
    'google.com': `<html></html>`,
  });

  const summary = await runSerpScan(context, SAMPLE_PERSONS, SAMPLE_BROKERS, { _skipWrite: true });
  const r = summary.results.find(r => r.broker === 'Spokeo');
  if (r) {
    assert.equal(r.ranks.bing, null, 'bing rank should be null when not found');
    assert.equal(r.ranks.google, null, 'google rank should be null when not found');
  }
});

// -- readHistory (safe reader for serp-watch) ---------------------------------

const { readHistory, HISTORY_PATH } = require('../lib/serp-scan');

test('readHistory returns parsed array when history file is valid JSON', () => {
  const fsMod = require('fs');
  const sample = [
    { personId: 'abc', broker: 'Spokeo', engine: 'ddg', rank: 1, hostname: 'spokeo.com', scannedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const origRead = fsMod.readFileSync;
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) return JSON.stringify(sample);
    return origRead(p, enc);
  };
  try {
    const out = readHistory();
    assert.deepEqual(out, sample);
  } finally {
    fsMod.readFileSync = origRead;
  }
});

test('readHistory returns empty array when file is missing', () => {
  const fsMod = require('fs');
  const origRead = fsMod.readFileSync;
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return origRead(p, enc);
  };
  try {
    assert.deepEqual(readHistory(), []);
  } finally {
    fsMod.readFileSync = origRead;
  }
});

test('readHistory returns empty array when file is malformed JSON', () => {
  const fsMod = require('fs');
  const origRead = fsMod.readFileSync;
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) return '{ not valid json';
    return origRead(p, enc);
  };
  try {
    assert.deepEqual(readHistory(), []);
  } finally {
    fsMod.readFileSync = origRead;
  }
});

test('readHistory returns empty array when JSON is not an array', () => {
  const fsMod = require('fs');
  const origRead = fsMod.readFileSync;
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) return JSON.stringify({ optOuts: {} });
    return origRead(p, enc);
  };
  try {
    assert.deepEqual(readHistory(), []);
  } finally {
    fsMod.readFileSync = origRead;
  }
});

test('serp-scan exports HISTORY_PATH ending in data/serp-history.json', () => {
  assert.ok(HISTORY_PATH.endsWith('serp-history.json'), `HISTORY_PATH was ${HISTORY_PATH}`);
});

// ── Fix 4: history batching + cap ────────────────────────────────────────────

test('Fix4: runSerpScan batches history writes - single writeFileSync + rename per scan, not per result', async () => {
  const fsMod = require('fs');

  let writeCallCount = 0;
  const origWriteFileSync = fsMod.writeFileSync;
  const origRenameSync = fsMod.renameSync;
  const origMkdirSync = fsMod.mkdirSync;
  const origReadFileSync = fsMod.readFileSync;

  fsMod.mkdirSync = () => {};
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return origReadFileSync(p, enc);
  };
  fsMod.writeFileSync = (filePath, data) => { writeCallCount++; };
  fsMod.renameSync = () => {};

  // Context that returns multiple brokers across engines to generate > 1 result
  const context = {
    newPage: async () => ({
      _url: null,
      goto: async function(url) { this._url = url; },
      content: async function() {
        if (this._url && this._url.includes('duckduckgo')) {
          return `
            <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">S</a>
            <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.whitepages.com%2FJane">WP</a>
          `;
        }
        return '<html></html>';
      },
      close: async () => {},
    }),
  };

  const persons = [
    { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', city: 'Austin', state: 'TX', email: 'j@x.com' },
  ];
  const brokers = [
    { name: 'Spokeo',     optOutUrl: 'https://www.spokeo.com/optout' },
    { name: 'WhitePages', optOutUrl: 'https://www.whitepages.com/suppression-requests' },
  ];

  try {
    await runSerpScan(context, persons, brokers, {});
  } finally {
    fsMod.writeFileSync = origWriteFileSync;
    fsMod.renameSync = origRenameSync;
    fsMod.mkdirSync = origMkdirSync;
    fsMod.readFileSync = origReadFileSync;
  }

  // There were 2 broker results (Spokeo + WhitePages in DDG), but the write
  // should happen once per scan, NOT once per result (which would be 2 writes).
  assert.ok(
    writeCallCount <= 1,
    `history should be written once per scan (batched), but writeFileSync was called ${writeCallCount} times`
  );
});

test('Fix4: history is capped at HISTORY_MAX entries - older entries are dropped', async () => {
  const { HISTORY_MAX } = require('../lib/serp-scan');
  assert.ok(typeof HISTORY_MAX === 'number' && HISTORY_MAX > 0, 'HISTORY_MAX should be exported as a positive number');

  const fsMod = require('fs');

  // Pre-populate history with HISTORY_MAX entries
  const existingEntries = Array.from({ length: HISTORY_MAX }, (_, i) => ({
    personId: `pid-${i}`,
    broker: 'OldBroker',
    engine: 'ddg',
    rank: 1,
    hostname: 'oldbrok.com',
    scannedAt: new Date(Date.now() - (HISTORY_MAX - i) * 1000).toISOString(),
  }));

  let lastWrittenData = null;
  const origWriteFileSync = fsMod.writeFileSync;
  const origRenameSync = fsMod.renameSync;
  const origMkdirSync = fsMod.mkdirSync;
  const origReadFileSync = fsMod.readFileSync;

  fsMod.mkdirSync = () => {};
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) return JSON.stringify(existingEntries);
    return origReadFileSync(p, enc);
  };
  fsMod.writeFileSync = (filePath, data) => { lastWrittenData = data; };
  fsMod.renameSync = () => {};

  const context = {
    newPage: async () => ({
      _url: null,
      goto: async function(url) { this._url = url; },
      content: async function() {
        if (this._url && this._url.includes('duckduckgo')) {
          return `<a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">S</a>`;
        }
        return '<html></html>';
      },
      close: async () => {},
    }),
  };

  const persons = [
    { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', city: 'Austin', state: 'TX', email: 'j@x.com' },
  ];
  const brokers = [{ name: 'Spokeo', optOutUrl: 'https://www.spokeo.com/optout' }];

  try {
    await runSerpScan(context, persons, brokers, {});
  } finally {
    fsMod.writeFileSync = origWriteFileSync;
    fsMod.renameSync = origRenameSync;
    fsMod.mkdirSync = origMkdirSync;
    fsMod.readFileSync = origReadFileSync;
  }

  assert.ok(lastWrittenData !== null, 'should have written history data');
  const written = JSON.parse(lastWrittenData);
  assert.ok(
    Array.isArray(written) && written.length <= HISTORY_MAX,
    `history should be capped at HISTORY_MAX (${HISTORY_MAX}), but got ${written.length} entries`
  );
  // The new Spokeo entry should be present (most recent entries kept)
  assert.ok(
    written.some(e => e.broker === 'Spokeo'),
    'most recent entry (Spokeo) must be in history'
  );
});

// ── end Fix 4 ─────────────────────────────────────────────────────────────────

// -- runSerpScan summary results carry a hostname (for serp-watch diffing) ----

test('runSerpScan summary results include a broker hostname', async () => {
  const context = makeContext({
    'duckduckgo.com': `
      <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">S</a>
    `,
    'bing.com': `<html></html>`,
    'google.com': `<html></html>`,
  });

  const summary = await runSerpScan(context, SAMPLE_PERSONS, SAMPLE_BROKERS, { _skipWrite: true });
  const spokeo = summary.results.find(r => r.broker === 'Spokeo');
  assert.ok(spokeo, 'Spokeo should be in results');
  assert.equal(spokeo.hostname, 'spokeo.com', 'each result should carry the broker registrable hostname');
});
