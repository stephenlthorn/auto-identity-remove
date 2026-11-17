'use strict';
/**
 * test/broker-health-issues.test.js
 *
 * The issue sync for the weekly broker health job. The planning is a pure
 * function (open drift issues + new results in, actions out); the gh calls live
 * in a thin layer that is tested here with an injected gh.
 *
 * What it must get right: one bad check is noise (sites run experiments), so an
 * issue opens only after TWO drifted checks in a row; blocked, dead and error
 * results never open one; a recovered broker closes its issue.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  planIssueActions, extractMissing, markerFor, titleFor, syncIssues, listOpenDriftIssues, LABEL,
} = require('../scripts/ci/broker-health-issues');

const AT = '2026-11-17T06:23:00.000Z';
const res = (status, over = {}) => ({ status, detail: `${status} detail`, checkedAt: AT, previousStatus: null, ...over });
const drifted = (missing, over = {}) => res('drifted', { previousStatus: 'drifted', missing, detail: `${missing.length} selectors match nothing: ${missing.join(' | ')}`, ...over });
const issue = (name, missing, number = 7) => ({ number, title: titleFor(name), missing });

describe('opening an issue', () => {
  test('drifted twice in a row opens one issue, titled and labelled', () => {
    const plan = planIssueActions({ openIssues: [], results: { Spokeo: drifted(['input[name="email"]']) } });
    assert.equal(plan.length, 1);
    const [a] = plan;
    assert.equal(a.type, 'create');
    assert.equal(a.title, 'Broker drift: Spokeo');
    assert.deepEqual(a.labels, [LABEL]);
    assert.equal(LABEL, 'broker-drift');
    assert.match(a.body, /input\[name="email"\]/);
    assert.deepEqual(extractMissing([a.body]), ['input[name="email"]']);
  });

  test('drifted once (the check before was ok) opens nothing', () => {
    const plan = planIssueActions({ openIssues: [], results: { Spokeo: drifted(['x'], { previousStatus: 'ok' }) } });
    assert.deepEqual(plan, []);
  });

  test('drifted after a blocked check is not two in a row', () => {
    assert.deepEqual(planIssueActions({ openIssues: [], results: { Spokeo: drifted(['x'], { previousStatus: 'blocked' }) } }), []);
  });

  test('a broker with no history that is drifted opens nothing', () => {
    assert.deepEqual(planIssueActions({ openIssues: [], results: { Spokeo: drifted(['x'], { previousStatus: null }) } }), []);
  });

  test('blocked, dead and error never open an issue, however many times in a row', () => {
    for (const status of ['blocked', 'dead', 'error']) {
      const plan = planIssueActions({ openIssues: [], results: { Spokeo: res(status, { previousStatus: status }) } });
      assert.deepEqual(plan, [], status);
    }
  });

  test('the issue body names the page and the weekly job, and never page content', () => {
    const [a] = planIssueActions({
      openIssues: [], results: { Spokeo: drifted(['a']) }, urls: { Spokeo: 'https://www.spokeo.com/optout' },
    });
    assert.match(a.body, /https:\/\/www\.spokeo\.com\/optout/);
    assert.match(a.body, /two weekly checks in a row/);
  });

  test('one issue per drifted broker, in a stable order', () => {
    const plan = planIssueActions({ openIssues: [], results: { B: drifted(['b']), A: drifted(['a']) } });
    assert.deepEqual(plan.map((a) => a.title), ['Broker drift: A', 'Broker drift: B']);
  });

  test('a broker that already has an open issue is not opened again', () => {
    const plan = planIssueActions({ openIssues: [issue('Spokeo', ['x'])], results: { Spokeo: drifted(['x']) } });
    assert.deepEqual(plan, []);
  });
});

describe('updating an issue', () => {
  test('a changed set of missing selectors adds one comment naming them', () => {
    const plan = planIssueActions({ openIssues: [issue('Spokeo', ['a'])], results: { Spokeo: drifted(['a', 'b']) } });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].type, 'comment');
    assert.equal(plan[0].number, 7);
    assert.match(plan[0].body, /a/);
    assert.match(plan[0].body, /b/);
    assert.deepEqual(extractMissing([plan[0].body]), ['a', 'b']);
  });

  test('the same selectors in a different order are not a change', () => {
    const plan = planIssueActions({ openIssues: [issue('Spokeo', ['a', 'b'])], results: { Spokeo: drifted(['b', 'a']) } });
    assert.deepEqual(plan, []);
  });

  test('an open issue with no recorded selectors gets a comment so the record starts', () => {
    const plan = planIssueActions({ openIssues: [issue('Spokeo', null)], results: { Spokeo: drifted(['a']) } });
    assert.equal(plan[0].type, 'comment');
  });

  test('a drifted broker whose last check was ok still updates an open issue (the issue is the record)', () => {
    const plan = planIssueActions({ openIssues: [issue('Spokeo', ['a'])], results: { Spokeo: drifted(['b'], { previousStatus: 'ok' }) } });
    assert.equal(plan[0].type, 'comment');
  });
});

describe('closing an issue', () => {
  test('ok again closes it with a comment', () => {
    const plan = planIssueActions({ openIssues: [issue('Spokeo', ['a'])], results: { Spokeo: res('ok', { previousStatus: 'drifted' }) } });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].type, 'close');
    assert.equal(plan[0].number, 7);
    assert.match(plan[0].comment, /ok again/);
  });

  test('blocked, dead or error do not close it: that is not recovery', () => {
    for (const status of ['blocked', 'dead', 'error']) {
      const plan = planIssueActions({ openIssues: [issue('Spokeo', ['a'])], results: { Spokeo: res(status) } });
      assert.deepEqual(plan, [], status);
    }
  });

  test('a broker that left brokers.js closes its issue', () => {
    const plan = planIssueActions({ openIssues: [issue('Gone Co', ['a'])], results: { Other: res('ok') } });
    assert.equal(plan[0].type, 'close');
    assert.match(plan[0].comment, /no longer in the broker list/);
  });

  test('a run with no results at all closes nothing', () => {
    assert.deepEqual(planIssueActions({ openIssues: [issue('Spokeo', ['a'])], results: {} }), []);
  });
});

describe('matching issues to brokers', () => {
  test('only titles of the form "Broker drift: <name>" are ours; other open issues are ignored', () => {
    const plan = planIssueActions({
      openIssues: [{ number: 1, title: 'Add a broker', missing: null }, issue('Spokeo', ['x'], 9)],
      results: { Spokeo: res('ok') },
    });
    assert.deepEqual(plan.map((a) => a.number), [9]);
  });

  test('duplicate issues for one broker: the oldest is the record, the rest are left alone', () => {
    const plan = planIssueActions({
      openIssues: [issue('Spokeo', ['a'], 12), issue('Spokeo', ['a'], 5)],
      results: { Spokeo: drifted(['b']) },
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].number, 5);
  });

  test('titleFor round-trips broker names with punctuation', () => {
    assert.equal(titleFor('Equifax (marketing)'), 'Broker drift: Equifax (marketing)');
  });
});

describe('extractMissing', () => {
  test('reads the last marker across the body and the comments', () => {
    const first = `text\n${markerFor(['a'])}`;
    const later = `update\n${markerFor(['a', 'b'])}`;
    assert.deepEqual(extractMissing([first, 'a human comment', later]), ['a', 'b']);
  });

  test('no marker, or a garbled one, is null', () => {
    assert.equal(extractMissing(['nothing here']), null);
    assert.equal(extractMissing(['<!-- aidr-broker-health missing=not-json -->']), null);
  });

  test('a selector containing --> cannot break out of the comment', () => {
    const marker = markerFor(['a[title="-->"]']);
    assert.equal(marker.slice(0, -3).includes('-->'), false);
    assert.deepEqual(extractMissing([marker]), ['a[title="-->"]']);
  });
});

describe('syncIssues (the thin gh layer)', () => {
  const fakeGh = () => {
    const calls = [];
    return {
      calls,
      ensureLabel: async (l) => calls.push(['label', l]),
      create: async (a) => calls.push(['create', a.title, a.labels]),
      comment: async (n, body) => calls.push(['comment', n, body]),
      close: async (n, comment) => calls.push(['close', n, comment]),
    };
  };

  test('performs each planned action through the injected gh, and the label first', async () => {
    const gh = fakeGh();
    const out = await syncIssues({
      gh,
      plan: [
        { type: 'create', title: 'Broker drift: A', body: 'b', labels: [LABEL] },
        { type: 'comment', number: 3, body: 'c' },
        { type: 'close', number: 4, comment: 'done' },
      ],
    });
    assert.deepEqual(gh.calls.map((c) => c[0]), ['label', 'create', 'comment', 'close']);
    assert.equal(out.length, 3);
  });

  test('an empty plan touches nothing', async () => {
    const gh = fakeGh();
    await syncIssues({ gh, plan: [] });
    assert.deepEqual(gh.calls, []);
  });

  test('one failing action does not stop the rest, and is reported', async () => {
    const gh = fakeGh();
    gh.comment = async () => { throw new Error('rate limited'); };
    const out = await syncIssues({
      gh,
      plan: [{ type: 'comment', number: 3, body: 'c' }, { type: 'close', number: 4, comment: 'done' }],
    });
    assert.equal(out[0].ok, false);
    assert.match(out[0].error, /rate limited/);
    assert.equal(out[1].ok, true);
  });

  test('listOpenDriftIssues reads the selectors from the body and the comments', async () => {
    const run = async (args) => {
      assert.deepEqual(args.slice(0, 2), ['issue', 'list']);
      assert.ok(args.includes(LABEL));
      return JSON.stringify([{
        number: 7, title: 'Broker drift: Spokeo',
        body: `body ${markerFor(['a'])}`,
        comments: [{ body: `c ${markerFor(['a', 'b'])}` }],
      }]);
    };
    const open = await listOpenDriftIssues({ run });
    assert.deepEqual(open, [{ number: 7, title: 'Broker drift: Spokeo', missing: ['a', 'b'] }]);
  });
});
