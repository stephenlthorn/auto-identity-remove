# Full Code Review - auto-identity-remove (HEAD dd5d217, 2026-06-10)

Whole-codebase review by 5 parallel reviewers (core run loop, state/config/security, new-feature modules, browser/network, dashboard/CLI). Every finding was verified against the real code; the top findings were re-verified by hand before this document. Baseline at review time: **1151 root + 74 dashboard tests, all green, CI green.**

The codebase is mature and has survived several prior audits - security fundamentals are solid (no shell in spawns, path-traversal blocked, timing-safe auth, GCM config encryption, XSS-escaped dashboard, hermetic tests). The findings below are the genuinely-open items.

Legend: severity in [brackets]. "Auto-fix" = addressed in this remediation pass; "Defer" = documented follow-up (architectural or new feature).

---

## 1. Bugs (confirmed)

### High

| # | File:line | Issue | Fix |
|---|-----------|-------|-----|
| B1 | complaint.js:51 | `resolveRegime` reads `entry.regime`, which is **never written anywhere** - GDPR/EU-DPA complaint path is dead code; every complaint routes CCPA (45-day window applied even to EU users) | Derive regime from `person.country` via `right-to-know.pickRegime`; drop the `entry.regime` read | Auto-fix |
| B2 | complaint.js:72 + watcher.js:377 | `findOverdue` returns the raw state key; in multi-person mode that is the composite `"Broker|First Last"`, so `brokerMap.get(overdue.broker)` misses and the complaint loses `optOutUrl`/`emailTo` and prints a `|Name`-suffixed slug | Strip the composite key (as report.js already does) before map lookup; return `{broker, person}` | Auto-fix |
| B3 | captcha.js:550-551 | reCAPTCHA v3 detector matches any `api.js?render=` including `render=explicit` (standard v2 explicit-render). Such v2 pages route to `solveRecaptchaV3`, which excludes `explicit` and returns false, and the v2 solver is never tried | Exclude `render=explicit` in the v3 detector so v2 pages fall through | Auto-fix |
| B4 | captcha.js:371-401 | reCAPTCHA v3 `action` hardcoded to `'submit'`; v3 scores are action-scoped, so a site expecting a different action silently gets a low-score/rejected token reported as "solved" | Allow `broker.recaptchaV3Action` override; default `'submit'` | Auto-fix |
| B5 | server.js:439 | `/api/config/status` uses non-decrypting `readJsonMeta(CONFIG)` instead of `readConfigMeta()`; with an encrypted config the wizard re-triggers on every load and an enc-only install can never clear the gate | Use `readConfigMeta()` | Auto-fix |

### Medium

| # | File:line | Issue | Fix |
|---|-----------|-------|-----|
| B6 | right-to-know-runner.js:112,123 | `recordKnowRequest(broker.name)` uses the bare key; in multi-person runs all persons collapse onto one `knowRequestedAt` and it diverges from the composite keys `recordSuccess`/verify-loop write | Thread `stateKey(name, person, personCount)` | Auto-fix |
| B7 | config.js:305,332 | `detail`/`lastDetail` schema drift: `recordSuccess` writes `lastDetail`, `recordPendingConfirmation` writes `detail`; neither is ever read | Unify on `lastDetail`; drop dead field | Auto-fix |
| B8 | watcher.js:730 / audit.js:97 | Run-log + audit filenames are date-only (`slice(0,10)`); two same-day runs overwrite each other, so `loadPreviousLog`/`diffResults` can never diff intraday runs and evidence is destroyed | Include time in the filename (`slice(0,19)`, `:`→`-`) | Auto-fix |
| B9 | config.js:82-90, 216-222 | `readStateFileSafe` accepts any valid JSON (arrays/primitives) with no shape check; a hand-edited/truncated `state.json` that parses to `[]`/`42` makes `state.optOuts[...]` throw, defeating the "crash-safe load" intent | Validate `parsed && typeof==='object' && !Array.isArray && .optOuts` before accepting; else fall to `.bak`/empty | Auto-fix |
| B10 | config.js:161-165 | `encryptConfigToDisk`/`decryptConfigToDisk` use `writeJsonAtomic` (rename, no fsync), unlike the fsync'd `saveState`; a crash after rename can leave a zero-length `config.json.enc` and if plaintext was shredded the secrets are unrecoverable | Reuse the fsync'd write path | Auto-fix |
| B11 | config.js:54-57 | `saveCheckpoint` is a non-atomic `writeFileSync`; a kill mid-write yields an empty checkpoint and `--resume` silently restarts from the top | tmp + rename | Auto-fix |
| B12 | generic-runner.js:591-599 | `allowlisted` generic outcomes are counted in `attempted` but omitted from the returned `genericStats` breakdown, so the numbers do not sum | Add `allowlisted` to the returned stats | Auto-fix |
| B13 | broker-runner.js:99 vs generic-runner.js | Explicit brokers with a truly-dead domain (`ERR_NAME_NOT_RESOLVED`) are logged `error` and retried every run forever; the generic runner classifies the identical error as `dead` and short-circuits. Also broker-runner never inspects the goto response, so a 404/410/500 opt-out page is filled/submitted and can be logged `unverified`/`success` | Reuse `classifyNavError` + `isDeadStatus` in broker-runner; check `response.status()` after goto | Auto-fix |
| B14 | captcha.js:544-556 | hCAPTCHA rendered as `<div class="h-captcha" data-sitekey>` (iframe injected lazily) hits the `[data-sitekey]` catch-all and is solved as reCAPTCHA v2 - guaranteed CapSolver failure + wasted spend | Add `.h-captcha[data-sitekey]` to the hCAPTCHA detector before the reCAPTCHA catch-all | Auto-fix |
| B15 | imap-confirm.js:180-190 + serp-scan.js:186 | `registrableDomain()` uses a naive last-two-labels rule, so the SSRF host allowlist reduces `attacker.co.uk` and `broker.co.uk` both to `co.uk` and passes. No current broker uses a multi-part TLD (latent) | Require exact hostname or `.`-anchored suffix match against the broker host | Auto-fix |
| B16 | imap-confirm.js:203-211 | `matchBroker` does unbounded `includes()` on the From header, so `optout@spokeo.com.attacker.com` matches Spokeo | Parse the From address and compare the domain after `@` | Auto-fix |

### Low

| # | File:line | Issue | Fix |
|---|-----------|-------|-----|
| B17 | logger.js:100 | Drift banner says "failed 3+ consecutive times" but `drift.js` counts `pending_confirm` as non-success, so a broker legitimately awaiting email confirmation is flagged "failed" | Reword to "3+ consecutive non-success outcomes" (or exclude pending_confirm) | Auto-fix |
| B18 | server.js:554 | Dead condition `if (r.err || (r.err && r.err.code))` - right operand subsumed by left; inconsistent with the cleaner `preset` branch | Reduce to `if (r.err)` | Auto-fix |
| B19 | server.js:252-263 | `mergeConfig` recurses over `__proto__` (own key after JSON.parse); no global pollution occurs and it does not persist, but defense-in-depth | Skip `__proto__`/`constructor`/`prototype` keys | Auto-fix |
| B20 | relay.js:130-134 | When `state` is not supplied, alias is cached in a throwaway local, so a caller that forgets `state` mints a fresh (paid) SimpleLogin alias every run | Warn/log when `state` is absent | Auto-fix |
| B21 | config.js:290 vs defunct.js:21 | `HISTORY_MAX===DEFUNCT_THRESHOLD===5` coupling is unasserted; any future reduction silently breaks defunct detection | Assert `HISTORY_MAX >= DEFUNCT_THRESHOLD` | Auto-fix |
| B22 | watcher.js:893-943 | `--resume` matches the checkpoint against bare `broker.name`, but the checkpoint stores the composite `stateKey` in multi-person mode, so `--resume` silently re-runs everything | Match on `stateKey(b.name, person, count)` | Auto-fix |
| B23 | config.js:303-304 | `recordSuccess` calls `new Date().toISOString()` twice; `lastAttempt` can predate `lastSuccess` by a tick | Compute once | Auto-fix |
| B24 | generic-runner.js:568-571 | A `dead` outcome appends `'error'` (not `'dead'`) to history, so defunct/drift cannot tell "site gone" from "transient error" | Append the actual status | Auto-fix |
| B25 | captcha.js:264+ | Solvers report `true` immediately after token injection with no acceptance re-probe, so `captcha_failed` telemetry undercounts | Optional post-injection re-probe (Defer - low value) | Defer |

---

## 2. Performance

| # | File:line | Finding | Action |
|---|-----------|---------|--------|
| P1 | generic-runner.js loop | ~521 brokers processed strictly serially on one page with a fixed `waitForTimeout(1500)` + 400ms delay each = **35-70 min** for the generic loop alone; no concurrency | Defer (architectural): bounded concurrency pool + per-domain token-bucket rate limiting |
| P2 | generic-runner.js:345 | Blanket `waitForTimeout(1500)` after every nav regardless of settle | Auto-fix: bounded `waitForLoadState` / drop |
| P3 | captcha.js:41-50 | Poll always `sleep(intervalMs)` before the first check (wastes 3-5s/broker) and has no absolute wall-clock deadline | Auto-fix: poll once immediately; add deadline |
| P4 | forms.js:154 | `findListingUrl` uses `waitUntil:'networkidle'` (20s) - frequently waits the full timeout on tracker-heavy sites | Auto-fix: `domcontentloaded` + short settle |
| P5 | config.js saveState | Full JSON re-serialize + fsync + 2 renames on **every** broker outcome = O(N^2) serialization across a run | Defer (architectural): debounced/batched writes or SQLite/WAL backend |
| P6 | broker-runner.js:211 | `jitterSleep(5000,15000)` in finally after every explicit broker with no fast-path override | Auto-fix: honor a TURBO/env scale factor (as timing.js already supports) |

---

## 3. New feature ideas (documented; not part of "fix" pass)

- **Bounded concurrency + per-domain rate limiting** for the generic loop (biggest runtime win; pairs with P1).
- **Resumable generic run** - the 521-broker loop has no checkpoint (only explicit brokers do); persist a cursor.
- **Residential proxy support** - `config.proxy` -> `launchPersistentContext({proxy})` + CapSolver non-proxyless tasks; likely the biggest lever against DataDome/Akamai blocks that are currently detect-only.
- **playwright-extra + stealth plugin** (gated behind config) to cover the ~20 fingerprint vectors the hand-rolled stealth.js cannot.
- **Live IMAP polling** (imapflow) to auto-fetch confirmation mail instead of the local `.eml` dir, reusing the existing SSRF guard + broker-domain match.
- **DataDome / Cloudflare-interstitial / Turnstile-invisible** CapSolver task types to convert detect-only blocks to solvable.
- **Per-broker browser context isolation** (fresh fingerprint/UA per broker or person) - pairs with proxy rotation.
- **SQLite/WAL state backend** + schema versioning/migration (fixes P5 and the legacy dual-key handling).
- **HIBP paste + domain search**, richer exposure weighting (by broker reach + breach severity tier), and Oregon/Texas broker registries in feeds.
- **Dashboard**: run-history tab (from `logs/reports/`), session cookie after auth (kills the Basic re-prompt), login rate-limit, responsive/mobile layout.

---

## 4. What looks good (verified)

- Purity + dependency injection is excellent (hibp/relay/report/complaint/feeds/serp-watch all inject I/O; hermetically tested).
- `lib/secrets.js` crypto is correct (random per-encryption salt+nonce, GCM tag verified, single wrong-passphrase/tamper error, no oracle).
- `lib/lock.js` `wx` exclusive-create + pid-ownership release closes the TOCTOU window.
- Dashboard: auth fail-closed + timing-safe + scrypt, path-traversal double-guarded, XSS escaped everywhere, `spawn` argv (no shell) + flag-injection guard, encryption-aware config PUT, secret masking round-trips.
- `saveState` (state.json) is genuinely crash-safe (fsync + atomic rename + independent .bak).
- Regex patterns (success/confirm/locale, imap URL) are linear - no catastrophic backtracking (probed with 80k-char adversarial input).
- Per-broker error isolation + popup pruning + page recycling in the generic loop resolve the documented ~1200-process leak.

---

## Remediation plan

Four Opus fix agents, disjoint file ownership, TDD, merged sequentially with a full-suite gate:

1. **Multi-person keying + regime + state/config robustness + run-log filenames** - config.js, logger.js, generic-runner.js, right-to-know-runner.js, complaint.js, watcher.js (B1,B2,B6,B7,B8,B9,B10,B11,B12,B13,B17,B21,B22,B23,B24, P6).
2. **CAPTCHA routing** - captcha.js (B3,B4,B14, P3).
3. **Dashboard** - dashboard/server.js (B5,B18,B19).
4. **SSRF hardening + browser perf** - imap-confirm.js, serp-scan.js, forms.js (B15,B16, P2,P4).

Deferred (documented, not auto-fixed): P1, P5 (architectural), B25, and all of section 3.
