# 2026-05-19 - HN follow-up implementation plan (batch 2)

Plan for the 4 remaining unimplemented suggestions from the HN thread re-read
(https://news.ycombinator.com/item?id=48178184). The first 4 features from this
batch (CA DELETE portal, --pending, defunct detection, Dockerfile) were already
implemented without a formal plan. This document covers the remaining 4.

## Full feature set (8 total from HN re-read)

| # | Feature | Status |
|---|---|---|
| 1 | California DELETE portal broker | Done (fc856c3) |
| 2 | --pending subcommand | Done (bb6aba8) |
| 3 | Defunct broker detection | Done (4b3ca83) |
| 4 | Dockerfile + docker-compose | Done (3f77f7a) |
| 5 | CapSolver optional + --no-capsolver flag | **To implement** |
| 6 | Multi-person support | **To implement** |
| 7 | Checkpoint/resume for interrupted runs | **To implement** |
| 8 | Per-broker expected sender hints | **To implement** |

## Workflow

1. Each WP is built in its own git worktree (isolation: worktree) to avoid merge
   conflicts.
2. Each WP must add tests; full suite must stay 100% green.
3. Commit and push after each WP.
4. Final smoke test: `node watcher.js --dry-run --list`.

## Conflict map

| WP | Primary files | Test files | Conflict risk |
|---|---|---|---|
| WP5 | lib/broker-runner.js, watcher.js, README.md | test/capsolver-optional.test.js | medium |
| WP6 | lib/config.js, watcher.js | test/multi-person.test.js | medium |
| WP7 | lib/config.js, watcher.js | test/checkpoint.test.js | high (config.js) |
| WP8 | brokers.js, lib/config.js, lib/defunct.js | test/broker-sender-hints.test.js | low |

Batching: WP5 and WP8 touch different files - run in parallel.
WP6 and WP7 both touch lib/config.js - run sequentially.

---

## WP5 - CapSolver optional + --no-capsolver flag

**Source:** `exiguus` stopped reading when they saw CapSolver is required ("it
looks like advertising for it in npm package form"). CapSolver is already
optional in the code (captcha_failed is logged and the browser opens for manual
intervention) but the README does not make this clear.

**Problem:** Users see "Solves CAPTCHAs via CapSolver" and assume it is
required. Many will not install it. There should be a `--no-capsolver` flag
that explicitly skips CAPTCHA-likely brokers (routes them straight to manual)
so users can opt-out of sites without any paid API.

**Approach:**

1. `lib/broker-runner.js` - Check a new `opts.noCapsolver` flag. When true,
   skip the `detectAndSolveCaptcha` call entirely for `captchaLikely` brokers:
   log `manual` instead of attempting and failing.

2. `watcher.js` - Accept `--no-capsolver` CLI flag, pass it to
   `brokerRunner.configure()`.

3. `README.md` - Add a "CapSolver is optional" callout near the CapSolver
   section. Something like:
   "CapSolver is optional. Without it, CAPTCHA-protected sites are flagged as
   manual and opened in your browser. Run with `--no-capsolver` to skip them
   entirely."

**Files:**
- `lib/broker-runner.js` - add `noCapsolver` to opts; guard captcha block
- `watcher.js` - parse `--no-capsolver` flag
- `README.md` - add callout

**Tests (`test/capsolver-optional.test.js`):**
- When `noCapsolver: true` and `broker.captchaLikely: true`, the broker is
  logged as `manual` (not `captcha_failed`, not `success`)
- When `noCapsolver: false` and `broker.captchaLikely: true`, the captcha
  path runs normally (existing behavior)
- When `noCapsolver: true` and `broker.captchaLikely: false`, the broker
  runs normally (captcha skip only applies to captcha-likely brokers)

**Acceptance:** `node watcher.js --no-capsolver --dry-run` runs without error.
CAPTCHA-likely brokers are listed as manual in the summary. README clearly
states CapSolver is optional.

---

## WP6 - Multi-person support

**Source:** Repeated HN commenter request - "run for my whole family." The
prior analysis also flagged this as a top ask.

**Problem:** `config.json` has a single `person` object. To run for a spouse
or child, the user has to edit config, run, edit back. This is error-prone and
makes monthly scheduling useless for families.

**Approach:**

1. `lib/config.js` - Extend `loadConfig()` to accept either:
   ```json
   { "person": { ... } }          // existing single-person format
   { "persons": [{ ... }, { ... }] }  // new multi-person format
   ```
   If `persons` array is present, use it. If only `person`, wrap it in an
   array internally. Export `getPersons()` alongside the existing API.

2. `watcher.js` - After loading config, iterate over `getPersons()`. For each
   person, run the full broker loop with that person's data. Print a header
   per person: "=== Running for Jane Doe ===".

3. State tracking - Namespace state keys by person when multiple persons are
   configured. Key: `${person.firstName}_${person.lastName}` or use an
   explicit `person.id` field if provided.

**Files:**
- `lib/config.js` - `getPersons()`, multi-person config loading, namespaced
  state keys
- `watcher.js` - iterate persons loop

**Tests (`test/multi-person.test.js`):**
- `getPersons()` returns array of one when config has single `person`
- `getPersons()` returns array of N when config has `persons: [...]`
- `getPersons()` throws if neither `person` nor `persons` is present
- State keys are namespaced when multiple persons configured
- Single-person config still produces un-namespaced state keys (backwards
  compatibility)

**Acceptance:**
```json
{
  "persons": [
    { "firstName": "Jane", "lastName": "Doe", ... },
    { "firstName": "John", "lastName": "Doe", ... }
  ]
}
```
Running `node watcher.js --dry-run` processes both persons. Summary shows
per-person counts.

---

## WP7 - Checkpoint/resume for interrupted runs

**Source:** Prior analysis item. Runs across 500+ brokers take 20-90 minutes.
A crash or Ctrl-C loses all progress. Re-running from scratch wastes time and
triggers rate-limiting.

**Problem:** If the run is interrupted at broker 200/500, the next run starts
over at broker 1. Since `shouldSkip()` requires a success entry, any broker
that was submitted in the killed run but didn't write state will be re-run.

**Approach:**

1. `lib/config.js` - Add `saveCheckpoint(brokerName)` and `clearCheckpoint()`
   functions. A checkpoint file (`state.json.checkpoint`) records the last
   broker that started processing. On a fresh run, if a checkpoint exists,
   log a warning: "Previous run was interrupted at [broker]. Use --resume to
   skip already-submitted brokers."

2. `watcher.js` - Add `--resume` flag. When set, load the checkpoint and skip
   all brokers alphabetically before the checkpoint broker. Clear checkpoint
   when the run completes normally.

3. `brokerRunner.js` - Call `saveCheckpoint(broker.name)` at the start of
   each broker's processing (before any network calls). Clear on normal exit.

**Files:**
- `lib/config.js` - `saveCheckpoint`, `clearCheckpoint`, `loadCheckpoint`
- `lib/broker-runner.js` - call `saveCheckpoint` before processing
- `watcher.js` - `--resume` flag, checkpoint clear on success

**Tests (`test/checkpoint.test.js`):**
- `saveCheckpoint('Spokeo')` writes checkpoint file
- `loadCheckpoint()` returns broker name
- `clearCheckpoint()` removes checkpoint file
- `clearCheckpoint()` is a no-op when no checkpoint file exists
- `setDryRun(true)` prevents checkpoint writes (consistent with other dry-run
  behavior)

**Acceptance:** Run `node watcher.js --dry-run`, kill mid-run with Ctrl-C.
Run `node watcher.js --resume --dry-run` - brokers before the checkpoint are
logged as `skipped (resumed)`.

---

## WP8 - Per-broker expected sender hints

**Source:** `lolpython` - "a stopgap solution could be to just tell me to
click confirm on the emails and which senders to look out for."

The `--pending` subcommand (just added) shows which brokers need email
confirmation, but the "Confirmation hint" column is just the snippet from the
page (e.g., "Please check your email to confirm"). It doesn't tell the user
which email address to look for.

**Problem:** Users don't know which inbox messages to look for. A broker's
confirmation comes from a specific sender domain that's predictable.

**Approach:**

1. `brokers.js` - Add optional `expectedSender` field to broker definitions
   where known. This is the sender domain users should look for in their inbox.
   Example: `expectedSender: 'noreply@spokeo.com'` or `expectedSender:
   'privacy@beenverified.com'`.

   Add this field to at least the 10 most common `pendingConfirm`-prone brokers
   (Spokeo, BeenVerified, Radaris, Intelius, MyLife, WhitePages, FamilyTreeNow,
   TruePeopleSearch, PeopleFinders, InstantCheckmate).

2. `watcher.js` `--pending` output - When `expectedSender` is available on the
   broker definition, show it in the Confirmation hint column instead of the
   generic snippet.

3. `lib/config.js` `getPendingConfirmations()` - Accept an optional `brokers`
   array parameter and join against it to include `expectedSender` in the
   returned objects.

**Files:**
- `brokers.js` - add `expectedSender` to ~10 broker definitions
- `lib/config.js` - update `getPendingConfirmations(brokers?)` signature
- `watcher.js` - pass brokers to `getPendingConfirmations`, use
  `expectedSender` in output

**Tests (`test/broker-sender-hints.test.js`):**
- At least 5 brokers in `brokers.js` have `expectedSender` defined
- `expectedSender` values are strings containing `@`
- `getPendingConfirmations(brokers)` returns `expectedSender` when broker has
  it defined
- `getPendingConfirmations(brokers)` falls back to snippet when no
  `expectedSender`
- `getPendingConfirmations()` (no brokers arg) still works as before

**Acceptance:** After a run with Spokeo pending, `--pending` shows:
```
Spokeo                                  2026-05-01    noreply@spokeo.com
```

---

## Final acceptance criteria

- [ ] WP5 through WP8 all merged to `main`
- [ ] Full test suite passes (430+ tests)
- [ ] `node watcher.js --dry-run` runs end-to-end without errors
- [ ] `node watcher.js --no-capsolver --dry-run` runs without error
- [ ] `node watcher.js --pending` shows expected sender when available
- [ ] All commits pushed to GitHub
