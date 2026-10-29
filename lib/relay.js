/**
 * lib/relay.js
 *
 * Masked-email relay integration.
 *
 * When config.relay = { provider: 'simplelogin', apiKey } is set, opt-out
 * submissions use a per-person masked alias instead of the person's real
 * email address, so brokers never receive a fresh real address. The alias is
 * created once per person and cached in state.relayAliases[personKey] so a new
 * alias is not minted on every run.
 *
 * The relay FAILS CLOSED. If an alias cannot be created, the real address is
 * NOT returned: resolveSubmissionEmail reports { email: null, error } and
 * getSubmissionEmail throws a RelayUnavailableError, so the caller can skip the
 * email-bearing brokers instead of silently handing them the address the user
 * asked to hide. Setting config.relay.failOpen === true opts back in to the old
 * "use the real email" fallback, with a loud warning.
 *
 * With { dryRun: true } an alias is never created (a dry run does not persist
 * state, so every dry run would mint a fresh alias): a cached alias is used if
 * present, otherwise DRY_RUN_PLACEHOLDER, which callers may only print.
 *
 * The only side effect (creating an alias) is injected via createImpl, which
 * defaults to the real SimpleLogin API call. When no relay is configured the
 * person's email is returned unchanged (fully backward compatible).
 *
 * Manual fallbacks (Apple Hide My Email, Firefox Relay) are documented in
 * docs/relay.md; they cannot be automated via API here, so users paste the
 * generated alias into config.person.email manually for those providers.
 */

'use strict';

// SimpleLogin's random-alias endpoint. (/api/alias/custom/new is not a real
// route: custom aliases live at /api/v3/alias/custom/new and need a prefix,
// a signed suffix and mailbox ids.)
const SIMPLELOGIN_ALIAS_URL = 'https://app.simplelogin.io/api/alias/random/new';

// Shown in dry-run previews when no alias is cached yet. The .invalid TLD is
// reserved (RFC 2606) so it can never be a real mailbox.
const DRY_RUN_PLACEHOLDER = 'relay-alias-would-be-created@example.invalid';

const REQUEST_TIMEOUT_MS = 15000;

// Providers supported via API automation. Apple Hide My Email and Firefox Relay
// are documented manual fallbacks (no public alias-creation API), so they are
// intentionally not listed here.
const RELAY_PROVIDERS = ['simplelogin'];

/**
 * Thrown by getSubmissionEmail when a relay is configured but unusable and
 * relay.failOpen is not true. `cause` carries the underlying error.
 */
class RelayUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RelayUnavailableError';
    this.code = 'RELAY_UNAVAILABLE';
    if (cause) this.cause = cause;
  }
}

/**
 * Stable, case-insensitive cache key for a person. Prefers the email address
 * (already unique per person); falls back to first+last name when absent.
 *
 * @param {{ email?: string, firstName?: string, lastName?: string }} person
 * @returns {string}
 */
function personKey(person) {
  const email = (person && person.email) ? String(person.email).trim().toLowerCase() : '';
  if (email) return email;
  const first = (person && person.firstName) ? String(person.firstName).trim().toLowerCase() : '';
  const last = (person && person.lastName) ? String(person.lastName).trim().toLowerCase() : '';
  return `${first} ${last}`.trim();
}

/**
 * Create a random alias via the SimpleLogin API.
 *
 * POST https://app.simplelogin.io/api/alias/random/new
 * Header: Authentication: <apiKey>
 * Body:   { "note": "<optional note>" }
 * Reply:  201 with the alias object (the address is in `alias`, or `email` in
 *         the newer alias-object shape; both are accepted).
 *
 * @param {object} args
 * @param {string} args.apiKey   - SimpleLogin API key
 * @param {string} args.note     - human-readable note stored on the alias
 * @param {function} [args.fetchImpl] - injected for testing; defaults to global fetch
 * @param {number} [args.timeoutMs]
 * @returns {Promise<string>} the created alias email address
 */
async function createSimpleLoginAlias({ apiKey, note, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  let res;
  try {
    res = await doFetch(SIMPLELOGIN_ALIAS_URL, {
      method: 'POST',
      headers: {
        'Authentication': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ note }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`SimpleLogin alias creation failed: ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res || !res.ok) {
    const status = res ? res.status : 'no-response';
    let detail = '';
    try {
      const j = await res.json();
      detail = j && j.error ? `: ${j.error}` : '';
    } catch (_) {}
    throw new Error(`SimpleLogin alias creation failed (HTTP ${status})${detail}`);
  }

  const data = await res.json();
  const alias = data && (data.alias || data.email);
  if (!alias) {
    throw new Error('SimpleLogin alias creation failed: response missing "alias" field');
  }
  return alias;
}

/**
 * Default createImpl: routes to the configured provider's real alias creator.
 * Injected (and overridden) by tests.
 *
 * @param {object} args
 * @param {string} args.provider
 * @param {string} args.apiKey
 * @param {string} args.note
 * @param {function} [args.fetchImpl]
 * @returns {Promise<string>}
 */
async function defaultCreateImpl({ provider, apiKey, note, fetchImpl }) {
  if (provider === 'simplelogin') {
    return createSimpleLoginAlias({ apiKey, note, fetchImpl });
  }
  throw new Error(`Unsupported relay provider: ${provider}`);
}

function looksLikeAddress(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+$/.test(value.trim());
}

/**
 * Resolve the email address to use when submitting an opt-out for `person`,
 * reporting what happened instead of throwing.
 *
 * - No relay configured (no config.relay, or an empty block) -> person.email.
 * - Relay configured -> a cached alias from state.relayAliases[personKey], or a
 *   freshly created one (via createImpl) cached for subsequent runs.
 * - dryRun -> never creates: cached alias, else DRY_RUN_PLACEHOLDER.
 * - Relay configured but unusable (missing apiKey, unsupported provider, API
 *   failure, no usable alias in the reply) -> { email: null, source:
 *   'unavailable', error }, unless config.relay.failOpen === true, in which case
 *   a loud warning is printed and the real email is returned with
 *   source 'real-fallback'.
 *
 * @param {object} args
 * @param {object} args.config       - full config object (reads config.relay)
 * @param {object} args.person       - person whose submission email we resolve
 * @param {object} [args.state]      - shared mutable state; alias cache stored under state.relayAliases
 * @param {function} [args.createImpl] - injected alias creator; defaults to defaultCreateImpl
 * @param {function} [args.fetchImpl]  - injected fetch for the default creator
 * @param {boolean} [args.dryRun]    - never create an alias
 * @param {function} [args.warn]     - warning sink (default console.warn)
 * @returns {Promise<{ email: string|null, source: 'real'|'cache'|'created'|'dry-run-placeholder'|'real-fallback'|'unavailable', error?: Error }>}
 */
async function resolveSubmissionEmail({ config, person, state, createImpl, fetchImpl, dryRun = false, warn }) {
  const relay = config && config.relay;
  const rawEmail = (person && person.email) || '';

  if (!relay || (!relay.provider && !relay.apiKey)) {
    return { email: rawEmail, source: 'real' };
  }

  const failOpen = relay.failOpen === true;
  const fail = (error) => {
    if (!failOpen) return { email: null, source: 'unavailable', error };
    (warn || console.warn)(
      `WARNING: masked-email relay unavailable (${error.message}). relay.failOpen is true, ` +
      'so your REAL email address is being sent to brokers for this person.'
    );
    return { email: rawEmail, source: 'real-fallback', error };
  };

  if (!RELAY_PROVIDERS.includes(relay.provider)) {
    return fail(new Error(`unsupported relay provider "${relay.provider}"`));
  }
  if (!relay.apiKey) {
    return fail(new Error('config.relay.apiKey is missing'));
  }

  const key = personKey(person);
  const store = state || {};

  const cached = store.relayAliases && store.relayAliases[key];
  if (cached) return { email: cached, source: 'cache' };

  if (dryRun) return { email: DRY_RUN_PLACEHOLDER, source: 'dry-run-placeholder' };

  const make = createImpl || defaultCreateImpl;
  let alias;
  try {
    alias = await make({
      provider: relay.provider,
      apiKey: relay.apiKey,
      note: `auto-identity-remove opt-out for ${(person && person.fullName) || key}`,
      fetchImpl,
    });
  } catch (err) {
    return fail(err instanceof Error ? err : new Error(String(err)));
  }

  if (!looksLikeAddress(alias)) {
    return fail(new Error('relay did not return a usable alias address'));
  }

  if (!store.relayAliases) store.relayAliases = {};
  store.relayAliases[key] = alias.trim();
  return { email: alias.trim(), source: 'created' };
}

/**
 * String-returning wrapper around resolveSubmissionEmail, kept for existing
 * callers. Returns the address to submit with, or throws RelayUnavailableError
 * when a relay is required but unavailable (the real email is never returned in
 * that case unless relay.failOpen === true).
 *
 * @param {object} args  see resolveSubmissionEmail
 * @returns {Promise<string>}
 */
async function getSubmissionEmail(args) {
  const out = await resolveSubmissionEmail(args);
  if (out.email === null) {
    const reason = out.error ? out.error.message : 'unknown error';
    throw new RelayUnavailableError(
      `Masked-email relay unavailable: ${reason}. Refusing to use your real email ` +
      '(set relay.failOpen to true to allow that).',
      out.error
    );
  }
  return out.email;
}

module.exports = {
  getSubmissionEmail,
  resolveSubmissionEmail,
  personKey,
  createSimpleLoginAlias,
  defaultCreateImpl,
  RelayUnavailableError,
  RELAY_PROVIDERS,
  SIMPLELOGIN_ALIAS_URL,
  DRY_RUN_PLACEHOLDER,
};
