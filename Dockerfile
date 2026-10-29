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
# Build:  docker build -t auto-identity-remove .
#
# Everything the container must keep lives in ONE host directory, mounted at
# /home/aidr: config.json (or config.json.enc), state.json and its .bak, .lock
# and .checkpoint, and an optional passphrase file. Mount a directory, never
# single files (rename() onto a file mount fails with EBUSY, and the lock, .bak
# and checkpoint would stay in the throwaway container layer), and never mount
# over /app/data (it holds the shipped broker datasets).
#
#   mkdir -p aidr-home/logs && sudo chown -R 1001:1001 aidr-home
#   docker run --rm --init \
#       -v "$(pwd)/aidr-home:/home/aidr" \
#       -v "$(pwd)/aidr-home/logs:/app/logs" \
#       -e AIDR_CONFIG_PATH=/home/aidr/config.json \
#       -e AIDR_CONFIG_ENC_PATH=/home/aidr/config.json.enc \
#       -e AIDR_STATE_PATH=/home/aidr/state.json \
#       -e HOME=/tmp \
#       auto-identity-remove
#
# The container user is pwuser (uid 1001). Either chown the directory to 1001 as
# above, or add --user "$(id -u):$(id -g)" so it runs as the directory's owner.
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

# Copy application source
COPY . .

# Run as non-root. The base image already ships `pwuser` (uid/gid 1001) with a
# home directory and the right access to /ms-playwright, so reuse it - creating
# another account at uid 1001 collides with it and aborts the build.
#
# /home/aidr is where the recommended host directory is mounted (see the header).
# Creating it here means an unmounted `docker run` still has somewhere writable.
RUN mkdir -p /home/aidr/logs && chown -R pwuser:pwuser /app /home/aidr

USER pwuser

# Default command - override with e.g. `node watcher.js --dry-run`
CMD ["node", "watcher.js"]
