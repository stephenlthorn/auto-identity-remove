/**
 * dashboard/generic.js
 *
 * The ~490 generic brokers (The Markup dataset, BADBOOL extras, registry feeds)
 * are not in brokers.js, so the broker table never showed them. This loads that
 * list exactly the way generic-runner does and totals their state, so the
 * summary can say how many exist and how far along they are.
 *
 * Generic results live in the same state.optOuts map as the explicit brokers,
 * keyed by the row's name ("Name" or "Name|First Last"), so the status of each
 * one is read with the same aggregateBrokerStatus the broker table uses.
 */

'use strict';

const path = require('path');
const { aggregateBrokerStatus } = require('./validate');
const { brokerPart } = require('../lib/config');

// The same host list watcher.js hands generic-runner so it can drop rows that
// are the same site as an explicit broker.
function explicitHostsOf(explicitBrokers) {
  const hosts = new Set();
  for (const b of Array.isArray(explicitBrokers) ? explicitBrokers : []) {
    try {
      const host = new URL((b && (b.optOutUrl || b.searchUrl)) || '').hostname.replace(/^www\./, '');
      if (host) hosts.add(host);
    } catch (_) { /* a broker with no usable url has no host to dedupe on */ }
  }
  return hosts;
}

/**
 * @param {object} opts
 * @param {Array<object>} [opts.explicitBrokers]  brokers.js entries (their hosts and names are deduped out)
 * @param {Function} [opts.load]  replaces generic-runner's loadGenericBrokers (tests)
 * @param {string} [opts.root]    repo root holding generic-runner.js
 * @returns {Array<{ name: string, url?: string, source?: string }>|null}  null when the datasets cannot be read
 */
function loadGenericList({ explicitBrokers = [], load, root } = {}) {
  try {
    const loader = load || require(path.join(root || path.join(__dirname, '..'), 'generic-runner')).loadGenericBrokers;
    const rows = loader(explicitHostsOf(explicitBrokers), { explicitBrokers });
    return Array.isArray(rows) ? rows : null;
  } catch (_) {
    return null;
  }
}

/**
 * How the generic brokers stand in state: one status per broker (the worst
 * across people, as the broker table shows), counted by class.
 *
 * @param {object} optOuts  state.optOuts (anything else is treated as empty)
 * @param {Array<{ name: string }>} generic
 * @returns {{ total: number, optedOut: number, pending: number, error: number,
 *             notListed: number, manual: number, other: number, untried: number }}
 */
function tallyGeneric(optOuts, generic) {
  const names = new Set();
  for (const b of Array.isArray(generic) ? generic : []) {
    if (b && typeof b.name === 'string' && b.name) names.add(b.name);
  }
  const map = optOuts && typeof optOuts === 'object' && !Array.isArray(optOuts) ? optOuts : {};
  // One pass over state, not one per broker: ~500 brokers x every key adds up on
  // each 15 s summary poll.
  const grouped = new Map();
  for (const key of Object.keys(map)) {
    const name = brokerPart(key);
    if (!names.has(name)) continue;
    if (!grouped.has(name)) grouped.set(name, Object.create(null));
    grouped.get(name)[key] = map[key];
  }
  const totals = { total: names.size, optedOut: 0, pending: 0, error: 0, notListed: 0, manual: 0, other: 0, untried: 0 };
  for (const name of names) {
    const own = grouped.get(name);
    const cls = own ? aggregateBrokerStatus(own, name).key : 'none';
    if (cls === 'ok') totals.optedOut += 1;
    else if (cls === 'pending') totals.pending += 1;
    else if (cls === 'error') totals.error += 1;
    else if (cls === 'notfound') totals.notListed += 1;
    else if (cls === 'manual') totals.manual += 1;
    else if (cls === 'none') totals.untried += 1;
    else totals.other += 1;
  }
  return totals;
}

module.exports = { loadGenericList, tallyGeneric, explicitHostsOf };
