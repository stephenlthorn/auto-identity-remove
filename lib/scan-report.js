/**
 * lib/scan-report.js
 *
 * What `aidr scan` prints, as pure functions that return lines (watcher.js writes them), so
 * what reaches stdout can be tested without running a browser.
 */

'use strict';

/**
 * The body of the scan summary: the counts, then one section per kind of result.
 *
 * @param {{ found: object[], not_found: object[], unvalidated?: object[], unknown: object[], unsearchable: object[] }} result
 * @param {{ label: (e: object) => string, interactive?: boolean }} opts
 * @returns {string[]}
 */
function scanReportLines(result, opts) {
  const { label } = opts;
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
    for (const e of result.found) lines.push(`  - ${label(e)}: ${e.listingUrl}${e.screenshot ? `\n      screenshot: ${e.screenshot}` : ''}`);
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

module.exports = { scanReportLines };
