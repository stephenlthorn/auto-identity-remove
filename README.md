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
- **Run from a browser** - an optional local web dashboard with a first-run config wizard, live run console, and status board (`aidr dashboard`)
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
| `aidr dashboard` | Starts the local web dashboard and prints its URL + a one-time login |

Pass extra flags straight through, e.g. `aidr run --only Spokeo` or
`aidr preview --skip BeenVerified`. Run `aidr --help` for the full list.
Every subcommand maps to the equivalent `node watcher.js --<flag>` invocation.

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
└── logs/               ← Per-run JSON logs (gitignored)
```

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

Exit status: `0` finished; `1` could not start (no config, an unedited
`config.example.json`, another run holds the lock) or finished incomplete (a
person skipped because the masked-email relay was down); `2` a bad command line,
or a check that could not reach a verdict (`--breach-check`, `--serp-scan`,
`--serp-watch` with every search engine unavailable); `130`/`143` interrupted by
Ctrl-C or `docker stop`, after the browser is closed and state is saved.

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

## Uninstall / disable schedule

| Platform | Command |
|----------|---------|
| **macOS** (launchd) | `launchctl unload ~/Library/LaunchAgents/com.auto-identity-remove.plist` then `rm ~/Library/LaunchAgents/com.auto-identity-remove.plist` |
| **Linux** (systemd) | `systemctl --user disable --now auto-identity-remove.timer` then `rm ~/.config/systemd/user/auto-identity-remove.{service,timer}` |
| **Linux** (crontab fallback) | Run `crontab -e` and delete the `auto-identity-remove` line |
| **Windows** (schtasks) | `schtasks /Delete /TN auto-identity-remove /F` |

---

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
