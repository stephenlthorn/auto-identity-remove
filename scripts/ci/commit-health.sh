#!/usr/bin/env bash
# scripts/ci/commit-health.sh
#
# The commit step of the weekly broker health workflow (the `publish` job): commit
# data/broker-health.json and STATUS.md, then push them to main.
#
# Two things went wrong with a bare `git push origin HEAD:main`:
#   - any commit that landed on main while the job ran made the push fail, and a
#     re-run starts from the trigger-time commit, so it failed the same way;
#   - the issue sync after it was skipped whenever the push failed.
#
# So: commit, `git pull --rebase`, push. The two files are generated, so when the
# rebase conflicts nothing is hand-merged: the health file from this run is kept,
# main is taken as it is, STATUS.md is regenerated on top, and that is pushed.
# One retry if the push itself is rejected; after that the step fails, loudly.
# "Nothing changed" is a success, so the issue sync that follows still runs.
#
# Environment (for tests): HEALTH_REMOTE (default origin), HEALTH_BRANCH (default
# main), HEALTH_REGENERATE (default `node scripts/generate-status.js`).

set -euo pipefail

REMOTE="${HEALTH_REMOTE:-origin}"
BRANCH="${HEALTH_BRANCH:-main}"
REGENERATE="${HEALTH_REGENERATE:-node scripts/generate-status.js}"
FILES=(data/broker-health.json STATUS.md)
MESSAGE="chore(health): weekly broker health check"

regenerate() {
  # shellcheck disable=SC2086  # the command is a short, trusted, fixed string
  $REGENERATE
}

# Stage the two generated files and commit them when they differ. Returns 1 when there was nothing to commit.
commit_generated() {
  git add data/broker-health.json STATUS.md
  if git diff --cached --quiet; then return 1; fi
  git commit -q -m "$MESSAGE"
}

# Throw away the local commit, take the remote branch as it is, and put this run's
# health file and a regenerated STATUS.md on top. Exits 0 when that leaves nothing to push.
rebuild_on_remote() {
  local keep
  keep="$(mktemp)"
  cp data/broker-health.json "$keep"
  git fetch -q "$REMOTE" "$BRANCH"
  git reset -q --hard "FETCH_HEAD"
  cp "$keep" data/broker-health.json
  rm -f "$keep"
  regenerate
  if ! commit_generated; then
    echo "nothing changed on top of the current $BRANCH"
    exit 0
  fi
}

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if ! commit_generated; then
  echo "nothing changed"
  exit 0
fi

if git pull -q --rebase "$REMOTE" "$BRANCH"; then
  # main may have changed brokers.js while the job ran, so STATUS.md can be stale
  # against it even though the rebase was clean.
  regenerate
  git add STATUS.md
  if ! git diff --cached --quiet; then git commit -q --amend --no-edit; fi
else
  echo "rebase conflict in the generated files: regenerating on top of $REMOTE/$BRANCH"
  git rebase --abort || true
  rebuild_on_remote
fi

if git push -q "$REMOTE" "HEAD:$BRANCH"; then
  echo "pushed"
  exit 0
fi

echo "push rejected: trying once more on top of the current $BRANCH"
rebuild_on_remote
git push -q "$REMOTE" "HEAD:$BRANCH"
echo "pushed on the second try"
