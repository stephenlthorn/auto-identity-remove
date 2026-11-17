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
  planIssueActions, extractMissing, extractBrokerName, markerFor, brokerMarkerFor, titleFor, syncIssues,
  listDriftIssues, makeGh, makeRun, LABEL, WONTFIX_LABEL,
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
    const PAGE = 'PAGE-CONTENT-SENTINEL <script>alert(1)</script> @everyone';
    const [a] = planIssueActions({
      openIssues: [],
      results: { Spokeo: drifted(['a'], { detail: `1 of 2 selectors match nothing visible: a (${PAGE})`, pageText: PAGE }) },
      urls: { Spokeo: 'https://www.spokeo.com/optout' },
    });
    assert.match(a.body, /https:\/\/www\.spokeo\.com\/optout/);
    assert.match(a.body, /two weekly checks in a row/);
    assert.equal(a.body.includes('PAGE-CONTENT-SENTINEL'), false, 'the result detail (which can echo the page) is not copied into the issue');
    assert.equal(a.body.includes('<script>'), false);
    const [c] = planIssueActions({
      openIssues: [issue('Spokeo', ['zzz'])], results: { Spokeo: drifted(['a'], { detail: PAGE }) },
    });
    assert.equal(c.type, 'comment');
    assert.equal(c.body.includes('PAGE-CONTENT-SENTINEL'), false);
    const [d] = planIssueActions({ openIssues: [issue('Spokeo', ['a'])], results: { Spokeo: res('ok', { detail: PAGE }) } });
    assert.equal(d.type, 'close');
    assert.equal(d.comment.includes('PAGE-CONTENT-SENTINEL'), false);
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

  test('listDriftIssues reads the selectors from the body and the comments', async () => {
    const run = async (args) => {
      assert.deepEqual(args.slice(0, 2), ['issue', 'list']);
      assert.ok(args.includes(LABEL));
      assert.equal(args[args.indexOf('--state') + 1], 'all', 'closed issues are read too (H4b)');
      return JSON.stringify([{
        number: 7, title: 'Broker drift: Spokeo', state: 'OPEN', labels: [{ name: LABEL }],
        author: { login: 'app/github-actions' },
        body: `body ${markerFor(['a'])}`,
        comments: [{ body: `c ${markerFor(['a', 'b'])}`, author: { login: 'github-actions' } }],
      }]);
    };
    const open = await listDriftIssues({ run });
    assert.deepEqual(open, [{
      number: 7, title: 'Broker drift: Spokeo', state: 'open', labels: [LABEL], brokerName: null, missing: ['a', 'b'],
    }]);
  });
});


// ── H4 ───────────────────────────────────────────────────────────────────────

const BOT = { login: 'app/github-actions' };
const HUMAN = { login: 'some-contributor' };
const raw = (over) => ({
  number: 7, title: 'Broker drift: Spokeo', state: 'OPEN', labels: [{ name: LABEL }], author: BOT, body: '', comments: [], ...over,
});
const listWith = (issues) => listDriftIssues({ run: async () => JSON.stringify(issues) });

describe('H4a: an issue is identified by a hidden broker-name marker in its body, not by its title', () => {
  const retitled = (name, over = {}) => ({
    number: 7, title: `Broker drift: ${name} (domain sold)`, state: 'open', labels: [LABEL], brokerName: name, missing: ['x'], ...over,
  });

  test('a retitled issue is still the record: no "no longer in the broker list" close, no duplicate', () => {
    assert.deepEqual(planIssueActions({ openIssues: [retitled('Spokeo')], results: { Spokeo: drifted(['x']) } }), []);
    assert.deepEqual(planIssueActions({ openIssues: [retitled('Spokeo')], results: { Spokeo: drifted(['x']), Other: res('ok') } }), []);
  });

  test('a retitled issue still closes when its broker is ok again, and says which broker', () => {
    const plan = planIssueActions({ openIssues: [retitled('Spokeo')], results: { Spokeo: res('ok') } });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].type, 'close');
    assert.equal(plan[0].number, 7);
  });

  test('the created issue carries the broker marker in its body, and it reads back', () => {
    const [a] = planIssueActions({ openIssues: [], results: { 'Spokeo --> x': drifted(['a']) } });
    assert.equal(extractBrokerName([a.body]), 'Spokeo --> x');
    const marker = a.body.split('\n').find((line) => line.includes('broker='));
    assert.equal(marker.slice(0, -3).includes('-->'), false, 'the marker cannot end its own comment early');
  });

  test('an issue with no marker (made before this) is still matched by its title', () => {
    const plan = planIssueActions({ openIssues: [issue('Spokeo', ['a'])], results: { Spokeo: res('ok') } });
    assert.equal(plan[0].type, 'close');
  });

  test('listDriftIssues takes the broker name from a marker in a body the bot wrote', async () => {
    const [i] = await listWith([raw({ title: 'Broker drift: Spokeo (domain sold)', body: `text\n${brokerMarkerFor('Spokeo')}` })]);
    assert.equal(i.brokerName, 'Spokeo');
  });

  test('a marker in a body a PERSON wrote is not trusted: the title decides', async () => {
    const [i] = await listWith([raw({ author: HUMAN, title: 'Broker drift: Spokeo', body: brokerMarkerFor('Somebody Else') })]);
    assert.equal(i.brokerName, null);
  });
});

describe('H4b: an issue closed by a person is not recreated every week', () => {
  const closed = (name, labels, number = 4) => ({
    number, title: titleFor(name), state: 'closed', labels, brokerName: name, missing: ['x'],
  });

  test('closed with the wontfix label: left closed, nothing created, nothing reopened', () => {
    const plan = planIssueActions({ openIssues: [closed('Spokeo', [LABEL, WONTFIX_LABEL])], results: { Spokeo: drifted(['x']) } });
    assert.deepEqual(plan, []);
    assert.equal(WONTFIX_LABEL, 'wontfix');
  });

  test('closed without wontfix: it is REOPENED, never a duplicate created', () => {
    const plan = planIssueActions({ openIssues: [closed('Spokeo', [LABEL])], results: { Spokeo: drifted(['x']) } });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].type, 'reopen');
    assert.equal(plan[0].number, 4);
    assert.match(plan[0].body, new RegExp(WONTFIX_LABEL), 'tells the person how to keep it closed');
    assert.deepEqual(extractMissing([plan[0].body]), ['x']);
  });

  test('reopening needs the same two drifted checks in a row that opening does', () => {
    const plan = planIssueActions({ openIssues: [closed('Spokeo', [LABEL])], results: { Spokeo: drifted(['x'], { previousStatus: 'ok' }) } });
    assert.deepEqual(plan, []);
  });

  test('the newest closed issue decides, not an older one', () => {
    const plan = planIssueActions({
      openIssues: [closed('Spokeo', [LABEL, WONTFIX_LABEL], 3), closed('Spokeo', [LABEL], 9)],
      results: { Spokeo: drifted(['x']) },
    });
    assert.deepEqual(plan.map((a) => [a.type, a.number]), [['reopen', 9]]);
  });

  test('an open issue wins over a closed one: it is updated, not reopened', () => {
    const plan = planIssueActions({
      openIssues: [closed('Spokeo', [LABEL], 3), { ...closed('Spokeo', [LABEL], 8), state: 'open' }],
      results: { Spokeo: drifted(['y']) },
    });
    assert.deepEqual(plan.map((a) => [a.type, a.number]), [['comment', 8]]);
  });

  test('a closed issue is never closed again, and a broker that left the list is not touched', () => {
    assert.deepEqual(planIssueActions({ openIssues: [closed('Spokeo', [LABEL])], results: { Spokeo: res('ok') } }), []);
    assert.deepEqual(planIssueActions({ openIssues: [closed('Gone Co', [LABEL])], results: { Other: res('ok') } }), []);
  });

  test('the reopen action goes through gh', async () => {
    const calls = [];
    const gh = {
      ensureLabel: async () => {}, create: async () => {}, comment: async () => {}, close: async () => {},
      reopen: async (n, body) => calls.push([n, body]),
    };
    const out = await syncIssues({ gh, plan: [{ type: 'reopen', number: 4, name: 'Spokeo', body: 'again' }] });
    assert.deepEqual(calls, [[4, 'again']]);
    assert.equal(out[0].ok, true);
  });
});

describe('H4c: only the bot can write a marker the planner believes', () => {
  test('a marker in a comment by another person is ignored', async () => {
    const [i] = await listWith([raw({
      body: `body ${markerFor(['a'])}`,
      comments: [{ body: `spoof ${markerFor(['zzz'])}`, author: HUMAN }],
    })]);
    assert.deepEqual(i.missing, ['a']);
  });

  test('a marker in a comment by the bot counts, whichever way gh spells the bot login', async () => {
    for (const login of ['github-actions', 'app/github-actions', 'github-actions[bot]']) {
      const [i] = await listWith([raw({
        body: `body ${markerFor(['a'])}`,
        comments: [{ body: `update ${markerFor(['a', 'b'])}`, author: { login } }],
      })]);
      assert.deepEqual(i.missing, ['a', 'b'], login);
    }
  });

  test('a marker in the body of an issue a person opened is ignored too', async () => {
    const [i] = await listWith([raw({ author: HUMAN, body: markerFor(['forged']) })]);
    assert.equal(i.missing, null);
  });

  test('a person posting a marker cannot cause a spurious bot comment', async () => {
    const issues = await listWith([raw({
      body: `body ${markerFor(['a'])}`,
      comments: [{ body: markerFor(['something else']), author: HUMAN }],
    })]);
    const plan = planIssueActions({ openIssues: issues, results: { Spokeo: drifted(['a']) } });
    assert.deepEqual(plan, []);
  });
});

describe('what reaches gh (argv, never a shell string)', () => {
  const hostile = '--repo evil; rm -rf / $(id) `id` --body x';

  test('makeRun hands gh an argv array through execFileSync, with no shell', async () => {
    const seen = [];
    const run = makeRun({ exec: (file, args, options) => { seen.push({ file, args, options }); return 'out'; } });
    assert.equal(await run(['issue', 'list']), 'out');
    assert.equal(seen[0].file, 'gh');
    assert.ok(Array.isArray(seen[0].args));
    assert.notEqual(seen[0].options.shell, true);
  });

  const captured = () => {
    const calls = [];
    return { calls, gh: makeGh(async (args) => { calls.push(args); return ''; }) };
  };

  test('create: every value follows its own flag, and a hostile name stays inside one argument', async () => {
    const { calls, gh } = captured();
    const [a] = planIssueActions({ openIssues: [], results: { [hostile]: drifted([hostile]) }, urls: { [hostile]: `https://x.example/?q=${hostile}` } });
    await gh.create(a);
    const args = calls[0];
    assert.deepEqual(args.slice(0, 2), ['issue', 'create']);
    assert.ok(args.every((x) => typeof x === 'string'));
    assert.equal(args[args.indexOf('--title') + 1], `Broker drift: ${hostile}`);
    assert.equal(args[args.indexOf('--body') + 1], a.body);
    assert.equal(args[args.indexOf('--label') + 1], LABEL);
    assert.equal(args.filter((x) => x === '--repo').length, 0, 'the name did not become a flag');
    // Flags appear exactly where the code put them: the four option names, nothing else starting with "--".
    assert.deepEqual(args.filter((x) => /^--[a-z]/.test(x)), ['--title', '--body', '--label']);
  });

  test('comment, close and reopen: the number is a plain integer string, the text follows its flag', async () => {
    const { calls, gh } = captured();
    await gh.comment(12, hostile);
    await gh.close(12, hostile);
    await gh.reopen(12, hostile);
    assert.deepEqual(calls[0], ['issue', 'comment', '12', '--body', hostile]);
    assert.deepEqual(calls[1], ['issue', 'close', '12', '--comment', hostile]);
    assert.deepEqual(calls[2], ['issue', 'reopen', '12', '--comment', hostile]);
  });

  test('an issue number that is not a positive integer is refused, so it cannot become a flag', async () => {
    const { calls, gh } = captured();
    for (const bad of ['--repo evil', '1; id', -1, 1.5, NaN, null]) {
      assert.throws(() => gh.comment(bad, 'x'), /issue number/, String(bad));
    }
    assert.deepEqual(calls, []);
  });

  test('the issue body never contains page content, only the name, the page URL from brokers.js, selectors and a date', () => {
    const [a] = planIssueActions({ openIssues: [], results: { Spokeo: drifted(['a']) }, urls: { Spokeo: 'https://www.spokeo.com/optout' } });
    const visible = a.body.replace(/<!--[^]*?-->/g, '');
    for (const line of visible.split('\n').filter(Boolean)) {
      assert.ok(
        /^(The weekly broker health check|Page: |Selectors that match nothing:|- `|Last checked: |This looks at the shape)/.test(line),
        `unexpected line in an issue body: ${line}`,
      );
    }
  });

  test('names and selectors sit in code spans, so a hostile one cannot mention a user or break the markdown', () => {
    const [a] = planIssueActions({ openIssues: [], results: { 'Acme @everyone': drifted(['a`b @octocat']) } });
    const visible = a.body.replace(/<!--[^]*?-->/g, '');
    assert.doesNotMatch(visible.replace(/``[^]*?``|`[^`\n]*`/g, ''), /@/, 'every @ is inside a code span');
  });
});

describe('H5: a drifted broker that moved to another domain', () => {
  const moved = (over = {}) => res('drifted', { previousStatus: 'drifted', redirectedTo: 'parked.example.net', detail: 'redirected to parked.example.net', ...over });

  test('opens an issue that says where the page went, not an empty list of selectors', () => {
    const [a] = planIssueActions({ openIssues: [], results: { Spokeo: moved() }, urls: { Spokeo: 'https://www.spokeo.com/optout' } });
    assert.equal(a.type, 'create');
    assert.match(a.body, /parked\.example\.net/);
    assert.doesNotMatch(a.body.replace(/<!--[^]*?-->/g, ''), /Selectors that match nothing/);
  });

  test('the same redirect next week is not a change; a different place is', () => {
    const open = [{ number: 7, title: titleFor('Spokeo'), state: 'open', labels: [LABEL], brokerName: 'Spokeo', missing: ['redirected to parked.example.net'] }];
    assert.deepEqual(planIssueActions({ openIssues: open, results: { Spokeo: moved() } }), []);
    const plan = planIssueActions({ openIssues: open, results: { Spokeo: moved({ redirectedTo: 'other.example.org' }) } });
    assert.equal(plan[0].type, 'comment');
    assert.match(plan[0].body, /other\.example\.org/);
  });
});
