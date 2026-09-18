#!/usr/bin/env bash
#
# scripts/cross-model-preflight.sh - is the cross-model reviewer actually alive?
#
# Why this exists: on 2026-09-18 the codex CLI had been broken for an unknown
# length of time (0.137.0 could not decode the server's model list: "unknown
# variant `max`"), so `npm run review:cross-model` could not review anything.
# Nobody noticed, because nothing asks. The CI gate checks for a commit trailer,
# which is paperwork, and a public repo cannot give CI a model key anyway (see
# docs/CROSS_MODEL_REVIEW.md). So the policy was silently off for weeks while
# still looking enforced.
#
# The old preflight asked "is it installed?" and "is it authenticated?". A
# broken-but-present codex answers yes to both. This asks the only question that
# distinguishes a working reviewer from a decorative one: can it complete a
# trivial request and hand back what was asked for?
#
# Usage:
#   scripts/cross-model-preflight.sh          # probe, print a verdict
#   npm run review:doctor                     # same thing
#   CROSS_MODEL_PROBE_TIMEOUT=60 ...          # seconds to allow (default 45)
#
# Exit codes (shared with cross-model-review.sh, which calls this first):
#   0  reviewer is alive
#   3  codex CLI not installed
#   4  codex not authenticated
#   7  codex is installed and authenticated but cannot complete a request

set -uo pipefail

SENTINEL="CODEX_PROBE_OK"
TIMEOUT="${CROSS_MODEL_PROBE_TIMEOUT:-45}"

if [ "${SKIP_CROSS_MODEL:-}" = "1" ]; then
  echo "cross-model preflight skipped (SKIP_CROSS_MODEL=1)"
  exit 0
fi

# ── 1. present ───────────────────────────────────────────────────────────────

if ! command -v codex >/dev/null 2>&1; then
  echo "FAIL: codex CLI not found."
  echo "  Install it: brew install codex   (or: npm i -g @openai/codex)"
  echo "  Or set SKIP_CROSS_MODEL=1 to bypass the policy deliberately."
  exit 3
fi

# ── 2. authenticated ─────────────────────────────────────────────────────────
#
# `codex login status` reports on stderr, not stdout - check both streams or
# this reports every authenticated user as logged out.

if ! codex login status 2>&1 | grep -qi "logged in"; then
  echo "FAIL: codex is installed but not authenticated."
  echo "  Run: codex login"
  exit 4
fi

# ── 3. can it actually do the job ────────────────────────────────────────────
#
# The step that would have caught the 0.137.0 breakage. Bounded by hand rather
# than with timeout(1), which is not installed on stock macOS.

PROBE_OUT="$(mktemp)"
trap 'rm -f "$PROBE_OUT"' EXIT

codex exec --sandbox read-only "Reply with exactly: $SENTINEL" >"$PROBE_OUT" 2>&1 &
PROBE_PID=$!

waited=0
while kill -0 "$PROBE_PID" 2>/dev/null; do
  if [ "$waited" -ge "$TIMEOUT" ]; then
    kill -9 "$PROBE_PID" 2>/dev/null
    wait "$PROBE_PID" 2>/dev/null
    echo "FAIL: codex timed out after ${TIMEOUT}s on a trivial request."
    echo "  The reviewer is installed and authenticated but not usable, so the"
    echo "  cross-model policy is currently OFF. Last 5 lines:"
    tail -5 "$PROBE_OUT" | sed 's/^/    /'
    exit 7
  fi
  sleep 1
  waited=$((waited + 1))
done
wait "$PROBE_PID"
PROBE_STATUS=$?

if ! grep -q "$SENTINEL" "$PROBE_OUT"; then
  echo "FAIL: codex could not complete a trivial round trip (exit $PROBE_STATUS)."
  echo "  It is installed and authenticated, so this is not a setup problem -"
  echo "  the reviewer itself is unusable and the cross-model policy is OFF."
  echo "  Most likely the CLI is behind the server: try 'brew upgrade codex'."
  echo "  Last 5 lines:"
  tail -5 "$PROBE_OUT" | sed 's/^/    /'
  exit 7
fi

VERSION="$(codex --version 2>/dev/null | head -1)"
echo "ok: cross-model reviewer is alive (${VERSION:-codex}, round trip in ${waited}s)"
exit 0
