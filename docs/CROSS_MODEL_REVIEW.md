# Cross-model review policy

## Why this exists

[Issue #8](https://github.com/stephenlthorn/auto-identity-remove/issues/8) made a
fair criticism: most of this code was written by Claude and reviewed by Claude,
including a "full 5-reviewer code review". A model is bad at finding blind spots
it shares with itself, and the SSRF fix landing reactively after a review was
evidence of exactly that.

The first cross-model pass, run against a tree where every test passed, found
four P1s that same-family review had missed:

| Found by the outside model | Missed by same-family review because |
|---|---|
| `docker build` fails - `groupadd --gid 1001` collides with the base image's `pwuser` | The Docker test asserted the Dockerfile *contained strings*, never that it built. Text-shaped test, text-shaped confidence. |
| Playwright client 1.60.0 vs base image v1.52.0 - no launchable Chromium | Both numbers were individually plausible. Nothing compared them. |
| A `persons: []` config blanks every broker form value; a mixed config submits person A's PII under person B's request | Destructuring a Proxy evaluates its getters immediately. The lazy-config abstraction *looked* lazy. |
| Generic runner recorded `success` for "form filled but no submit control found" | The line even had a comment explaining why it was fine. It was not fine. |

Plus, later in the same pass: state writes failing with `EBUSY` under the
documented Docker mount, and at-rest encryption silently disabling the whole form
filler.

None of these are exotic. They are the kind of thing you stop seeing once you
have already decided the code is correct.

## The three layers

### 1. Copilot code review - always on, fork-safe

The only layer that covers pull requests from forks, because it needs no secret.
Enable it as a repository ruleset targeting `main`:

Settings → Rules → Rulesets → New branch ruleset → target `main` → enable
**Request pull request review from Copilot**.

Solo-maintainer tuning: leave **Review new pushes** off so a single PR is not
billed once per push, and leave **Review draft pull requests** off.

Cost note: since 2026-06-01 Copilot code review is usage-based - it bills AI
credits for tokens *and* consumes GitHub Actions minutes. Budget accordingly
before turning on per-push review.

### 2. `npm run review:cross-model` - deep pre-merge pass

```bash
npm run review:cross-model                              # diff vs origin/main
npm run review:cross-model -- --base HEAD~5
npm run review:cross-model -- --files lib/config.js,lib/secrets.js
npm run review:cross-model -- --full                    # whole tier-1 surface
npm run review:cross-model -- --strict                  # fail on P2 as well
```

Runs locally against the maintainer's own `codex` auth. Writes a committed report
to `docs/reviews/cross-model/<date>-<sha>.md` and exits non-zero on a P1.

Exits 3 when `codex` is absent, 4 when it is unauthenticated and 7 when it is
present but unusable, each with a message saying what to do. Honours
`SKIP_CROSS_MODEL=1`, so it is safe to wire into a git hook.

### 2a. `npm run review:doctor` - is the reviewer actually alive?

```bash
npm run review:doctor
```

This policy rests on a binary on one machine, and on 2026-09-18 that binary had
been broken for an unknown stretch: codex 0.137.0 could not decode the server's
model list (`unknown variant 'max'`) and died before reviewing anything. The
policy was off and still looked enforced, because **nothing asked**. The CI gate
below checks for a commit trailer, which is paperwork, and CI cannot call a
model here at all.

The old preflight asked two questions, and a broken-but-present codex answered
both correctly:

| question | broken 0.137.0 |
|---|---|
| is it installed? | yes |
| is it authenticated? | yes |
| can it complete a request? | *never asked* |

`review:doctor` adds the third. It makes a real round trip and requires the
sentinel back, so exit 0 means the reviewer can do the job rather than merely
exist. `review:cross-model` runs it first, which is why a dead reviewer now
names itself instead of surfacing as "produced no findings file" - a message
that reads, wrongly, like a clean review.

A hang counts as dead: the probe is bounded (45s, `CROSS_MODEL_PROBE_TIMEOUT`)
and kills the child rather than waiting forever. So does an exit 0 with no
sentinel, because silence must never read as success.

Run it when a review behaves oddly, after upgrading or reinstalling `codex`, or
on any machine where you intend to merge a tier-1 change.

### 3. This document - the policy and the record

## Why there is no OpenAI-key job in CI

A public repo cannot make this work in Actions, and pretending otherwise is worse
than not doing it:

- **`pull_request` from a fork** gets a read-only `GITHUB_TOKEN` and **no access
  to repository or organization secrets**. `${{ secrets.OPENAI_API_KEY }}`
  resolves to an empty string on every fork PR - so a key-based reviewer job
  would be decorative precisely where an outside contribution needs review.
- **`pull_request_target`** does receive secrets, because it runs the workflow
  from the base ref. Reviewing the PR then requires checking out untrusted head
  code in a privileged context: the classic "pwn request". Not on a repo whose
  data at rest is the user's home address.

So: no model API key in CI, ever, and no `pull_request_target`. What CI *does*
run with zero secrets is the `cross-model-gate` job, which checks whether a PR
touching tier-1 files carries a `Cross-model-review:` trailer, and the `docker`
job, which builds the image and launches a real browser - the behavioural test
that would have caught two of the four P1s above.

Sources (fetched 2026-08-12):
[securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target),
[configuring automatic Copilot code review](https://docs.github.com/en/copilot/how-tos/agents/copilot-code-review/automatic-code-review),
[Copilot code review and Actions minutes](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/).

## Tier 1 - a second-family review is required before merge

Chosen by what actually touches PII, crypto, subprocesses, or inbound untrusted
data. Not by line count or churn.

| File | Why it is tier 1 |
|---|---|
| `lib/config.js` | Loads and writes the PII; owns encryption orchestration and all state durability |
| `lib/secrets.js` | AES-256-GCM + scrypt envelope. Crypto mistakes are silent |
| `lib/field-resolver.js`, `lib/forms.js` | Decide *which* PII value goes into *which* form field on a third-party site |
| `dashboard/server.js`, `dashboard/validate.js` | HTTP surface over the config, plus auth and subprocess spawning |
| `lib/imap-confirm.js`, `lib/confirm.js` | Parse attacker-influenced email and follow links out of it |
| `lib/email.js`, `lib/right-to-know-runner.js` | Send PII over SMTP |
| `lib/feeds.js`, `lib/serp-scan.js` | Turn remote registry rows into navigation and submission targets |
| `lib/scheduler.js` | Writes launchd/systemd/crontab units, historically via a shell |
| `lib/complaint.js` | Generates PDFs containing full PII |
| `generic-runner.js`, `lib/broker-runner.js`, `brokers.js` | Submit PII to third parties and decide what counts as success |
| `lib/relay.js`, `lib/captcha.js`, `lib/hibp.js` | Outbound third-party APIs carrying the email address and API keys |
| `setup.js` | Writes the PII file and installs the scheduler |
| `Dockerfile`, `docker-compose.yml` | The only realistic deployment path for Linux and NAS users |

Tier 2 - Copilot alone is enough: `watcher.js` orchestration, `lib/report.js`,
`lib/logger.js`, `lib/audit.js`, `lib/exposure.js`, `lib/diff.js`, `data/`,
`docs/`, `test/`.

## Recording the result

Each run commits a report under `docs/reviews/cross-model/` with a header block
(reviewer family, tool, model, base, head, files reviewed, P1/P2/P3 counts) and a
**Disposition** column per finding: `fixed <sha>`, `wontfix <reason>`, or
`not-a-bug <reason>`. A finding left `_pending_` is not reviewed.

The merge commit carries a trailer:

```
Cross-model-review: docs/reviews/cross-model/2026-08-12-0202bb7.md (P1:0 P2:2)
```

so the audit query is `git log --grep='Cross-model-review:'`.

Skipping is allowed. It just has to be visible:

```
Cross-model-review: SKIPPED (docs only)
```

Copilot's reviews already live in the PR timeline, so the trailer is only
required for the codex pass, or when a Copilot finding was accepted or explicitly
rejected.

## Honest limits of this

- Two models sharing a wrong assumption still agree. Cross-family review widens
  coverage; it does not prove correctness.
- The outside model was also wrong here. Of eight findings in the first pass, one
  ("broker definitions capture one person's PII") was right about the mechanism
  but described the wrong consequence, and had to be re-derived by hand before it
  could be fixed. **Verify every finding against the code before acting on it** -
  a confident review from a different model is a lead, not a verdict.
- The real fix for the two Docker P1s was not a review at all. It was building the
  image. Where a behavioural test is possible, write that instead of asking a
  model.
