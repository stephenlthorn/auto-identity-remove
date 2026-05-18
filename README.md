# auto-identity-remove

Automated data broker opt-out runner for **macOS and Linux**. Removes your personal information from **500+ people-search sites and data broker databases** on a monthly schedule — with CAPTCHA solving, persistent state tracking (so completed opt-outs aren't resubmitted every run), and a desktop notification when done.

## What it does

Each month, the script:

1. **Searches** each data broker site for your name + state
2. **Finds your specific listing** (for sites that need a profile URL)
3. **Fills and submits** the opt-out form automatically
4. **Solves CAPTCHAs** via [CapSolver](https://capsolver.com) (AI-powered, ~$0.001/solve)
5. **Skips** brokers you were already removed from recently (90-day re-check window)
6. **Notifies you** with the results summary (iMessage on macOS, desktop notification on Linux)
7. **Opens** any sites that require manual action in your browser

---

## Requirements

- **macOS** or **Linux** (Ubuntu, Debian, Fedora, Arch, etc.)
- Node.js 18+
- [Playwright](https://playwright.dev) browsers installed
- (Linux only) `notify-send` for desktop notifications (install `libnotify-bin` on Ubuntu/Debian)
- (Linux only, for email opt-outs) `sendmail` or `mailutils` package

```bash
npx playwright install chromium
```

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/stephenlthorn/auto-identity-remove.git
cd auto-identity-remove

# 2. Install dependencies
npm install

# 3. (Linux only) Install system dependencies
#    Ubuntu/Debian:  sudo apt install libnotify-bin sendmail
#    Fedora:         sudo dnf install libnotify msmtp
#    Arch:           sudo pacman -S libnotify msmtp

# 4. Run interactive setup (creates config.json and schedules the monthly job)
node setup.js

# 5. Run manually anytime
./run.sh
```

---

## Setup walkthrough

`node setup.js` guides you through:

| Step | What it does |
|------|-------------|
| **Personal info** | Name, city, state, ZIP, email, phone |
| **Aliases** | Past names or variations (e.g. "Steve Doe") |
| **CapSolver key** | For CAPTCHA-protected opt-out forms |
| **One-time accounts** | Creates accounts on sites that require login (stored in `config.json`, gitignored) |
| **iMessage / Desktop** | Phone number to iMessage results to (macOS), or desktop notification (Linux) |
| **Schedule** | Registers a monthly job to run on the 1st at 9am (launchd on macOS, systemd timer on Linux) |

**Your personal info never leaves your machine.** `config.json` and `state.json` are both gitignored.

---

## CapSolver (optional but recommended)

Some opt-out forms have reCAPTCHA. Without CapSolver, those sites go to your manual list instead of being handled automatically.

1. Sign up at [capsolver.com](https://capsolver.com) — free, pay-as-you-go
2. Add $1–2 of credits (enough for months of use at ~$0.001/solve)
3. Paste your API key when `setup.js` asks, or add it to `config.json`:

```json
"capsolver": {
  "apiKey": "CAP-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

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

`state.json` tracks when each broker was last successfully opted out. The default re-check window is **90 days** — brokers typically re-add your data within that window, so the script re-submits when it's time.

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
- `✅ Removed` — opt-out submitted this run
- `⏭  Skipped (fresh)` — removed recently, re-check not due yet
- `🔍 Not listed` — your name wasn't found on that site
- `📋 Manual needed` — opened in your browser for you to handle
- `❌ Error` — network/timeout issue, will retry next run

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
| Pipl | Email opt-out |

### Generic — 500+ additional brokers (auto-detected)

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
| Google — Results About You | Requires Google account interaction |
| Google — Outdated Content | Case-by-case URL submission |

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

PRs welcome — especially for brokers with verified working selectors.

---

## Manual run

```bash
./run.sh
```

**Dry-run mode** — navigates to each site and fills forms but does NOT submit anything. Good for verifying what the script will do before your first real run:

```bash
node watcher.js --dry-run
```

Or to run in the background and log output:

```bash
./run.sh >> logs/manual-run.log 2>&1 &
```

---

## Uninstall / disable schedule

**macOS:**
```bash
launchctl unload ~/Library/LaunchAgents/com.auto-identity-remove.plist
rm ~/Library/LaunchAgents/com.auto-identity-remove.plist
```

**Linux:**
```bash
systemctl --user stop auto-identity-remove.timer
systemctl --user disable auto-identity-remove.timer
rm ~/.config/systemd/user/auto-identity-remove.service
rm ~/.config/systemd/user/auto-identity-remove.timer
```

---

## Is it safe to submit my info to 500 opt-out forms?

A fair concern raised by some users: aren't you just confirming your data to the brokers by filling out their forms?

A few things worth knowing:

- **These brokers already have your info.** You're not revealing anything new — you're using the legally-required removal mechanism they're obligated to provide.
- **CCPA (California) and similar state laws require brokers to honor opt-out requests.** Submitting the form creates a legal obligation to remove you. Doing nothing does not.
- **The script uses info you're already listed under** — your name as it appears publicly, your state, your email. It doesn't add new data points.
- **The alternative is worse.** Every month that passes, more brokers scrape and resell your data. Opt-outs are imperfect, but they work more often than not.

That said: if you're in a situation where even confirming your email address to a broker is a risk, this tool is not the right approach. Consider a paid service that uses a proxy email.

---

## California residents: DELETE Registry (August 2025)

California is launching an official **Delete Me** opt-out registry on August 1, 2025. Once registered, data brokers are legally required to delete your info automatically — no individual form submissions needed for participating brokers.

Register at: **[optoutregistry.oag.ca.gov](https://optoutregistry.oag.ca.gov)** (live August 1)

**Recommended:** Register with the CA Delete Registry first, then run this script for the brokers that aren't covered.

---

## Why not just use a paid service?

Paid services like [Incogni](https://incogni.com) ($96/yr) or [Optery](https://optery.com) ($39/yr) are excellent and cover more brokers with professionally maintained opt-out flows. This tool is for people who want full control, transparency, and no recurring subscription — or who want to handle the gaps those services miss (Acxiom, LexisNexis, ZoomInfo, Clearbit).

Using both is the strongest approach: a paid service for the bulk of brokers + this script for the gaps.

---

## License

MIT
