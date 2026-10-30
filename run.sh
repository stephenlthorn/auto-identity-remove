#!/bin/bash
# auto-identity-remove - manual / scheduled trigger
# Usage: ./run.sh [watcher options]      e.g. ./run.sh --dry-run
#
# Every argument is handed to watcher.js unchanged, so ./run.sh --dry-run and
# ./run.sh --only Spokeo mean what they say (they used to be dropped, which made
# a "dry run" a REAL run).
#
# AIDR_HOME, AIDR_CONFIG_PATH, AIDR_CONFIG_ENC_PATH, AIDR_STATE_PATH, AIDR_LOG_DIR and
# AIDR_DATA_DIR relocate the runtime files (see lib/paths.js); relative values are
# anchored where this script was launched.
#
# An encrypted config (config.json.enc) needs AIDR_PASSPHRASE or
# AIDR_PASSPHRASE_FILE (a file whose first line is the passphrase). The
# scheduler installer passes AIDR_PASSPHRASE_FILE to scheduled jobs; it never
# writes the passphrase itself.

set -e

# Relative paths in the environment mean "relative to where the user ran this",
# not to the project directory we cd into below.
START_DIR="$PWD"
absolute() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *)  printf '%s/%s' "$START_DIR" "$1" ;;
  esac
}
for var in AIDR_HOME AIDR_CONFIG_PATH AIDR_CONFIG_ENC_PATH AIDR_STATE_PATH AIDR_LOG_DIR AIDR_DATA_DIR AIDR_PASSPHRASE_FILE; do
  value="${!var:-}"
  if [ -n "$value" ]; then
    export "$var=$(absolute "$value")"
  fi
done

cd "$(dirname "$0")"

# AIDR_HOME is where every runtime file lives when it is set (lib/paths.js); a
# specific variable still wins over it. With neither, the project directory.
CONFIG_PLAIN="${AIDR_CONFIG_PATH:-${AIDR_HOME:+$AIDR_HOME/}config.json}"
CONFIG_ENC="${AIDR_CONFIG_ENC_PATH:-${CONFIG_PLAIN}.enc}"

# Encryption removes config.json and leaves config.json.enc, so either file is
# a valid install. A config.json can also be an encrypted envelope in place.
encrypted=0
if [ -f "$CONFIG_ENC" ]; then
  encrypted=1
elif [ -f "$CONFIG_PLAIN" ]; then
  if grep -q '"ciphertext"' "$CONFIG_PLAIN"; then
    encrypted=1
  fi
else
  echo "ERROR: no config found ($CONFIG_PLAIN or $CONFIG_ENC). Run: node setup.js" >&2
  exit 1
fi

if [ "$encrypted" = 1 ] && [ -z "${AIDR_PASSPHRASE:-}" ]; then
  if [ -z "${AIDR_PASSPHRASE_FILE:-}" ]; then
    echo "ERROR: your config is encrypted, but neither AIDR_PASSPHRASE nor AIDR_PASSPHRASE_FILE is set." >&2
    echo "       Scheduled runs need AIDR_PASSPHRASE_FILE: a file (mode 600) whose first line is the passphrase." >&2
    echo "       Set it, then re-run: node watcher.js --install-scheduler" >&2
    exit 1
  fi
  if [ ! -r "$AIDR_PASSPHRASE_FILE" ]; then
    echo "ERROR: AIDR_PASSPHRASE_FILE is set to $AIDR_PASSPHRASE_FILE, which does not exist or is not readable." >&2
    exit 1
  fi
fi

# Platform-aware Playwright browsers path
if [ -z "${PLAYWRIGHT_BROWSERS_PATH}" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    export PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright"
  else
    export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
  fi
fi

# exec so SIGTERM/SIGINT from the scheduler, `docker stop` or Ctrl-C reach node
# directly and its shutdown handlers run, instead of stopping at this shell.
exec node watcher.js "$@"
