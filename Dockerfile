# Dockerfile - auto-identity-remove
#
# Based on the official Playwright image, which ships Chromium plus every system
# library it needs for both amd64 and arm64.
#
# IMPORTANT: the image tag below must match the `playwright` version pinned in
# package.json. The image contains exactly one Chromium build - the one its own
# Playwright release expects - so a mismatched client fails at launch with
# "Executable doesn't exist at /ms-playwright/chromium-<rev>/chrome-linux/chrome".
# test/docker-build-contract.test.js enforces the match; do not bump one without
# the other.
#
# Prebuilt: every release publishes this image for linux/amd64 and linux/arm64 to
# ghcr.io/stephenlthorn/auto-identity-remove, so you only build it yourself to work
# on the tool or for another architecture. The release workflow builds it from this
# file and launches Chromium in it before it publishes anything.
#
#   docker pull ghcr.io/stephenlthorn/auto-identity-remove:latest
#
# Build:  docker build -t auto-identity-remove .
#
# Everything the container must keep lives in ONE host directory, mounted at
# /home/aidr, and the image already sets AIDR_HOME=/home/aidr: config.json (or
# config.json.enc), state.json and its .bak, .lock and .checkpoint, run logs,
# audit reports, snapshots, complaints, the confirmation inbox, the SERP /
# exposure / breach / registry caches (in data/) and an optional passphrase file.
# Mount a directory, never single files (rename() onto a file mount fails with
# EBUSY, and the lock, .bak and checkpoint would stay in the throwaway container
# layer), and never mount over /app/data (it holds the shipped broker datasets).
#
#   mkdir -p aidr-home && sudo chown -R 1001:1001 aidr-home
#   docker run --rm --init \
#       -v "$(pwd)/aidr-home:/home/aidr" \
#       -e HOME=/tmp \
#       auto-identity-remove
#
# Coming from the first recipe, which bind-mounted config.json and state.json as two single
# files at /app? Those mounts are ignored now: the image reads AIDR_HOME. Copy BOTH files into
# the directory above. A run that finds them at /app instead says where they must go.
#
# The container user is pwuser (uid 1001). Either chown the directory to 1001 as
# above, or add --user "$(id -u):$(id -g)" so it runs as the directory's owner.
# AIDR_CONFIG_PATH, AIDR_CONFIG_ENC_PATH, AIDR_STATE_PATH, AIDR_LOG_DIR and
# AIDR_DATA_DIR still override AIDR_HOME for any one file.
#
# Tip: pass --dry-run to preview without submitting anything:
#   docker run --rm --init ... auto-identity-remove node watcher.js --dry-run
#
# Low-RAM hosts (Synology NAS, Raspberry Pi, small VPS): add
#   -e AIDR_LOW_MEMORY=1
# See docs/SYNOLOGY.md for measured numbers and the full NAS walkthrough.

FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# Install Node dependencies (Playwright browsers already in base image)
RUN npm ci --omit=dev

# Playwright browsers are bundled in the base image at /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# One directory holds everything the container keeps (see the header). Mount it
# at this path and nothing else needs configuring.
ENV AIDR_HOME=/home/aidr

# Copy application source
COPY . .

# Run as non-root. The base image already ships `pwuser` (uid/gid 1001) with a
# home directory and the right access to /ms-playwright, so reuse it - creating
# another account at uid 1001 collides with it and aborts the build.
#
# /home/aidr is AIDR_HOME, where the recommended host directory is mounted (see
# the header). Creating it here means an unmounted `docker run` still has
# somewhere writable; the app makes logs/, data/ and the rest as it needs them.
RUN mkdir -p /home/aidr/logs && chown -R pwuser:pwuser /app /home/aidr

USER pwuser

# Default command - override with e.g. `node watcher.js --dry-run`
CMD ["node", "watcher.js"]
