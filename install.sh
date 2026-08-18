#!/usr/bin/env bash
# install.sh - one-command setup for auto-identity-remove.
#
# Run once after cloning:   bash install.sh
#
# Checks Node, installs dependencies, installs the Playwright Chromium browser,
# and prints what to do next. No personal data is touched here.

set -e

cd "$(dirname "$0")"

echo ""
echo "auto-identity-remove - installer"
echo "--------------------------------"

# 1. Node present?
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed."
  echo "Install Node 18 or newer from https://nodejs.org and re-run: bash install.sh"
  exit 1
fi

# 2. Node version >= 18 ?
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18 or newer is required (found $(node -v))."
  echo "Upgrade from https://nodejs.org and re-run: bash install.sh"
  exit 1
fi
echo "Node $(node -v) detected."

# 3. Install dependencies (reproducible - uses package-lock.json).
echo ""
echo "Installing dependencies (npm ci)..."
npm ci

# 3b. Install the dashboard's own dependencies (it's a separate package).
if [ -f "dashboard/package.json" ]; then
  echo ""
  echo "Installing dashboard dependencies..."
  if [ -f "dashboard/package-lock.json" ]; then
    npm ci --prefix dashboard
  else
    npm install --prefix dashboard
  fi
fi

# 4. Install the Chromium browser Playwright drives.
echo ""
echo "Installing the Chromium browser (npx playwright install chromium)..."
npx playwright install chromium

# 5. Install the dashboard's own dependencies.
#    express lives in dashboard/package.json, not the root manifest, so without
#    this step `aidr dashboard` fails with MODULE_NOT_FOUND right after a
#    documented install.
echo ""
echo "Installing dashboard dependencies..."
(cd dashboard && npm ci) || echo "  (dashboard deps failed - 'aidr dashboard' will not start until you run: cd dashboard && npm ci)"

# 6. Next steps.
echo ""
echo "--------------------------------"
echo "Install complete."
echo ""
echo "Next steps:"
echo "  1. Run setup (creates config.json, schedules the monthly job):"
echo "       node bin/aidr.js setup"
echo "  2. Preview what it will do (submits nothing):"
echo "       node bin/aidr.js preview"
echo "  3. Run for real when ready:"
echo "       node bin/aidr.js run"
echo ""
echo "  Open the local web dashboard:"
echo "       node bin/aidr.js dashboard"
echo ""
echo "Tip: run 'npm link' (or 'npm i -g .') to use 'aidr' instead of 'node bin/aidr.js'."
echo "--------------------------------"
echo ""
