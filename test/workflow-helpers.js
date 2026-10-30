/**
 * test/workflow-helpers.js
 *
 * Shared by test/release-workflow.test.js and test/image-workflow.test.js. Not a
 * test itself (the suite only globs *.test.js).
 *
 * Nothing here can run GitHub Actions, and the repo has no YAML dependency, so
 * these read the workflow as text. That works because the workflows keep one
 * fixed shape: jobs at two spaces, a job's keys at four, its steps at six, a
 * step's keys at eight and its `with:` values at ten. A workflow that drifts
 * from that shape fails the "was parsed" tests loudly instead of passing quietly.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const readOrEmpty = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/** The workflow split at its top-level keys: { on, permissions, concurrency, jobs, ... }. */
function topLevelSections(text) {
  const sections = {};
  let key = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z][\w-]*):/);
    if (m) {
      key = m[1];
      sections[key] = '';
    }
    if (key) sections[key] += `${line}\n`;
  }
  return sections;
}

/** A job's steps, each as the text of one list item, re-indented so its first key sits with its siblings. */
function stepsOf(jobText) {
  const marker = '    steps:\n';
  const at = jobText.indexOf(marker);
  if (at === -1) return [];
  return jobText
    .slice(at + marker.length)
    .split(/^ {6}- /m)
    .slice(1)
    .map(s => `        ${s}`);
}

/**
 * The `jobs:` section as { name: { name, text, steps } }, in file order. A comment
 * written above a job belongs to that job, not to the one before it, so those
 * lines move across the boundary: a comment about the image job must not read as
 * part of the release job's configuration.
 */
function parseJobs(jobsSection) {
  const jobLines = {};
  let current = null;
  for (const line of jobsSection.split('\n').slice(1)) {
    const m = line.match(/^ {2}([\w-]+):\s*$/);
    if (m) {
      const carried = [];
      const previous = jobLines[current] || [];
      while (previous.length && /^( {2}#.*|\s*)$/.test(previous[previous.length - 1])) carried.unshift(previous.pop());
      current = m[1];
      jobLines[current] = carried;
    }
    if (current) jobLines[current].push(line);
  }
  const jobs = {};
  for (const [name, list] of Object.entries(jobLines)) {
    const text = `${list.join('\n')}\n`;
    jobs[name] = { name, text, steps: stepsOf(text) };
  }
  return jobs;
}

function parseWorkflow(file) {
  const text = readOrEmpty(file);
  const sections = topLevelSections(text);
  return { text, sections, jobs: parseJobs(sections.jobs || '') };
}

const nameOf = step => (step.match(/^ {8}name: (.+)$/m) || [])[1];

/** The lines after `lines[start]` that are indented by at least `indent`, dedented by it. */
function blockAfter(lines, start, indent) {
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(indent))) break;
    body.push(line.trim() === '' ? '' : line.slice(indent));
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  return body;
}

/** The script a step runs: a `run: |` block, dedented, or a one-line `run: cmd` ('' when it has none). */
function runScript(step) {
  const oneLine = step.match(/^ {8}run: (?!\|\s*$)(.+)$/m);
  if (oneLine) return oneLine[1];
  const lines = step.split('\n');
  const start = lines.findIndex(l => /^ {8}run: \|\s*$/.test(l));
  if (start === -1) return '';
  return `${blockAfter(lines, start, 10).join('\n')}\n`;
}

/** A step's `with:` input: a one-line scalar, or a `|` block as a string. undefined when absent. */
function withInput(step, key) {
  const lines = step.split('\n');
  const start = lines.findIndex(l => new RegExp(`^ {10}${key}:( |$)`).test(l));
  if (start === -1) return undefined;
  const value = lines[start].replace(new RegExp(`^ {10}${key}:\\s*`), '');
  if (/^[|>][+-]?$/.test(value)) return blockAfter(lines, start, 12).join('\n');
  return value;
}

/** A step's own `key:` value at the step level (id, uses, if, ...). undefined when absent. */
function stepKey(step, key) {
  return (step.match(new RegExp(`^ {8}${key}: (.+)$`, 'm')) || [])[1];
}

/** A job's `key:` value: one line, or a folded/literal block joined with spaces. undefined when absent. */
function jobKey(job, key) {
  const lines = job.text.split('\n');
  const start = lines.findIndex(l => new RegExp(`^ {4}${key}:( |$)`).test(l));
  if (start === -1) return undefined;
  const value = lines[start].replace(new RegExp(`^ {4}${key}:\\s*`), '');
  if (/^[|>][+-]?$/.test(value)) return blockAfter(lines, start, 6).join(' ').replace(/\s+/g, ' ').trim();
  return value.trim();
}

/** A job's `permissions:` map, e.g. { contents: 'read', packages: 'write' }. {} when it has none. */
function jobPermissions(job) {
  const lines = job.text.split('\n');
  const start = lines.findIndex(l => /^ {4}permissions:\s*$/.test(l));
  if (start === -1) return {};
  const out = {};
  for (const line of blockAfter(lines, start, 6)) {
    const m = line.match(/^([\w-]+):\s*(\S+)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// `if:` expressions
//
// The workflows only use ==, !=, &&, ||, !, parentheses, 'strings' and dotted
// context lookups (github.ref, needs.release.outputs.exists). That is small
// enough to evaluate directly, which lets a test run the real expression
// against a table of situations instead of pattern-matching its text. Nothing is
// handed to eval.
// ---------------------------------------------------------------------------

const NEXT_TOKEN = /^\s*(&&|\|\||==|!=|!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)/;

function tokenize(expression) {
  const tokens = [];
  let rest = expression;
  while (rest.trim() !== '') {
    const m = rest.match(NEXT_TOKEN);
    if (!m) throw new Error(`unsupported syntax in the if: expression at "${rest.trim().slice(0, 20)}"`);
    tokens.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return tokens;
}

/**
 * Evaluate an `if:` expression against { github: {...}, needs: {...} }-style contexts.
 * A context the expression reads but the caller did not supply throws, so a
 * condition that depends on something unmodelled fails the test instead of
 * reading as false.
 */
function evaluateIf(expression, contexts) {
  const bare = expression.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');
  const tokens = tokenize(bare);
  let at = 0;

  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const loose = v => (typeof v === 'string' ? v.toLowerCase() : v);

  const lookup = dotted => {
    const [head, ...rest] = dotted.split('.');
    if (!(head in contexts)) throw new Error(`the if: expression reads "${dotted}" but the test supplies no "${head}" context`);
    let value = contexts[head];
    for (const key of rest) value = value == null ? undefined : value[key];
    return value === undefined ? '' : value;
  };

  function primary() {
    const token = take();
    if (token === undefined) throw new Error('the if: expression ends early');
    if (token === '(') {
      const value = or();
      if (take() !== ')') throw new Error('the if: expression has an unclosed parenthesis');
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
    if (token === 'true') return true;
    if (token === 'false') return false;
    return lookup(token);
  }

  function unary() {
    if (peek() === '!') {
      take();
      return !unary();
    }
    return primary();
  }

  function equality() {
    let left = unary();
    while (peek() === '==' || peek() === '!=') {
      const op = take();
      const right = unary();
      const same = loose(left) === loose(right);
      left = op === '==' ? same : !same;
    }
    return left;
  }

  function and() {
    let left = equality();
    while (peek() === '&&') {
      take();
      const right = equality();
      left = left && right;
    }
    return left;
  }

  function or() {
    let left = and();
    while (peek() === '||') {
      take();
      const right = and();
      left = left || right;
    }
    return left;
  }

  const result = or();
  if (at !== tokens.length) throw new Error(`the if: expression has trailing input at "${tokens[at]}"`);
  return Boolean(result);
}

/** Every `uses:` line in the text. */
const usesLines = text => text.split('\n').filter(l => /^\s*(- )?uses:/.test(l));

module.exports = {
  ROOT,
  readOrEmpty,
  parseWorkflow,
  nameOf,
  runScript,
  withInput,
  stepKey,
  jobKey,
  jobPermissions,
  evaluateIf,
  usesLines,
};
