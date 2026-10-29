# Running on a Synology NAS (and other small boxes)

Asked in [issue #8](https://github.com/stephenlthorn/auto-identity-remove/issues/8):
does this run on a DS720+ (Celeron J4125, x86_64, 2 GB RAM), and what is the
memory footprint in practice?

**Short answer:** yes, and comfortably - about **250 MB peak** for a full
40-broker run. But nobody had actually tried it before that issue, and three
defects meant it could not have worked. All three are fixed; the numbers below
are measured, not estimated.

## What was broken before this was tested

| | Symptom on a NAS |
|---|---|
| `docker build` aborted | `groupadd: GID '1001' already exists` - the Dockerfile created a user at uid/gid 1001, which the official Playwright base image already uses for `pwuser`. The image never built, for anyone. |
| Browser could not launch | The base image was pinned to Playwright v1.52.0 (ships chromium build 1169) while `npm ci` installed the Playwright client 1.60.0 (needs build 1223). Even with the build fixed, every run died with `Executable doesn't exist at /ms-playwright/chromium-1223/...`. |
| No state was ever saved | Every durable write is tmp-file + `rename()`. `rename()` onto a Docker **single-file** bind mount returns `EBUSY`, and the documented recipe mounted `state.json` exactly that way. Nothing persisted, so each scheduled run re-submitted every broker from scratch. |
| The documented recipe still could not work | It mounted the project over `/app/data` (hiding the shipped broker datasets), never told the app where `config.json` was, left the lock, `.bak` and resume checkpoint in the throwaway container layer, and ignored that the container runs as uid 1001 while DSM files you create are owned by your own uid (1026 for the first admin) at mode `0600`: `EACCES` on the config. Step 3 and 4 below fix all of it. |

`test/docker-build-contract.test.js` and the `docker` job in CI now build the
image and launch a real browser on every push, so this class of failure cannot
ship again silently.

## Measured footprint

Full 40-broker serial run inside the container, using cgroup v2 accounting
(`memory.peak`), not process RSS:

| Configuration | Peak | Result |
|---|---|---|
| Default profile, uncapped | **248.5 MB** | all 40 brokers |
| `AIDR_LOW_MEMORY=1`, hard 700 MB cap | **235.8 MB** | all 40 brokers |
| After launch, before any broker | 140 MB | - |

Memory is **flat across the run** - 236 MB after 10 brokers, 248 MB after 40 - so
there is no page or context leak that compounds over a long run. The tool
processes brokers strictly serially, one page at a time, which is what keeps the
ceiling low.

For contrast: five heavy pages open *simultaneously* peaks at ~1.5 GB. That is
what would OOM a 2 GB box, and it is why this tool stays serial. Do not add
concurrency here without revisiting these numbers.

Image size on disk, `linux/amd64` (the DS720+ architecture): **940 MB**. Most of
that is the Chromium build in the Playwright base image.

So on a 2 GB DS720+, with DSM itself typically using 600-900 MB, a ~250 MB
container leaves real headroom. 2 GB is enough; you do not need the RAM upgrade
for this.

### Caveats on those numbers, stated plainly

- Measured on Docker Desktop 28.0.4, `linux/arm64`. The `linux/amd64` image is
  verified to build and is what a DS720+ runs; Chromium's footprint on amd64 is
  in the same range, but I have not measured it on the J4125 itself.
- The test page is a representative opt-out form plus a 4,000-node DOM and a
  canvas. Real broker pages carry ad and tracker JavaScript and will run higher.
  Budget ~400 MB rather than 250 MB before you consider it tight.
- J4125 is four slow cores. Expect a full run to take noticeably longer than on a
  laptop. It is a monthly unattended job, so that does not matter much.

## Setup on DSM 7 (Container Manager)

### 1. Put the project somewhere on a volume

SSH in (Control Panel → Terminal & SNMP → Enable SSH):

```bash
cd /volume1/docker
git clone https://github.com/stephenlthorn/auto-identity-remove.git
cd auto-identity-remove
```

### 2. Create your config on a machine with a browser

Run `node setup.js` on your laptop, then copy the resulting `config.json` into a
new `aidr-home` directory on the NAS. The wizard is interactive and wants a
browser for the account-creation steps, so it is not a good fit for a headless
NAS.

```bash
ssh admin@nas.local 'mkdir -p /volume1/docker/auto-identity-remove/aidr-home/logs'
scp config.json admin@nas.local:/volume1/docker/auto-identity-remove/aidr-home/
```

`aidr-home` is the one place the container keeps anything: your config,
`state.json` and its `.bak`, `.lock` and resume `.checkpoint`, and (through a
second mount) the run logs. Back it up and treat it like `config.json`.

### 3. Lock down the files and give the container access

`config.json` holds your legal name, home address, phone and API keys. On a NAS
with family accounts this matters more than on a laptop. The container runs as
uid 1001, so the directory has to belong to it:

```bash
cd /volume1/docker/auto-identity-remove
chmod 700 aidr-home && chmod 600 aidr-home/config.json
sudo chown -R 1001:1001 aidr-home
```

The tool writes its own files `0600` too, but the copy you scp'd in has whatever
mode it arrived with. If you would rather not hand the files to uid 1001, leave
them yours and run the container as you instead: `AIDR_UID=$(id -u)
AIDR_GID=$(id -g) docker compose run ...` (compose passes it as `user:`), or
`--user "$(id -u):$(id -g)"` with `docker run`. Without one of the two, the first
run fails with `EACCES` reading `config.json`.

**Encrypted config on a schedule.** If you ran `--encrypt-config`, DSM Task
Scheduler has no terminal to type the passphrase into. Put it on the first line
of a `0600` file inside `aidr-home` and point `AIDR_PASSPHRASE_FILE` at it:

```bash
printf '%s\n' 'your passphrase' > aidr-home/aidr.passphrase
chmod 600 aidr-home/aidr.passphrase && sudo chown 1001:1001 aidr-home/aidr.passphrase
# then uncomment AIDR_PASSPHRASE_FILE=/home/aidr/aidr.passphrase in docker-compose.yml
```

The file sits next to the config it unlocks, so it protects a stolen copy of
`config.json.enc`, not someone who can read the whole directory.

### 4. Mount the directory, not individual files

This is the one thing to get right. Mounting `state.json` as a file breaks
atomic writes (`EBUSY`, see above) and leaves the lock, `.bak` and checkpoint in
the container layer. Mounting anything over `/app/data` hides the shipped broker
datasets. Mount `aidr-home` and point the app inside it:

```bash
docker build -t auto-identity-remove .

docker run --rm --init \
  -e TZ=America/New_York \
  -e AIDR_LOW_MEMORY=1 \
  -v /volume1/docker/auto-identity-remove/aidr-home:/home/aidr \
  -v /volume1/docker/auto-identity-remove/aidr-home/logs:/app/logs \
  -e AIDR_CONFIG_PATH=/home/aidr/config.json \
  -e AIDR_CONFIG_ENC_PATH=/home/aidr/config.json.enc \
  -e AIDR_STATE_PATH=/home/aidr/state.json \
  -e HOME=/tmp \
  --memory=1g \
  auto-identity-remove node watcher.js --dry-run
```

Or with compose, from the project directory, which already carries all of that:

```bash
TZ=America/New_York AIDR_LOW_MEMORY=1 docker compose run --rm watcher node watcher.js --dry-run
```

Always do a `--dry-run` first. It navigates and confirms the brokers are
reachable without submitting anything.

Not everything is kept: `serp-history.json`, `exposure-history.json` and
`feeds-brokers.json` are written under `/app/data` inside the container and do
not survive `--rm` (see the README's table of what persists). Opt-outs, state,
resume and logs are unaffected.

### 5. Schedule it

Do not use the in-container scheduler on a NAS - use DSM's own. Control Panel →
Task Scheduler → Create → Scheduled Task → User-defined script, monthly on the
1st at 09:00:

```bash
cd /volume1/docker/auto-identity-remove && /usr/local/bin/docker compose run --rm watcher
```

Check the docker path with `which docker` over SSH; DSM has moved it between
versions. The task runs as root by default, but the container itself still runs
as the `user:` in `docker-compose.yml` (uid 1001 unless you set `AIDR_UID`), so
`aidr-home` must belong to that uid. On an encrypted config the task needs
`AIDR_PASSPHRASE_FILE` (step 3); it has no terminal to ask.

## Settings that matter on a small box

| Setting | Why |
|---|---|
| `AIDR_LOW_MEMORY=1` | Adds `--disable-gpu`, `--no-zygote` and friends. Saved ~13 MB peak in testing - small, but it also cuts background work on slow cores. |
| `TZ=<your zone>` | Containers are UTC. Without this a "1st of the month, 9am" schedule and every report timestamp land in the wrong hour. |
| `--init` / `init: true` | Otherwise node is PID 1, `docker stop` cannot reap the Chromium children, and the state lock is left behind - wedging the next run. |
| `user:` / `--user` | The image runs as uid 1001. Either `chown -R 1001:1001 aidr-home` or run as your own uid, otherwise `EACCES` on the config and on every state write. Keep `HOME=/tmp` when you override it. |
| `--memory=1g` | Not required (peak is ~250 MB) but it turns a runaway into a container restart instead of DSM killing something else. |
| `shm_size` | The compose file sets 512 MB. Not strictly needed - the code passes `--disable-dev-shm-usage`, so a plain `docker run` with the default 64 MB `/dev/shm` works - but real shared memory is faster. |

## What does not work on a NAS

- **Desktop notifications.** `notify-send` needs a session bus. Use the SMTP
  report (`notify.emailReportTo` in config) or a webhook.
- **iMessage / `osascript` notifications.** macOS only.
- **The interactive `setup.js` wizard.** Some steps want a real browser. Run it
  elsewhere and copy `config.json` over.
- **Headed mode.** There is no display. The tool auto-detects this (Linux with no
  `DISPLAY` → headless) so you do not need to set anything.

## If something goes wrong

```bash
# Is the browser actually launchable in your image?
docker run --rm auto-identity-remove node -e \
  "require('playwright').chromium.launch({headless:true}).then(b=>{console.log('browser OK');return b.close()})"

# Does the image agree with the client about Playwright versions?
docker run --rm auto-identity-remove sh -c 'ls /ms-playwright; node -p "require(\"playwright-core/package.json\").version"'

# Is state actually being written? (look for aidr-home/state.json afterwards,
# then delete the "probe" entry from it - or just `rm aidr-home/state.json` if
# this is a brand new install)
docker compose run --rm watcher node -e \
  "const c=require('/app/lib/config');c.recordSuccess('probe','t');c.saveState();console.log('state write OK ->', c.getStatePath())"
```

If you have a DS720+ and run this, please report back on
[issue #8](https://github.com/stephenlthorn/auto-identity-remove/issues/8) - real
hardware numbers are better than my emulated ones.
