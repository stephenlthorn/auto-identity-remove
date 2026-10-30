/**
 * lib/imap-confirm.js
 *
 * Email-confirmation auto-click via .eml file processor.
 *
 * Walks a directory for *.eml files. For each one it:
 *   1. skips messages already processed (Message-ID / content-hash ledger)
 *   2. parses the MIME structure per part (multipart, QP, base64, charset)
 *   3. matches the From: domain to a broker's expectedSender
 *   4. refuses mail whose Authentication-Results says dkim=fail / spf=fail
 *   5. maps the message to a person (To:/Delivered-To: vs person.email or the
 *      person's cached relay alias) and derives the SAME stateKey the runner used
 *   6. requires that broker to be pending confirmation for that person
 *   7. picks a confirmation/verification/opt-out link on the broker's host
 *   8. (unless dryRun) opens it in a guarded Playwright page: every navigation
 *      and redirect must stay on the broker host and off private addresses, the
 *      response must be < 400, and the final URL is checked again
 *   9. only then calls recordSuccess(stateKey) and moves the file away
 *
 * No external dependencies - Node built-ins only.
 *
 * @param {object} context     Playwright browser context (or stub in tests)
 * @param {Array}  brokers     Broker definitions with optional `expectedSender`
 * @param {object} opts
 * @param {string}   opts.dir          Directory containing .eml files
 * @param {boolean}  opts.dryRun       When true, skip Playwright + recordSuccess
 * @param {Array}    opts.persons      Configured persons. Multi-person configs need
 *                                     it: the mail is mapped to one person and the
 *                                     composite "Broker|First Last" key is used.
 * @param {object}   opts.relayAliases state.relayAliases (personKey -> alias)
 * @param {string}   opts.processedFile  Ledger of processed messages. Default:
 *                                     confirm-processed.json beside state.json.
 * @param {function} opts._readDir     Injection hook for tests (replaces fs.readdirSync)
 * @param {function} opts._readFile    Injection hook for tests (replaces fs.readFileSync)
 * @param {function} opts._moveFile    Injection hook for tests (replaces file move)
 * @param {function} opts._recordSuccess  Injection hook for tests (replaces config.recordSuccess)
 * @param {function} opts._isPending   Injection hook for tests (replaces config.isPendingConfirmation)
 * @param {object}   opts._processedStore  Injection hook: { has(id), add(id) }
 * @param {function} opts._resolveHost Injection hook: async (host) => string[] of addresses
 * @param {function} opts.openContext  async () => { context, close }: a browser context for ONE click,
 *                                     closed after it (browser.js createThrowawayContexts). Without it the
 *                                     shared context is used with its cookies cleared around the click.
 *
 * @returns {{ processed: Array, unmatched: Array, failed: Array }}
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const net    = require('net');
const dns    = require('dns');
const crypto = require('crypto');
const { hostnameOf } = require('./serp-scan');
const { personKey } = require('./relay');
const urlGuard = require('./url-guard');
const { looksLikeSuccess, looksLikeFailure } = require('./success');
const { looksLikeConfirmationRequired } = require('./confirm');
const { redactIdentity } = require('./redact-identity');
const { langOf } = require('./locale-patterns');

// Matches confirmation-type URLs in an email body.
// Looks for http(s) URLs containing keywords that indicate an opt-out confirmation link.
const CONFIRM_URL_RE = /https?:\/\/[^\s<>"']*?(confirm|verify|optout|opt-out|removal|delete)[^\s<>"']*/i;

// Matches any http(s) URL for full extraction pass
const ANY_URL_RE = /https?:\/\/[^\s<>"']*/gi;

// Keywords that indicate a confirmation link. Only links that match one of
// these ever qualify: there is deliberately NO "first neutral link" fallback,
// because a promo mail from a broker's domain used to be clicked and recorded
// as a successful opt-out (NET-1).
const GOOD_KEYWORDS_RE = /confirm|verify|optout|opt-out|removal|delete/i;

// Strongest signal: an explicit confirm/verify link beats a generic opt-out
// landing page that merely mentions the word.
const STRONG_KEYWORDS_RE = /confirm|verify/i;

// Keywords that indicate a low-quality (footer / tracking) link to deprioritize
const BAD_KEYWORDS_RE = /unsubscribe|\/track|utm_|list-manage/i;

// Landing-page text that says the click did NOT confirm anything. Recording
// success here would clear the pending state and the form would never be
// resubmitted.
const REJECTED_PAGE_RE = /(link (has )?expired|has expired|expired link|no longer valid|invalid (link|token|code)|link is invalid|could ?n['o]?t be (verified|confirmed)|unable to (verify|confirm))/i;

// A page that is a wall rather than an answer: a login prompt, a bot check. The
// click did not reach the broker's confirmation, whatever else the page says.
const BLOCKED_PAGE_RE = /(sign|log) ?in to continue|please (sign|log) ?in|(sign|log) ?in (is )?required|verify (that )?you(?:'|’)?(?:re| are) (a )?human|are you a robot|checking your browser|enable javascript and cookies|access denied|just a moment|unusual traffic/i;

// What a confirmation landing page says when the click worked, beyond the generic
// post-submit wording in lib/success.js.
const CONFIRMED_PAGE_RE = /(?:^|\n)\s*(?:confirmed|verified|success)\W*(?:\n|$)|(you(?:'|’)?(?:re| are| have been)|your (email|e-mail|address|identity|request|opt-?out|listing|record|information|data)( address)?( has been| was| is)?) (now |successfully )?(confirmed|verified|unsubscribed|opted out|removed|deleted|suppressed)|thank you for (confirming|verifying)|(confirmation|verification) (is |was )?(complete|successful)|successfully (confirmed|verified|unsubscribed)|(opt-?out|removal|deletion) (is |was |has been )?(confirmed|complete|completed|successful)/i;

const MAX_MIME_DEPTH = 8;
const MAX_TEXT_PARTS = 32;
const LEDGER_MAX_ENTRIES = 5000;
const NAV_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/**
 * Decode quoted-printable text into raw bytes. Soft line breaks ("=" at end of
 * line, optionally followed by blanks) are removed first, then =XX runs become
 * bytes; literal text is passed through as UTF-8.
 *
 * @param {string} text
 * @returns {Buffer}
 */
function quotedPrintableToBuffer(text) {
  const joined = text.replace(/=[ \t]*\r?\n/g, '');
  const chunks = [];
  let last = 0;
  for (const m of joined.matchAll(/(?:=[0-9A-Fa-f]{2})+/g)) {
    if (m.index > last) chunks.push(Buffer.from(joined.slice(last, m.index), 'utf8'));
    chunks.push(Buffer.from(m[0].replace(/=/g, ''), 'hex'));
    last = m.index + m[0].length;
  }
  if (last < joined.length) chunks.push(Buffer.from(joined.slice(last), 'utf8'));
  return Buffer.concat(chunks);
}

/**
 * Decode a quoted-printable encoded string.
 * Removes soft line breaks (= at end of line followed by CRLF or LF).
 * Decodes =XX hex sequences as raw bytes then interprets the byte sequence
 * as UTF-8, so multi-byte characters (accented letters, CJK, emoji) survive.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeQuotedPrintable(text) {
  return quotedPrintableToBuffer(text).toString('utf8');
}

function bytesToText(buf, charset) {
  const cs = String(charset || 'utf-8').trim().toLowerCase();
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') return buf.toString('utf8');
  try {
    return new TextDecoder(cs).decode(buf);
  } catch (_) {
    return buf.toString('utf8');
  }
}

/**
 * Decode a MIME part body according to ITS OWN Content-Transfer-Encoding.
 * 7bit/8bit/binary text is already a decoded JS string and is returned as is.
 */
function decodePartBody(body, cte, charset) {
  const enc = String(cte || '7bit').trim().toLowerCase();
  if (enc === 'quoted-printable') return bytesToText(quotedPrintableToBuffer(body), charset);
  if (enc === 'base64') return bytesToText(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
  return body;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntitiesOnce(text) {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, dec, hex, name) => {
    if (dec !== undefined || hex !== undefined) {
      const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      try { return String.fromCodePoint(code); } catch (_) { return whole; }
    }
    const named = NAMED_ENTITIES[name.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/**
 * Decode HTML entities, repeating so a double-encoded "&amp;amp;" (seen in real
 * broker HTML mail) collapses to "&" instead of leaving "&amp;" in the URL.
 */
function decodeHtmlEntities(text) {
  let out = String(text);
  for (let i = 0; i < 4; i++) {
    const next = decodeEntitiesOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// MIME parsing
// ---------------------------------------------------------------------------

function splitHeadBody(text) {
  if (text.startsWith('\n')) return { head: '', body: text.slice(1) };
  const idx = text.indexOf('\n\n');
  if (idx === -1) return { head: text, body: '' };
  return { head: text.slice(0, idx), body: text.slice(idx + 2) };
}

/** Header block -> Map(lower-cased name -> [values]). Folded headers are unfolded. */
function parseHeaders(head) {
  const headers = new Map();
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const m = line.match(/^([!-9;-~]+):[ \t]*(.*)$/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (!headers.has(name)) headers.set(name, []);
    headers.get(name).push(m[2].trim());
  }
  return headers;
}

function firstHeader(headers, name) {
  const values = headers.get(name);
  return values && values.length ? values[0] : '';
}

function parseContentType(value) {
  const raw = String(value || '').trim();
  const typeMatch = raw.match(/^([\w.+-]+\/[\w.+-]+)/);
  const params = {};
  for (const m of raw.matchAll(/;\s*([\w*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g)) {
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return { type: typeMatch ? typeMatch[1].toLowerCase() : 'text/plain', params };
}

function splitMultipart(body, boundary) {
  const delim = '--' + boundary;
  const parts = [];
  let current = null;
  for (const line of body.split('\n')) {
    if (line.startsWith(delim)) {
      const rest = line.slice(delim.length).trim();
      if (rest === '') {
        if (current) parts.push(current.join('\n'));
        current = [];
        continue;
      }
      if (rest === '--') {
        if (current) parts.push(current.join('\n'));
        current = null;
        break;
      }
    }
    if (current) current.push(line);
  }
  if (current) parts.push(current.join('\n')); // truncated message: no closing boundary
  return parts;
}

/** Walk the MIME tree and collect decoded text/plain and text/html parts. */
function collectTextParts(headers, body, depth, out) {
  if (depth > MAX_MIME_DEPTH || out.length >= MAX_TEXT_PARTS) return out;
  const ct = parseContentType(firstHeader(headers, 'content-type'));

  if (ct.type.startsWith('multipart/')) {
    if (!ct.params.boundary) return out;
    for (const part of splitMultipart(body, ct.params.boundary)) {
      const { head, body: partBody } = splitHeadBody(part);
      collectTextParts(parseHeaders(head), partBody, depth + 1, out);
    }
    return out;
  }

  if (/^\s*attachment/i.test(firstHeader(headers, 'content-disposition'))) return out;

  if (ct.type === 'text/plain' || ct.type === 'text/html') {
    out.push({
      type: ct.type,
      text: decodePartBody(body, firstHeader(headers, 'content-transfer-encoding'), ct.params.charset),
    });
  }
  return out;
}

/**
 * Parse an RFC 5322 / MIME .eml file.
 *
 * @param {string} content
 * @returns {{
 *   from: string, body: string, headers: Map<string, string[]>, parts: Array<{type: string, text: string}>,
 *   to: string[], messageId: string, authResults: string[]
 * }}
 */
function parseEml(content) {
  const text = String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const { head, body } = splitHeadBody(text);
  const headers = parseHeaders(head);
  const parts = collectTextParts(headers, body, 0, []);

  return {
    from: firstHeader(headers, 'from'),
    body: parts.map(p => p.text).join('\n'),
    headers,
    parts,
    to: recipientAddresses(headers),
    messageId: firstHeader(headers, 'message-id'),
    authResults: headers.get('authentication-results') || [],
  };
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Lower-cased addresses in a header value. Quoted display names and comments
 * are removed first so `"alice@x.com" <bob@x.com>` yields only bob@x.com.
 */
function addressesIn(value) {
  const cleaned = String(value || '')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/\((?:[^()\\]|\\.)*\)/g, ' ');
  return Array.from(
    cleaned.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g),
    m => m[0].toLowerCase().replace(/\.+$/, '')
  );
}

const RECIPIENT_HEADERS = ['to', 'delivered-to', 'x-original-to', 'envelope-to', 'x-envelope-to'];

function recipientAddresses(headers) {
  const out = [];
  for (const name of RECIPIENT_HEADERS) {
    for (const value of headers.get(name) || []) out.push(...addressesIn(value));
  }
  return out;
}

/**
 * Persons whose email or cached relay alias appears among the recipients.
 */
function matchPersons(persons, addresses, relayAliases) {
  const wanted = new Set(addresses);
  return persons.filter((p) => {
    const email = String((p && p.email) || '').trim().toLowerCase();
    if (email && wanted.has(email)) return true;
    const alias = relayAliases && relayAliases[personKey(p)];
    return !!alias && wanted.has(String(alias).trim().toLowerCase());
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function stripTags(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

function urlsInText(text) {
  // Sentence punctuation right after a URL is not part of it.
  return Array.from(text.matchAll(ANY_URL_RE), m => m[0].replace(/[.,;:!?)\]}]+$/, ''));
}

function looksLikeHtml(text) {
  return /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(text);
}

/** Every http(s) URL in the parts, in document order, entity-decoded. */
function extractLinks(parts) {
  const links = [];
  for (const part of parts) {
    if (part.type === 'text/html') {
      for (const m of part.text.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
        links.push(decodeHtmlEntities(raw).replace(/[\t\n\r]/g, '').trim());
      }
      links.push(...urlsInText(decodeHtmlEntities(stripTags(part.text))));
    } else {
      links.push(...urlsInText(part.text));
    }
  }
  return [...new Set(links.filter(u => /^https?:\/\//i.test(u)))];
}

function linkRank(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return 0; }
  // Judge the path and query only: "optout.broker.com" in the HOST of a promo
  // link must not make it look like a confirmation link.
  const target = parsed.pathname + parsed.search;
  if (BAD_KEYWORDS_RE.test(url) || !GOOD_KEYWORDS_RE.test(target)) return 0;
  return STRONG_KEYWORDS_RE.test(target) ? 2 : 1;
}

/**
 * Confirmation-looking links from MIME parts, best first. Links that do not look
 * like confirm/verify/opt-out links never qualify.
 *
 * @param {Array<{type: string, text: string}>} parts
 * @returns {string[]}
 */
function extractConfirmCandidates(parts) {
  return extractLinks(parts)
    .map((url, index) => ({ url, index, rank: linkRank(url) }))
    .filter(c => c.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map(c => c.url);
}

/**
 * Extract the best confirmation URL from an email body string.
 * Prefers confirm/verify paths, then opt-out/removal/delete paths, and never
 * returns an unsubscribe/tracking link or an unrelated "neutral" link.
 *
 * @param {string} body  Email body (already transfer-decoded)
 * @returns {string|null}
 */
function extractConfirmUrl(body) {
  const text = String(body || '');
  const candidates = extractConfirmCandidates([{ type: looksLikeHtml(text) ? 'text/html' : 'text/plain', text }]);
  return candidates.length > 0 ? candidates[0] : null;
}

// ---------------------------------------------------------------------------
// Hosts and addresses
// ---------------------------------------------------------------------------

/**
 * True when a hostname is a loopback / private / link-local / metadata address
 * (IPv4 or IPv6 literal) or an internal-looking name (localhost, *.local,
 * *.internal, single-label names). Unparseable input counts as private. The address
 * table is lib/url-guard.js's, shared with the generic runner (BRK2-12).
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateHost(hostname) {
  let h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h) return true;
  if (net.isIP(h.split('%')[0])) return urlGuard.isBlockedAddress(h);
  return urlGuard.isInternalHostName(h);
}

async function defaultResolveHost(host) {
  const records = await dns.promises.lookup(host, { all: true });
  return records.map(r => r.address);
}

/**
 * Hostname -> true when it is, or resolves to, a private address. A lookup failure
 * counts as private (fail closed). `cache` (optional) memoises answers for requests
 * that do not need a fresh one; a navigation is never answered from it, because the
 * browser resolves the name itself and the answer can change between two hops
 * (DNS rebinding).
 */
async function hostIsPrivate(host, resolveHost, cache) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isPrivateHost(h)) return true;
  if (net.isIP(h)) return false;
  if (cache && cache.has(h)) return cache.get(h);
  let blocked;
  try {
    const addresses = await resolveHost(h);
    blocked = !addresses || addresses.length === 0 || addresses.some(a => isPrivateHost(a));
  } catch (_) {
    blocked = true;
  }
  if (cache) cache.set(h, blocked);
  return blocked;
}

/**
 * Extract the canonical broker host from a broker definition.
 * Tries optOutUrl, then searchUrl, then the expectedSender domain. The www.
 * prefix is stripped so it never widens the allowed suffix.
 *
 * This intentionally returns the FULL host (e.g. 'broker.co.uk'), NOT a naive
 * two-label registrable domain, so that lookalikes on multi-part TLDs such as
 * attacker.co.uk vs broker.co.uk are not collapsed to a shared 'co.uk'.
 *
 * @param {object} broker
 * @returns {string}  broker host (e.g. 'spokeo.com') or ''
 */
function brokerHost(broker) {
  const urlSource = broker.optOutUrl || broker.searchUrl || '';
  if (urlSource) {
    const host = hostnameOf(urlSource);
    if (host) return host.replace(/^www\./, '').toLowerCase();
  }
  // Fall back to extracting the domain from expectedSender (e.g. 'optout@spokeo.com' -> 'spokeo.com')
  if (broker.expectedSender) {
    return senderDomainOf(broker.expectedSender).replace(/^www\./, '');
  }
  return '';
}

/**
 * Validate a candidate confirmation URL against a matched broker.
 *
 * Checks:
 *   1. URL must use http or https scheme (rejects javascript:, file:, data:, etc.)
 *   2. No embedded credentials, and never a loopback/private/metadata host
 *   3. The URL's host must be the broker's host or a dot-anchored subdomain of it.
 *
 * @param {string} url
 * @param {object} broker
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateConfirmUrl(url, broker) {
  // Check 1: must be http or https
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { valid: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: `non_http_scheme:${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'credentials_in_url' };
  }
  // Even when the broker's own definition points at a private address (a bad
  // registry entry), the browser must never be sent there.
  if (isPrivateHost(parsed.hostname)) {
    return { valid: false, reason: 'private_host', urlDomain: parsed.hostname.toLowerCase() };
  }

  // Check 3: host must be the broker host exactly, or a dot-anchored subdomain
  // of it. We compare full hosts (not naive two-label registrable domains) so a
  // lookalike sharing a multi-part TLD (attacker.co.uk vs broker.co.uk) is
  // rejected rather than collapsed to a shared 'co.uk'.
  const urlHost   = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const baseHost  = brokerHost(broker);

  if (!baseHost) {
    // No broker host to compare against - allow (cannot validate)
    return { valid: true };
  }

  if (!hostMatchesBase(urlHost, baseHost)) {
    return { valid: false, reason: 'host_mismatch', urlDomain: urlHost, brokerDomain: baseHost };
  }

  return { valid: true };
}

/**
 * Extract the lower-cased domain (the part after the final '@') from an email
 * address or address-domain string. Strips RFC 5322 display-name wrappers such
 * as `Name <addr@host>` and trailing '>' characters.
 *
 * @param {string} address  e.g. 'Name <optout@spokeo.com>' or 'optout@spokeo.com'
 * @returns {string}  lower-cased domain (e.g. 'spokeo.com') or ''
 */
function senderDomainOf(address) {
  if (!address) return '';
  // Prefer an angle-bracketed address (RFC 5322 name-addr form) when present.
  const angle = address.match(/<([^>]*)>/);
  const addr = (angle ? angle[1] : address).trim();
  const atIdx = addr.lastIndexOf('@');
  if (atIdx === -1) return '';
  return addr
    .slice(atIdx + 1)
    .replace(/[>\s].*$/, '')
    .toLowerCase();
}

/**
 * True when `host` is exactly `base` or a dot-anchored subdomain of `base`.
 * Rejects lookalikes that merely share a suffix without a label boundary
 * (e.g. 'attacker-spokeo.com' does NOT match 'spokeo.com', and
 * 'spokeo.com.attacker.com' does NOT match 'spokeo.com').
 *
 * @param {string} host
 * @param {string} base
 * @returns {boolean}
 */
function hostMatchesBase(host, base) {
  if (!host || !base) return false;
  const h = host.toLowerCase();
  const b = base.toLowerCase();
  return h === b || h.endsWith('.' + b);
}

/**
 * Find a broker whose expectedSender domain matches the From header's sender
 * domain. Matching is anchored on the domain (exact host or a dot-anchored
 * subdomain of the broker domain) rather than a raw substring, so a spoofed
 * sender such as `optout@spokeo.com.attacker.com` is NOT matched to Spokeo.
 *
 * @param {string} fromHeader
 * @param {Array}  brokers
 * @returns {object|null}
 */
function matchBroker(fromHeader, brokers) {
  const fromDomain = senderDomainOf(fromHeader);
  if (!fromDomain) return null;
  for (const broker of brokers) {
    if (!broker.expectedSender) continue;
    const brokerDomain = senderDomainOf(broker.expectedSender);
    if (brokerDomain && hostMatchesBase(fromDomain, brokerDomain)) {
      return broker;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Authentication-Results
// ---------------------------------------------------------------------------

function domainOfAuthValue(value) {
  const v = String(value || '').replace(/[<>;"']/g, '').toLowerCase();
  const at = v.lastIndexOf('@');
  return at === -1 ? v : v.slice(at + 1);
}

/**
 * When an Authentication-Results header reports dkim=fail or spf=fail for the
 * broker's domain (or the From domain), return a short reason, else null. A
 * missing header is NOT a failure: local .eml exports often strip it.
 *
 * @param {string[]} authResults  Authentication-Results header values
 * @param {string[]} domains      domains the failure must relate to
 * @returns {string|null}
 */
function authFailureFor(authResults, domains) {
  const relevant = domains.filter(Boolean);
  for (const value of authResults || []) {
    for (const clause of String(value).split(';')) {
      const method = clause.match(/^\s*(dkim|spf)\s*=\s*fail\b/i);
      if (!method) continue;
      const props = Array.from(
        clause.matchAll(/\b(?:header\.(?:d|i|from)|smtp\.(?:mailfrom|helo))\s*=\s*([^\s;]+)/gi),
        m => domainOfAuthValue(m[1])
      );
      const related = props.length === 0
        || props.some(d => relevant.some(r => hostMatchesBase(d, r) || hostMatchesBase(r, d)));
      if (related) return `${method[1].toLowerCase()}=fail`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Processed-message ledger
// ---------------------------------------------------------------------------

/**
 * File-backed set of processed message ids. Tolerates a missing/corrupt file
 * and an unwritable location (the ids are still remembered for the rest of the
 * run), so a read-only mount degrades to "once per run" instead of throwing.
 *
 * @param {string} file
 * @returns {{ has: (id: string) => boolean, add: (id: string) => void }}
 */
function createProcessedStore(file) {
  const ids = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.ids && typeof parsed.ids === 'object') {
      for (const [id, at] of Object.entries(parsed.ids)) ids.set(id, at);
    }
  } catch (_) {
    // missing or corrupt: start empty
  }

  function persist() {
    const entries = [...ids.entries()].slice(-LEDGER_MAX_ENTRIES);
    const data = JSON.stringify({ version: 1, ids: Object.fromEntries(entries) }, null, 2);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch (_) {}
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      console.warn(`confirm-emails: could not write processed ledger ${file}: ${err.message}`);
    }
  }

  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.set(id, new Date().toISOString());
      persist();
    },
  };
}

// Beside the state file, wherever AIDR_HOME / AIDR_STATE_PATH put it: the ledger
// is what stops a confirmation link being clicked twice, so it must survive
// exactly as long as the state does (and in Docker, in the same mount).
function defaultProcessedFile() {
  const { STATE_PATH } = require('./config');
  return path.join(path.dirname(STATE_PATH), 'confirm-processed.json');
}

/** Ids a message is known by: its content hash, and its Message-ID when present. */
function messageIds(content, messageId) {
  const ids = [`sha256:${crypto.createHash('sha256').update(String(content)).digest('hex')}`];
  const mid = String(messageId || '').trim().toLowerCase();
  if (mid) ids.push(`mid:${mid}`);
  return ids;
}

/**
 * Move a processed .eml file to dir/processed/.
 * Returns false (never throws) when the move fails, e.g. on a read-only mount;
 * the processed ledger is what stops such a message being clicked again.
 */
function moveToProcessed(filePath, dir) {
  try {
    const processedDir = path.join(dir, 'processed');
    fs.mkdirSync(processedDir, { recursive: true });
    const dest = path.join(processedDir, path.basename(filePath));
    fs.renameSync(filePath, dest);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Guarded navigation
// ---------------------------------------------------------------------------

/**
 * Route handler that keeps a confirm click inside the broker's own site.
 *
 * Navigation requests (initial load, every redirect hop, later JS/meta
 * redirects) must be http(s), on the broker's host, and not resolve to a
 * private address. Other requests (scripts, images, XHR) may go to third-party
 * hosts - pages need their CDNs - but never to a private/loopback/metadata
 * address. Anything blocked is recorded in `blocked` so the caller can refuse to
 * record success even if the page itself still rendered.
 */
function makeNavigationGuard({ broker, resolveHost }) {
  const resolve = resolveHost || defaultResolveHost;
  const blocked = [];
  const cache = new Map();

  async function verdict(request) {
    const url = request.url();
    let parsed;
    try { parsed = new URL(url); } catch (_) { return 'invalid_url'; }
    const navigation = typeof request.isNavigationRequest === 'function' && request.isNavigationRequest();

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      const inline = parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:';
      return !navigation && inline ? null : `non_http_scheme:${parsed.protocol}`;
    }
    if (navigation) {
      const check = validateConfirmUrl(url, broker);
      if (!check.valid) return check.reason;
    }
    if (await hostIsPrivate(parsed.hostname, resolve, navigation ? null : cache)) return 'private_address';
    return null;
  }

  async function handler(route) {
    const request = route.request();
    let reason;
    try {
      reason = await verdict(request);
    } catch (_) {
      reason = 'guard_error';
    }
    if (reason) {
      blocked.push({ url: request.url(), reason });
      return route.abort('blockedbyclient');
    }
    return route.continue();
  }

  return { handler, blocked };
}

/** Register the guard on the context (covers popups) or, failing that, the page. */
async function installGuard(context, page, handler) {
  const pattern = '**/*';
  if (typeof context.route === 'function') {
    await context.route(pattern, handler);
    return async () => {
      if (typeof context.unroute === 'function') await context.unroute(pattern, handler).catch(() => {});
    };
  }
  if (typeof page.route === 'function') {
    await page.route(pattern, handler);
  }
  return async () => {};
}

/**
 * Open `url` in a guarded page and decide whether the click counts as a
 * confirmation. Never records state itself.
 *
 * The page must SAY it worked: confirmation wording (lib/success.js plus the
 * confirmation-page phrasing above). Failure wording, a login or bot wall, and a
 * page that says nothing either way are not confirmations: the last is
 * 'unverified' (the link was opened, the request stays pending) (BRK2-2, codex #4).
 *
 * The click happens in a context of its own when `openContext` is given (one
 * throwaway browser per click), otherwise on the shared context with its cookies
 * cleared before and after, so one click never carries what an earlier one (or
 * another person's) left behind (BRK2-11).
 *
 * @returns {Promise<{ ok: true, finalText: string } | { ok: false, reason: string, error: string, clicked?: boolean }>}
 */
async function clickConfirmLink({ context: sharedContext, broker, url, resolveHost, openContext }) {
  const guard = makeNavigationGuard({ broker, resolveHost });
  let context = sharedContext;
  let closeContext = async () => {};
  let page;
  let release = async () => {};
  const refuse = (reason, error, extra) => ({ ok: false, reason, error, ...extra });
  const blockedSummary = () => guard.blocked.map(b => `${b.reason}: ${redactedUrl(b.url)}`).join('; ');

  try {
    if (typeof openContext === 'function') {
      const opened = await openContext();
      context = opened.context;
      closeContext = opened.close || (async () => {});
    } else if (context && typeof context.clearCookies === 'function') {
      await context.clearCookies().catch(() => {});
    }

    page = await context.newPage();
    release = await installGuard(context, page, guard.handler);
    // The address the browser really connected to is compared as well: it resolves
    // names itself, so the guard's own lookup can disagree with it.
    const addresses = urlGuard.watchServerAddresses(page, (entry) => guard.blocked.push({ url: entry.url, reason: entry.reason }));

    let response;
    try {
      response = await page.goto(url, { timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      await addresses.settle();
      if (guard.blocked.length > 0) return refuse('blocked_navigation', `navigation blocked (${blockedSummary()})`);
      throw err;
    }

    if (typeof page.waitForLoadState === 'function') {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    await addresses.settle();
    if (guard.blocked.length > 0) return refuse('blocked_navigation', `navigation blocked (${blockedSummary()})`);

    const status = response && typeof response.status === 'function' ? response.status() : null;
    if (status === null || status === undefined) return refuse('no_response', 'navigation returned no HTTP response');
    if (status >= 400) return refuse(`http_${status}`, `HTTP ${status} on confirmation link`);

    const finalUrl = typeof page.url === 'function' ? page.url() : '';
    const finalCheck = validateConfirmUrl(finalUrl, broker);
    if (!finalCheck.valid) {
      return refuse('redirected_off_host', `final URL not acceptable (${finalCheck.reason}): ${redactedUrl(finalUrl)}`);
    }

    let finalText = '';
    try { finalText = (await page.textContent('body')) || ''; } catch (_) {}
    const clicked = { clicked: true };
    if (REJECTED_PAGE_RE.test(finalText)) {
      return refuse('link_expired', `confirmation page says the link was rejected: ${finalText.slice(0, 120).replace(/\s+/g, ' ')}`, clicked);
    }
    const lang = langOf(await Promise.resolve()
      .then(() => page.evaluate(() => (document.documentElement && document.documentElement.getAttribute('lang')) || ''))
      .catch(() => ''));
    if (BLOCKED_PAGE_RE.test(finalText)) {
      return refuse('blocked_page', 'the confirmation link led to a login or bot-check page, not a confirmation', clicked);
    }
    if (looksLikeFailure(finalText, lang)) {
      return refuse('confirmation_failed', 'the confirmation page reports an error', clicked);
    }
    const confirmed = looksLikeSuccess(finalText, lang) || CONFIRMED_PAGE_RE.test(finalText);
    if (!confirmed) {
      // Opened fine, said nothing either way. Not a success (no 90-day cooldown on a
      // guess) and not a retry either: the link has been clicked.
      return refuse('unverified', 'the confirmation page showed no sign that the opt-out was confirmed', clicked);
    }

    return { ok: true, finalText };
  } finally {
    await release();
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    if (typeof openContext !== 'function' && context && typeof context.clearCookies === 'function') {
      await context.clearCookies().catch(() => {});
    }
    await Promise.resolve(closeContext()).catch(() => {});
  }
}

/** The URL without query string or fragment: safe to store (tokens are secrets). */
function redactedUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return String(url).split(/[?#]/)[0];
  }
}

/** Free text with every URL in it reduced to host and path (an error message can quote the link). */
function scrubUrls(text) {
  return String(text == null ? '' : text).replace(/https?:\/\/[^\s'")<>]+/gi, (m) => redactedUrl(m));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Process confirmation emails in a directory.
 *
 * @param {object} context   Playwright browser context
 * @param {Array}  brokers   Array of broker definition objects
 * @param {object} opts
 * @returns {Promise<{ processed: Array, unmatched: Array, failed: Array }>}
 */
async function processConfirmationEmails(context, brokers, opts = {}) {
  const {
    dir = './inbox/confirms',
    dryRun = false,
    persons,
    relayAliases,
    processedFile,
    _readDir,
    _readFile,
    _moveFile,
    _recordSuccess,
    _isPending,
    _processedStore,
    _resolveHost,
    openContext,
  } = opts;

  const readDir  = _readDir  || (() => fs.readdirSync(dir));
  const readFile = _readFile || ((f) => fs.readFileSync(f, 'utf8'));
  const moveFile = _moveFile || ((f) => moveToProcessed(f, dir));

  // Load config helpers lazily unless injected (injection used by tests)
  const configMod       = require('./config');
  const doRecordSuccess = _recordSuccess || configMod.recordSuccess;
  const isPending       = _isPending     || configMod.isPendingConfirmation;
  const { stateKey }    = configMod;

  const processed = [];
  const unmatched = [];
  const failed = [];

  let fileNames;
  try {
    fileNames = readDir();
  } catch (err) {
    // If dir doesn't exist, return empty result gracefully
    return { processed, unmatched, failed };
  }

  const emlFiles = fileNames.filter(f => f.toLowerCase().endsWith('.eml'));
  if (emlFiles.length === 0) return { processed, unmatched, failed };

  const ledger = _processedStore || createProcessedStore(processedFile || defaultProcessedFile());
  const personList = Array.isArray(persons) ? persons : [];

  for (const fileName of emlFiles) {
    const filePath = path.join(dir, fileName);

    let content;
    try {
      content = readFile(filePath);
    } catch (err) {
      unmatched.push({ file: filePath, reason: 'read_error', error: err.message });
      continue;
    }

    const message = parseEml(content);
    const ids = messageIds(content, message.messageId);

    if (ids.some(id => ledger.has(id))) {
      unmatched.push({ file: filePath, reason: 'already_processed' });
      continue;
    }

    // Find a matching broker by expectedSender
    const broker = matchBroker(message.from, brokers);
    if (!broker) {
      unmatched.push({ file: filePath, reason: 'no_broker', from: message.from });
      continue;
    }

    // Spoofable offline, so only a header that actively reports a failure for
    // the broker's domain refuses the mail; an absent header is fine.
    const authFailure = authFailureFor(message.authResults, [brokerHost(broker), senderDomainOf(message.from)]);
    if (authFailure) {
      unmatched.push({ file: filePath, reason: 'auth_failed', broker: broker.name, detail: authFailure });
      continue;
    }

    // Whose confirmation is this? One person: no ambiguity. Several: the
    // recipient headers must single one out, otherwise leave everything pending.
    let person = null;
    if (personList.length > 1) {
      const matches = matchPersons(personList, message.to, relayAliases);
      if (matches.length === 0) {
        unmatched.push({ file: filePath, reason: 'no_person', broker: broker.name, to: message.to });
        continue;
      }
      if (matches.length > 1) {
        unmatched.push({ file: filePath, reason: 'ambiguous_person', broker: broker.name, to: message.to });
        continue;
      }
      person = matches[0];
    } else if (personList.length === 1) {
      person = personList[0];
    }
    const key = stateKey(broker.name, person, personList.length);

    // Only a submission that is actually waiting on this confirmation may be
    // confirmed; otherwise any mail from the broker's domain would be recorded
    // as a successful opt-out.
    if (!isPending(key)) {
      unmatched.push({ file: filePath, reason: 'not_pending', broker: broker.name, key });
      continue;
    }

    // Pick the best confirmation link that is on the broker's host.
    const candidates = extractConfirmCandidates(message.parts);
    if (candidates.length === 0) {
      unmatched.push({ file: filePath, reason: 'no_url', broker: broker.name });
      continue;
    }

    let url = null;
    let firstRejection = null;
    for (const candidate of candidates) {
      const validation = validateConfirmUrl(candidate, broker);
      if (validation.valid) { url = candidate; break; }
      if (!firstRejection) firstRejection = { candidate, validation };
    }
    if (!url) {
      unmatched.push({
        file: filePath,
        reason: firstRejection.validation.reason,
        url: redactedUrl(firstRejection.candidate),
        broker: broker.name,
        brokerDomain: firstRejection.validation.brokerDomain,
        urlDomain: firstRejection.validation.urlDomain,
      });
      continue;
    }

    // Results and logs carry the link without its query string and fragment: the
    // token in it is a bearer credential. `url` itself is only ever navigated to.
    const shownUrl = redactedUrl(url);

    if (dryRun) {
      processed.push({ broker, url: shownUrl, file: filePath, person, key });
      continue;
    }

    let outcome;
    try {
      outcome = await clickConfirmLink({ context, broker, url, resolveHost: _resolveHost, openContext });
    } catch (err) {
      failed.push({ broker, url: shownUrl, file: filePath, error: scrubUrls(err.message), reason: 'navigation_error' });
      continue;
    }
    if (!outcome.ok) {
      failed.push({ broker, url: shownUrl, file: filePath, error: scrubUrls(outcome.error), reason: outcome.reason });
      // The link WAS opened and the page said nothing either way: the request stays
      // pending (no success recorded), but the mail is spent so the next run does not
      // click the same token again.
      if (outcome.reason === 'unverified') {
        for (const id of ids) ledger.add(id);
        try { moveFile(filePath); } catch (_) { /* the ledger already stops a second click */ }
      }
      continue;
    }

    try {
      // Transition state: mark this person's broker entry as confirmed. The
      // detail drops the query string: confirmation tokens are secrets.
      doRecordSuccess(key, `email-confirm:${shownUrl}`);
    } catch (err) {
      failed.push({ broker, url: shownUrl, file: filePath, error: scrubUrls(err.message), reason: 'record_error' });
      continue;
    }

    for (const id of ids) ledger.add(id);

    // Move processed file out of the inbox (best effort; the ledger already
    // guarantees it is never processed twice).
    let moved = false;
    try { moved = moveFile(filePath) !== false; } catch (_) { moved = false; }

    // The page may echo what was submitted: the person's own details are not kept.
    const alias = person && relayAliases ? relayAliases[personKey(person)] : undefined;
    const finalText = redactIdentity(outcome.finalText.slice(0, 200), person, [alias]);
    processed.push({ broker, url: shownUrl, file: filePath, person, key, finalText, moved });
  }

  return { processed, unmatched, failed };
}

module.exports = {
  processConfirmationEmails,
  CONFIRM_URL_RE,
  decodeQuotedPrintable,
  decodeHtmlEntities,
  extractConfirmUrl,
  extractConfirmCandidates,
  validateConfirmUrl,
  parseEml,
  addressesIn,
  isPrivateHost,
  authFailureFor,
  createProcessedStore,
  defaultProcessedFile,
  makeNavigationGuard,
  redactedUrl,
};
