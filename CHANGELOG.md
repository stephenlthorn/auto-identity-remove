# Changelog

A release is cut by bumping `version` in `package.json` on main. The section here for that version becomes the release notes, so every version needs one.

## 2.0.1 - 2026-10-30

A prebuilt Docker image, so a NAS no longer has to build one. The tool itself is the same as 2.0.0.

### New

- **A prebuilt multi-arch image on GitHub Container Registry with every release** ([#8](https://github.com/stephenlthorn/auto-identity-remove/issues/8)): `ghcr.io/stephenlthorn/auto-identity-remove`, for `linux/amd64` and `linux/arm64`, tagged with the version and `latest`. The release workflow builds it from the release tag and launches Chromium in it before it publishes anything. A Synology DS720+ now pulls it, instead of downloading the source and building a 940 MB Playwright image on a Celeron.

### Docs and compose

- `docs/SYNOLOGY.md` and the README's Docker section lead with the prebuilt image: `docker pull`, then a plain `docker run`. The DSM Task Scheduler line is a plain `docker run --rm ...` that needs no compose file and no source on the NAS. Building from source is a short alternative.
- `docker-compose.yml` pulls the image by default, and `AIDR_VERSION` pins a release. If you ran `docker compose run` from a checkout and relied on it building the image, build it with `docker compose -f docker-compose.yml -f docker-compose.build.yml build`.

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

- **If you ran the test suite** (`npm test`) from a checkout between 2026-08-13 and 2026-10-29, check `crontab -l`. The old scheduler test replaced your whole crontab with a single test line pointing at a temporary folder. Restore any jobs you had from a backup; `aidr schedule install` puts back the monthly aidr job.
- Node 20 or newer is required (nodemailer 10). CI runs 20, 22 and 24.
- The dashboard requires a username and password, even on localhost. `aidr dashboard` prints generated ones, and `AIDR_PASS=change-me` counts as unset.
- Unknown or misspelled flags exit 2 with a suggestion. For example, `--dryrun` suggests `--dry-run`.
- A run where every broker failed exits 1. So does a run where most sites could not be resolved: that points to a network or DNS problem, not to dead brokers. `aidr schedule status` exits non-zero when the last full run failed or crashed, and says when it could not reach most sites.
- In a headed, interactive run, `captcha.manual: "auto"` waits up to 180 s per CAPTCHA for you to solve it.
- When an email relay is configured, `email.smtp.from` should be a dedicated sender address. Otherwise brokers still see your real mailbox in `From`. `aidr config check` and `aidr doctor` warn about this.
- The Docker image uses `AIDR_HOME=/home/aidr`. The old `/app/config.json` mounts fail with a message naming both paths, so they are not silently ignored.
