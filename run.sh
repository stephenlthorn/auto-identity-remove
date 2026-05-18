#!/bin/bash
# auto-identity-remove — manual trigger
# Usage: ./run.sh

set -e
cd "$(dirname "$0")"

if [ ! -f config.json ]; then
  echo "❌ config.json not found. Run: node setup.js"
  exit 1
fi

# Platform-aware Playwright browsers path
if [ -z "${PLAYWRIGHT_BROWSERS_PATH}" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    export PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright"
  else
    export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
  fi
fi

node watcher.js
