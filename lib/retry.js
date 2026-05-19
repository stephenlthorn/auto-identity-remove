/**
 * lib/retry.js
 *
 * withRetry(fn, opts) — retry fn() on transient errors with exponential backoff.
 *
 * opts:
 *   attempts {number}   - max total attempts (default 3)
 *   baseMs   {number}   - base backoff in ms (default 500); backoff is baseMs * 2^(attempt-1)
 *   sleep    {Function} - injectable sleep for tests (default real setTimeout)
 *
 * Transient errors (will retry):
 *   - message includes 'Timeout'
 *   - message includes 'net::ERR_'
 *   - message includes 'status 502', 'status 503', or 'status 504'
 *
 * Non-transient errors throw immediately on first failure.
 */

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

function isTransient(err) {
  const msg = err?.message || '';
  if (msg.includes('Timeout')) return true;
  if (msg.includes('net::ERR_')) return true;
  if (/status 50[234]/.test(msg)) return true;
  return false;
}

async function withRetry(fn, opts = {}) {
  const {
    attempts = 3,
    baseMs = 500,
    sleep = defaultSleep,
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      if (attempt < attempts) {
        await sleep(baseMs * Math.pow(2, attempt - 1));
      }
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isTransient };
