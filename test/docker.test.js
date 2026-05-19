const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('Dockerfile exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'Dockerfile')));
});

test('Dockerfile uses official Playwright base image', () => {
  const content = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.ok(content.includes('mcr.microsoft.com/playwright'));
});

test('Dockerfile sets PLAYWRIGHT_BROWSERS_PATH', () => {
  const content = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.ok(content.includes('PLAYWRIGHT_BROWSERS_PATH'));
});

test('docker-compose.yml exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docker-compose.yml')));
});

test('docker-compose.yml mounts config.json', () => {
  const content = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.ok(content.includes('config.json'));
});

test('.dockerignore exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, '.dockerignore')));
});

test('.dockerignore excludes node_modules', () => {
  const content = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  assert.ok(content.includes('node_modules'));
});
