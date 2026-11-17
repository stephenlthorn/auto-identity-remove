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
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LABEL = 'broker-drift';
const TITLE_PREFIX = 'Broker drift: ';
const MARKER_RE = /<!-- aidr-broker-health missing=(\S+) -->/g;

const titleFor = (name) => `${TITLE_PREFIX}${name}`;

/**
 * The hidden record of the missing selectors. `>` is escaped inside the JSON so
 * a selector such as a[title="-->"] cannot end the HTML comment early.
 */
function markerFor(missing) {
  const json = JSON.stringify([...missing]).replace(/>/g, '\\u003e').replace(/ /g, '\\u0020');
  return `<!-- aidr-broker-health missing=${json} -->`;
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
const bullets = (missing) => missing.map((s) => `- \`${s}\``).join('\n');

function createBody({ name, result, url }) {
  return [
    `The weekly broker health check found that **${name}**'s opt-out page loads but no longer has the form the definition in \`brokers.js\` expects. It was \`drifted\` on two weekly checks in a row.`,
    '',
    url ? `Page: ${url}` : null,
    '',
    'Selectors that match nothing:',
    bullets(result.missing),
    '',
    `Last checked: ${result.checkedAt}`,
    '',
    'This looks at the shape of the form only. See STATUS.md for what the labels mean. The issue closes itself when the broker is `ok` again.',
    '',
    markerFor(result.missing),
  ].filter((line) => line !== null).join('\n');
}

function updateBody({ result }) {
  return [
    'The selectors that match nothing have changed. Now:',
    bullets(result.missing),
    '',
    `Checked: ${result.checkedAt}`,
    '',
    markerFor(result.missing),
  ].join('\n');
}

/**
 * @param {object} args
 * @param {Array<{ number: number, title: string, missing: string[]|null }>} args.openIssues  open issues carrying the broker-drift label
 * @param {object} args.results   the `results` object of data/broker-health.json
 * @param {object} [args.urls]    broker name -> opt-out URL, for the issue body
 * @returns {Array<object>} actions: { type: 'create', title, body, labels } | { type: 'comment', number, name, body } | { type: 'close', number, name, comment }
 */
function planIssueActions({ openIssues, results, urls = {} }) {
  // The oldest issue for a broker is its record; later duplicates are left alone.
  const byName = new Map();
  for (const issue of [...openIssues].sort((a, b) => a.number - b.number)) {
    if (!issue.title.startsWith(TITLE_PREFIX)) continue;
    const name = issue.title.slice(TITLE_PREFIX.length);
    if (!byName.has(name)) byName.set(name, issue);
  }

  const hasResults = Object.keys(results).length > 0;
  const actions = [];

  for (const name of Object.keys(results).sort()) {
    const result = results[name];
    const issue = byName.get(name);
    const missing = Array.isArray(result.missing) ? result.missing : [];

    if (result.status === 'drifted') {
      if (!issue) {
        if (result.previousStatus === 'drifted') {
          actions.push({ type: 'create', name, title: titleFor(name), body: createBody({ name, result: { ...result, missing }, url: urls[name] }), labels: [LABEL] });
        }
      } else if (!issue.missing || !sameSet(issue.missing, missing)) {
        actions.push({ type: 'comment', number: issue.number, name, body: updateBody({ result: { ...result, missing } }) });
      }
    } else if (result.status === 'ok' && issue) {
      actions.push({
        type: 'close', number: issue.number, name,
        comment: `The weekly check found **${name}** ok again on ${result.checkedAt}: the page loads and every selector matches. Closing.`,
      });
    }
  }

  if (hasResults) {
    for (const [name, issue] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
      if (name in results) continue;
      actions.push({
        type: 'close', number: issue.number, name,
        comment: `**${name}** is no longer in the broker list, so it is no longer checked. Closing.`,
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
      outcomes.push({ action, ok: true });
    } catch (err) {
      outcomes.push({ action, ok: false, error: err.message });
    }
  }
  return outcomes;
}

/** Open broker-drift issues with their recorded selectors, via an injected `run(args) => stdout`. */
async function listOpenDriftIssues({ run }) {
  const out = await run(['issue', 'list', '--label', LABEL, '--state', 'open', '--limit', '200', '--json', 'number,title,body,comments']);
  return JSON.parse(out).map((issue) => ({
    number: issue.number,
    title: issue.title,
    missing: extractMissing([issue.body, ...(issue.comments || []).map((c) => c.body)]),
  }));
}

/** The real thing: the `gh` CLI, arguments passed as an array (no shell). */
function makeRun() {
  return async (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function makeGh(run) {
  return {
    ensureLabel: (label) => run(['label', 'create', label, '--force', '--color', 'D93F0B', '--description', 'A broker opt-out form changed shape']),
    create: (a) => run(['issue', 'create', '--title', a.title, '--body', a.body, ...a.labels.flatMap((l) => ['--label', l])]),
    comment: (number, body) => run(['issue', 'comment', String(number), '--body', body]),
    close: (number, comment) => run(['issue', 'close', String(number), '--comment', comment]),
  };
}

async function main() {
  const file = path.join(__dirname, '..', '..', 'data', 'broker-health.json');
  const health = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { explicitBrokers } = require('../../lib/broker-health');
  const urls = Object.fromEntries(explicitBrokers(require('../../brokers')).filter((b) => b.optOutUrl).map((b) => [b.name, b.optOutUrl]));

  const run = makeRun();
  const openIssues = await listOpenDriftIssues({ run });
  const plan = planIssueActions({ openIssues, results: health.results || {}, urls });
  const outcomes = await syncIssues({ plan, gh: makeGh(run) });
  for (const o of outcomes) console.log(`${o.ok ? 'done' : 'FAILED'} ${o.action.type} ${o.action.name || ''}${o.ok ? '' : ` (${o.error})`}`);
  if (plan.length === 0) console.log('no issue changes');
  if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
}

module.exports = { planIssueActions, syncIssues, listOpenDriftIssues, makeGh, extractMissing, markerFor, titleFor, LABEL };

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
