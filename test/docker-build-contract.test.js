/**
 * test/docker-build-contract.test.js
 *
 * The pre-existing test/docker.test.js only asserts that the Dockerfile
 * *mentions* certain strings. That is why two build-breaking defects shipped
 * undetected:
 *
 *   1. `groupadd --gid 1001` collided with the `pwuser` account (uid/gid 1001)
 *      that the official Playwright base image already ships, so
 *      `docker build .` failed with "groupadd: GID '1001' already exists".
 *
 *   2. The base image tag (v1.52.0, chromium build 1169) did not match the
 *      playwright version npm actually installs (1.60.0, chromium build 1223),
 *      so even a successful build could not launch a browser:
 *      PLAYWRIGHT_BROWSERS_PATH=/ms-playwright has no chromium-1223.
 *
 * These tests encode the invariants that would have caught both. They are
 * static checks so they run in milliseconds; .github/workflows/test.yml also
 * performs a real `docker build` plus a browser-launch smoke run, which is the
 * behavioural counterpart to this file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
const pkg = require(path.join(ROOT, 'package.json'));

test('playwright is pinned to an exact version, not a caret range', () => {
  const spec = pkg.dependencies.playwright;
  assert.match(
    spec,
    /^\d+\.\d+\.\d+$/,
    `playwright must be pinned exactly so the Docker base image can match it; got "${spec}". `
    + 'A caret range lets npm install a client whose required chromium build is absent from the image.',
  );
});

test('Dockerfile base image tag matches the installed playwright version', () => {
  const spec = pkg.dependencies.playwright;
  const tag = dockerfile.match(/^FROM\s+mcr\.microsoft\.com\/playwright:v([\d.]+)-/m);
  assert.ok(tag, 'Dockerfile must FROM a versioned mcr.microsoft.com/playwright:v<x.y.z>-<distro> tag');
  assert.equal(
    tag[1],
    spec,
    `Dockerfile pins playwright image v${tag[1]} but package.json installs playwright ${spec}. `
    + 'The image ships only the browser build its own version needs, so a mismatch fails at launch '
    + 'with "Executable doesn\'t exist at /ms-playwright/chromium-<rev>".',
  );
});

test('Dockerfile does not create an account at a uid/gid the base image already uses', () => {
  // The official Playwright image ships ubuntu (1000:1000) and pwuser (1001:1001).
  assert.doesNotMatch(
    dockerfile,
    /group(add|mod)[^\n]*--gid\s+100[01]\b/,
    'creating a group at gid 1000/1001 collides with the base image and aborts the build',
  );
  assert.doesNotMatch(
    dockerfile,
    /useradd[^\n]*--uid\s+100[01]\b/,
    'creating a user at uid 1000/1001 collides with the base image and aborts the build',
  );
});

test('Dockerfile runs as a non-root user that exists in the base image', () => {
  const user = dockerfile.match(/^USER\s+(\S+)/m);
  assert.ok(user, 'Dockerfile must declare a USER so the container does not run as root');
  assert.notEqual(user[1], 'root');
  assert.notEqual(user[1], '0');
  assert.equal(
    user[1],
    'pwuser',
    'reuse the base image pwuser account rather than creating a new one; '
    + 'it already owns a home dir and is the account the Playwright image is built around',
  );
});

test('container Chromium is configured to survive the default 64MB /dev/shm', () => {
  // Docker gives a container 64MB of /dev/shm. Chromium renderers need far more
  // and crash ("Target closed" / SIGBUS) once they exhaust it. Two accepted
  // remedies: raise shm_size, or tell Chromium to use /tmp instead. We require
  // both so a plain `docker run` (no compose, no --shm-size) is still safe.
  const { buildLaunchArgs } = require('../lib/browser');
  assert.ok(
    buildLaunchArgs({ platform: 'linux' }).includes('--disable-dev-shm-usage'),
    'launch args must include --disable-dev-shm-usage so a plain `docker run` does not crash',
  );
  assert.match(
    compose,
    /shm_size:/,
    'docker-compose.yml should also raise shm_size for better Chromium performance',
  );
});

test('.dockerignore excludes every artifact that can carry PII or secrets', () => {
  const ignored = dockerignore.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  // COPY . . happens after npm ci, so anything not listed here is baked into
  // the image layer and travels with it if the user pushes to a registry.
  const mustExclude = [
    'config.json',      // plaintext PII
    'config.json.enc',  // encrypted PII blob + its salt
    'state.json',       // per-broker submission history
    'state.json.bak',
    'state.json.tmp',
    'inbox/',           // raw .eml confirmation mail
    'logs',             // run logs, snapshots, reports
    'data/serp-history.json',
    'data/exposure-history.json',
    '.env',
  ];
  for (const entry of mustExclude) {
    const bare = entry.replace(/\/$/, '');
    const hit = ignored.some(l => l === entry || l === bare || l === `${bare}/` || l === `${bare}/*`);
    assert.ok(hit, `.dockerignore must exclude "${entry}" - otherwise it is baked into the image`);
  }
});

test('.dockerignore patterns match at every depth, not just the root', () => {
  // A bare `node_modules` in a .dockerignore matches only a TOP-LEVEL entry, so
  // dashboard/node_modules (4.5 MB, verified present in a built image) was
  // shipped in every layer. Same trap for *.md and *.test.js.
  const ignored = dockerignore.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  for (const pat of ['node_modules', '*.md', '*.test.js']) {
    const bare = ignored.includes(pat);
    const deep = ignored.includes(`**/${pat}`);
    assert.ok(
      deep && !bare,
      `.dockerignore should list "**/${pat}" (matches at any depth), not the root-only "${pat}"`,
    );
  }
});

test('docker-compose.yml does not mount config.json read-only', () => {
  // setup/encryption/pending-request flows write config.json. A :ro mount turns
  // those into EACCES at the least convenient moment (mid-run, unattended).
  assert.doesNotMatch(
    compose,
    /config\.json:\/app\/config\.json:ro/,
    'config.json is written at runtime (pending know-requests, --encrypt-config), so a :ro mount breaks those paths',
  );
});

test('docker-compose.yml uses an init process so SIGTERM reaches node', () => {
  // Without an init, node is PID 1: it gets SIGTERM but child chromium
  // processes are orphaned and the state lock is never released, wedging the
  // next scheduled run.
  assert.match(compose, /init:\s*true/, 'set init: true so `docker stop` shuts down cleanly');
});

test('docker-compose.yml no longer declares the obsolete top-level version key', () => {
  assert.doesNotMatch(
    compose,
    /^version:/m,
    'the top-level `version:` key is obsolete in Compose v2 and emits a warning on every command',
  );
});

// ── Persistence and ownership contract (CFG-3, CFG-4, CORE-14) ───────────────
//
// The documented recipes mounted the project over /app/data (hiding the shipped
// broker datasets), mounted state.json as a single FILE (so the lock, .bak and
// resume checkpoint lived in the container's throwaway layer), never told the
// app where config.json was, and ran as uid 1001 against 0600 files owned by
// the host user. Each of those is a working-looking recipe that silently does
// the wrong thing, so the contract pins the shape of a correct one.

/**
 * Container-side paths of every bind mount in `text` (compose `- src:dst[:opt]`
 * entries and `-v src:dst[:opt]` flags).
 * @param {string} text
 * @returns {string[]}
 */
function mountTargets(text) {
  const targets = [];
  for (const line of text.split('\n')) {
    const m = line.match(/(?:^\s*-\s+|-v\s+)["']?([^\s"']+?):(\/[^\s"':]+)(?::[a-z,]+)?["']?\s*\\?\s*$/);
    if (m) targets.push(m[2]);
  }
  return targets;
}

const looksLikeFile = p => /\.[a-z]{2,10}$/i.test(p.split('/').pop());

test('mountTargets understands both compose entries and docker run flags (the detector must not fail open)', () => {
  const sample = [
    '      - ./aidr-home:/home/aidr',
    '      - "./aidr-home/logs:/app/logs"',
    '  -v "$(pwd)/state.json:/app/state.json" \\',
    '  -v /volume1/docker/x:/app/data \\',
    '  -v "$(pwd)/aidr-home:/home/aidr:rw" \\',
  ].join('\n');
  assert.deepEqual(mountTargets(sample), [
    '/home/aidr', '/app/logs', '/app/state.json', '/app/data', '/home/aidr',
  ]);
});

test('docker-compose.yml mounts directories only, never a single file', () => {
  const files = mountTargets(compose).filter(looksLikeFile);
  assert.deepEqual(
    files,
    [],
    `single-file bind mounts break atomic writes (EBUSY) and leave the lock, .bak and checkpoint in the container layer: ${files.join(', ')}`,
  );
});

test('docker-compose.yml never mounts over /app/data, which holds the shipped broker datasets', () => {
  const over = mountTargets(compose).filter(p => p === '/app/data' || p.startsWith('/app/data/'));
  assert.deepEqual(over, [], 'a mount at /app/data hides markup-parsed.json, badbool-extra.json and dead-urls.json');
});

test('docker-compose.yml mounts one home directory and points config and state inside it', () => {
  const targets = mountTargets(compose);
  assert.ok(targets.includes('/home/aidr'), 'mount a dedicated host directory at /home/aidr');
  for (const name of ['AIDR_CONFIG_PATH', 'AIDR_CONFIG_ENC_PATH', 'AIDR_STATE_PATH']) {
    assert.match(
      compose,
      new RegExp(`${name}=/home/aidr/`),
      `${name} must point inside the mounted directory, or the file lands in the container layer`,
    );
  }
});

test('docker-compose.yml runs as a chosen uid so the host-owned 0600 files are readable', () => {
  // The image user is pwuser (1001). Files created by the host user (1000, or
  // 1026 on a Synology) at mode 0600 are unreadable to uid 1001: EACCES on
  // config.json and on every state write.
  assert.match(compose, /^\s*user:\s*["']?\$\{AIDR_UID:-1001\}:\$\{AIDR_GID:-1001\}["']?\s*$/m);
  assert.match(compose, /HOME=\/tmp/, 'a uid with no passwd entry has no writable home; Chromium needs one for its profile');
});

test('the Dockerfile creates /home/aidr owned by the runtime user so an unmounted run still works', () => {
  assert.match(dockerfile, /mkdir -p [^\n]*\/home\/aidr/);
  assert.match(dockerfile, /chown -R pwuser:pwuser [^\n]*\/home\/aidr/);
});

test('the Dockerfile header recipe does not teach single-file mounts', () => {
  const header = dockerfile.split(/^FROM\s/m)[0];
  const files = mountTargets(header.replace(/^#\s?/gm, '')).filter(looksLikeFile);
  assert.deepEqual(files, [], `Dockerfile header documents a single-file mount: ${files.join(', ')}`);
  assert.doesNotMatch(header, /:\/app\/data\b/);
});
