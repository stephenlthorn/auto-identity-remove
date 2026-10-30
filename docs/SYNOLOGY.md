# Running on a Synology NAS (and other small boxes)

Asked in [issue #8](https://github.com/stephenlthorn/auto-identity-remove/issues/8):
does this run on a DS720+ (Celeron J4125, x86_64, 2 GB RAM), and what is the
memory footprint in practice?

**Short answer:** yes, and comfortably - about **250 MB peak** for a full
40-broker run. But nobody had actually tried it before that issue, and three
defects meant it could not have worked. All three are fixed; the numbers below
are measured, not estimated.

**You do not build anything on the NAS.** Every release publishes a prebuilt
image, `ghcr.io/stephenlthorn/auto-identity-remove`, for `linux/amd64` (the
DS720+) and `linux/arm64`. Before that, the only way on was to download the
source and `docker build` a 940 MB Playwright image on a Celeron. The setup below
pulls the image instead, and building from source is a short
[alternative](#alternative-build-from-source) at the end of it.

## What was broken before this was tested

| | Symptom on a NAS |
|---|---|
| `docker build` aborted | `groupadd: GID '1001' already exists` - the Dockerfile created a user at uid/gid 1001, which the official Playwright base image already uses for `pwuser`. The image never built, for anyone. |
| Browser could not launch | The base image was pinned to Playwright v1.52.0 (ships chromium build 1169) while `npm ci` installed the Playwright client 1.60.0 (needs build 1223). Even with the build fixed, every run died with `Executable doesn't exist at /ms-playwright/chromium-1223/...`. |
| No state was ever saved | Every durable write is tmp-file + `rename()`. `rename()` onto a Docker **single-file** bind mount returns `EBUSY`, and the documented recipe mounted `state.json` exactly that way. Nothing persisted, so each scheduled run re-submitted every broker from scratch. |
| The documented recipe still could not work | It mounted the project over `/app/data` (hiding the shipped broker datasets), never told the app where `config.json` was, left the lock, `.bak` and resume checkpoint in the throwaway container layer, and ignored that the container runs as uid 1001 while DSM files you create are owned by your own uid (1026 for the first admin) at mode `0600`: `EACCES` on the config. Steps 1 to 4 below fix all of it. |

`test/docker-build-contract.test.js` and the `docker` job in CI now build the
image and launch a real browser on every push, and the release workflow does the
same before it publishes the image, so this class of failure cannot ship again
silently.

## Measured footprint

**Every number in this section was measured on Docker Desktop on an Apple
Silicon Mac (`linux/arm64`), not on a Synology and not on x86.** Full 40-broker
serial run inside the container, using cgroup v2 accounting (`memory.peak`), not
process RSS:

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

Nothing to download and nothing to build: the setup is one directory, `aidr-home`,
and the published image. Every path below assumes `/volume1/docker`, so change
that to a shared folder you have.

### 1. Create the home directory and put your config in it

Run `node setup.js` on your laptop (the README's Quick Start installs it), then
copy the resulting `config.json` into a new `aidr-home` directory on the NAS. The
wizard is interactive and wants a browser for the account-creation steps, so it is
not a good fit for a headless NAS. To get a shell on the NAS, enable SSH under
Control Panel → Terminal & SNMP.

```bash
ssh admin@nas.local 'mkdir -p /volume1/docker/aidr-home'
scp config.json admin@nas.local:/volume1/docker/aidr-home/
```

`aidr-home` is the one place the container keeps anything (the image sets
`AIDR_HOME=/home/aidr` and you mount `aidr-home` there): your config,
`state.json` and its `.bak`, `.lock` and resume `.checkpoint`, the run logs,
audit reports, snapshots and complaints (`logs/`), the confirmation inbox
(`inbox/`), and the SERP, exposure and broker-registry history (`data/`). The app
creates those subdirectories itself. Back it up and treat it like `config.json`.

### 2. Lock down the files and give the container access

`config.json` holds your legal name, home address, phone and API keys. On a NAS
with family accounts this matters more than on a laptop. The container runs as
uid 1001, so the directory has to belong to it:

```bash
cd /volume1/docker
chmod 700 aidr-home && chmod 600 aidr-home/config.json
sudo chown -R 1001:1001 aidr-home
```

The tool writes its own files `0600` too, but the copy you scp'd in has whatever
mode it arrived with. If you would rather not hand the files to uid 1001, leave
them yours and run the container as you instead: add `--user "$(id -u):$(id -g)"`
to the `docker run` lines below (`AIDR_UID` and `AIDR_GID` are the same thing for
the compose file). Without one of the two, the first run fails with `EACCES`
reading `config.json`.

**Encrypted config on a schedule.** If you ran `--encrypt-config`, DSM Task
Scheduler has no terminal to type the passphrase into. Put it on the first line
of a `0600` file inside `aidr-home` and point `AIDR_PASSPHRASE_FILE` at it:

```bash
printf '%s\n' 'your passphrase' > aidr-home/aidr.passphrase
chmod 600 aidr-home/aidr.passphrase && sudo chown 1001:1001 aidr-home/aidr.passphrase
# then add  -e AIDR_PASSPHRASE_FILE=/home/aidr/aidr.passphrase  to the docker run lines below
```

The file sits next to the config it unlocks, so it protects a stolen copy of
`config.json.enc`, not someone who can read the whole directory.

### 3. Get the image

Either way you end up with `ghcr.io/stephenlthorn/auto-identity-remove` on the
NAS. It is a GitHub Container Registry image, not a Docker Hub one.

**Over SSH.** One command, and it is the one that does not depend on DSM's screens:

```bash
docker pull ghcr.io/stephenlthorn/auto-identity-remove:latest
```

If DSM answers `permission denied`, put `sudo` in front.

**In Container Manager.** Open Registry → Settings and add `https://ghcr.io` if
the list only shows Docker Hub, then search for `stephenlthorn/auto-identity-remove`
and download the `latest` tag. I wrote this from DSM's documentation and have not
clicked through it on a NAS: registries other than Docker Hub do not always
support DSM's search box, and if it finds nothing, use the SSH command above.

`latest` is the newest release. To stay on a version you have checked, use its tag
instead, for example `ghcr.io/stephenlthorn/auto-identity-remove:2.0.1`, in this
command and in the two `docker run` lines below. The tags are on the
[package page](https://github.com/stephenlthorn/auto-identity-remove/pkgs/container/auto-identity-remove).

### 4. Mount the directory, not individual files, and do a dry run

This is the one thing to get right. Mounting `state.json` as a file breaks
atomic writes (`EBUSY`, see above) and leaves the lock, `.bak` and checkpoint in
the container layer. Mounting anything over `/app/data` hides the shipped broker
datasets. Mount `aidr-home` once, at `/home/aidr`, and let `AIDR_HOME` point the
app inside it (the image sets it, so there is nothing to pass):

```bash
docker run --rm --init \
  -e TZ=America/New_York \
  -e AIDR_LOW_MEMORY=1 \
  -v /volume1/docker/aidr-home:/home/aidr \
  -e HOME=/tmp \
  --memory=1g \
  ghcr.io/stephenlthorn/auto-identity-remove:latest node watcher.js --dry-run
```

Always do a `--dry-run` first. It navigates and confirms the brokers are
reachable without submitting anything.

Everything that should outlive a `--rm` container is in `aidr-home`: opt-outs,
state, resume, logs, and the `serp-history.json`, `exposure-history.json`,
`breach-result.json` and `feeds-brokers.json` files under `aidr-home/data` (see
the README's table of what persists). The datasets that ship with the image stay
in `/app/data` and are read-only.

**Upgrading from the older recipe.** It used a second mount for the logs and set
`AIDR_CONFIG_PATH=/home/aidr/config.json`,
`AIDR_CONFIG_ENC_PATH=/home/aidr/config.json.enc` and
`AIDR_STATE_PATH=/home/aidr/state.json` one by one. Those variables still work
and `AIDR_HOME=/home/aidr` is the same thing for all of them. The old `/app/logs`
mount is no longer needed: logs default to `/home/aidr/logs`, which is the same
host directory (`aidr-home/logs`), so nothing has to move.

### 5. Schedule it

Do not use the in-container scheduler on a NAS - use DSM's own. Control Panel →
Task Scheduler → Create → Scheduled Task → User-defined script, monthly on the
1st at 09:00, with this as the script. It is the dry run without its last two
words, and it needs nothing else on the NAS:

```bash
docker run --rm --init \
  -e TZ=America/New_York \
  -e AIDR_LOW_MEMORY=1 \
  -v /volume1/docker/aidr-home:/home/aidr \
  -e HOME=/tmp \
  --memory=1g \
  ghcr.io/stephenlthorn/auto-identity-remove:latest
```

Check the docker path with `which docker` over SSH, and use the full path in the
script if the task cannot find it; DSM has moved it between versions. The task runs
as root by default, but the container itself runs as uid 1001 (or as the `--user`
you added), so `aidr-home` must belong to that uid. On an encrypted config the
task needs `-e AIDR_PASSPHRASE_FILE=/home/aidr/aidr.passphrase` (step 2); it has no
terminal to ask.

### Updating

A scheduled run uses the image already on the NAS and never updates it, so a run
cannot change behind your back. To update, pull again over SSH, or download the tag
again in Container Manager:

```bash
docker pull ghcr.io/stephenlthorn/auto-identity-remove:latest
```

The next run uses it. If you pinned a version tag, such as
`ghcr.io/stephenlthorn/auto-identity-remove:2.0.1`, change it in the two `docker run`
lines instead. What changed between releases is in the
[CHANGELOG](../CHANGELOG.md), and `aidr-home` is never touched by an update.

## Alternative: build from source

Only if you want to build the image yourself: you are working on the tool, you
need an architecture the image is not published for, or you want a change that is
not released yet. It needs the source on the NAS and a build on the NAS's CPU,
which is the slow thing the prebuilt image saves you. Download the latest release
and build it:

```bash
cd /volume1/docker
curl -L -O https://github.com/stephenlthorn/auto-identity-remove/releases/latest/download/auto-identity-remove.tar.gz
tar xzf auto-identity-remove.tar.gz
cd auto-identity-remove
docker build -t auto-identity-remove .
```

Then use `auto-identity-remove` in place of `ghcr.io/stephenlthorn/auto-identity-remove:latest` in
the `docker run` lines in steps 4 and 5. Everything else in the setup is the same.
To update, repeat the `curl` and `tar` lines from `/volume1/docker` (your `aidr-home`
is not in the archive, so it stays) and run the `docker build` again.

Prefer git, to track `main`? Use this instead of the download. It is the alternative
for contributors, and needs `git` on the NAS:

```bash
cd /volume1/docker
git clone https://github.com/stephenlthorn/auto-identity-remove.git
cd auto-identity-remove
```

The compose file in that directory pulls the published image by default. To build
from the source instead, see the header of `docker-compose.yml`.

## Settings that matter on a small box

| Setting | Why |
|---|---|
| `AIDR_LOW_MEMORY=1` | Adds `--disable-gpu`, `--no-zygote` and friends. Saved ~13 MB peak in testing - small, but it also cuts background work on slow cores. |
| `TZ=<your zone>` | Containers are UTC. Without this a "1st of the month, 9am" schedule and every report timestamp land in the wrong hour. |
| `--init` / `init: true` | Otherwise node is PID 1, `docker stop` cannot reap the Chromium children, and the state lock is left behind - wedging the next run. |
| `user:` / `--user` | The image runs as uid 1001. Either `chown -R 1001:1001 aidr-home` or run as your own uid, otherwise `EACCES` on the config and on every state write. Keep `HOME=/tmp` when you override it. |
| `--memory=1g` | Not required (peak is ~250 MB) but it turns a runaway into a container restart instead of DSM killing something else. |
| `--shm-size` / `shm_size` | The compose file sets 512 MB. Not needed on the NAS - the code passes `--disable-dev-shm-usage`, so the plain `docker run` above, with the default 64 MB `/dev/shm`, works - but real shared memory is faster. |

## What does not work on a NAS

- **Desktop notifications.** `notify-send` needs a session bus. Use the SMTP
  report (`notify.emailReportTo` in config) or a webhook.
- **iMessage / `osascript` notifications.** macOS only.
- **The interactive `setup.js` wizard.** Some steps want a real browser. Run it
  elsewhere and copy `config.json` over.
- **Headed mode.** There is no display. The tool auto-detects this (Linux with no
  `DISPLAY` → headless) so you do not need to set anything.

## If something goes wrong

**"config.json not found" right after an upgrade.** If you set the container up with
the very first recipe, which bind-mounted `config.json` and `state.json` as two single
files at `/app`, those mounts are ignored now: the image sets `AIDR_HOME=/home/aidr` and reads everything
from the one directory you mount there. The run says where it found your files and where
they must go. Copy **both** into `aidr-home` (`cp config.json state.json aidr-home/`) and
mount the directory as in step 4. Copying only the config makes the next run re-submit every
broker, because the history stayed behind; `node watcher.js config check` warns about that
while a `state.json` is still left at the old location (run it like the dry run in step 4,
with `node watcher.js config check` as the last words of the command).

**`--encrypt-config` says it could not delete `config.json`.** A single-file mount cannot
be removed from inside the container. The file is left untouched (never emptied: the
encrypted copy may only exist in the container's throwaway layer). Check that
`aidr-home/config.json.enc` is really on the volume, then delete `config.json` from DSM
yourself. `config check` also lists any plaintext copy (`config.json.bak` from the
dashboard, for example) that sits next to an encrypted config.

**`docker pull` says `denied`, `unauthorized` or `403`.** The package may not be public
yet, or the name has a typo. It is `ghcr.io/stephenlthorn/auto-identity-remove`, all
lower case. Say so on [issue #8](https://github.com/stephenlthorn/auto-identity-remove/issues/8).

```bash
# Is the browser actually launchable in your image?
docker run --rm ghcr.io/stephenlthorn/auto-identity-remove node -e \
  "require('playwright').chromium.launch({headless:true}).then(b=>{console.log('browser OK');return b.close()})"

# Does the image agree with the client about Playwright versions?
docker run --rm ghcr.io/stephenlthorn/auto-identity-remove sh -c 'ls /ms-playwright; node -p "require(\"playwright-core/package.json\").version"'

# Is state actually being written? (look for aidr-home/state.json afterwards,
# then delete the "probe" entry from it - or just `rm aidr-home/state.json` if
# this is a brand new install)
docker run --rm --init -e HOME=/tmp -v /volume1/docker/aidr-home:/home/aidr \
  ghcr.io/stephenlthorn/auto-identity-remove node -e \
  "const c=require('/app/lib/config');c.recordSuccess('probe','t');c.saveState();console.log('state write OK ->', c.getStatePath())"
```

If you built the image yourself, use `auto-identity-remove` for the image name in these.

If you have a DS720+ and run this, please report back on
[issue #8](https://github.com/stephenlthorn/auto-identity-remove/issues/8) - real
hardware numbers are better than my emulated ones.
