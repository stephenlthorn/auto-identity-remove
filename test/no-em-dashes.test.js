/**
 * test/no-em-dashes.test.js
 *
 * House style: plain hyphens only. No em dashes (U+2014) and no en dashes
 * (U+2013), anywhere in tracked files - prose, comments, code strings, commit
 * fixtures, all of it.
 *
 * This exists because remembering did not work. 674 of them accumulated across
 * 94 files before anyone swept them, and three were load-bearing rather than
 * decorative by the time they were found:
 *
 *   - dashboard/server.js emits "- process exited with code N -" and
 *     dashboard/public/app.js matches that prefix to style the line;
 *   - scripts/cross-model-render.js writes a report header a test asserts on;
 *   - two broker display names are used as state.optOuts keys, so editing them
 *     orphans existing history.
 *
 * A sweep that has to be done by hand will drift again. A test will not.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Built from code points on purpose. Writing the characters literally here
// would make this file its own first offender: it is tracked, so the scan
// below reads it too, and the suite could never go green.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

/** Tracked files, so generated and ignored content is out of scope. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/** Skip anything that is not UTF-8 text. */
function readTextOrNull(abs) {
  let raw;
  try {
    raw = fs.readFileSync(abs);
  } catch (_) {
    return null;
  }
  if (raw.includes(0)) return null;
  try {
    return raw.toString('utf8');
  } catch (_) {
    return null;
  }
}

/** @returns {Array<{file: string, line: number, text: string, char: string}>} */
function findOffenders() {
  const hits = [];
  for (const rel of trackedFiles()) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const text = readTextOrNull(abs);
    if (text === null) continue;
    if (!text.includes(EM_DASH) && !text.includes(EN_DASH)) continue;
    text.split('\n').forEach((line, i) => {
      for (const [char, name] of [[EM_DASH, 'em dash'], [EN_DASH, 'en dash']]) {
        if (line.includes(char)) {
          hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 100), char: name });
        }
      }
    });
  }
  return hits;
}

test('the git ls-files scan actually sees this repo', () => {
  // Guard against the test passing vacuously because git failed or the cwd moved.
  const files = trackedFiles();
  assert.ok(files.length > 50, `expected a populated repo, got ${files.length} tracked files`);
  assert.ok(files.includes('README.md'), 'README.md should be tracked');
  assert.ok(files.includes('brokers.js'), 'brokers.js should be tracked');
});

test('the detector finds a dash when one is present', () => {
  // Proves the assertion below can fail, rather than always passing.
  const sample = `a ${EM_DASH} b`;
  assert.ok(sample.includes(EM_DASH));
  const en = `a ${EN_DASH} b`;
  assert.ok(en.includes(EN_DASH));
});

test('no tracked file contains an em dash or an en dash', () => {
  const hits = findOffenders();
  const report = hits
    .slice(0, 25)
    .map(h => `  ${h.file}:${h.line} (${h.char})  ${h.text}`)
    .join('\n');
  assert.equal(
    hits.length,
    0,
    `${hits.length} em/en dash(es) found. Use a plain hyphen (-) instead:\n${report}`
      + (hits.length > 25 ? `\n  ... and ${hits.length - 25} more` : ''),
  );
});
