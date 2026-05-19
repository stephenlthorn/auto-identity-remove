# Dockerfile — auto-identity-remove
#
# Based on the official Playwright image which ships Chromium + all deps
# pre-installed for both amd64 and arm64.
#
# Build:  docker build -t auto-identity-remove .
# Run:    docker run --rm -v $(pwd)/config.json:/app/config.json \
#                         -v $(pwd)/state.json:/app/state.json \
#                         auto-identity-remove
#
# Tip: pass --dry-run to preview without submitting anything:
#   docker run --rm ... auto-identity-remove node watcher.js --dry-run

FROM mcr.microsoft.com/playwright:v1.44.0-focal

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# Install Node dependencies (Playwright browsers already in base image)
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Run as non-root for security
RUN groupadd --gid 1001 appuser && \
    useradd --uid 1001 --gid appuser --shell /bin/bash --create-home appuser && \
    chown -R appuser:appuser /app

USER appuser

# Default command — override with e.g. `node watcher.js --dry-run`
CMD ["node", "watcher.js"]
