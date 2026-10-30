/**
 * test/helpers/pii-artifacts.js - the files a run leaves behind, for the purge and
 * retention tests: old run logs, journals, audit reports, snapshots and report PDFs
 * (all PII, all purgeable), the newest run (never purged), and a complaint (a legal
 * record, never purged). Built inside a sandbox, with modification times set by hand.
 *
 * Not a test file (no .test.js suffix).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const STAMP = (n) => `2026-0${n}-01T00-00-00`;

function writeLog(sandbox, name, body) {
  fs.mkdirSync(sandbox.logs, { recursive: true });
  const file = path.join(sandbox.logs, name);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

/**
 * @param {{ logs: string }} sandbox
 * @param {{ ageDays?: number }} [options]  how old the purgeable files are (default 100 days)
 * @returns {Record<string, string>} name -> absolute path
 */
function seedArtifacts(sandbox, { ageDays = 100 } = {}) {
  fs.mkdirSync(path.join(sandbox.logs, 'complaints'), { recursive: true });
  fs.mkdirSync(path.join(sandbox.logs, 'snapshots'), { recursive: true });
  fs.mkdirSync(path.join(sandbox.logs, 'reports'), { recursive: true });
  const old = new Date(Date.now() - ageDays * DAY);
  const files = {
    oldRun: writeLog(sandbox, `run-${STAMP(1)}.json`, '{}'),
    oldJournal: writeLog(sandbox, `run-${STAMP(1)}.jsonl`, '{"type":"run"}\n'),
    oldAudit: writeLog(sandbox, `audit-${STAMP(1)}.md`, '# audit'),
    oldSnapshot: path.join(sandbox.logs, 'snapshots', 'Spokeo-2026-01-01T00-00-00-000Z.png'),
    oldReport: path.join(sandbox.logs, 'reports', 'report-2026-01-01.pdf'),
    middleRun: writeLog(sandbox, `run-${STAMP(2)}.json`, '{}'),
    newestRun: writeLog(sandbox, `run-${STAMP(3)}.json`, '{}'),
    newestJournal: writeLog(sandbox, `run-${STAMP(3)}.jsonl`, '{"type":"run"}\n'),
    newestAudit: writeLog(sandbox, `audit-${STAMP(3)}.md`, '# audit'),
    complaint: path.join(sandbox.logs, 'complaints', 'complaint-Spokeo-2026-01-01.txt'),
  };
  fs.writeFileSync(files.oldSnapshot, 'png');
  fs.writeFileSync(files.oldReport, 'pdf');
  fs.writeFileSync(files.complaint, 'a legal record');
  for (const [name, file] of Object.entries(files)) {
    if (/^(old|middle|complaint)/.test(name)) fs.utimesSync(file, old, old);
  }
  return files;
}

module.exports = { seedArtifacts, writeLog, STAMP };
