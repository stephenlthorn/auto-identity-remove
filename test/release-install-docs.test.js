/**
 * test/release-install-docs.test.js
 *
 * The README used to tell everyone to `git clone`. A clone is invisible: GitHub
 * counts downloads only for files attached to a release, so the maintainer had
 * no way to know whether anyone installed the tool. The documented install is now
 * the release tarball (scripts/release-archive.sh, attached by
 * .github/workflows/release.yml); `git clone` stays as the way for contributors
 * and for anyone who wants to track main.
 *
 * These are static checks on the text people copy. They cannot prove the commands
 * work (test/release-archive.test.js proves the archive is complete), only that
 * the docs point at the asset the release actually carries, and that no
 * user-facing install instruction still presents a clone as the main path.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const readme = read('README.md');
const synology = read('docs/SYNOLOGY.md');
const installSh = read('install.sh');
const archiveScript = read('scripts/release-archive.sh');

const ASSET = `${archiveScript.match(/^NAME="([^"]+)"$/m)[1]}.tar.gz`;
const LATEST = `https://github.com/stephenlthorn/auto-identity-remove/releases/latest/download/${ASSET}`;

const section = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));
const quickStart = section(readme, '## Quick Start', '### The `aidr` command');
const firstCodeBlock = quickStart.match(/```bash\n([\s\S]*?)```/)[1];

test('the Quick Start section was located, and the asset name comes from the script that builds it', () => {
  assert.ok(quickStart.length > 300, 'precondition: found the Quick Start');
  assert.equal(ASSET, 'auto-identity-remove.tar.gz');
});

test('Quick Start step 1 downloads the latest release asset, then unpacks it', () => {
  assert.match(firstCodeBlock, /^# 1\. .*release/mi);
  assert.ok(firstCodeBlock.includes(`curl -L -O ${LATEST}\n`), 'step 1 must curl the latest-release asset URL');
  assert.match(firstCodeBlock, /^tar xzf auto-identity-remove\.tar\.gz && cd auto-identity-remove$/m);
});

test('the download and unpack come before install.sh, and the first block no longer clones', () => {
  assert.ok(firstCodeBlock.indexOf('curl -L -O') < firstCodeBlock.indexOf('tar xzf'));
  assert.ok(firstCodeBlock.indexOf('tar xzf') < firstCodeBlock.indexOf('bash install.sh'));
  assert.doesNotMatch(firstCodeBlock, /git clone/);
});

test('the Quick Start explains how to verify the download with the published checksum', () => {
  assert.ok(quickStart.includes(`${LATEST}.sha256`), 'it must link the .sha256 asset');
  assert.match(quickStart, /shasum -a 256 -c auto-identity-remove\.tar\.gz\.sha256/);
  assert.match(quickStart, /sha256sum -c/, 'and say what to run on Linux');
});

test('git clone survives, labelled as the way for contributors and for tracking main', () => {
  const at = quickStart.indexOf('git clone');
  assert.ok(at > 0, 'the clone instructions are still in the Quick Start');
  const lead = quickStart.slice(Math.max(0, at - 400), at);

  assert.match(lead, /contributor/i);
  assert.match(lead, /\bmain\b/);
});

test('no user-facing instruction presents git clone without saying it is the alternative', () => {
  for (const [name, text] of [['README.md', readme], ['docs/SYNOLOGY.md', synology], ['install.sh', installSh]]) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/git clone/.test(line) || /^\s*#\s*Run once after/.test(line)) return;
      const lead = lines.slice(Math.max(0, i - 8), i).join('\n');
      assert.match(lead, /Prefer git|alternative|contributor|track(ing)? `?main/i,
        `${name}:${i + 1} tells the reader to clone with no hint that a release download is the default`);
    });
  }
});

test('install.sh says it runs after unpacking a release, not only after cloning', () => {
  const header = installSh.split('\n').slice(0, 8).join('\n');

  assert.match(header, /unpack/i);
  assert.match(header, /clon/i);
});

test('the README has an Updating note for tarball installs: unpack over the old folder, then re-run install.sh', () => {
  const updating = section(readme, '### Updating', '### The `aidr` command');

  assert.ok(updating.length > 200, 'precondition: found an "Updating" subsection in the Quick Start');
  assert.match(updating, /unpack/i);
  assert.match(updating, /over\s+the\s+old\s+folder/i);
  assert.match(updating, /config\.json/);
  assert.match(updating, /state\.json/);
  assert.match(updating, /logs/);
  assert.match(updating, /not\s+in\s+the\s+archive/i);
  assert.match(updating, /bash install\.sh/);
});

test('the Updating note also covers a git checkout and a rebuilt Docker image', () => {
  const updating = section(readme, '### Updating', '### The `aidr` command');

  assert.match(updating, /git pull/);
  assert.match(updating, /docker build -t auto-identity-remove \./);
});

test('docs/SYNOLOGY.md step 1 downloads the release on the NAS and keeps git as the alternative', () => {
  const step = section(synology, '### 1. Put the project somewhere on a volume', '### 2. Create your config');

  assert.ok(step.includes(`curl -L -O ${LATEST}`), 'DSM step 1 must fetch the release asset');
  assert.match(step, /tar xzf auto-identity-remove\.tar\.gz/);
  assert.match(step, /git clone/);
  assert.ok(step.indexOf('curl -L -O') < step.indexOf('git clone'), 'the release comes first');
  assert.match(step, /cd \/volume1\/docker\/auto-identity-remove|cd auto-identity-remove/);
});

test('the README says how a release is cut: bump version in package.json on main, with a CHANGELOG section', () => {
  const releasing = section(readme, '## Releasing', '## License');

  assert.ok(releasing.length > 200, 'precondition: found a Releasing section');
  assert.match(releasing, /`version` in `package\.json`/);
  assert.match(releasing, /\bmain\b/);
  assert.match(releasing, /CHANGELOG\.md/);
  assert.match(releasing, /X\.Y\.Z/);
  assert.match(releasing, /\.github\/workflows\/release\.yml/);
  assert.match(releasing, /download_count/, 'and where the download numbers are');
});
