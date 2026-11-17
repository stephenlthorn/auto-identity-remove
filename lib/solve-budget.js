/**
 * lib/solve-budget.js
 *
 * One solve budget per run (roadmap Q2). A paid CAPTCHA solve costs money, so a
 * run may be given a ceiling: `capsolver.maxSolvesPerRun`.
 *
 *   - A solve counts when a paid task is created with the service, whether or not
 *     it then succeeds: that is the moment the money is spent.
 *   - Unset means no cap, exactly as before.
 *   - A value that is not a whole number of 1 or more is a config problem, and the
 *     run behaves as if no paid solve is allowed (cap 0). Someone who tried to set
 *     a limit and got it wrong must not end up with no limit.
 *   - The budget is created once by watcher.js and handed to the explicit runner
 *     and the generic pass through the solver config (`capsolver.budget`), so both
 *     passes and every person in a multi-person run draw from the same count.
 *
 * Spend is never computed from a price list (prices change). It is the difference
 * between the account balance read before the first solve and the one read at the
 * end. When either read fails the spend is reported as unknown, never as zero.
 */

'use strict';

const BALANCE_URL = 'https://api.capsolver.com/getBalance';

/**
 * Read `capsolver.maxSolvesPerRun`.
 *
 * @param {unknown} raw
 * @returns {{ cap: number|null, problem: string|null }} cap null = no cap; a problem always comes with cap 0
 */
function parseMaxSolves(raw) {
  if (raw === undefined || raw === null) return { cap: null, problem: null };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return { cap: raw, problem: null };
  let shown;
  try { shown = JSON.stringify(raw); } catch (_) { shown = undefined; }
  shown = String(shown === undefined ? raw : shown).slice(0, 40);
  return {
    cap: 0,
    problem: `capsolver.maxSolvesPerRun must be a whole number of 1 or more (got ${shown}); no paid solve is allowed this run`,
  };
}

/**
 * The config problem with the solve cap, as warnings (same shape as
 * captchaConfigWarnings). Shared by `aidr config check` and the start of a run.
 *
 * @param {object|null} [config]
 * @returns {string[]}
 */
function solveCapWarnings(config) {
  const section = config && config.capsolver;
  if (!section || typeof section !== 'object') return [];
  const { problem } = parseMaxSolves(section.maxSolvesPerRun);
  return problem ? [problem] : [];
}

/**
 * The account balance, or null when it cannot be read (no key, a transport error,
 * an error response, a reply that is not a number). Never throws and never puts the
 * key anywhere.
 *
 * @param {string} key
 * @param {{ post?: (url: string, body: object) => Promise<{ data: any }> }} [deps]
 * @returns {Promise<number|null>}
 */
async function readBalance(key, deps = {}) {
  if (!key) return null;
  try {
    const post = deps.post || require('axios').create({ timeout: 30000 }).post;
    const { data } = await post(BALANCE_URL, { clientKey: key });
    if (!data || data.errorId) return null;
    return typeof data.balance === 'number' && Number.isFinite(data.balance) ? data.balance : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {{ cap?: number|null, fetchBalance?: () => Promise<number|null> }} [opts]
 *   cap: null/undefined for none; fetchBalance: how to read the balance (absent = spend unknown)
 */
function createSolveBudget({ cap = null, fetchBalance } = {}) {
  const limit = cap === undefined ? null : cap;
  let used = 0;
  let refused = 0;
  let startRead = null;
  let startBalance = null;

  let finished = null;

  const settle = async () => {
    const base = { used, cap: limit };
    if (used === 0) return { ...base, spend: null };
    if (startRead) await startRead;
    const end = startBalance === null ? null : await readSafely();
    // A balance that went up means credit was added mid-run: the difference
    // says nothing about this run's spend.
    const spend = end === null || end > startBalance ? null : startBalance - end;
    return { ...base, spend };
  };

  const readSafely = async () => {
    if (typeof fetchBalance !== 'function') return null;
    try {
      const value = await fetchBalance();
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch (_) {
      return null;
    }
  };

  return {
    cap: limit,
    used: () => used,
    refusals: () => refused,
    exhausted: () => limit !== null && used >= limit,

    /**
     * Take one solve. Counted before anything is awaited so two solves in flight
     * cannot both take the last one. The first solve waits for the start balance.
     * @returns {Promise<boolean>} false when the cap is used up (nothing is counted)
     */
    async reserve() {
      if (limit !== null && used >= limit) {
        refused += 1;
        return false;
      }
      used += 1;
      if (!startRead) startRead = readSafely().then((v) => { startBalance = v; });
      await startRead;
      return true;
    },

    /**
     * The numbers for the summary. The end balance is read once: asking again
     * returns the same answer, so the run log and the printed summary agree.
     */
    finish() {
      if (!finished) finished = settle();
      return finished;
    },
  };
}

/**
 * Everything watcher.js needs, built once per run: the budget, the solver config
 * that carries it (a copy, so the loaded config is untouched), and any config
 * warnings. A placeholder or missing key never reaches the balance endpoint.
 *
 * @param {object|null} config
 * @param {{ post?: Function }} [deps]
 */
function budgetForRun(config, deps = {}) {
  const section = config && config.capsolver && typeof config.capsolver === 'object' ? config.capsolver : null;
  const { cap } = parseMaxSolves(section ? section.maxSolvesPerRun : undefined);
  const key = section && section.apiKey;
  const usable = Boolean(key) && !String(key).startsWith('CAP-YOUR');
  const budget = createSolveBudget({
    cap,
    fetchBalance: usable ? () => readBalance(key, deps) : undefined,
  });
  return {
    budget,
    capsolver: section ? { ...section, budget } : null,
    warnings: solveCapWarnings(config),
  };
}

/** "solve cap reached (2 of 2 used)" */
function describeCapReached(budget) {
  const cap = budget && budget.cap !== null && budget.cap !== undefined ? budget.cap : '?';
  const used = budget && typeof budget.used === 'function' ? budget.used() : 0;
  return `solve cap reached (${used} of ${cap} used)`;
}

/**
 * The run-summary lines for a finished budget. Empty when no paid solve happened.
 *
 * @param {{ used: number, cap: number|null, spend: number|null }} end
 * @returns {string[]}
 */
function summaryLines(end) {
  if (!end || !end.used) return [];
  const solves = `${end.used} solve${end.used === 1 ? '' : 's'} used (${end.cap === null ? 'no cap' : `cap ${end.cap}`})`;
  const spend = end.spend === null || end.spend === undefined
    ? 'spend unknown (the balance could not be read)'
    : `spend about $${end.spend.toFixed(4)} (balance difference)`;
  return [`CapSolver: ${solves}, ${spend}`];
}

/**
 * The run-level numbers for the run log and the journal, or undefined when no paid
 * solve happened (so a run that never used the solver leaves its log as before).
 * spendUsd is null when it is unknown, never 0.
 */
function runLogSolves(end) {
  if (!end || !end.used) return undefined;
  return { used: end.used, cap: end.cap, spendUsd: end.spend === undefined ? null : end.spend };
}

/**
 * Finish the budget and print the run-summary lines. Returns the numbers so the
 * caller can write them into the run log too.
 *
 * @param {ReturnType<typeof createSolveBudget>} budget
 * @param {(line: string) => void} [log]
 */
async function reportSolves(budget, log = console.log) {
  const end = await budget.finish();
  for (const line of summaryLines(end)) log(line);
  return end;
}

module.exports = {
  reportSolves,
  runLogSolves,
  parseMaxSolves,
  solveCapWarnings,
  readBalance,
  createSolveBudget,
  budgetForRun,
  describeCapReached,
  summaryLines,
};
