# Roadmap: HN + GitHub Feedback Fixes

**Date:** 2026-05-18
**Status:** Ready for implementation
**Audience:** Sonnet subagents — each Work Package (WP) is self-contained and can be implemented by an agent with no prior context.

---

## Context

`auto-identity-remove` is a Node.js + Playwright tool that automates data-broker opt-outs.
After a Show HN post (https://news.ycombinator.com/item?id=48178184) and reaching 500+
GitHub stars, the community surfaced feedback. Three quick wins are **already shipped**:

- ✅ `setup.js` creates `~/Library/LaunchAgents/` before writing the plist (closed GH #2)
- ✅ `--dry-run` flag (fills forms, skips submit + state save)
- ✅ README: "Is it safe?" FAQ + California DELETE Registry note

This roadmap covers **every remaining item**.

### Current architecture

| File | Lines | Role |
|------|-------|------|
| `watcher.js` | ~470 | Monolith: config/state, playwright, logging, captcha, forms, processBroker, email opt-out, summary, main |
| `brokers.js` | ~350 | ~31 explicit broker definitions |
| `generic-runner.js` | ~320 | Heuristic handler for ~500 generic brokers |
| `setup.js` | ~225 | Interactive setup + launchd scheduling |
| `data/*.json` | — | Markup (494) + BADBOOL (27) datasets |

No test suite exists. `package.json` has `"os": ["darwin"]` (blocks non-mac `npm install`).

### Outstanding feedback → Work Package map

| Source | Complaint | WP |
|--------|-----------|----|
| GH #1, HN (ramon156, LatencyKills, nixass, pards) | macOS-only; need Linux/Windows | WP1, WP2 |
| HN (pards, nixass) | Assumes Apple Mail; iMessage hard-coded | WP2 |
| HN (pards) | Many 404s on stale broker URLs | WP3 |
| HN (author, lolpython) | Forms submit but email confirmation never clicked | WP4 |
| HN (lolpython) | No proof generic submissions actually work | WP5 |
| HN (pards) | Fails on Canadian postal codes / non-US addresses | WP6 |
| HN (lolpython — "vibe coded?") | No transparency on what's tested vs heuristic | WP7 |

---

## Phase 0 — Modularization (REQUIRED FIRST, single agent, no parallelism)

**Why:** `watcher.js` is ~470 lines and every WP below needs to touch it. Without
extraction the WPs cannot run in parallel — they would constantly collide. This
phase also satisfies the repo's "files under 500 lines / many small files" rule.

**Agent:** 1 subagent, runs alone, blocks all of Phase 1.

**Task:** Extract `watcher.js` internals into `lib/` with zero behavior change.

Create:

- `lib/config.js` — exports `loadConfig()`, `loadState()`, `saveState()`,
  `lastOptOutDaysAgo()`, `recordSuccess()`, `RECHECK_DAYS`
- `lib/logger.js` — exports `results`, `logResult()`, the bucket map, `ICONS`
- `lib/notify.js` — exports `sendText()`, `macNotify()`, `openInBrowser()`
  (keep current macOS impl as-is here; WP2 will generalize this module)
- `lib/captcha.js` — exports `solveRecaptcha()`, `detectAndSolveCaptcha()`
- `lib/forms.js` — exports `fillForm()`, `findListingUrl()`
- `lib/broker-runner.js` — exports `processBroker()`
- `lib/platform.js` — **new**, exports `getPlatform()` → `'macos'|'linux'|'windows'`
  via `process.platform` mapping. (Empty utility WP1/WP2 build on.)
- `watcher.js` becomes a thin orchestrator (`main()` + arg parsing) under 120 lines.

**Acceptance criteria:**
- `node watcher.js --dry-run` produces identical output to before (diff the console log on 5 brokers)
- No file in `lib/` exceeds 300 lines
- `require()` graph has no cycles
- `generic-runner.js` updated to import the shared `logger`/`config` instead of receiving them as callbacks **only if trivial** — otherwise leave its callback signature and document it

**Tests:** add `node --test` (built-in test runner — no new deps). Write
`test/config.test.js` and `test/logger.test.js` covering pure logic
(`lastOptOutDaysAgo`, bucket routing). Add `"test": "node --test"` to package.json.

---

## Phase 1 — Parallel Work Packages

After Phase 0 merges, WP1–WP7 touch mostly disjoint files and can run as
**concurrent subagents**. Conflict notes are called out per WP.

---

### WP1 — Cross-platform scheduling

**Closes:** GH #1, HN (ramon156, LatencyKills)

**Problem:** Scheduling is launchd-only. Linux/Windows users can't auto-schedule.

**Files:** `setup.js`, new `lib/scheduler.js`, `package.json`, `README.md`

**Approach:**
1. New `lib/scheduler.js` with `installSchedule({ scriptPath, logDir })` that
   branches on `getPlatform()`:
   - **macOS:** existing launchd plist logic (move it here verbatim).
   - **Linux:** prefer a systemd **user** timer
     (`~/.config/systemd/user/auto-identity-remove.{service,timer}` +
     `systemctl --user enable --now`). If `systemctl` absent, fall back to
     appending a `crontab -l` line (`0 9 1 * *`). Detect via
     `which systemctl`.
   - **Windows:** generate a `schtasks /Create /SC MONTHLY /D 1 /TN ...`
     command. If it fails, print the exact manual command and continue
     (don't crash setup).
2. `setup.js` calls `installSchedule(...)` instead of inline plist code.
3. `package.json`: remove `"os": ["darwin"]` so `npm install` works everywhere.
4. README: replace the macOS-only uninstall block with a per-platform table
   (launchd / systemd / crontab / schtasks teardown commands).

**Acceptance criteria:**
- On macOS: behaves exactly as today (plist created + loaded)
- On Linux: systemd timer OR crontab entry created; `setup.js` reports which
- On Windows: prints working `schtasks` command; never throws
- `npm install` succeeds on Linux (CI: `node -e "require('./lib/scheduler')"` on ubuntu)

**Tests:** `test/scheduler.test.js` — mock `child_process.execSync` and
`os.platform`; assert correct command string per platform. No real scheduler installs.

**Conflict note:** Touches `setup.js` (also WP6). WP1 owns the *scheduling*
section; WP6 owns the *prompts* section. Coordinate by editing different
functions — WP1 should wrap scheduling in `installSchedule()` so WP6's prompt
edits stay above it.

---

### WP2 — Cross-platform notifications + email opt-out

**Closes:** HN (pards, nixass) — "assumes Apple Mail / iMessage"

**Problem:** `sendText()` (iMessage via AppleScript), `macNotify()` (osascript),
and `sendEmailOptOuts()` (Mail.app via AppleScript) are hard macOS dependencies
and fail silently elsewhere. The email opt-out brokers (e.g. Pipl) are simply
skipped on non-mac with no user-visible fallback.

**Files:** `lib/notify.js`, new `lib/email.js`, `watcher.js` (call sites only),
`config.example.json`, `setup.js` (notify prompts), `README.md`

**Approach:**
1. Generalize `lib/notify.js`:
   - `notify(summaryText)` dispatches by platform + config:
     - macOS → existing iMessage + osascript (unchanged default)
     - Linux → `notify-send` if present (desktop toast)
     - all platforms → if `config.notify.webhook` set, POST the summary
       (works with ntfy.sh / Slack / Discord) — most portable option
     - always → print summary to console (already happens)
   - Never throw; each channel is best-effort.
2. New `lib/email.js` — `sendOptOutEmails(brokers, config)`:
   - macOS + no SMTP config → existing Mail.app path
   - if `config.email.smtp` configured → send via `nodemailer`
     (**add dep**; gate behind config so it's optional)
   - else → push each email broker onto the manual list with the address +
     a copy-pasteable opt-out request body, so the user can send it themselves
3. `config.example.json`: add commented `notify.webhook` and `email.smtp` blocks.
4. `setup.js`: in the notification section, additionally offer "webhook URL
   (optional, works on any OS)".
5. README: document the webhook option as the recommended cross-platform notifier.

**Acceptance criteria:**
- macOS default behavior unchanged when no webhook/SMTP configured
- With `notify.webhook` set, summary POSTs successfully (test against a mock server)
- On Linux with no config, run completes, prints summary, email brokers appear
  in the manual list with addresses — no silent skip, no crash
- `nodemailer` only loaded when SMTP configured (lazy `require`)

**Tests:** `test/notify.test.js` (mock fetch + platform), `test/email.test.js`
(mock nodemailer + Mail.app branch). 80% line coverage on both modules.

**Conflict note:** Owns `lib/notify.js` and email logic. Phase 0 created
`lib/notify.js` with the macOS impl — WP2 expands it. No overlap with WP1's
`lib/scheduler.js`.

---

### WP3 — Dead / stale URL handling

**Closes:** HN (pards) — "got tons of 404s"

**Problem:** Stale Markup URLs return 4xx/5xx. They currently log as `error`,
polluting the summary and obscuring real failures. No mechanism prunes them.

**Files:** `generic-runner.js`, `lib/logger.js`, new `scripts/prune-dead.js`,
new `data/dead-urls.json`, `README.md`

**Approach:**
1. `generic-runner.js` `processGenericUrl()`: capture the `page.goto()` response.
   If `status() >= 400` or navigation throws `net::ERR_NAME_NOT_RESOLVED` /
   `ERR_CONNECTION_REFUSED` → return `{ status: 'dead', detail: <code> }`.
2. `lib/logger.js`: add a `dead` bucket + `💀` icon; surface count in summary
   separately from `errors`.
3. `data/dead-urls.json`: array of hostnames confirmed dead. `generic-runner.js`
   skips any host in this list immediately (fast-path, logged as `dead (cached)`).
4. `scripts/prune-dead.js`: reads the last N run logs in `logs/`, finds hosts
   that were `dead` in **every** run they appeared in, appends them to
   `data/dead-urls.json`. Idempotent. Documented in README under maintenance.

**Acceptance criteria:**
- A 404 broker logs as `dead`, not `error`
- Summary shows `💀 Dead (stale): N` distinct from `❌ Errors`
- Hosts in `data/dead-urls.json` are skipped without a network request
- `node scripts/prune-dead.js` run twice produces no duplicate entries

**Tests:** `test/dead-url.test.js` — mock a Playwright page returning 404 /
throwing connection errors; assert `dead` classification. Unit-test
`prune-dead` aggregation with fixture logs.

**Conflict note:** Touches `lib/logger.js` (bucket addition) — coordinate with
WP4 which also adds a bucket. Both should add their bucket via a single
`addBucket(name, icon)` helper if Phase 0 didn't provide one; otherwise append
to the map and keep edits to adjacent lines.

---

### WP4 — Email-confirmation tracking

**Closes:** HN (author's own ask, lolpython)

**Problem:** Many brokers respond to a submitted form with "check your email to
confirm." The script logs `success` and moves on; the user never knows removal
is incomplete.

**Files:** `lib/broker-runner.js`, `generic-runner.js`, `lib/logger.js`,
`watcher.js` (summary call)

**Approach:**
1. After submit, before logging `success`, scan the result page text for
   confirmation-required patterns (case-insensitive):
   `/check your (e-?mail|inbox)/`, `/confirm(ation)? (e-?mail|link|your request)/`,
   `/verify your (e-?mail|request)/`, `/we('| ha)ve sent/`.
2. If matched → log status `pending_confirm` (new bucket, `📧` icon) instead of
   `success`. Still call `recordSuccess()` BUT store
   `{ pendingConfirmation: true }` in the state entry so re-check logic knows it
   was only partially completed (do **not** treat as fully done — re-attempt
   next run if still pending after 14 days; add that window as a constant).
3. Summary: dedicated section "📧 Awaiting email confirmation (check inbox): …"
   listing broker names. Include count in the iMessage/webhook short summary.

**Acceptance criteria:**
- A page containing "Please check your email to confirm" → `pending_confirm`, not `success`
- State entry records `pendingConfirmation: true`
- Summary lists pending-confirmation brokers in their own section
- A pending broker still pending after 14 days is re-attempted (unit-test the date logic)

**Tests:** `test/confirm-detection.test.js` — table of result-page snippets →
expected classification (positive + negative cases). Date-window logic unit-tested.

**Conflict note:** Adds a bucket to `lib/logger.js` (see WP3 note). Touches
`generic-runner.js` (also WP3). WP3 owns the *navigation/dead* path; WP4 owns the
*post-submit* path — different functions/regions of the file. Land WP3 first if
possible, then WP4 rebases.

---

### WP5 — Verify mode (`--verify`)

**Closes:** HN (lolpython) — "how do you know any of this works?"

**Problem:** No way to confirm an opt-out actually took effect.

**Files:** new `lib/verifier.js`, `watcher.js` (arg + mode dispatch),
`brokers.js` (read-only — uses existing `searchUrl`/`listingPattern`), `README.md`

**Approach:**
1. New mode: `node watcher.js --verify`. Does **not** submit anything.
2. For every broker in `state.optOuts` with a recorded success that is a
   `search-form` broker (has `searchUrl` + `listingPattern`):
   re-run `findListingUrl()`. If a listing is **still found** → flag
   `STILL LISTED (opt-out may have failed or data re-added)`. If not found →
   `verified clear`.
3. Brokers without a searchable signal → `unverifiable (no signal)` — be honest,
   don't fake a result.
4. Write `logs/verify-<date>.json` and print a three-column report:
   verified clear / still listed / unverifiable. Send summary via `notify()`.

**Acceptance criteria:**
- `--verify` never submits a form or mutates `state.json`
- search-form brokers correctly classified against a mocked search page
  (listing present → "still listed"; absent → "verified clear")
- non-search brokers reported as `unverifiable`, not silently dropped
- Honest framing in README: explains this is best-effort, not proof of deletion

**Tests:** `test/verifier.test.js` — mock `findListingUrl`; assert the three
classifications and that no write/submit occurs (spy on `saveState`,
`btn.click`).

**Conflict note:** Almost fully additive (new `lib/verifier.js`). Only shared
edit is `watcher.js` arg parsing — coordinate with WP1/WP6 (also edit setup/args).
Keep the change to a single `if (argv.includes('--verify'))` branch in `main()`.

---

### WP6 — International address support

**Closes:** HN (pards) — Canadian postal code failure

**Problem:** Schema assumes US `state` (2-letter) + `zip`. Non-US users
(Canada/UK/AU) can't represent province/postcode; form-filler has no
province/postcode selectors.

**Files:** `setup.js`, `lib/forms.js`, `config.example.json`, `brokers.js`
(add `usOnly` flags), `README.md`

**Approach:**
1. Config schema: add `person.country` (default `"US"`). Keep `state`/`zip`
   field names for back-compat but treat them as generic
   region/postal values; document the mapping.
2. `setup.js`: prompt for country first. If `US` → existing prompts
   ("State (2-letter)", "ZIP"). Else → "Province/Region", "Postal code"
   (no format coercion; accept `A1A 1A1` etc.). Skip the US-style
   `phoneFormatted` `(xxx) xxx-xxxx` transform for non-US numbers.
3. `lib/forms.js`: extend the field-map with
   `input[name*="province" i]`, `input[name*="postal" i]`,
   `input[name*="postcode" i]`, `select[name*="country" i]` and fill `country`
   when such a field exists.
4. `brokers.js`: tag clearly US-only brokers (e.g. US voter-record sites) with
   `usOnly: true`. Runner skips `usOnly` brokers when
   `config.person.country !== 'US'`, logging `skipped (US-only)`.
5. README: add an "International users" subsection (what works, what's US-only,
   note that US people-search sites won't have non-US records anyway).

**Acceptance criteria:**
- US config path unchanged (regression-test prompt order via mocked readline)
- Canadian config (`country: "CA"`, postal `K1A 0A6`) accepted by setup; no
  `(xxx)` phone mangling
- Form filler populates a `postal`/`province` field on a synthetic test page
- `usOnly` brokers skipped for non-US users with explicit log line

**Tests:** `test/forms-intl.test.js` (synthetic DOM via Playwright or jsdom-lite
— mock locators), `test/setup-intl.test.js` (mock readline; assert branch).

**Conflict note:** Touches `setup.js` (WP1 also). WP6 owns the *personal-info
prompt* block (top of `main()`), WP1 owns the *scheduling* block (bottom). Edit
non-overlapping regions. Touches `lib/forms.js` (WP3/WP4 don't). Land after
Phase 0; safe to parallelize with WP1 if regions respected.

---

### WP7 — Transparency: STATUS table + honest summary

**Closes:** HN (lolpython — "is this vibe coded? does it work?")

**Problem:** Users can't tell which of the 500+ brokers are explicitly tested vs
heuristic best-effort. Erodes trust.

**Files:** new `STATUS.md`, `README.md`, `lib/logger.js` (summary wording only)

**Approach:**
1. `STATUS.md`: table of the ~31 explicit brokers with a `Confidence` column —
   `verified` (manually tested, selectors confirmed) vs `untested` (defined but
   not hand-verified). Be conservative: only mark `verified` ones the maintainer
   has actually confirmed; default everything else to `untested`. Add a section
   explaining the generic runner is heuristic and success is not guaranteed.
2. Summary wording (`lib/logger.js`): change `✅ Removed` →
   `✅ Submitted (form accepted)` and add a one-line disclaimer in the summary
   footer: "Submitted ≠ confirmed deleted. Run `--verify` to spot-check." This
   directly counters the "claims success but doesn't work" critique.
3. README: link STATUS.md from the top; add a short "How confident should I be?"
   paragraph (explicit = high, generic = best-effort, use `--verify`).

**Acceptance criteria:**
- `STATUS.md` exists, lists every explicit broker, no broker marked `verified`
  without justification
- Summary no longer claims "Removed"; uses "Submitted" + disclaimer
- README links STATUS.md above the broker table

**Tests:** none required (docs + string change). Add a trivial assertion in
`test/logger.test.js` that the summary contains the disclaimer string.

**Conflict note:** Only code touch is summary strings in `lib/logger.js`
(shared with WP3/WP4 bucket edits). Smallest footprint — land **last** so it
phrases the summary around whatever buckets WP3/WP4 added.

---

## Execution Plan

```
Phase 0 (1 agent, solo)         ── modularize watcher.js → lib/*  [BLOCKS ALL]
        │
        ▼
Phase 1 (parallel subagents)
   ├─ WP1  scheduler        (setup.js bottom, lib/scheduler.js)
   ├─ WP2  notify/email     (lib/notify.js, lib/email.js)
   ├─ WP3  dead URLs        (generic-runner.js, lib/logger.js, prune script)
   ├─ WP5  verify mode      (lib/verifier.js — additive)
   └─ WP6  international     (setup.js top, lib/forms.js)
        │
        ▼
Phase 2 (depends on WP3 buckets landing)
   ├─ WP4  email confirm    (rebase after WP3's logger change)
   └─ WP7  transparency     (last — phrases summary around final buckets)
```

**Dispatch guidance for the orchestrator:**
- Run Phase 0 as a single `coder` subagent. Do not start Phase 1 until its PR/commit lands and `node watcher.js --dry-run` is verified unchanged.
- Phase 1: spawn WP1, WP2, WP3, WP5, WP6 as concurrent subagents in one message.
  Give each subagent **only its WP section** plus this file's Context section.
- Phase 2: WP4 then WP7 sequentially (both edit `lib/logger.js` summary region).
- Each subagent: write tests first (repo rule = TDD, 80% coverage), keep files
  <300 lines, no new deps except `nodemailer` (WP2, lazy-loaded), commit with a
  `feat:`/`fix:` message referencing the HN/GH item, do **not** push — the
  orchestrator reviews and pushes once per phase.
- After each phase: run `node --test`, run `node watcher.js --dry-run` on a
  5-broker subset, eyeball the summary, then push.

## Out of scope (explicitly not doing)

- Data-poisoning / fake-record injection (HN himata4113) — legally/ethically dubious, conflicts with project's honest-opt-out framing.
- Bundling a paid proxy-email service.
- Guaranteeing deletion / legal escalation (CCPA complaints) — `--verify` is the honest ceiling here.
- Per-broker bespoke flows for all 500 generic sites — the long tail stays heuristic by design; WP7 documents this honestly.

## One-line PR/issue replies (for the maintainer)

- **GH #1 (Linux):** "Cross-platform scheduling + notifications are on the roadmap (systemd/crontab/schtasks, webhook notifications, SMTP email fallback). Tracked in `docs/plans/2026-05-18-roadmap-hn-gh-fixes.md` WP1/WP2."
