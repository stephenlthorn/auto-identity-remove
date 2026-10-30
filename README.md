# auto-identity-remove

![CI](https://github.com/stephenlthorn/auto-identity-remove/actions/workflows/test.yml/badge.svg)

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
- **Close the loop** - re-verify removals (`aidr verify`), watch search engines for new listings (`aidr serp-watch`), and generate a monthly PDF report (`aidr report`)
- **Add teeth** - send CCPA/GDPR right-to-know requests (`aidr know`) and auto-generate regulator complaints when a broker blows the legal deadline (`aidr complaints`)
- **Protect proactively** - check Have I Been Pwned (`aidr breach`) and walk a credit/identity-freeze checklist (`aidr freeze`)
- **Stay private** - submit from a masked relay email (SimpleLogin), encrypt `config.json` at rest (AES-256-GCM, opt-in via `AIDR_PASSPHRASE`), and detect success/confirmation text in 6 languages
- **Run from a browser** - an optional local web dashboard with a first-run config wizard, live run console, status board and a **History** tab of past runs (`aidr dashboard`)
- **Stay in control of the job** - solve the CAPTCHAs a solver cannot (`aidr captchas`), check and remove the monthly job (`aidr schedule`), resume a killed run, check your config (`aidr config check`) and purge old PII files (`aidr purge`)
- **Keep coverage fresh** - pull the broker list from the official California (SB 362) and Vermont registries (`aidr update-brokers`), and keep brokers you *want* to stay listed on via an allowlist

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
# 1. Clone the repo
git clone https://github.com/stephenlthorn/auto-identity-remove.git
cd auto-identity-remove

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

### The `aidr` command

`aidr` is a friendly wrapper around the underlying scripts. Every subcommand
maps to an existing entrypoint:

| Command | What it does |
|---------|--------------|
| `aidr setup` | Interactive first-run setup (creates `config.json`, schedules the monthly job) |
| `aidr preview` | Dry-run: fills forms but submits nothing |
| `aidr run` | Runs the opt-out pass for real |
| `aidr captchas` | Re-runs only the brokers that ended on a CAPTCHA last time, in a visible browser, so you can solve them |
| `aidr verify` | Re-searches brokers and reports whether you still appear |
| `aidr score` | Prints your 0-100 exposure score and its month-over-month trend |
| `aidr report` | Generates the monthly PDF + emails the summary |
| `aidr pending` | Lists brokers awaiting an email-confirmation click |
| `aidr serp` | Scans search engines for where your name still ranks |
| `aidr serp-watch` | Scans and alerts only when your name appears on a NEW domain |
| `aidr breach` | Checks Have I Been Pwned and recommends a credit freeze on high-severity breaches |
| `aidr freeze` | Shows the credit/identity-freeze checklist and its status |
| `aidr complaints` | Generates regulator complaints for brokers past the CCPA/GDPR deadline |
| `aidr know` | Sends CCPA/GDPR right-to-know requests |
| `aidr update-brokers` | Refreshes the broker list from the CA + Vermont registries |
| `aidr list` | Lists configured brokers and their last-known status |
| `aidr doctor` | Self-diagnoses your environment and configuration |
| `aidr config check` | Checks `config.json`, the passphrase source and where state lives; exits 1 on a problem |
| `aidr schedule status` | Shows whether the monthly job is installed and how its last run ended (`--json` for scripts) |
| `aidr schedule install` | Installs (or reinstalls) the monthly job |
| `aidr schedule uninstall` | Removes the monthly job |
| `aidr purge` | Deletes old logs, audit reports and screenshots, which hold your details (never complaints or the latest run) |
| `aidr dashboard` | Starts the local web dashboard and prints its URL + a one-time login |

Pass extra flags straight through, e.g. `aidr run --only Spokeo` or
`aidr preview --skip BeenVerified`. Run `aidr --help` for the full list.
Every subcommand maps to the equivalent `node watcher.js --<flag>` invocation
(`aidr schedule status` is `--schedule-status`, `aidr config check` is
`--config-check`). `aidr schedule` with no verb shows the status; an unknown
verb (`aidr schedule remove`) stops with the list of real ones before anything runs.

> A native desktop wrapper (Electron/Tauri) is a planned follow-up and is **not**
> included here - this release is clean CLI packaging only.

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
run lock the whole time, and a lock older than `AIDR_LOCK_MAX_AGE_HOURS` (default 6) is
treated as abandoned: raise it for a very long manual session.

---

## Running with Docker

The `Dockerfile` uses the official Playwright image, so Chromium and all system
dependencies are pre-installed. No Mac required. Builds for `linux/amd64` and
`linux/arm64`; the amd64 image is about 940 MB.

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
# Once, from the project directory
mkdir -p aidr-home
cp config.json aidr-home/config.json        # made on a laptop with `node setup.js`
chmod 700 aidr-home && chmod 600 aidr-home/config.json
sudo chown -R 1001:1001 aidr-home           # the container user is uid 1001

docker build -t auto-identity-remove .
```

```bash
# Dry-run - navigates and checks reachability, submits nothing
docker run --rm --init \
  -v "$(pwd)/aidr-home:/home/aidr" \
  -e HOME=/tmp \
  -e TZ="$(date +%Z)" \
  auto-identity-remove node watcher.js --dry-run

# Full run: the same command without the trailing `node watcher.js --dry-run`
```

Or with compose, which already carries the mount and the variable:
`docker compose run --rm watcher node watcher.js --dry-run`.

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
run is killed anyway, `aidr-home/state.json.lock` can be left behind; delete it
once you are sure no run is active. A lock older than 6 hours is treated as stale
and taken over even if its process id looks alive (a pid recycled after a
reboot would otherwise hold it forever); if a full multi-person run really takes
longer, set `AIDR_LOCK_MAX_AGE_HOURS` (for example `12`) so a second run cannot
take the lock from a live one.

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
> DSM Container Manager walkthrough, measured memory numbers, DSM Task Scheduler
> setup, and the three defects that used to make the container unusable.

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

The tool POSTs `{"text": "<summary>"}` after every run. Works on macOS, Linux,
and Windows - the webhook fires in addition to (not instead of) any platform
notification that is available.

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
(a hash of the normalised name, ZIP, email and phone digits). If you correct a ZIP
or an email, the old entries no longer match and count as never run, so those
brokers are submitted again at the next run instead of waiting out 90 days; two people
with the same name no longer share an entry's stamp. Entries written before this
(which have no stamp) are trusted, so nothing re-runs just because you upgraded.
`aidr config check` shows how many entries belong to a previous identity.

> **Submitted ≠ confirmed deleted.** Use `node watcher.js --verify` for spot-check verification. See [STATUS.md](STATUS.md) for a per-broker confidence table.

## How confident should I be?

This tool covers 500+ data brokers in two tiers:

| Tier | Count | Confidence |
|---|---|---|
| **Explicit brokers** ([STATUS.md](STATUS.md)) | 51 | Hand-mapped with specific selectors. **None are currently marked `verified`** - the selectors compile and were correct when written, but none has been re-tested against the live site recently, so any of them may have drifted. |
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
| Radaris | Search → privacy form |
| Intelius | Direct opt-out form |
| PeopleFinders | Direct opt-out form |
| PeopleSmart | Direct opt-out form |
| MyLife | Search → opt-out |
| Nuwber | Search → removal form |
| FamilyTreeNow | Direct opt-out form |
| CheckPeople | Direct opt-out form |
| ThatsThem | Direct opt-out form |
| USPhonebook | Direct opt-out form |
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
case-insensitive. `--retry-failed` re-runs what the last run log recorded as an
error, a CAPTCHA failure, awaiting an email confirmation, or *unconfirmed* (the
form was sent but the result page could not be read). A filtered or resumed run
marks its log as partial, so the next full run is not compared against it.

**`--resume` carries on where a killed run stopped, in the generic pass too.** The
run records a checkpoint as it goes: the explicit broker in progress, and, in the
~490-broker generic pass that is most of the wall-clock, the person and the row.
`--resume` skips every person whose explicit pass is finished, continues a
person's generic pass at the recorded row (and skips the generic passes of people
already done), and clears the checkpoint when the run completes. An old
checkpoint (a bare broker name) still works. If the checkpointed broker is no
longer in the list, the pass starts over rather than guess. The checkpoint lives
beside `state.json`.

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
never a name or a broker. A start with no end reads as `running` while it is younger
than the lock's maximum age (`AIDR_LOCK_MAX_AGE_HOURS`, default 6) and as `crashed`
after. `aidr schedule status` and `aidr doctor` read it. A dry run, `--verify` and the
SERP modes do not write it.

Exit status: `0` finished; `1` could not start (no config, an unedited
`config.example.json`, a malformed `browser` section, another run holds the lock) or
finished incomplete (a person skipped because the masked-email relay was down); `2` a
bad command line (including a modifier without its mode, such as `--yes` outside
`--purge`), or a check that could not reach a verdict (`--breach-check`,
`--serp-scan`, `--serp-watch` with every search engine unavailable); `130`/`143`
interrupted by Ctrl-C or `docker stop`, after the browser is closed and state is
saved. The read-only commands answer for scripts: `aidr schedule status` exits `0`
for an installed, active job, `1` when none is installed and `2` when one exists but
will not fire; `aidr config check` exits `1` when it finds a problem that would stop
a run (warnings alone exit `0`); `aidr purge` exits `2` when it was told nothing
to confirm with (no terminal and no `--yes`).

### Verifying removals (`--verify`)

Re-search the brokers to see whether previous opt-outs are still in effect:

```bash
node watcher.js --verify
```

This opens a browser and, for each broker where a submission was recorded at least 7 days ago, searches for your listing. No forms are submitted. It **does** write to `state.json`: each checked entry gets `verifiedDeletedAt` (not found) or `verifiedStillListedAt` (found) plus a short `verifyHistory`, which is what `aidr report`, `aidr score` and `aidr complaints` read. It writes no report file; the result is printed to the console only.

The console shows a count for each outcome, then lists every broker that is still listed:

| Outcome | Meaning |
|---------|---------|
| `verified_clear` | Your name was not found in the broker's search today |
| `still_listed` | A listing was found - the opt-out may have failed, or your data was re-added |
| `unverifiable` | The broker uses a direct-form, email, or manual method (no automated search signal exists), or its search page could not be read |
| `skipped` | Nothing to check yet: no recorded submission, submitted fewer than 7 days ago, already verified since the last submission, or allowlisted |

**Important caveats:**

- Only `search-form` brokers (those with a `searchUrl` and `listingPattern`) can be checked automatically. Direct-form and email opt-outs are always `unverifiable`.
- "Verified clear" means your name was not found in one search today. It is **not** a legal guarantee of deletion. Brokers routinely re-ingest data from upstream sources.
- "Still listed" can mean the opt-out failed **or** the broker re-added your data since the last successful opt-out was recorded. Either way, re-running `node watcher.js` will attempt removal again.
- If the broker's search page is down or slow, the result is classified as `unverifiable` (a timeout is not counted as "still listed").

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

The bundled Markup dataset is from January 2023 and is increasingly stale. Refresh the broker coverage from the official, auto-updating state data-broker registries:

```bash
node watcher.js --update-brokers
```

This fetches the California (SB-362) and Vermont registries over HTTP (no browser is launched), normalizes each entry, dedups it by hostname against the explicit brokers in `brokers.js`, and writes `data/feeds-brokers.json`. The generic runner loads that file alongside the Markup dataset on the next run; the Markup data stays as the fallback, so a failed or skipped refresh never reduces coverage. Override the registry URLs with the `CA_REGISTRY_URL` / `VT_REGISTRY_URL` environment variables if the official endpoints move.

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
definition, and never prints it. Exit status: `0` installed and active, `1` not installed,
`2` installed but not active. `uninstall` removes only the job this tool installed (a
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
also warns about things that run but quietly do something else: a ZIP that lost its leading
zero, two people with one name or one email, a mistyped `captcha.manual`, an unusable
`retention.days`. It is read-only, never exits on a bad config, and its output is made to be
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
- Global brokers (ZoomInfo, Clearbit, Acxiom, Radaris, etc.) are attempted for all users.

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

### California residents: DROP delete portal (SB 362)

California's Delete Request and Opt-out Platform (DROP), established by SB 362,
will eventually let residents submit a single deletion request that all
California-registered data brokers must honor. The platform is operated by the
California Privacy Protection Agency (CPPA).

**Status as of late 2025: not yet live.** The broker-side compliance deadline
in SB 362 is August 1, 2026. CPPA has missed several preceding milestones and
ongoing litigation (Data Brokers Association v. Bonta) may further delay things.

See: https://cppa.ca.gov/data_broker_registry/

Until DROP is live, this tool falls back to per-broker opt-out flows for
California-registered brokers.

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

## License

MIT - see [LICENSE](LICENSE).
