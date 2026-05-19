# Privacy & Data Flow

## TL;DR

This tool runs entirely on your local machine. Your personal information (name, address, email, phone) is sent **only** to data broker opt-out forms via HTTPS - the same brokers that already have your data and that you are asking to remove it. If a broker presents a CAPTCHA, only the CAPTCHA image bytes are forwarded to CapSolver to solve it; your PII is never included in that request. There is no telemetry, no analytics, no central server, and no phone-home of any kind. Nothing about you is logged or stored outside your own machine.

---

## What data is used

All personal data comes exclusively from your local `config.json` file. No data is fetched from external sources or inferred at runtime.

| Field | Description | Required |
|---|---|---|
| `name` | Your full legal name | Yes |
| `address` | Street address | Yes |
| `city` | City | Yes |
| `state` | State / province | Yes |
| `zip` | Postal code | Yes |
| `email` | Email address | Yes |
| `phone` | Phone number | Yes |
| `username` / `password` | Account credentials for brokers that require login | No (optional) |

Your `config.json` is listed in `.gitignore` and is never committed to version control.

---

## Where data goes

| Destination | Data sent | When |
|---|---|---|
| Broker opt-out forms (HTTPS) | name, address, email, phone | every run, per broker |
| CapSolver API (optional) | CAPTCHA image bytes ONLY | only when a broker presents a CAPTCHA |
| Your SMTP server (optional) | email body containing your PII | only for email-method brokers |
| Your webhook URL (optional) | summary text (opt-out counts, broker names) | end of run |

**Notes:**
- All broker form submissions go directly to the broker's own HTTPS endpoint - there is no proxy or intermediary.
- CapSolver receives raw image bytes (a PNG/JPEG of the CAPTCHA challenge). It does not receive your name, address, email, or any other identifying field from `config.json`.
- SMTP and webhook destinations are entirely under your control. You configure them in `config.json` and may leave them blank to disable.

---

## What data is NOT sent

- No telemetry or usage analytics
- No data is sent to any Anthropic, GitHub, or third-party analytics server
- No central server collects opt-out results or tracks which brokers you submitted to
- No phone-home on startup or shutdown
- No third-party tracking libraries are included in `package.json`
- The repository itself contains zero PII - `config.json` and `state.json` are gitignored

---

## Trust assumptions

Using this tool requires accepting the following trust assumptions:

1. **Broker honors opt-out under GDPR/CCPA.** When you submit an opt-out form, you are trusting that the broker will process your removal request in good faith and as required by applicable law. The tool cannot verify compliance after submission.

2. **CapSolver does not log or leak CAPTCHA images.** CapSolver is a third-party service. The tool sends only image bytes to their API. You are trusting that CapSolver does not correlate CAPTCHA images back to individual users or store them beyond the solving session. Review [CapSolver's privacy policy](https://capsolver.com/privacy) if this is a concern. CapSolver is optional - brokers without CAPTCHAs do not trigger any CapSolver call.

3. **Your `config.json` stays on your machine.** The `.gitignore` file prevents `config.json` and `state.json` from being committed. You are responsible for not manually adding them to version control, sharing them, or storing them in an insecure location.

---

## Threat model

### Malicious broker captures submitted opt-out data

**What happens:** A broker records the name, address, email, and phone you submitted in the opt-out form.

**Impact:** Low. The broker already holds this data - that is why you are opting out. Submitting an opt-out does not give them any new information. The data you send is the same data they already have on file about you.

---

### CapSolver is compromised or behaves maliciously

**What happens:** An attacker gains access to CapSolver's systems or CapSolver itself acts dishonestly.

**Impact:** Low. CapSolver receives only raw CAPTCHA image bytes. Your name, address, email, phone, and credentials are never included in CapSolver requests. An attacker who compromises CapSolver cannot obtain your PII from that channel.

---

### Repository accidentally pushed with sensitive files (e.g., `git push` with config.json)

**What happens:** A user accidentally stages and commits `config.json` or `state.json` and pushes to a public repository.

**Impact:** The `.gitignore` file prevents this. `config.json` and `state.json` are listed as ignored files and will not be staged by `git add` unless explicitly forced with `--force`.

Verify this protection is in place at any time:

```bash
cat .gitignore
git ls-files | grep -E 'config|state'
```

The second command should produce no output, confirming neither file is tracked.

---

### Local machine compromise

**What happens:** An attacker gains access to your local filesystem (malware, physical access, etc.).

**Impact:** Same as any local file containing PII. If an attacker can read your filesystem, they can read `config.json`. This is not a risk introduced by this tool - it is the same risk as storing personal data in any local file. Mitigate with full-disk encryption (FileVault on macOS, BitLocker on Windows, LUKS on Linux).

---

## How to verify

Run these commands yourself to confirm the tool's behavior:

```bash
# Confirm config.json and state.json are gitignored (should show both entries)
cat .gitignore

# Confirm neither file is tracked in git (should produce no output)
git ls-files | grep -E 'config|state'

# See exactly what fields would be submitted to each broker, without making
# any network requests
node watcher.js --dry-run --preview

# Re-check your opt-out status on all brokers in read-only mode
# (no form submissions, no state changes)
node watcher.js --verify
```
