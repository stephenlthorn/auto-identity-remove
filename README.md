# auto-identity-remove

![CI](https://github.com/stephenlthorn/auto-identity-remove/actions/workflows/test.yml/badge.svg)
[![Hacker News points via HackerGit](https://hackergit.org/badge/stephenlthorn/auto-identity-remove.svg?style=card)](https://news.ycombinator.com/item?id=48178184)
[![brokers ok](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fstephenlthorn%2Fauto-identity-remove%2Fmain%2Fdata%2Fbroker-health.json&query=%24.summary.ok&label=brokers%20ok&cacheSeconds=3600)](STATUS.md) [![brokers checked](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fstephenlthorn%2Fauto-identity-remove%2Fmain%2Fdata%2Fbroker-health.json&query=%24.summary.total&label=brokers%20checked&cacheSeconds=3600)](STATUS.md)

Automated data broker opt-out runner for macOS, Linux, and Windows. Removes your personal information from **500+ people-search sites and data broker databases** on a monthly schedule - with CAPTCHA solving, persistent state tracking (so completed opt-outs aren't resubmitted every run), and an iMessage notification when done. [**Privacy & data flow ->**](docs/PRIVACY.md)

## What it does

Each month, the script:

1. **Searches** each data broker site for your name + state
2. **Finds your specific listing** (for sites that need a profile URL)
3. **Fills and submits** the opt-out form automatically
4. **Solves CAPTCHAs** via [CapSolver](https://capsolver.com) (AI-powered, ~$0.001/solve)
5. **Skips** brokers you were already removed from recently (90-day re-check window)
6. **Sends you an iMessage** with the results summary
7. **Opens** any sites that require manual action in your browser

Beyond the monthly run, it can also:

- **Score your exposure** - a single 0-100 number with a month-over-month trend (`aidr score`), built from verified removals, search-engine visibility, and breach data
- **Look before you submit** - see where you are actually listed (`aidr scan`) and submit only there (`aidr run --found-only`)
- **Close the loop** - re-verify removals (`aidr verify`), watch search engines for new listings (`aidr serp-watch`), and generate a monthly PDF report (`aidr report`)
- **Add teeth** - send CCPA/GDPR right-to-know requests (`aidr know`) and auto-generate regulator complaints when a broker blows the legal deadline (`aidr complaints`)
- **Protect proactively** - check Have I Been Pwned (`aidr breach`) and walk a credit/identity-freeze checklist (`aidr freeze`)
- **Stay private** - submit from a masked relay email (SimpleLogin), encrypt `config.json` at rest (AES-256-GCM, opt-in via `AIDR_PASSPHRASE`), and detect success/confirmation text in 6 languages
- **Run from a browser** - an optional local web dashboard with a first-run config wizard, live run console, status board and a **History** tab of past runs (`aidr dashboard`)
- **Stay in control of the job** - solve the CAPTCHAs a solver cannot (`aidr captchas`), check and remove the monthly job (`aidr schedule`), resume a killed run, check your config (`aidr config check`) and purge old PII files (`aidr purge`)
- **Keep coverage fresh** - pull the broker list from the California Privacy Protection Agency's current data broker registry (`aidr update-brokers`; Vermont no longer offers a file export, and Texas and Oregon have none), and keep brokers you *want* to stay listed on via an allowlist

---

## Requirements

- Node.js 20+
- macOS, Linux, or Windows (scheduling adapts automatically)
- [Playwright](https://playwright.dev) browsers installed

```bash
npx playwright install chromium
```

---

## Quick Start

```bash
# 1. Download the latest release and unpack it
curl -L -O https://github.com/stephenlthorn/auto-identity-remove/releases/latest/download/auto-identity-remove.tar.gz
tar xzf auto-identity-remove.tar.gz && cd auto-identity-remove

# 2. One-command install (checks Node, installs deps + the Chromium browser)
bash install.sh

# 3. Run interactive setup (creates config.json and schedules the monthly job)
node bin/aidr.js setup

# 4. Preview what it will do - submits nothing
node bin/aidr.js preview

# 5. Run for real anytime
node bin/aidr.js run
```

> Tip: run `npm link` (or `npm i -g .`) so you can type `aidr` directly instead
> of `node bin/aidr.js`. There is no `./node_modules/.bin/aidr` - npm only
> creates `.bin` shims for *dependencies*, never for the package's own `bin`.

**Check the download first (optional).** Each release carries a checksum file. Fetch it
next to the archive, before the `tar` line in step 1, and verify:

```bash
curl -L -O https://github.com/stephenlthorn/auto-identity-remove/releases/latest/download/auto-identity-remove.tar.gz.sha256
shasum -a 256 -c auto-identity-remove.tar.gz.sha256     # Linux: sha256sum -c auto-identity-remove.tar.gz.sha256
```

It prints `auto-identity-remove.tar.gz: OK`. That catches a corrupted or truncated
download. The checksum is published next to the archive, so it does not prove who
published it.

**Prefer git? (for contributors, or to track `main`).** A clone follows `main`, which can
be ahead of the latest release. Use it instead of step 1, then carry on from step 2:

```bash
git clone https://github.com/stephenlthorn/auto-identity-remove.git
cd auto-identity-remove
```

### Updating

- **Release install.** Download the new release and unpack it over the old folder: run
  the same `tar xzf auto-identity-remove.tar.gz` in the folder that contains
  `auto-identity-remove/`. Your `config.json`, `state.json` and `logs/` are not in the
  archive, so they stay where they are (with `AIDR_HOME` set they live elsewhere
  anyway). Then re-run `bash install.sh` to pick up new dependencies. Files a newer
  release removed are not deleted, and `data/dead-urls.json` (which
  `scripts/prune-dead.js` can add to) is replaced by the release's copy. For a clean
  tree, unpack into a new folder and copy `config.json` and `state.json` across.
- **Git install.** `git pull && bash install.sh`.
- **Docker or Synology.** Pull the new image:
  `docker pull ghcr.io/stephenlthorn/auto-identity-remove:latest` (compose:
  `docker compose pull`). Your `aidr-home` is not part of the image, so it stays. If you
  built the image yourself, update the folder as above and rebuild it:
  `docker build -t auto-identity-remove .`.

Check what is installed with `node bin/aidr.js --version`. What changed between releases is in
[CHANGELOG.md](CHANGELOG.md).

### The `aidr` command

`aidr` is a friendly wrapper around the underlying scripts. Every subcommand
maps to an existing entrypoint:

| Command | What it does |
|---------|--------------|
| `aidr setup` | Interactive first-run setup (creates `config.json`, schedules the monthly job) |
| `aidr preview` | Dry-run: fills forms but submits nothing |
| `aidr run` | Runs the opt-out pass for real |
| `aidr captchas` | Re-runs only the brokers that ended on a CAPTCHA last time, in a visible browser, so you can solve them |
| `aidr scan` | Searches every broker that can be searched and records where you are listed. Submits nothing |
| `aidr verify` | Re-searches brokers and reports whether you still appear |
| `aidr score` | Prints your 0-100 exposure score and its month-over-month trend |
| `aidr report` | Generates the monthly PDF + emails the summary |
| `aidr pending` | Lists brokers awaiting an email-confirmation click |
| `aidr serp` | Scans search engines for where your name still ranks |
| `aidr serp-watch` | Scans and alerts only when your name appears on a NEW domain |
| `aidr breach` | Checks Have I Been Pwned and recommends a credit freeze on high-severity breaches |
| `aidr freeze` | Shows the credit/identity-freeze checklist and its status |
| `aidr complaints` | Generates regulator complaints for brokers past the CCPA/GDPR deadline |
| `aidr drop` | California: shows how to file your DROP request, records when you did (`--done`, `--on DATE`, `--person NAME`, `--clear`), and skips the brokers it covers |
| `aidr know` | Sends CCPA/GDPR right-to-know requests |
| `aidr update-brokers` | Refreshes the broker list from the current California registry |
| `aidr list` | Lists configured brokers and their last-known status |
| `aidr doctor` | Self-diagnoses your environment and configuration |
| `aidr config check` | Checks `config.json`, the passphrase source and where state lives; exits 1 on a problem |
| `aidr schedule status` | Shows whether the monthly job is installed and how its last run ended (`--json` for scripts) |
| `aidr schedule install` | Installs (or reinstalls) the monthly job |
| `aidr schedule uninstall` | Removes the monthly job |
| `aidr purge` | Deletes old logs, audit reports and screenshots, which hold your details (never complaints or the latest run) |
| `aidr dashboard` | Starts the local web dashboard and prints its URL + a one-time login. A login is always required, loopback included |

Pass extra flags straight through, e.g. `aidr run --only Spokeo` or
`aidr preview --skip BeenVerified`. Run `aidr --help` for the full list.
Every subcommand maps to the equivalent `node watcher.js --<flag>` invocation
(`aidr schedule status` is `--schedule-status`, `aidr config check` is
`--config-check`). `aidr schedule` with no verb shows the status; an unknown
verb (`aidr schedule remove`) stops with the list of real ones before anything runs.

> A native desktop wrapper (Electron/Tauri) is a planned follow-up and is **not**
> included here - this release is clean CLI packaging only.

### See which of your details go to which broker

```
aidr preview --fields
```

fills each form without sending it and prints, per broker, the form fields it typed into and
which of your details went in each. It prints the NAME of the detail, never the value:

```
   fields for FastPeopleSearch:
     optout_name <- full name
     email <- masked email
```

The names are `first name`, `last name`, `full name`, `email` (`masked email` when your
email relay supplies an alias), `phone`, `city`, `state` and `ZIP`. A field that gets a fixed
choice, such as a dropdown option, shows `fixed text`. `unmapped` means the tool could not work
out which detail a field carries; treat it as "unknown", not as "harmless".

At the end of the run one table lists, for each broker, the set of details it would receive,
then how many brokers would receive each detail (for example `phone: 12 of 140`). A broker whose
form was not reached, or had no fillable form, is not in the table because nothing was typed.
For the generic pass only a form that is already on the page is previewed; a form that opens
after clicking a "Do Not Sell" link is not.

Nothing printed contains a value unless you add `--show-values`, which also prints each value
after its field on standard output (it is not written to the run log file, but anything that
captures the terminal, such as `docker logs`, will see it). Use it to check a selector before a
real run, and do not share that output.

**What a preview itself does.** `--fields` is not "nothing leaves my machine". A preview still
visits sites:

- **Search steps run.** For a broker that searches first, the search page is loaded, and your name
  (usually with your state) is in that URL. The table marks these as `search: full name, state`
  and counts them in the totals.
- **Explicit brokers' forms are filled in the page, not submitted.** The preview types your details
  into the form fields of the brokers listed in `brokers.js` and stops before the submit click.
  A script on such a page can read what is typed.
- **Generic brokers' forms are not touched.** For the generic pass the tool works out what it
  would type and types nothing, clicks nothing and submits nothing, so those pages see only a visit.

The audit report written after a real run lists the same detail names for each broker
(`details typed: first name, email`), never values, whatever flags you used.

---

## Setup walkthrough

`node setup.js` guides you through:

| Step | What it does |
|------|-------------|
| **Personal info** | Name, city, state, ZIP, email, phone |
| **Aliases** | Past names or variations (e.g. "Steve Doe") |
| **CapSolver key** | For CAPTCHA-protected opt-out forms |
| **One-time accounts** | Creates accounts on sites that require login (stored in `config.json`, gitignored) |
| **iMessage** | Phone number to text the results summary to |
| **Monthly schedule** | Registers a monthly job to run on the 1st at 9am (launchd / systemd / crontab / schtasks - detected automatically) |

**Your personal info never leaves your machine.** `config.json` and `state.json` are both gitignored.

---

## CapSolver (optional but recommended)

Some opt-out forms have reCAPTCHA. Without CapSolver, those sites go to your manual list instead of being handled automatically.

1. Sign up at [capsolver.com](https://capsolver.com) - free, pay-as-you-go
2. Add $1-2 of credits (enough for months of use at ~$0.001/solve)
3. Paste your API key when `setup.js` asks, or add it to `config.json`:

```json
"capsolver": {
  "apiKey": "CAP-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

> **CapSolver is optional.** Without it, CAPTCHA-protected sites are flagged as
> manual and opened in your browser for completion. Pass `--no-capsolver` to skip
> them entirely rather than opening the browser.

### Capping what CapSolver can spend

Every solve is paid for, so a run can be given a ceiling:

```json
"capsolver": {
  "apiKey": "CAP-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "maxSolvesPerRun": 25
}
```

- `maxSolvesPerRun` is a whole number of 1 or more. Leave it out for no cap.
- A solve counts when a paid task is created with CapSolver, whether or not it
  then succeeds. Dry runs and previews never solve, so they never count.
- One count covers the whole run: the explicit brokers, the 500+ generic brokers
  and every person in a multi-person config.
- When the cap is used up the solver is not called again. If you are at a visible
  browser with manual solving on, you are asked as usual. Otherwise the broker is
  recorded `captcha_failed` with the reason "solve cap reached (25 of 25 used)",
  and `aidr captchas` picks it up afterwards.
- Anything that is not a whole number of 1 or more (0, a negative, a fraction, a
  string) is reported by `aidr config check` and at the start of a run, and the
  run then allows no paid solve at all.
- The run summary prints how many solves were used and the cap. The spend is the
  difference between your CapSolver balance read before the first solve and again
  at the end, so it follows whatever CapSolver charges today. If the balance
  cannot be read, only the count is shown and the spend is reported as unknown.
  The count and the spend are also written into the run log (`solves`) and the
  end line of the journal.

### Solving CAPTCHAs yourself

A CAPTCHA the solver cannot do (no key, or CapSolver failed) used to end the
broker as `captcha_failed` at once, before anyone could look at the window. With
a visible browser you can now solve it yourself, and the run carries on:

- The window comes to the front, the terminal bell rings, a desktop notification
  names the broker, and the run waits (3 minutes by default) until the widget
  reports a token or the challenge goes away. The form is filled and submitted
  for you afterwards. If the time runs out the broker is `captcha_failed`, the
  run moves on, and nothing is submitted into an unsolved CAPTCHA. This applies
  to the form brokers and to the 500+ generic brokers alike.
- A usable CapSolver key is still tried first; you are asked only after it fails.
- It happens when the browser is visible and either you are at an interactive
  terminal (`captcha.manual: "auto"`, the default) or you asked for it:

```json
"captcha": {
  "manual": "auto",
  "manualTimeoutSec": 180
}
```

| Setting | Meaning |
|---|---|
| `captcha.manual` | `"auto"` (default): wait for you when a window is visible and a terminal is attached. `true`: wait whenever a window is visible (a desktop notification still reaches you without a terminal). `false`: never wait. A headless run never waits, whatever this says. Anything else is read as `"auto"`, and `aidr config check` warns about it. |
| `captcha.manualTimeoutSec` | Seconds you get per CAPTCHA. Default 180, at most 3600. |
| `--solve-captchas` | Asks for manual solving on one run, whatever `captcha.manual` says (still needs a visible browser). |

**`aidr captchas`** is the second chance. It reads the most recent run (its log,
or its journal if that run crashed), finds every broker that ended on a CAPTCHA
(`captcha_failed`, or a manual entry that names one), and re-runs only those, in a
visible browser with manual solving on. With nothing to retry it says so and
opens no browser; with no display it says that it needs one. Run it on a desktop
machine after a headless or Docker run: the run's last lines name it. It takes
`--dry-run` and `--solve-captchas`, but not `--only`, `--skip`, `--retry-failed`,
`--resume` or `--pollute`: it picks the brokers itself, and a second selector
would silently fight the first. A run that ends on a CAPTCHA opens the broker's
opt-out page in your browser (up to 10 sites) so you can finish it by hand too.
CAPTCHAs that show no widget until the page is judged to be a bot (invisible
reCAPTCHA v3, bot-manager challenges) cannot be waited on; those are reported as
skipped and `aidr captchas` will not help with them. A run that waits for you holds the
run lock the whole time. A running watcher refreshes its lock every few minutes, so
a long manual session is never taken for an abandoned one.

**Upgrading?** `captcha.manual` defaults to `"auto"`: an interactive `aidr run` with a
visible browser now waits up to 3 minutes per CAPTCHA that CapSolver cannot do, where
earlier versions moved straight on. Scheduled runs (no terminal) are unchanged. Set
`captcha.manual` to `false` to keep the old behaviour.

---

## Running with Docker

Every release publishes a prebuilt image to GitHub Container Registry, for
`linux/amd64` and `linux/arm64`. It is built on the official Playwright image, so
Chromium and all system dependencies are already in it. No Mac, no source download
and no build: on a small box that saves building about 940 MB of Playwright on a slow
CPU.

```bash
docker pull ghcr.io/stephenlthorn/auto-identity-remove:latest
```

`latest` is the newest release. To stay on one you have checked, use its version tag
instead, for example `ghcr.io/stephenlthorn/auto-identity-remove:2.0.1` (compose:
`AIDR_VERSION=2.0.1`). The tags are on the
[package page](https://github.com/stephenlthorn/auto-identity-remove/pkgs/container/auto-identity-remove).
The image holds no config, state or logs; those are the one directory below. To build
the image from this source instead, see [Building the image yourself](#building-the-image-yourself).

### One directory holds everything

Keep everything the container must remember in a single host directory,
`aidr-home/`, mount it at `/home/aidr`, and set `AIDR_HOME=/home/aidr` (the image
already does). One mount is the whole story. It holds your config, `state.json`
and its `.bak`, `.lock` and resume `.checkpoint`, the run logs, audit reports,
snapshots and complaints (`logs/`), the confirmation inbox (`inbox/`), and the
SERP, exposure, breach and broker-registry history (`data/`). The app creates
those subdirectories itself. Back it up and treat it like `config.json`: it is
full of PII.

```bash
# Once, in any directory
mkdir -p aidr-home
cp config.json aidr-home/config.json        # made on a laptop with `node setup.js`
chmod 700 aidr-home && chmod 600 aidr-home/config.json
sudo chown -R 1001:1001 aidr-home           # the container user is uid 1001
```

```bash
# Dry-run - navigates and checks reachability, submits nothing
docker run --rm --init \
  -v "$(pwd)/aidr-home:/home/aidr" \
  -e HOME=/tmp \
  -e TZ="$(date +%Z)" \
  ghcr.io/stephenlthorn/auto-identity-remove:latest node watcher.js --dry-run

# Full run: the same command without the trailing `node watcher.js --dry-run`
```

Or with compose, which already carries the mount and the variable, from a folder
holding `docker-compose.yml` and your `aidr-home`: `docker compose run --rm watcher
node watcher.js --dry-run`. It pulls the same image the first time and uses the copy it
has after that; `docker compose pull` updates it.

**`AIDR_HOME` and its overrides.** `AIDR_HOME` is the default base for every
runtime file. Each of these still wins over it for one file, if you ever need it
somewhere else:

| Variable | Default under `AIDR_HOME` |
|---|---|
| `AIDR_CONFIG_PATH` | `config.json` |
| `AIDR_CONFIG_ENC_PATH` | `<config path>.enc` |
| `AIDR_STATE_PATH` | `state.json` (the `.bak`, `.lock` and `.checkpoint` sit beside it) |
| `AIDR_LOG_DIR` | `logs/` (snapshots, reports and complaints sit under it) |
| `AIDR_DATA_DIR` | `data/` (the history and registry caches) |

With none of them set, nothing moves: everything stays in the project directory
exactly as before.

**Upgrading from the older recipe.** It mounted `aidr-home/logs` at `/app/logs`
and set `AIDR_CONFIG_PATH=/home/aidr/config.json`,
`AIDR_CONFIG_ENC_PATH=/home/aidr/config.json.enc` and
`AIDR_STATE_PATH=/home/aidr/state.json` one by one. That keeps working, and
`AIDR_HOME=/home/aidr` is the same thing for all three. The `/app/logs` mount is
no longer needed: logs now default to `/home/aidr/logs`, which is the same host
directory (`aidr-home/logs`), so nothing has to be moved.

**Upgrading from the single-file recipe.** The very first Docker recipe bind-mounted
two single files, `config.json` and `state.json`, at `/app/config.json` and
`/app/state.json`. The image now sets `AIDR_HOME=/home/aidr`, so those mounts are ignored: the run reads
`/home/aidr/config.json`, finds nothing, and used to exit 1 with only "Run node setup.js
first". It now says where it found your files and where they must go, for example:

```
config: found /app/config.json
        expected /home/aidr/config.json
state:  found /app/state.json
        expected /home/aidr/state.json
```

Move both into the one directory and mount that instead (the commands above), and keep
the history: `cp state.json aidr-home/state.json`. If you copy only the config, the first
run starts with an empty `state.json` and re-submits every broker; `aidr config check`
and `aidr doctor` warn about that while a state file is still left at the old location.
Setting only `AIDR_CONFIG_PATH` has the same effect on the state, and gets the same warning.

**Why a directory, and why not `/app/data`.**
- `rename()` onto a Docker single-file bind mount fails with `EBUSY`. A mounted
  `state.json` forces a non-atomic fallback, and the lock, `.bak` and
  `.checkpoint` that sit beside it would live in the container's throwaway
  layer: `--resume` could never find a checkpoint and two containers could not
  see each other's lock. A mounted directory has none of those problems.
- `/app/data` holds the broker datasets that ship with the image
  (`markup-parsed.json`, `badbool-extra.json`, `dead-urls.json`). Mounting
  anything over it hides them and the generic runner loses its broker list. The
  datasets you WRITE (history, caches) go to `aidr-home/data` instead; the
  shipped ones keep loading from the image whatever `AIDR_HOME` says.

**The container runs as uid 1001** (`pwuser`), and the files above are mode
`0600` and owned by you, so without help the container gets `EACCES` on
`config.json` and on every state write. Pick one:

- `sudo chown -R 1001:1001 aidr-home` (shown above), or
- run as the directory's owner instead: add `--user "$(id -u):$(id -g)"` to
  `docker run`, or `AIDR_UID=$(id -u) AIDR_GID=$(id -g) docker compose run ...`.
  Keep `-e HOME=/tmp`; an arbitrary uid has no writable home directory.

**`--init` matters.** Without it node is PID 1, `docker stop` cannot reap the
Chromium children, and the state lock is left behind, wedging the next run. If a
run is killed anyway, `aidr-home/state.json.lock` can be left behind. A lock that
nobody has refreshed for 6 hours is treated as stale and taken over even if its
process id looks alive (a pid recycled after a reboot would otherwise hold it
forever); a running watcher refreshes its own every 5 minutes, so a full run that
takes longer than that is safe. A new container has a new hostname, so it cannot check
the dead one's process id; it takes over a lock whose holder has stopped refreshing
for 15 minutes, instead of waiting the 6 hours. `AIDR_LOCK_MAX_AGE_HOURS` still sets
the 6.

**`TZ` matters.** Containers are UTC. Without it a "1st of the month, 9am"
schedule and every report timestamp land in the wrong hour.

**Low-RAM hosts** (NAS, Raspberry Pi, small VPS): add `-e AIDR_LOW_MEMORY=1`. A
full 40-broker run peaks at about 250 MB either way; the flag trades some render
fidelity for less background work on slow cores.

#### What survives a `--rm` container, and what does not

| Path in the container | Persists? | Notes |
|---|---|---|
| `/home/aidr/config.json` or `config.json.enc` | yes | the mounted directory |
| `/home/aidr/state.json`, `.bak`, `.lock`, `.checkpoint`, `confirm-processed.json` | yes | the mounted directory |
| `/home/aidr/logs/` (run logs, audit reports, snapshots, complaints, reports) | yes | the mounted directory |
| `/home/aidr/inbox/confirms/` (confirmation `.eml` files for `--confirm-emails`) | yes | the mounted directory |
| `/home/aidr/data/serp-history.json`, `exposure-history.json`, `breach-result.json`, `feeds-brokers.json` | yes | the mounted directory |
| `/app/data/*.json` (the shipped broker datasets) | n/a | read-only, part of the image |
| the Chromium profile (`~/.config/auto-identity-remove`) | no | set `profileDir` in the config to a path under `/home/aidr` if you want it kept |

`--serp-watch` has history to diff against, the exposure score has a trend, and
`--update-brokers` has a lasting effect, because their files now live in the
mounted directory. Drop confirmation `.eml` files in `aidr-home/inbox/confirms`
and `--confirm-emails` reads them from there by default; you can also pass any
directory inside the mount, for example `--confirm-emails /home/aidr/inbox/confirms`.

A relative `email.smtp.ca` path resolves against `/app`; use an absolute path
under `/home/aidr` for a certificate you keep in the mounted directory.

> **Synology / NAS users:** see [docs/SYNOLOGY.md](docs/SYNOLOGY.md) for a full
> DSM Container Manager walkthrough that needs no source download and no build,
> measured memory numbers, DSM Task Scheduler setup, and the three defects that used
> to make the container unusable.

### Building the image yourself

You do not need to: the published image above is built from this source by the release
workflow, after it has launched Chromium in it. Build it yourself to work on the tool, for
an architecture the image is not published for, or to run a change that is not released
yet. From the project directory:

```bash
docker build -t auto-identity-remove .
```

Then use `auto-identity-remove` in place of `ghcr.io/stephenlthorn/auto-identity-remove:latest`
in the recipes above. With compose, `docker-compose.build.yml` adds the build to the same
service, and the default `docker-compose.yml` has no `build:` on purpose (its header says why):

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose run --rm watcher node watcher.js --dry-run
```

### Encrypted config and unattended runs

`node watcher.js --encrypt-config` replaces `config.json` with `config.json.enc`
(AES-256-GCM). Every later run needs the passphrase. For a one-off, set
`AIDR_PASSPHRASE` in the environment. A scheduled job has no terminal and never
sets it, so give it a file instead:

```bash
printf '%s\n' 'your passphrase' > aidr-home/aidr.passphrase
chmod 600 aidr-home/aidr.passphrase && sudo chown 1001:1001 aidr-home/aidr.passphrase
# then add to the environment of the run (compose: uncomment the line):
#   AIDR_PASSPHRASE_FILE=/home/aidr/aidr.passphrase
```

`AIDR_PASSPHRASE_FILE` points at a `0600` file whose first line is the
passphrase; it is read only when `AIDR_PASSPHRASE` is unset. Be clear about what
it buys you: a passphrase file next to the encrypted config protects a stolen
copy of `config.json.enc` (a backup, a cloud sync), not someone who can read the
whole directory. Keep the two in directories with different access if that
matters to you. Both `*.passphrase` and `aidr-home/` are gitignored and
dockerignored.

To encrypt inside Docker:

```bash
AIDR_PASSPHRASE='your passphrase' docker compose run --rm -e AIDR_PASSPHRASE \
  watcher node watcher.js --encrypt-config
```

`--encrypt-config` removes `config.json` and then the plaintext copies that sit beside it:
the dashboard's `config.json.bak` and `config.json.unreadable-*.bak`, and the temp files
of an interrupted write. **If `config.json` cannot be deleted** (it is a single-file bind
mount, for example), it is left exactly as it is and the command says so: check that
`config.json.enc` is really on the host, then delete `config.json` yourself. It is never
emptied, because the encrypted copy you just read back may be sitting in the container's
throwaway layer. `aidr config check` and `aidr doctor` warn about any plaintext copy that
remains next to an encrypted config. Re-running `node setup.js` on an encrypted install
re-encrypts in place; the plaintext never touches the disk.

### Webhook notifications (any OS)

When running headless or in Docker you won't have iMessage or a desktop - use
a webhook instead. Set `notify.webhook` in `config.json` to any ntfy.sh,
Slack incoming-webhook, or Discord webhook URL:

```json
"notify": {
  "textTo": "",
  "webhook": "https://ntfy.sh/my-private-channel"
}
```

The tool POSTs `{"text": "<summary>"}` at the end of every real run, and again if the
run crashes (`❌ Privacy Watcher crashed: ...`). A run in which every broker ended in
an error says so (`❌ Privacy Watcher FAILED ...`) and exits `1`. A dry run or a
preview never sends it. The POST gives up after 10 seconds, so a webhook host that
does not answer cannot hold up the end of a run. Works on macOS, Linux, and Windows -
the webhook fires in addition to (not instead of) any platform notification that is
available.

---

## Files

```
auto-identity-remove/
├── setup.js            ← Run once: interactive setup + scheduling
├── watcher.js          ← Main runner
├── brokers.js          ← Broker list with opt-out strategies
├── run.sh              ← Manual trigger
├── config.example.json ← Template (copy → config.json)
├── package.json
├── .gitignore
│
├── config.json         ← YOUR personal info (gitignored, created by setup.js)
├── state.json          ← Opt-out history / skip logic (gitignored)
├── last-run.json       ← Run heartbeat: start, end, outcome, counts (gitignored)
└── logs/               ← Per-run JSON logs and .jsonl journals, audit reports,
                          snapshots/, reports/, complaints/ (gitignored)
```

**Where these live.** Set `AIDR_HOME` to put every runtime file (config, state and its
`.bak` / `.lock` / `.checkpoint`, `last-run.json`, `logs/`, `data/`, `inbox/`) in one
directory instead of the project directory, on any install, not only Docker; the
variables in the [Docker section](#one-directory-holds-everything) (`AIDR_CONFIG_PATH`,
`AIDR_STATE_PATH`, `AIDR_LOG_DIR`, `AIDR_DATA_DIR`, ...) still win over it for one file
each. `aidr doctor` prints every resolved path and what decided it. `run.sh`, the
dashboard and the scheduled job all follow the same variables (the installer carries
them into the job). With none set, nothing moves. With `AIDR_HOME` set, the default inbox
for `node watcher.js --confirm-emails` is `<AIDR_HOME>/inbox/confirms`.

---

## State tracking

`state.json` tracks when each broker was last successfully opted out. The default re-check window is **90 days** - brokers typically re-add your data within that window, so the script re-submits when it's time.

```json
{
  "optOuts": {
    "Spokeo": {
      "lastSuccess": "2026-05-01T09:00:00.000Z",
      "totalRuns": 3,
      "detail": ""
    }
  }
}
```

On each run you'll see:
- `✅ Submitted (form accepted)` - opt-out form was submitted this run
- `📧 Awaiting email confirm` - broker replied "check your email to confirm"; click the link in your inbox. Auto-retried after 14 days if still pending.
- `⏭  Skipped (fresh)` - removed recently, re-check not due yet
- `🔍 Not listed` - your name wasn't found on that site
- `📋 Manual needed` - opened in your browser for you to handle
- `❌ Error` - network/timeout issue, will retry next run
- `💀 Dead (stale URL)` - broker URL is gone (DNS/404); not counted as an error

Every entry is stamped with a short **fingerprint of the person it was written for**
(a hash of the normalised name, ZIP and email; the phone number is not part of it, so
adding a number or writing it `+1 512...` does not re-run anything). If you correct a ZIP
or an email, the old entries no longer match and count as never run, so those
brokers are submitted again at the next run instead of waiting out 90 days; two people
with the same name no longer share an entry's stamp. Entries written before this
(which have no stamp) are trusted, so nothing re-runs just because you upgraded.
`aidr config check` shows how many entries belong to a previous identity, and the
dashboard does not count them as done. If `state.json` cannot be read (a file left
root-owned by a `sudo` run, say), a run refuses to save over it rather than replacing
your whole history; `aidr config check` reports it and tells you how to fix the owner.

> **Submitted ≠ confirmed deleted.** Use `node watcher.js --verify` for spot-check verification. See [STATUS.md](STATUS.md) for a per-broker confidence table.

## Broker health

[STATUS.md](STATUS.md) shows, for every explicit broker, whether its opt-out page still answers and still has the form the definition expects. A weekly GitHub Actions job loads each page with a plain headless browser (no personal data, nothing typed or submitted) and rewrites `data/broker-health.json`; the badges at the top read their numbers from that file, so this page needs no edit when they change. A broker that is `drifted` twice in a row gets an issue titled `Broker drift: <name>`; close one as known with the `wontfix` label and it stays closed.

The labels are `ok` (every selector matches a visible element; for a `manual` broker the page only has to answer, its form is not checked), `drifted` (a selector the definition relies on matches nothing visible, or the page ended up on another site), `blocked` (a bot wall, or a CAPTCHA with not one selector visible: the real page was not seen, so it is never called drifted), `dead` (gone or unresolvable) and `error` (a timeout or server error; shown, never an issue). The check looks at the shape of the form, not at whether a submission deletes anything, and a data centre address is refused by some sites, so run `aidr doctor --brokers` to repeat the check from your own connection. It prints one line per broker and writes nothing.

## How confident should I be?

This tool covers 500+ data brokers in two tiers:

| Tier | Count | Confidence |
|---|---|---|
| **Explicit brokers** ([STATUS.md](STATUS.md)) | 48 | Hand-mapped with specific selectors. **None are currently marked `verified`** - the selectors compile and were correct when written, but none has been re-tested against the live site recently, so any of them may have drifted. |
| **Generic runner** | ~490 | Best-effort heuristic - tries 4 strategies (Do Not Sell click, OneTrust/TrustArc, generic form, DSAR link). Many succeed; some fail silently. |

Be skeptical of the counts this tool prints. Broker sites change their DOM
constantly and a selector that no longer matches fails quietly. That is the
central limitation of the whole approach, not a bug that is about to be fixed.

The `✅ Submitted` count means the form was accepted by the broker. It does **not** prove deletion. To check:

1. Run `node watcher.js --verify` - re-searches each broker where a successful opt-out was recorded and reports whether your name still appears.
2. Look at the `📧 Awaiting email confirm` section after each run - these are half-done until you click the link.

If you want to know exactly which brokers are hand-verified vs heuristic, see [STATUS.md](STATUS.md).

---

## Brokers covered

### Auto-removed (30+)

| Site | Method |
|------|--------|
| Spokeo | Search → find listing → opt-out form |
| WhitePages | Search → find listing → suppression form |
| FastPeopleSearch | Search → opt-out form |
| TruePeopleSearch | Direct opt-out form |
| BeenVerified | Opt-out search form |
| Intelius | Direct opt-out form |
| PeopleFinders | Direct opt-out form |
| PeopleSmart | Direct opt-out form |
| MyLife | Search → opt-out |
| Nuwber | Search → removal form |
| FamilyTreeNow | Direct opt-out form |
| CheckPeople | Direct opt-out form |
| ThatsThem | Direct opt-out form |
| USPhonebook | Direct opt-out form (also searchable by `aidr scan`) |
| SmartBackgroundChecks | Direct opt-out form |
| SearchPeopleFree | Direct opt-out form |
| PeopleSearchNow | Direct opt-out form |
| InfoTracer | Direct opt-out form |
| SocialCatfish | Direct opt-out form |
| NationalPublicData | Direct opt-out form |
| PrivateRecords | Direct opt-out form |
| **Acxiom** | Direct form (feeds dozens of downstream brokers) |
| **LexisNexis** | Direct form (legal/financial data) |
| **ZoomInfo** | Direct form (B2B professional data) |
| **Clearbit** | Direct form (B2B enrichment data) |
| Andrews Wharton | Manual (Stirista opt-out portal) |
| Pipl | Email opt-out via Mail.app |

### Phone numbers (caller ID and reverse phone lookup)

Spam calls are aimed at your number, so these entries are keyed by `person.phone`, not your name. Caller-ID apps build their directories from uploaded contact books; reverse-lookup sites are where call lists get a name for a number.

| Site | Method |
|------|--------|
| Truecaller | Manual - needs an SMS or WhatsApp message sent from your phone to prove it is yours |
| Sync.ME | Removal form (US numbers) |
| CallApp | Unlisting form (needs your number with its country code) |
| NumLookup | Phone opt-out form (US numbers) |
| Hiya | Email to its DPO (Hiya supplies caller ID to Samsung phones and several carriers) |
| Eyecon | Email to its privacy contact |
| National Do Not Call Registry | Manual, one time - stops legitimate telemarketers, not scammers |
| Spy Dialer | Manual - multi-step wizard behind reCAPTCHA Enterprise |

Without a phone number in `config.json` the phone forms are skipped with a reason in the log. A number outside the US and Canada needs a leading `+` and country code for CallApp. The generic runner also types your number into any deletion form that has a phone field, but only alongside your name or email, so a lone phone search box is never submitted.

### Generic - 500+ additional brokers (auto-detected)

`generic-runner.js` handles the remaining ~470 brokers from two public datasets:

| Dataset | Source | Count |
|---------|--------|-------|
| [The Markup's data broker list](https://themarkup.org/privacy/2023/01/26/which-data-brokers-offer-opt-outs) | Journalism research, 494 opt-out URLs | ~494 |
| [BADBOOL](https://github.com/yaelwrites/Big-Ass-Data-Broker-Opt-Out-List) | Community-maintained people-search list | ~27 extra |

For each site it tries four strategies in order:
1. Click a "Do Not Sell My Personal Information" button
2. Opt out via OneTrust / TrustArc / Osano privacy manager
3. Fill any generic opt-out form (email, name, state) and submit
4. Find and record a DSAR / data request link for manual follow-up

Sites requiring manual action are opened in your browser automatically.

### Manual (opened in browser for you)

| Site | Why manual |
|------|-----------|
| Google - Results About You | Requires Google account interaction |
| Google - Outdated Content | Case-by-case URL submission |

---

## Adding more brokers

Edit `brokers.js` and add an entry:

```js
{
  name: 'NewBrokerSite',
  method: 'direct-form',           // or 'search-form', 'email', 'manual'
  optOutUrl: 'https://example.com/opt-out',
  formFields: {
    'input[name*="first" i]': F,   // F, L, N, E, ST, Z are from config
    'input[name*="last"  i]': L,
    'input[type="email"]':    E,
  },
  submitSelector: 'button[type="submit"]',
  captchaLikely: false,
  priority: 2,
}
```

PRs welcome - especially for brokers with verified working selectors.

---

## Manual run

```bash
./run.sh
```

**Dry-run mode** - navigates to each site and fills forms but does NOT submit anything. Good for verifying what the script will do before your first real run:

```bash
node watcher.js --dry-run
```

Or to run in the background and log output:

```bash
./run.sh >> logs/manual-run.log 2>&1 &
```

### Flags are checked, and filters reach every broker

`node watcher.js --help` lists every flag. The command line is checked before
anything runs: an unknown flag, a flag missing its value, a stray word, or two
modes together (`--list --score`) is an error. Nothing is submitted, the closest
flag is suggested, and the exit status is 2. (A misspelt `--dryrun` used to be
ignored, which turned a preview into a real run.)

`--only A,B`, `--skip A,B` and `--retry-failed` apply to the whole run: the
form brokers, the **email** brokers and the 500+ **generic** brokers. Names are
case-insensitive. Together they **narrow** each other: a broker runs when it is
named by `--only`, is in the `--retry-failed` set, and is not named by `--skip`
(`--skip` always wins, so `--retry-failed --skip A` leaves A out). `--only` and
`--skip` also apply to `--pollute`, `--know`, `--verify`, `--scan`, `--serp-scan` and
`--serp-watch`; `--retry-failed` reads a run log that those modes do not use, so it
is refused with them. `--retry-failed` re-runs what the last run log recorded as an
error, a CAPTCHA failure, awaiting an email confirmation, or *unconfirmed* (the
form was sent but the result page could not be read). A filtered or resumed run
marks its log as partial, so the next full run is not compared against it.

`--dry-run` and `--preview` promise that nothing changes, so they are refused (exit
`2`) with the modes that never read them and would otherwise run for real:
`--install-scheduler`, `--uninstall-scheduler`, `--encrypt-config`,
`--decrypt-config`, `--allow`, `--unallow`, `--freeze-done`, `--freeze-clear` and
`--update-brokers`. `--allow` and `--unallow` are modes like the rest: combining
either with another mode (`--list --allow X`) is an error, not a silent no-op.

A relative `AIDR_*` path (`AIDR_HOME`, `AIDR_STATE_PATH`, ...) means relative to the
directory you ran the command from, whether you start the tool with `run.sh` or with
`aidr`, so a scheduled run and a manual one read the same files.

**`--resume` carries on where a killed run stopped, in the generic pass too.** The
run records a checkpoint as it goes: the explicit broker in progress, and, in the
~490-broker generic pass that is most of the wall-clock, the person and the row.
`--resume` skips every person whose explicit pass is finished, continues a
person's generic pass at the recorded row (and skips the generic passes of people
already done), and clears the checkpoint when the run completes. An old
checkpoint (a bare broker name) still works. If the checkpointed broker is no
longer in the list, the pass starts over rather than guess. The checkpoint lives
beside `state.json`. A filtered run (`--only`, `--skip`, `--retry-failed`,
`--captchas`) never writes or clears it, so a killed full run can still be resumed
after one. A person the masked-email relay could not serve is never counted as
finished: `--resume` runs their passes even though the checkpoint is further along.

### The run journal and the heartbeat

Every result is also appended, as it happens, to `logs/run-<timestamp>.jsonl` (mode
`0600`) next to the end-of-run `run-<timestamp>.json` summary, so a crash, an out-of-memory
kill or `docker stop` leaves a log instead of a hole. `--retry-failed` and `aidr
captchas` read the journal when the newest run never wrote its summary (and say so:
brokers a crashed run never reached are not in it, which is what `--resume` is for),
and the diff against the previous run never uses a crashed run as its baseline. A
dry run writes no journal.

Each real opt-out run also writes `last-run.json` beside `state.json`: when it
started, when it ended, `ok` / `partial` / `failed` and the counts, numbers only,
never a name or a broker. A filtered run (`--only`, `--skip`, `--retry-failed`,
`--captchas`) is marked `partial: true` and carries the last full run's record forward
beside its own, so it can never hide a monthly run that failed: `aidr schedule status`
and `aidr doctor` report the last **full** run, with the newer filtered one on a line of
its own. A start with no end reads as `running` while it is younger
than the lock's maximum age (`AIDR_LOCK_MAX_AGE_HOURS`, default 6) and as `crashed`
after. `aidr schedule status` and `aidr doctor` read it. A dry run, `--verify` and the
SERP modes do not write it.

Exit status: `0` finished; `1` could not start (no config, an unedited
`config.example.json`, a malformed `browser` section, another run holds the lock, a
state directory the lock cannot be created in) or finished incomplete (a person
skipped because the masked-email relay was down) or **failed** (every broker ended in
an error, so nothing was submitted; some errors beside some progress still exit `0`,
since an unreachable site is normal); `2` a
bad command line (including a modifier without its mode, such as `--yes` outside
`--purge`), or a check that could not reach a verdict (`--breach-check`,
`--serp-scan`, `--serp-watch` with every search engine unavailable); `130`/`143`
interrupted by Ctrl-C or `docker stop`, after the browser is closed and state is
saved. The read-only commands answer for scripts: `aidr schedule status` exits `0`
for an installed, active job whose last full run did not fail, `1` when none is
installed, `2` when one exists but will not fire and `3` when it is installed and
active but its last full run failed or crashed; `aidr schedule install` exits `1`
and says `NOT installed` when the OS scheduler refused (no cron in the container, a
crontab write that failed); `aidr config check` exits `1` when it finds a problem that would stop
a run (warnings alone exit `0`); `aidr purge` exits `2` when it was told nothing
to confirm with (no terminal and no `--yes`).

### Verifying removals (`--verify`)

Re-search the brokers to see whether previous opt-outs are still in effect:

```bash
node watcher.js --verify
```

This opens a browser and, for each broker where a submission was recorded at least 7 days ago, searches for your listing. No forms are submitted. It **does** write to `state.json`: each checked entry gets `verifiedDeletedAt` (gone after a listing was seen), `verifiedAbsentAt` (not found, and no listing was ever seen) or `verifiedStillListedAt` (found) plus a short `verifyHistory`, which is what `aidr report`, `aidr score` and `aidr complaints` read. It writes no report file; the result is printed to the console only.

The console shows a count for each outcome, then lists every broker that is still listed:

| Outcome | Meaning |
|---------|---------|
| `verified_clear` | A listing was seen before (by `aidr scan` or an earlier verify) and your name is not in the broker's search today: a removal |
| `never_seen` | Your name is not in the broker's search today, but no listing was ever seen there, so nothing was proved removed. It is not counted as a removal, as exposure, or as "unverified" |
| `still_listed` | A listing was found - the opt-out may have failed, or your data was re-added |
| `unverifiable` | The broker has no search step (email, manual, or a form with no search page), or its search page could not be read |
| `skipped` | Nothing to check yet: no recorded submission, submitted fewer than 7 days ago, already verified since the last submission, or allowlisted |

**Important caveats:**

- Only brokers with a search step (a `searchUrl` and a `listingPattern`, whatever their opt-out method) can be checked automatically. Email opt-outs and brokers with no search step are always `unverifiable`.
- A removal counts as verified only when a listing was seen before and is gone after. State written by older versions keeps working: an entry whose `verifiedDeletedAt` is newer than its last submission is still counted as a removal (older versions wrote it for any empty search page, and there is no way to tell which ones were real, so nothing is re-labelled). From now on an empty search page with no recorded sighting is `never_seen` instead.
- "Verified clear" means your name was not found in one search today. It is **not** a legal guarantee of deletion. Brokers routinely re-ingest data from upstream sources.
- "Still listed" can mean the opt-out failed **or** the broker re-added your data since the last successful opt-out was recorded. Either way, re-running `node watcher.js` will attempt removal again.
- If the broker's search page is down or slow, the result is classified as `unverifiable` (a timeout is not counted as "still listed").

### Looking before you submit (`aidr scan`, `aidr run --found-only`)

A normal run submits an opt-out to every broker whether or not it holds a listing
for you. `aidr scan` finds out first:

```bash
aidr scan                       # every broker that can be searched, for each person
aidr scan --only Spokeo,USPhonebook
aidr run --found-only           # submit only where the scan found you
```

`aidr scan` searches each broker that has a search step (a `searchUrl` and a
`listingPattern`, whatever its opt-out method), for each person, in that person's own
browser profile. **It submits nothing and sends no email.** It prints where you were
found, where you were not, where it could not tell (with the reason), and how many brokers
cannot be searched. A listing address carries your name in its path, and output is often
captured to a log, so on an interactive terminal it prints the full URL and anywhere else (cron,
launchd, docker, a redirect) only the host, with one line saying the full URLs are in
`state.json`. `--only` and `--skip` apply. It exits 2
when it could not tell anywhere (every search failed, for instance offline), so a scheduled
scan that learned nothing does not look like a clean one.

The latest result for each person and broker is saved in `state.json` under `scans`
(keyed like the opt-outs), with a short history:

| Result | Meaning |
|--------|---------|
| `found` | The search page showed a listing. The URL is kept and the search page is screenshotted into the snapshots directory (private permissions, and removed by `aidr purge` like the others) |
| `not_found` | The search page loaded and showed no listing. `aidr scan` files it under "Where you were not found" only for a broker whose search step was validated live (`searchCheckedAt` in `brokers.js`); for the others it prints "No listing seen, but this site's search is not validated", because a site whose result links stopped matching would give the same empty answer on a normal results page |
| `unknown` | **Could not tell**: a bot wall, a failed navigation, a non-2xx answer, a browser that would not start. This is never recorded as `not_found` |

Each record also carries `sh`, a one-way hash of the exact search address that was
searched (never the address itself: it holds your name). `--found-only` trusts a record only
when its hash is your current search at that broker, so fixing a wrong state or a full name
in `config.json` makes every older result count as never scanned instead of leaving the old
"not listed" in force for 30 days. A record from an older version has no hash and counts the
same way. A search whose details are blank (no full name, no state) is not made: it is
recorded as could not tell, with the missing detail named, never as not found.

`aidr run --found-only` runs the normal opt-out pass, narrowed by the scan:

- A broker the latest scan says is `found` is submitted. One it says is `not_found` is
  skipped, and the run log says why ("not listed (scan of 2026-11-17)"), but only when that
  broker's search step was validated live. A `found` from any searchable broker is used.
- A listing seen inside `scan.maxAgeDays` is not forgotten because a LATER scan could not tell
  (a bot wall) or came back empty from a search that is not validated: the broker is still
  treated as found. Only a later `not_found` from a validated search overrides a sighting.
- A scan dated more than a day in the future (a wrong clock) is unusable and says so.
- A broker whose scan is `unknown`, older than `scan.maxAgeDays`, missing (or made for
  different details), that cannot be searched at all, or whose empty result comes from a
  search step that was never validated follows `scan.unknown`: `submit` (the default) or
  `skip`. A skip is logged with its reason.
- An email opt-out follows the decision for a searchable entry of the same company (same
  registrable domain as the address's domain or the entry's pages, else the name before
  " (email)"): the Spokeo email is not sent while the Spokeo form is skipped as not listed.
  With several such entries any submit wins. Email entries with no searchable entry for their
  company (Hiya, Eyecon, Pipl) and the ~490 generic brokers cannot be searched, so they follow
  `scan.unknown`. With `skip` the run says in one line that the generic brokers were left out
  and why; with `submit` they run as before.
- Before the opt-out pass it prints one line per person: how many brokers the scan says you
  are listed at (submitted), how many it says you are not (skipped), and why every other
  broker is being submitted or skipped (scan too old, could not tell, never scanned, search not
  validated, cannot be searched). A person with no usable result is told so, and told to run
  `aidr scan` again.
- If NO person has a usable result (none recorded, or every one is too old, could not tell, or
  was made for different details), `--found-only` refuses to start and tells you to run
  `aidr scan` first: otherwise it would be a full run that only looks filtered.
- It combines with `--only`, `--skip` and `--retry-failed` (each narrows the list
  further) and `--dry-run`. It is refused with `--resume` (a checkpoint is a
  position in the full list), `--captchas` (which picks its own brokers) and `--pollute`
  (noise goes to every broker that accepts it, whatever the scan found), and with every other
  mode (each is its own command, not the opt-out run it narrows). `--scan` and `--verify`
  search and submit nothing, so they refuse `--pollute`, `--resume`, `--solve-captchas`,
  `--snapshot` and `--fields` instead of ignoring them. Like any
  filtered run it marks its log as partial and leaves the resume checkpoint alone.

```json
"scan": { "unknown": "submit", "maxAgeDays": 30 }
```

`scan.unknown` is `submit` or `skip`; `scan.maxAgeDays` is a whole number of 1 or more.
A wrong value is a config problem (`aidr config check` reports it), because a mistyped
`skip` would otherwise quietly mean `submit`.

An ordinary run also notes the listing it finds when it searches a broker before
submitting. That sighting counts as evidence for `aidr verify` but does not count as a
scan for `--found-only`.

**Evidence-backed removal.** A removal is verified only when a listing was seen before
(by a scan, a run's own search or an earlier verify) and is gone after. For a broker whose
opt-out starts with the search (method `search-form`, such as Spokeo) a recorded submission is
itself a sighting, because the run only submits after its own search found a listing: state
from before scans existed still counts. A broker that merely has a search step but submits
without looking (USPhonebook) does not get that credit. If `aidr verify`
finds an empty search page and no listing was ever seen, it reports `never seen`, which
is not counted as a removal in the exposure score, the monthly report or the complaints.

A sighting that is NEWER than a "found nothing" check wins: if `aidr verify` saw an empty page on
day 8 and `aidr scan` found the listing on day 18, the score counts it as listed, the report
lists it as listed (not under "Never seen"), and `aidr verify` searches it again instead of
skipping it as already found absent. A scan that finds a listing for someone with no opt-out
history yet also counts as listed in the score.

### Continuous SERP monitoring (`--serp-watch`)

`node watcher.js --serp-watch` runs a search-engine scan, diffs the broker domains it finds against the previous `data/serp-history.json` snapshot, and dispatches an alert (via `lib/notify.js` `dispatchNotify`: macOS toast/iMessage, Linux `notify-send`, and/or the `notify.webhook` URL) only when your name appears on a NEW domain. Because the scan appends to `data/serp-history.json`, repeated runs diff against the prior run. Add `--serp-watch` to `run.sh` to have the existing monthly scheduler watch for new exposures.

---

## Experimental: noise mode

> **WARNING: This feature may violate broker Terms of Service.** Submitting fabricated opt-out requests to data broker sites is ethically questionable and could expose you to legal risk. Use at your own discretion. This feature is **off by default** and is provided only as a research/experimental tool.

The `--pollute N` flag submits `N` randomly-generated fake person records to data brokers that are explicitly tagged `acceptsBogus: true` in `brokers.js`. The goal (inspired by a suggestion on HN) is to flood broker databases with junk records, degrading the accuracy of their search results.

```bash
# Submit 10 bogus records to each acceptsBogus broker
node watcher.js --pollute 10
```

Each fake record uses:
- A random name from a small fixture list (not real people)
- A US city/state/zip from a fixture of 50+ valid combos (not your address)
- A 10-digit phone with an area code valid for the fake state
- A randomised `firstname.lastname+XXXXXX@gmail.com` email

Only brokers tagged `acceptsBogus: true` in `brokers.js` will receive noise submissions. Currently tagged: ThatsThem, SearchPeopleFree, PeopleSearchNow, InfoTracer, SocialCatfish. These are direct-form brokers with no SSN/DOB gate.

**Regular opt-outs run first** - noise submissions happen after the normal run. The `--pollute` flag has no effect on your real opt-out submissions.

---

## Maintenance

### Refreshing the broker list (`--update-brokers`)

The bundled Markup dataset is from January 2023 and is increasingly stale. Refresh the broker coverage from the state data-broker registries that publish a file:

```bash
node watcher.js --update-brokers
```

This reads the California Privacy Protection Agency's current data broker registry over HTTP (no browser is launched), normalizes each entry (preferring the registry's consumer-rights page as the opt-out URL when it is a single http(s) address, otherwise the primary website), dedups it by company against the explicit brokers in `brokers.js`, and writes `data/feeds-brokers.json`. A company is the registrable domain of its primary website, so several brokers whose rights pages share one form platform (a OneTrust portal, a Google Form) stay separate rows. Each broker records which registries list it (`registries`), and the file keeps a `registryHosts` map of the registrable domain of each broker's primary website (never a rights-page host, a shared form platform or a bare suffix like `co.uk`) to the registries that list it, plus a `registries` block with each registry's broker count. The command prints one line per registry with its count or its failure. A registry that fails (an HTML page, an error status, no rows, a file cut off by an unclosed quote, a list under half the size of the earlier one, or, from the official California URL, fewer than 100 brokers) is reported as failed and its rows from the earlier run are kept, with their date; the command exits non-zero only when every registry failed. Other states:

- **Vermont** no longer offers a file export, so it is skipped with a one-line note. Set `VT_REGISTRY_URL` to a CSV of your own to read it.
- **Texas and Oregon** run their registries as web applications only, with no CSV, spreadsheet or JSON export, so they are not read.

The generic runner loads the file alongside the Markup dataset on the next run; the Markup data stays as the fallback, so a failed or skipped refresh never reduces coverage. Override the California URL with `CA_REGISTRY_URL` if the official endpoint moves.

---

### Pruning stale / dead URLs

The Markup dataset is years old; many of the ~489 generic opt-out URLs now 404 or fail DNS lookup. These are classified as `💀 Dead (stale URL)` in run output and do **not** count as errors.

After several runs have accumulated in `logs/`, trim permanently-dead hostnames from future runs so they are skipped without any network request:

```bash
node scripts/prune-dead.js
```

The script:
1. Reads every `logs/run-*.json` file
2. Finds hostnames whose status was `dead` in **every** run they appeared in
3. Merges them into `data/dead-urls.json` (deduped, sorted)
4. Prints a summary of how many new hosts were added

The script is **idempotent** - running it twice produces no change. You can add it as a post-run step or run it manually whenever you want to prune the dead list.

`data/dead-urls.json` is committed to the repo so the dead list is shared with all clones.

---

## The monthly job: `aidr schedule`

```bash
aidr schedule status          # is it installed, active, and how did the last run end?
aidr schedule status --json   # the same, for a script
aidr schedule install         # install or reinstall it (what `node setup.js` offers)
aidr schedule uninstall       # remove it
```

`status` reads the OS scheduler (launchd, systemd or crontab, Task Scheduler) and
`last-run.json`, and prints whether the job exists, whether it is active, what it runs,
which `AIDR_*` paths it carries, and when it last ran and how that ended (`crashed` for a
start that never reported back). It warns if a passphrase has been written into the job
definition, and never prints it. Exit status: `0` installed and active (and its last full
run did not fail), `1` not installed, `2` installed but not active, `3` installed and
active but the last full run failed or crashed. `last run` is always the last **full**
run: a filtered run (`--only`, `--retry-failed`, ...) is shown on a `Partial:` line and
never replaces it. `install` exits `1` and prints `NOT installed` with the reason when the OS
scheduler refused (the setup wizard says the same and fails). `uninstall` removes only the job this tool installed (a
crontab keeps every other line) and reports anything it could not remove.
`aidr doctor` adds the same checks: whether the job is installed and recently run, the
age and holder of the run lock, and whether an encrypted config has a passphrase source
a scheduled run can use.

The Task Scheduler reading (Windows) and the `launchctl list` / `systemctl is-enabled`
answers have not yet been checked against live hosts of every kind; they are read
defensively, and a command that cannot answer reads as "unknown", never as "not installed".

## Uninstall / disable schedule

`aidr schedule uninstall` does all of this for you. By hand:

| Platform | Command |
|----------|---------|
| **macOS** (launchd) | `launchctl unload ~/Library/LaunchAgents/com.auto-identity-remove.plist` then `rm ~/Library/LaunchAgents/com.auto-identity-remove.plist` |
| **Linux** (systemd) | `systemctl --user disable --now auto-identity-remove.timer` then `rm ~/.config/systemd/user/auto-identity-remove.{service,timer}` |
| **Linux** (crontab fallback) | Run `crontab -e` and delete the `auto-identity-remove` line |
| **Windows** (schtasks) | `schtasks /Delete /TN auto-identity-remove /F` |

---

## Checking your config

`aidr config check` reads `config.json` the way a run would and prints, in one pass: every
reason it could not run (blank or still-example fields, a missing file, an encrypted config
with no passphrase, a malformed `browser` section), which config file and passphrase source
are in use, where state lives, and how much of it is stamped with an identity fingerprint. It
also names a config or state file left at the old app-directory location while `AIDR_HOME`
points elsewhere, and any plaintext copy of the config next to an encrypted one. It
also warns about things that run but quietly do something else: a ZIP that lost its leading
zero, two people with one name or one email, a mistyped `captcha.manual`, an unusable
`retention.days`, and a masked-email relay whose sender (`email.smtp.from`, or the login
`email.smtp.user`) is one of your real addresses: `email.smtp.from` must be a dedicated
sending address, see [docs/relay.md](docs/relay.md). It is read-only, never exits on a bad config, and its output is made to be
pasted into a bug report: initials and a masked address instead of names, and never a
passphrase, a key, a proxy password or a quoted piece of the file. Exit `0` for ok (with or
without warnings), `1` for a problem.

## Retention: purging old logs

Run logs, journals, audit reports, full-page screenshots and report PDFs each name you and
the brokers that hold your data, and they accumulate forever. Two ways to trim them:

```bash
aidr purge --dry-run                     # list what would go, delete nothing
aidr purge --older-than 180d             # list it, ask, delete
aidr purge --older-than 6m --yes         # no question (for a script)
```

`--older-than` takes `30`, `180d`, `6m` or `1y` (default: `retention.days` from the config,
else 180 days); anything under 7 days needs `--force`. It lists files by name only, asks
`Delete these N files? [y/N]` (with no terminal and no `--yes` it deletes nothing and exits
2), and never touches **complaints** (legal records), the state, config, lock or checkpoint,
the newest run's log, journal and audit report, symlinks, subdirectories or any file whose
name it does not recognise as its own.

To do it automatically, set `retention.days` and every successful real run purges what is
older than that at its end, never its own files; a dry run purges nothing and a bad value
deletes nothing and says why:

```json
"retention": { "days": 180 }
```

## Browser profiles, proxy and user agent

**One browser profile per person.** Cookies, localStorage and cached logins live in the
browser profile, and one shared profile carried everything a broker learned about person A
into person B's run. Each person now gets their own directory under `profileDir`
(default `~/.config/auto-identity-remove`): `person-<index>-<hash>` (the hash comes from the
same identity as the state fingerprint, so a person who is replaced or whose details change
starts clean; a name never appears in a path). Their context is launched when their turn
comes and the previous one is closed first, so a small NAS still runs **one Chromium at a
time**; the explicit and the generic pass are separate loops, so with two people the browser
is started four times in a full run (one launch each, per pass). The report, the complaint
PDFs and `--confirm-emails` use a separate `utility` profile that belongs to no person. An
existing install keeps its logins: person 0 keeps using the old profile directory itself
while it holds a browser profile and no per-person directory exists, and from then on only
that person may use it.

**Headless user agent.** A headless Chromium announces itself as `HeadlessChrome`, an easy
bot-block. Headless launches now present the matching regular Chrome user agent.

```json
"browser": {
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "proxy": { "server": "http://proxy.example.net:8080", "username": "me", "password": "..." }
}
```

`browser.userAgent` overrides it. `browser.proxy` (`server`, `username`, `password`,
`bypass`) is passed to Playwright for the broker browsers and `--confirm-emails`; the scheme
must be `http://`, `https://` or `socks5://` (no username or password with SOCKS5: Chromium
cannot send them). A misspelt key or a bad proxy **refuses the run**, even a dry run:
launching without the proxy you asked for would send your address to the brokers directly.
The start-of-run banner names the proxy server and says `(authenticated)`; the password never
reaches output, logs or the dashboard (its config editor masks it).

## International users

This tool supports non-US users with a few important caveats.

### What works

- `setup.js` will prompt for **Country** (2-letter ISO code, e.g. `CA`, `GB`, `AU`) and then replace the US-centric "State" / "ZIP code" prompts with **Province/Region** and **Postal code** prompts that accept any format (`K1A 0A6`, `SW1A 1AA`, `2000`, etc.) with no coercion.
- Phone numbers for non-US users are stored verbatim - no `(xxx) xxx-xxxx` reformatting is applied.
- `lib/forms.js` automatically tries province/postal/postcode HTML field variants (e.g. `input[name*="province"]`, `input[name*="postcode"]`) when filling forms for non-US users, with no change needed in broker definitions.
- A country `<select>` on opt-out forms is targeted and filled with your 2-letter country code when present.
- Global brokers (ZoomInfo, Clearbit, Acxiom, etc.) are attempted for all users.

### US-only brokers (automatically skipped for non-US users)

The following brokers are flagged `usOnly: true` and are silently skipped when your configured country is not `US`. These sites index US public records, voter data, or phone directories - a non-US person definitionally has no record to remove there:

| Broker | Reason |
|--------|--------|
| Spokeo | US people-search (state-keyed search) |
| WhitePages | US white-pages directory |
| FastPeopleSearch | US people-search |
| TruePeopleSearch | US people-search |
| BeenVerified | US background-check (requires US state) |
| USPhonebook | US phone directory |
| Sync.ME, NumLookup | Country picker defaults to +1 and is not driven yet |
| National Do Not Call Registry, Spy Dialer | US-only services |

All other brokers in the list are attempted regardless of country.

### What won't help much

US people-search sites (`Spokeo`, `WhitePages`, etc.) hold records sourced from US public records - if you have never lived in the US, your data is very unlikely to appear on these sites. The script skips them for you automatically.

---

## Is it safe to submit my info to 500 opt-out forms?

A fair concern raised by some users: aren't you just confirming your data to the brokers by filling out their forms?

A few things worth knowing:

- **These brokers already have your info.** You're not revealing anything new - you're using the legally-required removal mechanism they're obligated to provide.
- **CCPA (California) and similar state laws require brokers to honor opt-out requests.** Submitting the form creates a legal obligation to remove you. Doing nothing does not.
- **The script uses info you're already listed under** - your name as it appears publicly, your state, your email. It doesn't add new data points.
- **The alternative is worse.** Every month that passes, more brokers scrape and resell your data. Opt-outs are imperfect, but they work more often than not.

That said: if you're in a situation where even confirming your email address to a broker is a risk, this tool is not the right approach. Consider a paid service that uses a proxy email.

---

### California residents: DROP, the one-request deletion (SB 362)

California's Delete Request and Opt-out Platform (DROP) is **live**. It is run by the
California Privacy Protection Agency (branded CalPrivacy) and lets a California resident
send one deletion request that every registered data broker must honor. It has been open
to consumers since 2026-01-01, and registered brokers have had to access it since
2026-08-01. The registry lists several hundred brokers; `aidr drop` prints the current
count once `aidr update-brokers` has run.

- Start at https://consumer.drop.privacy.ca.gov (the information page is https://privacy.ca.gov/drop/).
- It verifies that you live in California through the California Identity Gateway (Socure or
  Login.gov), and asks for your name, date of birth and email. Phone, ZIP code, mobile ad ID,
  vehicle VIN and device ID are optional. One request covers one person.
- You can amend or cancel a request no sooner than 45 days after you submit it.
- The clock, Cal. Civ. Code 1798.99.86(c)(1): a broker must access the platform at least once
  every 45 days and, within 45 days after receiving your request, delete your data. So a broker
  can take up to 90 days from your submission (up to 45 to pick the request up, then up to 45
  to delete). For a request submitted before 2026-08-01 the clock starts on 2026-08-01. After
  that, under (d)(1), the broker must keep deleting new data about you at least every 45 days,
  so one request stays in force.
- Complaints go through the agency's general CCPA complaint form,
  https://cppa.ca.gov/webapplications/complaint . There is no DROP-specific form.

Identity verification means DROP cannot be automated, and aidr does not try. What it does is
described under [`aidr drop`](#aidr-drop-record-your-california-drop-request) below.

#### `aidr drop`: record your California DROP request

```
aidr drop                          # what DROP is, the URL, and where your request stands
aidr drop --done                   # you submitted it today: record it
aidr drop --done --on 2026-09-01   # you submitted it on another day (not in the future, not before 2026-01-01)
aidr drop --done --person "Jane Sample"   # only this person, when config.json lists several
aidr drop --clear                  # remove the record (works even if you no longer live in California)
```

Days are your machine's local calendar days, so `--done` at 17:30 Pacific records that day, not
the next UTC date. `--done` on a request that is already recorded changes nothing and says which
date is recorded (the 90-day clock hangs on it); `--done --on DATE` replaces it. When
`config.json` lists more than one California resident, `--done` and `--clear` need `--person`
so one person's request is never recorded for another. If `--person` matches two configured
people with the same name, it refuses and says what tells them apart (email, zip code), because
the record is kept per name: give one of them a different first or last name. A record carries
the same identity fingerprint as the rest of the state, so a namesake or a replaced person does
not inherit it.

For each California person (state `CA` or `California`, country US or unset) it prints what
DROP is, the URL, what the platform asks for, and one of: *not recorded yet*, *submitted on
DATE and brokers have until DEADLINE*, or *the window passed on DATE*. It also says how many
registry brokers it knows (counted from the registry's own broker count, not from domains); with
none known it tells you to run `aidr update-brokers`. A person
outside California is told DROP is for California residents and nothing changes.

Once a request is recorded:

- The generic pass does not visit a broker that is on the California registry, so fewer companies
  receive your details. A broker counts as on the registry when its row came from the registry
  feed, or when its own website is the primary website of a registry broker; a page on a shared
  form platform (a OneTrust portal, a Google Form) never counts by its host. Each covered row is
  logged as skipped ("covered by your DROP request of DATE") and the run summary counts them. This needs the registry list from `aidr update-brokers`; with
  a recorded request and no list the run says so.
- The explicit brokers in `brokers.js` (the people-search sites) still run: their listings are
  public and a form is often faster.
- After the deadline, `aidr complaints` can draft a complaint to the California agency for a
  registry broker, but only when `aidr verify` saw you still listed after the deadline. It never
  files from the age of a request alone.
- `aidr score` shows how many registry brokers your request covers on a separate line. That is not
  counted as a removal: a broker you have not checked is never treated as verified gone.

To keep submitting to those brokers as well, set `"drop": { "alsoSubmit": true }` in `config.json`.
A mistyped `drop` block (for example `"alsoSubmit": "true"`) turns the skipping off for that run, so
every broker is submitted, and the run prints the config warning once at the start.

After a request is recorded, the `CalPrivacy DROP` entry is listed as done with its date instead of
as a to-do. A complaint treats a listing as seen after the deadline only from 08:00 UTC on the day
after it (past midnight in California in both standard and daylight time).

A real run for a California person with no recorded request prints one line pointing at `aidr drop`.

---

## Why not just use a paid service?

Paid services like [Incogni](https://incogni.com) ($96/yr) or [Optery](https://optery.com) ($39/yr) are excellent and cover more brokers with professionally maintained opt-out flows. This tool is for people who want full control, transparency, and no recurring subscription - or who want to handle the gaps those services miss (Acxiom, LexisNexis, ZoomInfo, Clearbit).

Using both is the strongest approach: a paid service for the bulk of brokers + this script for the gaps.

---

## Security, and how this code is reviewed

`config.json` holds your legal name, home address, phone, date of birth and API
keys. If you find a way for any of that to escape - into a log, a report, the
wrong form field, another local user, or a site chosen by a remote registry -
please report it privately rather than in an issue. See
[SECURITY.md](SECURITY.md).

Most of this codebase was written by an AI model, and the review loop originally
used the same model family, which [issue #8][i8] correctly called an echo
chamber. Files that touch PII, crypto, subprocesses or untrusted network input
now require a review from a *different* model family before merge, and CI builds
the Docker image and launches a real browser rather than grepping the Dockerfile.
The policy, the tooling, and an honest account of what that does and does not buy
you are in [docs/CROSS_MODEL_REVIEW.md](docs/CROSS_MODEL_REVIEW.md).

```bash
npm run review:cross-model        # review the current diff with a non-Anthropic model
```

[i8]: https://github.com/stephenlthorn/auto-identity-remove/issues/8

---

## Releasing

A release is cut by bumping `version` in `package.json` (as `X.Y.Z`) on `main`, with a
matching `## X.Y.Z - <date>` section in [CHANGELOG.md](CHANGELOG.md), which becomes the
release notes. The workflow in `.github/workflows/release.yml` then runs
the tests, builds `auto-identity-remove.tar.gz` and its `.sha256` with
`scripts/release-archive.sh`, and creates the `vX.Y.Z` release with both attached. A
version that already has a release or tag is left alone, and a missing CHANGELOG section
fails the run.

The same run then publishes the container image, `ghcr.io/stephenlthorn/auto-identity-remove`
for `linux/amd64` and `linux/arm64`, tagged `X.Y.Z` and `latest`. The `image` job builds from
the `vX.Y.Z` tag and pushes nothing until Chromium has launched in the built image. If it
fails, the release is already out: start the workflow by hand from `main` (Actions, Release,
Run workflow), which rebuilds the image for the release that exists and does nothing else.

**Once, after the first image is published:** GitHub creates a new package private, and a
linked repository's permissions are inherited but its visibility is not. Until the package
is public, `docker pull` fails with `denied` or `403` for everyone but you. Open the package
(`https://github.com/stephenlthorn/auto-identity-remove/pkgs/container/auto-identity-remove`),
Package settings, Danger Zone, Change visibility, Public. It cannot be made private again.
The package page then shows the pull count for the image.

GitHub counts downloads only for files attached to a release, so the numbers are on the
release assets (`assets[].download_count`):

```bash
gh api repos/stephenlthorn/auto-identity-remove/releases --jq '.[] | {tag: .tag_name, assets: [.assets[] | {name, download_count}]}'
```

---

## License

MIT - see [LICENSE](LICENSE).
