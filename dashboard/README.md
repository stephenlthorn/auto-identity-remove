# Dashboard (optional web UI)

A small, self-contained web control panel for `auto-identity-remove`. It is
**optional** and additive - the CLI works exactly as before without it.

It wraps the existing tooling rather than reimplementing it:

- **Brokers** - reads `../brokers.js` and `../state.json` to show every broker,
  its method/priority/scope, and current opt-out status (success / pending /
  error / not-listed / manual), with a per-row "preview this broker" button.
- **Runs** - buttons for every CLI mode (preview, real, verify, doctor, list,
  pending, confirm-emails, retry-failed, serp-scan, snapshot) with live
  streamed output (SSE) and `--only` / `--skip` filters.
- **Config editor** - a form over `../config.json` (person, CapSolver, SMTP,
  notifications, broker accounts). Secrets (CapSolver key, SMTP password,
  webhook, account passwords) are masked in transit and preserved on save
  unless you type a new value. If `../config.json` doesn't exist yet the form is
  prefilled from `../config.example.json` and the first Save creates it (`0600`).
- **Schedule** - enable/disable and set the cadence of a systemd timer (see
  *Scheduling* below).
- **Logs** - browses `../logs/`. A dated report is written when a real run
  *completes*, so the list is empty mid-run (watch the live console instead).
- **Admin** - change the login from the browser (see *Auth* below).

The only dependency is `express`.

## Run

```bash
cd dashboard
npm install
AIDR_PORT=8080 AIDR_USER=admin AIDR_PASS='a-strong-password' node server.js
# open http://localhost:8080
```

## Auth

Set credentials via env; the app authenticates **itself** (so it doesn't depend
on a reverse proxy for access control):

| Var | Default | Meaning |
|-----|---------|---------|
| `AIDR_PORT` | `8080` | Listen port |
| `AIDR_HOST` | `127.0.0.1` | Bind address. Defaults to loopback (local access only). Set `AIDR_HOST=0.0.0.0` **only** if you intend LAN/public access (use a reverse proxy with TLS). |
| `AIDR_USER` / `AIDR_PASS` | _(unset)_ | HTTP Basic credentials. **Both must be set** for the env credentials to be active (setting only one is treated as misconfigured and logs a warning). When set, **all routes except `/api/health`** require them (browser-native login prompt). |
| `AIDR_TOKEN` | _(unset)_ | Token accepted **only** via the `X-AIDR-Token` header (for scripts/automation). Not accepted via query string. |
| `AIDR_ALLOWED_HOSTS` | _(unset)_ | Comma-separated host names the dashboard may be reached under, besides `localhost` / `127.0.0.1` / `[::1]` and the concrete address in `AIDR_HOST`. Needed when you bind `0.0.0.0` and browse by LAN name or through a reverse proxy; any other `Host` header gets a 403 (DNS-rebinding defense). |
| `AIDR_AUTH_FILE` | `dashboard/.auth.json` | Where credentials changed in the Admin tab are stored (use it when the install directory is read-only). |
| `AIDR_CONFIG_PATH` / `AIDR_CONFIG_ENC_PATH` / `AIDR_STATE_PATH` | repo root | Relocate `config.json`, `config.json.enc` and `state.json`. The dashboard reads and writes the same files `watcher.js` does, and hands them to the runs it starts. |
| `AIDR_PASSPHRASE` | _(unset)_ | Needed when the config is encrypted (`config.json.enc`). Without it the dashboard reports the config as **locked** and refuses to overwrite it. |

A request is allowed if it satisfies **either** valid Basic credentials **or** a
valid token. Cross-origin state-changing requests are rejected (CSRF defense).
If none of the three are set the dashboard runs **unauthenticated** (and logs a
warning) - only acceptable on a trusted, isolated network. Credentials are
compared in constant time.

Failed logins are rate limited per client address (10 per minute, then `429`
until the window passes), and a non-loopback `AIDR_HOST` with no credentials set
is refused at start-up instead of merely warned about.

### Changing the login (Admin tab)

`AIDR_USER`/`AIDR_PASS` are the **bootstrap** credentials. When you change the
password from the **Admin** tab, the new username + a salted `scrypt` hash are
written atomically to `dashboard/.auth.json` (gitignored, `0600`), which then
**overrides** the env vars - no restart needed. Delete `.auth.json` to fall back
to the env credentials. Changing the password requires the current one. If
`.auth.json` is ever corrupt, the app **fails closed** (all logins denied) until
it is fixed or removed - it never silently downgrades to open access.

## Scheduling

The **Schedule** tab manages a systemd timer (`aidr.timer`) that periodically
runs `node watcher.js`. Presets: **daily / weekly / monthly** (03:30 local with
30-min jitter). This requires the dashboard to run **as root** in the target
environment, and the timer activates `aidr.service`, which you must install.

Example units are in [`examples/`](examples/):

- `examples/aidr-dashboard.service` - runs this dashboard (set your creds here).
- `examples/aidr.service` - the oneshot the timer triggers (`node watcher.js`).

Copy them to `/etc/systemd/system/`, edit paths/creds, then
`systemctl daemon-reload && systemctl enable --now aidr-dashboard`. After that
the Schedule tab can enable/disable `aidr.timer` and switch cadence.

## What the dashboard writes

- **Config saves** (`PUT /api/config`) keep a `0600` copy of what they replace as
  `config.json.bak` (or `config.json.enc.bak`). If the stored config cannot be
  read (wrong `AIDR_PASSPHRASE`, a truncated file) the save is refused with a
  `409` instead of replacing it with just the form fields; resend with
  `"overwrite": true` to replace it on purpose, which also keeps a timestamped
  `config.json.unreadable-*.bak` copy of the unreadable file. Treat the `.bak`
  files like `config.json`: they hold the same personal data, so keep them out
  of version control and images.
- **Multi-person configs** (`persons: [...]`): the Person section edits the first
  person; the others are changed in `config.json`. A blank `person` is never
  written next to `persons`.
- **Freeze checklist** writes `state.json` under the same lock `watcher.js` uses
  and answers `409` while a run is active or another process holds the lock.

## Security notes

The config holds personal data and the UI can trigger real opt-out submissions,
so set `AIDR_USER`/`AIDR_PASS` (and optionally `AIDR_TOKEN` for automation). The
server binds `127.0.0.1` by default (loopback only); set `AIDR_HOST=0.0.0.0` if
you need LAN access and use a TLS-terminating reverse proxy. `/api/health` is
intentionally unauthenticated and returns only `{ ok: true }` (no path or
version disclosure).

Every response carries `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; `/api/*` is
`Cache-Control: no-store`. The spawned watcher does not inherit `AIDR_USER`,
`AIDR_PASS` or `AIDR_TOKEN`. Stopping the dashboard (SIGTERM / SIGINT) stops a
run it started.
