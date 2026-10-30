#!/usr/bin/env bash
#
# scripts/cross-model-gate.sh <base-sha> <head-sha>
#
# Zero-secret CI check for the policy in docs/CROSS_MODEL_REVIEW.md: when a PR
# touches a tier-1 file (PII, crypto, subprocess, untrusted network), the commit
# range must carry a `Cross-model-review:` trailer.
#
# This deliberately does NOT call a model. A public repo gives fork PRs no access
# to secrets, and pull_request_target would mean running with secrets available
# while checking out untrusted head code. So CI checks the paperwork; the model
# call happens locally via `npm run review:cross-model`.
#
# Advisory by default: it annotates and exits 0 unless CROSS_MODEL_STRICT=1, so
# it never blocks a first-time contributor who has not read the policy yet.

set -euo pipefail

BASE_SHA="${1:-}"
HEAD_SHA="${2:-HEAD}"

if [ -z "$BASE_SHA" ]; then
  echo "usage: $0 <base-sha> [head-sha]" >&2
  exit 64
fi

# Kept in sync with the tier-1 table in docs/CROSS_MODEL_REVIEW.md and with the
# TIER1 list in scripts/cross-model-review.sh.
TIER1_PATTERN='^(lib/(config|secrets|field-resolver|forms|imap-confirm|confirm|email|right-to-know-runner|feeds|serp-scan|scheduler|complaint|broker-runner|relay|captcha|hibp)\.js|dashboard/(server|validate)\.js|generic-runner\.js|brokers\.js|setup\.js|Dockerfile|docker-compose\.yml)$'

CHANGED="$(git diff --name-only "$BASE_SHA".."$HEAD_SHA" || true)"
TIER1_TOUCHED="$(printf '%s\n' "$CHANGED" | grep -E "$TIER1_PATTERN" || true)"

if [ -z "$TIER1_TOUCHED" ]; then
  echo "No tier-1 files changed - cross-model review not required."
  exit 0
fi

echo "Tier-1 files changed:"
printf '%s\n' "$TIER1_TOUCHED" | sed 's/^/  - /'
echo

# Trailer may be on any commit in the range, or in a commit body. The log is
# read whole before searching: `git log | grep -q` under pipefail fails with
# SIGPIPE when grep stops early on a long range, hiding a trailer that is there.
TRAILERS="$(git log "$BASE_SHA".."$HEAD_SHA" --format='%B' | grep 'Cross-model-review:' || true)"
if [ -n "$TRAILERS" ]; then
  echo "Found a Cross-model-review trailer:"
  printf '%s\n' "$TRAILERS" | sed 's/^/  /'
  exit 0
fi

cat <<'MSG'
::warning::This PR changes tier-1 files but carries no Cross-model-review trailer.

These files touch PII, crypto, subprocesses, or untrusted network input, so the
policy asks for a review by a model from a different family than the one that
wrote the change. Run:

    npm run review:cross-model

then add a trailer to a commit message:

    Cross-model-review: docs/reviews/cross-model/<date>-<sha>.md (P1:0 P2:0)

Or, if it does not apply, say so explicitly:

    Cross-model-review: SKIPPED (<reason>)

Background: docs/CROSS_MODEL_REVIEW.md
MSG

if [ "${CROSS_MODEL_STRICT:-0}" = "1" ]; then
  echo "CROSS_MODEL_STRICT=1 - failing."
  exit 1
fi

echo "Advisory only (set CROSS_MODEL_STRICT=1 to enforce). Not failing the build."
exit 0
