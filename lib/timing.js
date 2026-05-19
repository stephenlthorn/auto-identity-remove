/**
 * lib/timing.js
 *
 * Human-like timing utilities to reduce bot-detection fingerprints.
 *
 * jitterSleep(minMs, maxMs) — resolves after a uniformly distributed random
 * delay between minMs and maxMs.  In test/turbo environments it resolves
 * immediately so tests stay fast.
 *
 * Fast-path conditions (no actual wait):
 *   - process.env.TURBO === '1'
 *   - process.env.NODE_ENV === 'test'
 */

const isFast =
  process.env.TURBO === '1' || process.env.NODE_ENV === 'test';

/**
 * Sleep for a uniformly distributed random duration between minMs and maxMs.
 *
 * @param {number} minMs  Minimum delay in milliseconds (inclusive)
 * @param {number} maxMs  Maximum delay in milliseconds (inclusive)
 * @returns {Promise<void>}
 */
function jitterSleep(minMs, maxMs) {
  if (isFast) return Promise.resolve();
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, delay));
}

module.exports = { jitterSleep };
