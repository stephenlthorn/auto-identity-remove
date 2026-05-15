#!/bin/bash
# auto-identity-remove — manual trigger
# Usage: ./run.sh

set -e
cd "$(dirname "$0")"

if [ ! -f config.json ]; then
  echo "❌ config.json not found. Run: node setup.js"
  exit 1
fi

PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}" \
  node watcher.js
