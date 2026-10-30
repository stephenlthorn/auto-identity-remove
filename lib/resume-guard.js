'use strict';

/**
 * lib/resume-guard.js
 *
 * What `--resume` may skip, checked against the interrupted run's own record.
 *
 * planResume (lib/config.js) reads a checkpoint and decides, per person, which
 * passes are already done. From a generic-phase checkpoint it infers that EVERY
 * person's explicit pass ended, because the generic passes come after all the
 * explicit ones. That holds for everyone the run served. A person the masked-email
 * relay could not serve is skipped by the run altogether (explicit and generic), so
 * for them nothing ran: skipping "the explicit pass, already done" left their explicit
 * brokers unsubmitted by a resume that then reported the run complete.
 *
 * The checkpoint cannot say who was skipped, but the run's journal (or its summary)
 * does: the relay failure is a result tagged with the person. These helpers read it
 * and take back every skip the plan made for such a person. Skipping needs evidence;
 * a person with no results is not evidence.
 */

const { personLabel } = require('./logger');
const { listRuns, loadRun } = require('./journal');

// The broker name the watcher logs a relay failure under (see watcher.js).
const RELAY_BROKER = 'Masked-email relay';

// How many of the newest runs are read. The interrupted run is normally the newest
// (a filtered run in between does not touch the checkpoint, so it may be one or two
// back); anything older says nothing about this checkpoint.
const RUNS_TO_READ = 5;

/**
 * The persons ("First Last") the relay failed for in any of the newest runs.
 * Deliberately generous: a person named here loses the resume shortcut, which costs
 * a re-walk of their explicit list (finished brokers are skipped by state), never
 * a missed submission.
 *
 * @param {string} logDir
 * @param {{ exclude?: string, limit?: number }} [opts]  exclude: the run in progress
 * @returns {Set<string>}
 */
function relaySkippedNames(logDir, { exclude, limit = RUNS_TO_READ } = {}) {
  const names = new Set();
  for (const run of listRuns(logDir, { exclude }).slice(0, limit)) {
    const loaded = loadRun(run);
    if (!loaded) continue;
    for (const entry of loaded.log.errors || []) {
      if (entry && entry.broker === RELAY_BROKER && typeof entry.person === 'string') names.add(entry.person);
    }
  }
  return names;
}

/**
 * A copy of a planResume() plan in which a person named in `skippedNames` skips
 * nothing: neither their explicit nor their generic pass counts as done. The
 * checkpoint's own resume key/row are left alone (they are evidence for the person
 * the checkpoint is inside).
 *
 * @param {Array<object>} plan  as returned by planResume
 * @param {Array<{ firstName?: string, lastName?: string }>} persons
 * @param {Set<string>} skippedNames
 * @returns {Array<object>}
 */
function guardResumePlan(plan, persons, skippedNames) {
  return plan.map((entry, index) => {
    const name = personLabel(persons[index]);
    if (!skippedNames || !name || !skippedNames.has(name)) return { ...entry };
    return { ...entry, skipExplicit: false, skipGeneric: false };
  });
}

module.exports = { RELAY_BROKER, RUNS_TO_READ, relaySkippedNames, guardResumePlan };
