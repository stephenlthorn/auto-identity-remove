# Changelog

A release is cut by bumping `version` in `package.json` on main. The section here for that version becomes the release notes, so every version needs one.

## 2.0.0 - 2026-10-30

A full audit, fix and roadmap pass, written test-first. It is a major version because some behaviour changes for existing installs: read **Upgrading from 1.x** before you update.

### New

- **One home directory** (R0): `AIDR_HOME` holds config, state, logs, reports and history. Docker and Synology need a single mount.
- **Solve CAPTCHAs yourself** (R1, #16): `captcha.manual`, `--solve-captchas` and `aidr captchas`.
- **`--resume` covers the generic pass** (R2): the ~490-broker pass is checkpointed per person and row.
- **Crash-safe run journal** (R3): `logs/run-<ts>.jsonl`, read by `--retry-failed`, `aidr captchas` and the diff when the summary is missing.
- **A scheduler you can see and undo** (R4): `aidr schedule status|install|uninstall`, a `last-run.json` heartbeat and new `aidr doctor` checks. The Windows Task Scheduler reading and the launchctl and systemctl exit codes are not yet verified on live hosts.
- **`aidr config check`** and identity fingerprints on state entries (R5): correcting a zip or email re-runs that person. Existing entries are trusted, so nothing re-runs on upgrade.
- **Retention** (R6): `aidr purge` and `retention.days`.
- **Browser isolation** (R7): a profile per person, a regular Chrome user agent when headless, and `browser.proxy`.
- **Dashboard** (R8): run history, per-person status, generic-broker totals and a CAPTCHA call to action.

### Fixed

Two audit rounds, each with independent same-family auditors and a cross-model review: about 85 findings, then about 45 on the new code. All are fixed or dispositioned. The main themes:

- Outcomes recorded as removals that were not: forms never sent, "try again" confirmation pages, policy pages.
- Wrong person, wrong data in multi-person setups, and email relay bypasses.
- Security: the SSRF guard fails closed, the dashboard closes DNS rebinding, CSRF and path traversal holes, and a one-character passphrase is refused.
- Scheduling and recovery: failed scheduler installs say so, crashed runs exit non-zero, and a dead browser is relaunched.
- Docker recipes now persist what they claim to.
- The old `test/scheduler.test.js` rewrote the real user crontab on every run of the suite. It no longer touches it.

The plan is in `docs/plans/2026-10-29-roadmap.md`. The full account is in PR #20.

### Upgrading from 1.x

- Node 20 or newer is required (nodemailer 10). CI runs 20, 22 and 24.
- The dashboard requires a username and password, even on localhost. `aidr dashboard` prints generated ones, and `AIDR_PASS=change-me` counts as unset.
- Unknown or misspelled flags exit 2 with a suggestion. For example, `--dryrun` suggests `--dry-run`.
- A run where every broker failed exits 1. `aidr schedule status` exits non-zero when the last full run failed or crashed.
- In a headed, interactive run, `captcha.manual: "auto"` waits up to 180 s per CAPTCHA for you to solve it.
- When an email relay is configured, `email.smtp.from` should be a dedicated sender address. Otherwise brokers still see your real mailbox in `From`. `aidr config check` and `aidr doctor` warn about this.
- The Docker image uses `AIDR_HOME=/home/aidr`. The old `/app/config.json` mounts fail with a message naming both paths, so they are not silently ignored.
