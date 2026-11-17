#!/usr/bin/env node
'use strict';
/**
 * scripts/ci/broker-health-issues.js
 *
 * The last step of the weekly broker health job: one GitHub issue per drifted
 * broker.
 *
 *   planIssueActions()  PURE. Open drift issues + new results in, a list of
 *                       create / comment / close actions out.
 *   syncIssues()        performs a plan through an injected `gh` object.
 *   makeGh()            the real `gh` calls, kept thin.
 *
 * Rules, and why:
 *   - An issue opens only when the broker was `drifted` on two checks in a row
 *     (result.previousStatus and result.status). Sites run experiments; one bad
 *     check is noise.
 *   - `blocked`, `dead` and `error` never open an issue. A CI address that a site
 *     refuses is not a bug in our selectors.
 *   - Recovery is `ok` and nothing else. A blocked or dead result is no evidence
 *     the form works again, so it leaves an open issue alone.
 *   - The record of which selectors were missing travels in a hidden comment
 *     marker in the issue body and in each update comment, so the planner can
 *     tell "same problem" from "the problem changed" without a database.
 *   - An issue belongs to a broker by a hidden broker-name marker in its BODY,
 *     not by its title: anyone may retitle an issue ("Broker drift: Spokeo
 *     (domain sold)") and the bot must not then close it as "no longer in the
 *     list" and open a duplicate. Issues made before the marker existed fall back
 *     to the title.
 *   - Markers are only believed when the bot wrote them (the issue body, or a
 *     comment, authored by github-actions). Any commenter can paste a marker.
 *   - An issue closed by a person that carries the `wontfix` label is a known
 *     problem: it stays closed and is not recreated. Closed without that label,
 *     it is REOPENED when the broker drifts again (two checks in a row), never
 *     duplicated.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LABEL = 'broker-drift';
const WONTFIX_LABEL = 'wontfix';
const TITLE_PREFIX = 'Broker drift: ';
const MARKER_RE = /<!-- aidr-broker-health missing=(\S+) -->/g;
const BROKER_MARKER_RE = /<!-- aidr-broker-health broker=(\S+) -->/g;
// The account the workflow's GITHUB_TOKEN acts as. gh spells it "github-actions",
// "app/github-actions" or "github-actions[bot]" depending on version and endpoint.
const BOT_LOGIN = 'github-actions';

const titleFor = (name) => `${TITLE_PREFIX}${name}`;

const isBot = (author, botLogin = BOT_LOGIN) => {
  const login = String((author && author.login) || '').toLowerCase().replace(/^app\//, '').replace(/\[bot\]$/, '');
  return login === botLogin;
};

/**
 * Inline code that survives any content: a longer fence than the longest run of
 * backticks inside. Names and selectors come from brokers.js and, through it,
 * from sites; inside a code span an `@name` cannot notify anyone and a backtick
 * cannot break the markup.
 */
function code(text) {
  const value = String(text).replace(/\r?\n/g, ' ');
  const longest = Math.max(0, ...(value.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${value.startsWith('`') || value.endsWith('`') ? ` ${value} ` : value}${fence}`;
}

const escapeForComment = (json) => json.replace(/>/g, '\\u003e').replace(/ /g, '\\u0020');

/** The hidden record of which broker an issue is about (see the header). */
function brokerMarkerFor(name) {
  return `<!-- aidr-broker-health broker=${escapeForComment(JSON.stringify(String(name)))} -->`;
}

/** The broker name recorded in the last marker among `texts`, or null. */
function extractBrokerName(texts) {
  let found = null;
  for (const text of texts) {
    for (const match of String(text || '').matchAll(BROKER_MARKER_RE)) {
      try {
        const parsed = JSON.parse(match[1]);
        if (typeof parsed === 'string' && parsed) found = parsed;
      } catch (_) { /* a garbled marker is no record */ }
    }
  }
  return found;
}

/**
 * The hidden record of the missing selectors. `>` is escaped inside the JSON so
 * a selector such as a[title="-->"] cannot end the HTML comment early.
 */
function markerFor(missing) {
  return `<!-- aidr-broker-health missing=${escapeForComment(JSON.stringify([...missing]))} -->`;
}

/** The newest recorded set of missing selectors across an issue's body and comments, or null. */
function extractMissing(texts) {
  let found = null;
  for (const text of texts) {
    for (const match of String(text || '').matchAll(MARKER_RE)) {
      try {
        const parsed = JSON.parse(match[1]);
        if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) found = parsed;
      } catch (_) { /* a garbled marker is no record */ }
    }
  }
  return found;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().every((s, i) => s === [...b].sort()[i]);
const bullets = (missing) => missing.map((s) => `- ${code(s)}`).join('\n');

// What the issue records as "wrong": the selectors that match nothing visible, and
// the redirect when the page moved to another domain. Both go through the same
// marker, so "same problem" and "the problem changed" work for either.
const problemOf = (result) => [
  ...(Array.isArray(result.missing) ? result.missing : []),
  ...(result.redirectedTo ? [`redirected to ${result.redirectedTo}`] : []),
];
const headingOf = (result) => (result.redirectedTo ? 'The page no longer lives where the definition says:' : 'Selectors that match nothing:');

function createBody({ name, result, url }) {
  return [
    `The weekly broker health check found that the opt-out page of ${code(name)} loads but no longer has the form the definition in \`brokers.js\` expects. It was \`drifted\` on two weekly checks in a row.`,
    '',
    url ? `Page: ${code(url)}` : null,
    '',
    headingOf(result),
    bullets(result.missing),
    '',
    `Last checked: ${result.checkedAt}`,
    '',
    `This looks at the shape of the form only. See STATUS.md for what the labels mean. The issue closes itself when the broker is \`ok\` again. If this is known and should stay closed, close it and add the \`${WONTFIX_LABEL}\` label.`,
    '',
    brokerMarkerFor(name),
    markerFor(result.missing),
  ].filter((line) => line !== null).join('\n');
}

function updateBody({ result }) {
  return [
    'What is wrong has changed. Now:',
    bullets(result.missing),
    '',
    `Checked: ${result.checkedAt}`,
    '',
    markerFor(result.missing),
  ].join('\n');
}

function reopenBody({ name, result }) {
  return [
    `The weekly broker health check found ${code(name)} \`drifted\` on two checks in a row again, so this issue is reopened instead of a new one being opened. If this is known and should stay closed, close it and add the \`${WONTFIX_LABEL}\` label.`,
    '',
    headingOf(result),
    bullets(result.missing),
    '',
    `Checked: ${result.checkedAt}`,
    '',
    markerFor(result.missing),
  ].join('\n');
}

const nameOfIssue = (issue) => {
  if (issue.brokerName) return issue.brokerName;
  return typeof issue.title === 'string' && issue.title.startsWith(TITLE_PREFIX) ? issue.title.slice(TITLE_PREFIX.length) : null;
};
const isClosed = (issue) => String(issue.state || 'open').toLowerCase() === 'closed';

/**
 * @param {object} args
 * @param {Array<{ number: number, title: string, missing: string[]|null, state?: 'open'|'closed', labels?: string[], brokerName?: string|null }>} args.openIssues  issues carrying the broker-drift label, open and closed
 * @param {object} args.results   the `results` object of data/broker-health.json
 * @param {object} [args.urls]    broker name -> opt-out URL, for the issue body
 * @returns {Array<object>} actions: { type: 'create', title, body, labels } | { type: 'comment', number, name, body } | { type: 'close', number, name, comment }
 */
function planIssueActions({ openIssues, results, urls = {} }) {
  // The oldest OPEN issue for a broker is its record; later duplicates are left alone.
  // Among closed ones the newest is the record: it is the one a person last decided about.
  const byName = new Map();
  const closedByName = new Map();
  for (const issue of [...openIssues].sort((a, b) => a.number - b.number)) {
    const name = nameOfIssue(issue);
    if (name === null) continue;
    if (isClosed(issue)) closedByName.set(name, issue);
    else if (!byName.has(name)) byName.set(name, issue);
  }

  const hasResults = Object.keys(results).length > 0;
  const actions = [];

  for (const name of Object.keys(results).sort()) {
    const result = results[name];
    const issue = byName.get(name);
    const missing = problemOf(result);

    if (result.status === 'drifted') {
      if (!issue) {
        const closedBefore = closedByName.get(name);
        if (result.previousStatus !== 'drifted') {
          // one drifted check is noise
        } else if (closedBefore && (closedBefore.labels || []).includes(WONTFIX_LABEL)) {
          // a person closed it as known: leave it closed
        } else if (closedBefore) {
          actions.push({ type: 'reopen', number: closedBefore.number, name, body: reopenBody({ name, result: { ...result, missing } }) });
        } else {
          actions.push({ type: 'create', name, title: titleFor(name), body: createBody({ name, result: { ...result, missing }, url: urls[name] }), labels: [LABEL] });
        }
      } else if (!issue.missing || !sameSet(issue.missing, missing)) {
        actions.push({ type: 'comment', number: issue.number, name, body: updateBody({ result: { ...result, missing } }) });
      }
    } else if (result.status === 'ok' && issue) {
      actions.push({
        type: 'close', number: issue.number, name,
        comment: `The weekly check found ${code(name)} ok again on ${result.checkedAt}: the page loads and every selector matches. Closing.`,
      });
    }
  }

  if (hasResults) {
    for (const [name, issue] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
      if (name in results) continue;
      actions.push({
        type: 'close', number: issue.number, name,
        comment: `${code(name)} is no longer in the broker list, so it is no longer checked. Closing.`,
      });
    }
  }
  return actions;
}

/**
 * Perform a plan through `gh`. One failing action is reported and does not stop
 * the others (a rate limit on one comment should not leave a recovered broker's
 * issue open).
 */
async function syncIssues({ plan, gh }) {
  if (plan.length === 0) return [];
  await gh.ensureLabel(LABEL);
  const outcomes = [];
  for (const action of plan) {
    try {
      if (action.type === 'create') await gh.create(action);
      else if (action.type === 'comment') await gh.comment(action.number, action.body);
      else if (action.type === 'close') await gh.close(action.number, action.comment);
      else if (action.type === 'reopen') await gh.reopen(action.number, action.body);
      outcomes.push({ action, ok: true });
    } catch (err) {
      outcomes.push({ action, ok: false, error: err.message });
    }
  }
  return outcomes;
}

/**
 * Broker-drift issues, open and closed, with what the bot recorded in them.
 * Through an injected `run(args) => stdout`.
 *
 * Only the bot's own words are read: the body when the bot opened the issue, and
 * comments the bot wrote. Anyone can paste `<!-- aidr-broker-health ... -->` into
 * a comment, and the newest marker wins, so an unfiltered read lets a stranger
 * make the bot comment (or hide a real change).
 */
async function listDriftIssues({ run, botLogin = BOT_LOGIN }) {
  const out = await run(['issue', 'list', '--label', LABEL, '--state', 'all', '--limit', '200', '--json', 'number,title,state,labels,author,body,comments']);
  return JSON.parse(out).map((issue) => {
    const botBody = isBot(issue.author, botLogin) ? [issue.body] : [];
    const botComments = (issue.comments || []).filter((c) => isBot(c.author, botLogin)).map((c) => c.body);
    return {
      number: issue.number,
      title: issue.title,
      state: String(issue.state || 'open').toLowerCase(),
      labels: (issue.labels || []).map((l) => l.name),
      brokerName: extractBrokerName(botBody),
      missing: extractMissing([...botBody, ...botComments]),
    };
  });
}

/** The real thing: the `gh` CLI, arguments passed as an array (no shell). */
function makeRun({ exec = execFileSync } = {}) {
  return async (args) => exec('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// The issue number becomes a positional argument, so it must be a plain integer:
// nothing else may ever sit where gh expects a number.
function issueNumber(number) {
  if (!Number.isInteger(number) || number < 1) throw new Error(`not an issue number: ${String(number)}`);
  return String(number);
}

/**
 * Every value is its own argv element and follows its flag. Broker names,
 * selectors and URLs reach these calls and are untrusted: nothing here builds a
 * shell string or splices text into a flag.
 */
function makeGh(run) {
  return {
    ensureLabel: (label) => run(['label', 'create', label, '--force', '--color', 'D93F0B', '--description', 'A broker opt-out form changed shape']),
    create: (a) => run(['issue', 'create', '--title', a.title, '--body', a.body, ...a.labels.flatMap((l) => ['--label', l])]),
    comment: (number, body) => run(['issue', 'comment', issueNumber(number), '--body', body]),
    close: (number, comment) => run(['issue', 'close', issueNumber(number), '--comment', comment]),
    reopen: (number, comment) => run(['issue', 'reopen', issueNumber(number), '--comment', comment]),
  };
}

async function main() {
  const file = path.join(__dirname, '..', '..', 'data', 'broker-health.json');
  const health = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { explicitBrokers } = require('../../lib/broker-health');
  const urls = Object.fromEntries(explicitBrokers(require('../../brokers')).filter((b) => b.optOutUrl).map((b) => [b.name, b.optOutUrl]));

  const run = makeRun();
  const openIssues = await listDriftIssues({ run });
  const plan = planIssueActions({ openIssues, results: health.results || {}, urls });
  const outcomes = await syncIssues({ plan, gh: makeGh(run) });
  for (const o of outcomes) console.log(`${o.ok ? 'done' : 'FAILED'} ${o.action.type} ${o.action.name || ''}${o.ok ? '' : ` (${o.error})`}`);
  if (plan.length === 0) console.log('no issue changes');
  if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
}

module.exports = {
  planIssueActions, syncIssues, listDriftIssues, makeGh, makeRun, extractMissing, extractBrokerName, markerFor, brokerMarkerFor, titleFor, LABEL, WONTFIX_LABEL,
};

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
