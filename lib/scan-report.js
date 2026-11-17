/**
 * lib/scan-report.js
 *
 * What `aidr scan` prints, as pure functions that return lines (watcher.js writes them), so
 * what reaches stdout can be tested without running a browser.
 */

'use strict';

const { scanSettings } = require('./scan-config');

// The host of a listing URL, and nothing else: its path carries the person's name. Anything
// that does not parse as a URL prints as "the site", never as the text it was.
function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return 'the site'; }
}

/**
 * The body of the scan summary: the counts, then one section per kind of result.
 *
 * @param {{ found: object[], not_found: object[], unvalidated?: object[], unknown: object[], unsearchable: object[] }} result
 * @param {{ label: (e: object) => string, interactive?: boolean, statePath?: string }} opts
 *   interactive: stdout is a terminal, so the full listing URL may be shown. Anywhere else (a log
 *   file, cron, docker) only the host is, as the run does (S11); the full URLs are in state.json.
 * @returns {string[]}
 */
function scanReportLines(result, opts) {
  const { label, interactive = false, statePath } = opts;
  const unvalidated = result.unvalidated || [];
  const cannotSearch = new Set(result.unsearchable.map(e => e.broker));
  const lines = [];
  lines.push(`  found          : ${result.found.length}`);
  lines.push(`  not found      : ${result.not_found.length}`);
  lines.push(`  not validated  : ${unvalidated.length} (no listing seen, but this site's search is not validated)`);
  lines.push(`  could not tell : ${result.unknown.length}`);
  lines.push(`  cannot search  : ${cannotSearch.size} broker(s) (and the generic brokers, which have no search page)`);
  if (result.found.length > 0) {
    lines.push('', 'Where you were found:');
    for (const e of result.found) {
      const shown = interactive ? e.listingUrl : hostOf(e.listingUrl);
      lines.push(`  - ${label(e)}: ${shown}${e.screenshot ? `\n      screenshot: ${e.screenshot}` : ''}`);
    }
    if (!interactive) {
      lines.push(`  (full listing URLs are in ${statePath || 'state.json'}; they are shown only on an interactive terminal, because the address holds your name)`);
    }
  }
  if (result.not_found.length > 0) {
    lines.push('', 'Where you were not found:');
    lines.push('  ' + result.not_found.map(label).join(', '));
  }
  if (unvalidated.length > 0) {
    lines.push('', "No listing seen, but this site's search is not validated:");
    lines.push('  ' + unvalidated.map(label).join(', '));
    lines.push('  (--found-only does not skip these on that basis: the search may simply not recognise a listing page)');
  }
  if (result.unknown.length > 0) {
    lines.push('', 'Could not tell (not the same as not listed):');
    for (const e of result.unknown) lines.push(`  - ${label(e)}: ${e.reason}`);
  }
  return lines;
}

/**
 * What `--found-only` has to go on, in words, before the explicit pass: how many brokers the
 * scan says you are listed at (submitted), how many it says you are not (skipped), and why
 * every other broker is being submitted or skipped instead (S2). Names no URL.
 *
 * @param {{ plan: { decisions: Array<{ decision: { basis: string } }>, usable: number }, config: object, name?: string }} args
 * @returns {string[]}
 */
function foundOnlyOverview({ plan, config, name }) {
  const policy = scanSettings(config).unknown;
  const count = (basis) => plan.decisions.filter(d => d.decision.basis === basis).length;
  const who = name ? ` for ${name}` : '';
  const rest = [
    [count('stale'), 'scan too old'],
    [count('unknown'), 'could not tell'],
    [count('missing'), 'never scanned'],
    [count('unvalidated'), 'search not validated'],
    [count('unsearchable'), 'cannot be searched'],
  ].filter(([n]) => n > 0).map(([n, why]) => `${n} ${why}`);
  const verdict = policy === 'skip' ? 'skipped' : 'submitted';

  const lines = [`--found-only${who}: ${count('found')} listed (submitted), ${count('not_found')} not listed (skipped).`];
  if (rest.length > 0) {
    lines.push(`   The rest are ${verdict} because scan.unknown is "${policy}": ${rest.join(', ')}.`);
  }
  if (plan.usable === 0) {
    lines.push(`   ${name ? `${name} has` : 'There is'} no usable scan result${name ? '' : ' for this run'}, so this is not narrowed at all: run \`aidr scan\` again first.`);
  }
  return lines;
}

module.exports = { scanReportLines, foundOnlyOverview };
