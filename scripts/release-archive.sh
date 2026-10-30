#!/usr/bin/env bash
#
# scripts/release-archive.sh <out-dir>
#
# Builds the two files attached to a GitHub Release:
#
#   <out-dir>/auto-identity-remove.tar.gz         the committed HEAD, under auto-identity-remove/
#   <out-dir>/auto-identity-remove.tar.gz.sha256  its checksum, in `sha256sum` format
#
# Why a tarball at all: GitHub counts downloads (`assets[].download_count`) only
# for files attached to a release. `git clone` and the auto-generated "Source
# code" archives are never counted, so this file is how the maintainer sees
# whether anyone installs the tool. The name carries no version on purpose, so
#
#   https://github.com/stephenlthorn/auto-identity-remove/releases/latest/download/auto-identity-remove.tar.gz
#
# always resolves to the newest release.
#
# It archives HEAD with `git archive`, never the working tree. A maintainer's
# config.json and state.json (PII) are untracked, so they cannot get in however
# the tree looks. What is left out of the archive on purpose is listed in
# .gitattributes (export-ignore). Run it after committing.
#
# Used by .github/workflows/release.yml and tested by test/release-archive.test.js.

set -euo pipefail

OUT_DIR="${1:-}"

if [ -z "$OUT_DIR" ]; then
  echo "usage: $0 <out-dir>" >&2
  exit 64
fi

NAME="auto-identity-remove"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

git -C "$ROOT" archive --format=tar.gz --prefix="$NAME/" --output="$OUT_DIR/$NAME.tar.gz" HEAD

# The checksum is written from inside the output directory so it names the bare
# file, which is what lets a downloader run `sha256sum -c` / `shasum -a 256 -c`
# next to the tarball.
cd "$OUT_DIR"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
else
  shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
fi

echo "Built from $(git -C "$ROOT" rev-parse --short HEAD):"
ls -l "$NAME.tar.gz" "$NAME.tar.gz.sha256"
cat "$NAME.tar.gz.sha256"
