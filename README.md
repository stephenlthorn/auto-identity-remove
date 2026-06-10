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

---

## Requirements

- Node.js 18+
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
./node_modules/.bin/aidr setup

# 4. Preview what it will do - submits nothing
./node_modules/.bin/aidr preview

# 5. Run for real anytime
./node_modules/.bin/aidr run
```

> Tip: run `npm link` (or install globally) so you can type `aidr` directly
> instead of `./node_modules/.bin/aidr`.

### The `aidr` command

`aidr` is a friendly wrapper around the underlying scripts. Every subcommand
maps to an existing entrypoint:

| Command | What it does |
|---------|--------------|
| `aidr setup` | Interactive first-run setup (creates `config.json`, schedules the monthly job) |
| `aidr preview` | Dry-run: fills forms but submits nothing |
| `aidr run` | Runs the opt-out pass for real |
| `aidr verify` | Re-searches brokers and reports whether you still appear |
| `aidr score` | Scans search engines for where your name still ranks (SERP scan) |
| `aidr report` | Lists brokers awaiting an email-confirmation click |
| `aidr doctor` | Self-diagnoses your environment and configuration |
| `aidr dashboard` | Starts the local web dashboard and prints its URL + a one-time login |

Pass extra flags straight through, e.g. `aidr run --only Spokeo` or
`aidr preview --skip BeenVerified`. Run `aidr --help` for the full list.

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

The included `Dockerfile` uses the official Playwright image, so Chromium and
all system dependencies are pre-installed. No Mac required.

```bash
# Build the image (once)
docker build -t auto-identity-remove .

# Dry-run (no opt-out forms submitted, no network calls)
docker run --rm \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/state.json:/app/state.json \
  auto-identity-remove node watcher.js --dry-run

# Full run
docker run --rm \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/state.json:/app/state.json \
  auto-identity-remove
```

**Persistent state:** mount `state.json` so completed opt-outs are remembered
between container runs. If the file does not exist yet, create an empty one
first: `echo '{}' > state.json`.

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
| **Explicit brokers** ([STATUS.md](STATUS.md)) | 42 | Hand-mapped with specific selectors. `verified` entries have been tested live; `untested` ones may have drifted since they were added. |
| **Generic runner** | ~490 | Best-effort heuristic - tries 4 strategies (Do Not Sell click, OneTrust/TrustArc, generic form, DSAR link). Many succeed; some fail silently. |

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
| PublicDataUSA | Direct opt-out form |
| SmartBackgroundChecks | Direct opt-out form |
| SearchPeopleFree | Direct opt-out form |
| PeopleSearchNow | Direct opt-out form |
| InfoTracer | Direct opt-out form |
| SocialCatfish | Direct opt-out form |
| NationalPublicData | Direct opt-out form |
| ClustrMaps | Direct opt-out form |
| PrivateRecords | Direct opt-out form |
| **Acxiom** | Direct form (feeds dozens of downstream brokers) |
| **LexisNexis** | Direct form (legal/financial data) |
| **ZoomInfo** | Direct form (B2B professional data) |
| **Clearbit** | Direct form (B2B enrichment data) |
| Pipl | Email opt-out via Mail.app |

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

### Verifying removals (`--verify`)

Run a read-only spot-check to see whether previous opt-outs are still in effect:

```bash
node watcher.js --verify
```

This opens a browser, searches each broker where you have a recorded successful opt-out, and reports what it finds. No forms are submitted, nothing is written to `state.json`.

Output is grouped into three sections:

| Section | Meaning |
|---------|---------|
| `VERIFIED CLEAR` | Your name was not found in the broker's search today |
| `STILL LISTED` | A listing was found - the opt-out may have failed, or your data was re-added |
| `UNVERIFIABLE` | The broker uses a direct-form, email, or manual method - no automated search signal exists to check |

A dated JSON report is saved to `logs/verify-YYYY-MM-DD.json`.

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
| PublicDataUSA | US public records |

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

## License

MIT
