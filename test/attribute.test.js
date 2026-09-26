import test from 'node:test';
import assert from 'node:assert/strict';

import { attribute, burnRate, activeSpan, taskLabel } from '../lib/attribute.js';
import { parseMetrics } from '../lib/parse.js';
import { REFERENCE_PRICE_CARD } from '../lib/price.js';
import { twoDayFleet, emptyFleet } from './fixtures.js';

const M = 1_000_000;
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

test('an empty fleet attributes to nothing and still returns a full report shape', () => {
  const r = attribute(emptyFleet());
  assert.equal(r.totals.storageReads, 0);
  assert.equal(r.totals.estimatedCostUsd, 0);
  assert.deepEqual(r.agents, []);
  assert.deepEqual(r.tasks, []);
  assert.equal(r.coverage, 1);
  assert.equal(r.window.activeDays, 0);
});

test('the fleet total is the declared total when the document declares one', () => {
  const r = attribute(parseMetrics({ totals: { storageReads: 999 }, days: [{ date: '2026-09-01', storageReads: 5 }] }));
  assert.equal(r.totals.storageReads, 999);
});

test('the fleet total is rolled up from the days when nothing is declared', () => {
  const r = attribute(
    parseMetrics({
      days: [
        { date: '2026-09-01', storageReads: 10 },
        { date: '2026-09-02', storageReads: 32 },
      ],
    }),
  );
  assert.equal(r.totals.storageReads, 42);
});

test('agent rows and task rows both reconcile to the fleet total', () => {
  const m = parseMetrics({
    totals: { storageReads: 1_000 },
    days: [{ date: '2026-09-01', storageReads: 1_000 }],
    agents: [{ id: 'a', storageReads: 1_000 }],
    tasks: [{ id: 'T', agent: 'a', storageReads: 1_000 }],
  });
  const r = attribute(m);
  assert.equal(r.agents.reduce((a, x) => a + x.storageReads, 0), 1_000);
  assert.equal(r.tasks.reduce((a, x) => a + x.storageReads, 0), 1_000);
  assert.equal(r.unattributed.storageReads, 0, 'nothing is lost when the rows agree');
  assert.equal(r.coverage, 1);
});

test('a task roll-up never dilutes a larger declared agent row', () => {
  // The agent declared 1_000 reads; its single task claims 10. The agent's
  // number is the declared one — the task does not shrink it.
  const m = parseMetrics({
    totals: { storageReads: 1_000 },
    agents: [{ id: 'a', storageReads: 1_000 }],
    tasks: [{ id: 'T', agent: 'a', storageReads: 10 }],
  });
  const r = attribute(m);
  assert.equal(r.agents[0].storageReads, 1_000);
  assert.equal(r.unattributed.storageReads, 0);
});

test('a task roll-up never double-counts a declared agent row', () => {
  const m = parseMetrics({
    totals: { storageReads: 500 },
    agents: [{ id: 'a', storageReads: 500 }],
    tasks: [
      { id: 'T1', agent: 'a', storageReads: 300 },
      { id: 'T2', agent: 'a', storageReads: 200 },
    ],
  });
  const r = attribute(m);
  assert.equal(r.agents[0].storageReads, 500, 'not 1000');
  assert.equal(r.totals.storageReads, 500);
});

test('a task claiming more than its agent declared raises the agent to the task figure', () => {
  // The declared agent row is stale and the task row is newer. The meter keeps
  // the larger, because under-reporting is the failure mode that costs money.
  const m = parseMetrics({
    totals: { storageReads: 5_000 },
    agents: [{ id: 'a', storageReads: 100 }],
    tasks: [{ id: 'T', agent: 'a', storageReads: 5_000 }],
  });
  const r = attribute(m);
  assert.equal(r.agents[0].storageReads, 5_000);
  assert.equal(r.unattributed.storageReads, 0);
  assert.equal(r.coverage, 1);
});

test('a task with no agent is counted as unattributed work, not dropped', () => {
  const m = parseMetrics({
    totals: { storageReads: 100 },
    agents: [{ id: 'a', storageReads: 40 }],
    tasks: [{ id: 'T', storageReads: 60 }],
  });
  const r = attribute(m);
  const unattributedAgent = r.agents.find((a) => a.id === 'unattributed');
  assert.ok(unattributedAgent, 'the orphan task gets its own agent row');
  assert.equal(unattributedAgent.storageReads, 60);
  assert.equal(r.coverage, 1);
});

test('coverage reports the gap when the fleet total exceeds what any row claims', () => {
  const m = parseMetrics({
    totals: { storageReads: 1_000 },
    agents: [{ id: 'a', storageReads: 250 }],
    tasks: [{ id: 'T', agent: 'a', storageReads: 250 }],
  });
  const r = attribute(m);
  assert.equal(r.unattributed.storageReads, 500);
  assert.ok(r.coverage < 1 && r.coverage > 0.4, `coverage ${r.coverage} should show the gap`);
});

test('burn rate divides by the active span, not the reported day count', () => {
  const m = parseMetrics({
    days: [
      { date: '2026-09-01', storageReads: 1_000 },
      { date: '2026-09-02' },
      { date: '2026-09-03' },
      { date: '2026-09-04' },
      { date: '2026-09-05', storageReads: 1_000 },
    ],
  });
  const r = attribute(m);
  assert.equal(r.window.activeDays, 2, 'the three idle days are not part of the average');
  approx(r.totals.burn.readsPerDay, 1_000);
});

test('a single active day still reports a rate rather than dividing by zero', () => {
  const r = attribute(parseMetrics({ days: [{ date: '2026-09-01', storageReads: 42 }] }));
  assert.equal(r.window.activeDays, 1);
  assert.equal(r.totals.burn.readsPerDay, 42);
});

test('activeSpan ignores days with no activity at all', () => {
  const m = parseMetrics({
    days: [{ date: '2026-09-01' }, { date: '2026-09-02', storageReads: 1 }, { date: '2026-09-03' }],
  });
  assert.deepEqual(activeSpan(m), { days: 1, start: '2026-09-02', end: '2026-09-02' });
});

test('a task with no start date does not appear in any day bucket', () => {
  const m = parseMetrics({
    days: [{ date: '2026-09-01', storageReads: 100 }],
    tasks: [{ id: 'T', storageReads: 100 }],
  });
  const r = attribute(m);
  assert.equal(r.days[0].storageReads, 100, 'the day row stands on its own');
  assert.equal(r.days[0].tasksStarted, 0);
});

test('tasks are bucketed into the day they started, and the day takes the larger of its own row and that bucket', () => {
  const m = parseMetrics({
    days: [{ date: '2026-09-01', storageReads: 10 }],
    tasks: [{ id: 'T', startedAt: '2026-09-01T05:00:00Z', storageReads: 99 }],
  });
  const r = attribute(m);
  assert.equal(r.days[0].storageReads, 99);
  assert.equal(r.days[0].tasksStarted, 1);
});

test('cost is estimated per row and summed, and the breakdown adds up', () => {
  const r = attribute(twoDayFleet());
  const t = r.totals;
  approx(t.estimatedCostUsd, t.costBreakdown.storageUsd + t.costBreakdown.llmUsd + t.costBreakdown.tokenUsd, 1e-5);
  assert.equal(t.costBreakdown.source, 'priceCard');
});

test('an explicit price card changes the answer, proportionally', () => {
  const m = twoDayFleet();
  const base = attribute(m);
  const doubled = attribute(m, { priceCard: { perMillion: { tokensIn: REFERENCE_PRICE_CARD.perMillion.tokensIn * 2 } } });
  const inDelta = (1_500_000 / 1_000_000) * REFERENCE_PRICE_CARD.perMillion.tokensIn;
  approx(doubled.totals.estimatedCostUsd - base.totals.estimatedCostUsd, inDelta, 1e-6);
});

test('cost per outcome is spend divided by completed tasks, and null with no completions', () => {
  const r = attribute(twoDayFleet());
  const d1 = r.days.find((d) => d.date === '2026-09-01');
  const d2 = r.days.find((d) => d.date === '2026-09-02');
  approx(d1.costPerOutcome, d1.estimatedCostUsd / 4, 1e-9);
  approx(d2.costPerOutcome, d2.estimatedCostUsd / 1, 1e-9);
  const none = attribute(parseMetrics({ days: [{ date: '2026-09-01', storageReads: 5 }] }));
  assert.equal(none.days[0].costPerOutcome, null);
});

test('worst cost-per-outcome ranks the days that spent the most per completion', () => {
  const r = attribute(twoDayFleet());
  assert.equal(r.rankings.worstCostPerOutcomeDays[0].date, '2026-09-02',
    'day 2 spent far more and completed one task');
});

test('the four leaderboards answer the four questions and are sorted', () => {
  const r = attribute(twoDayFleet());
  const { mostExpensiveAgents, heaviestReaders, mostExpensiveTasks, readiestTasks } = r.rankings;
  assert.equal(mostExpensiveAgents[0].id, 'alpha', 'alpha carries the most tokens (1M in + 200k out)');
  assert.equal(heaviestReaders[0].id, 'alpha', 'alpha declared 2,000 reads and its tasks claim 20');
  assert.deepEqual(mostExpensiveAgents.map((a) => a.id), ['alpha', 'beta', 'gamma']);
  assert.equal(mostExpensiveTasks[0].id, 'T2');
  assert.equal(readiestTasks[0].id, 'T2');
  for (const list of [mostExpensiveAgents, heaviestReaders, mostExpensiveTasks, readiestTasks]) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const key = list === mostExpensiveAgents || list === mostExpensiveTasks ? 'estimatedCostUsd' : 'storageReads';
      assert.ok(prev[key] >= list[i][key], 'leaderboards are descending');
    }
  }
});

test('agents come back ranked by cost with a resolved name', () => {
  const m = parseMetrics({ agents: [{ id: 'solo' }], tasks: [{ id: 'T', agent: 'solo', tokensOut: 1 * M }] });
  const r = attribute(m);
  assert.equal(r.agents[0].id, 'solo');
  assert.equal(r.agents[0].name, 'solo', 'name falls back to the id');
  assert.equal(r.agents[0].taskCount, 1);
});

test('a per-day agent split is carried through for exact budget attribution', () => {
  const r = attribute(twoDayFleet());
  const alpha = r.agents.find((a) => a.id === 'alpha');
  assert.equal(alpha.byDay['2026-09-02'].storageReads, 1_950);
  const gamma = r.agents.find((a) => a.id === 'gamma');
  assert.deepEqual(gamma.byDay, {}, 'an agent with no split reports none');
  assert.ok(JSON.parse(JSON.stringify(r)).agents.length, 'the report survives a JSON round trip');
});

test('coordination reads raise the agent total without inflating the fleet total', () => {
  const m = parseMetrics({
    totals: { storageReads: 300 },
    days: [{ date: '2026-09-01', storageReads: 300 }],
    agents: [{ id: 'a', storageReads: 100, coordinationReads: 100 }],
    tasks: [{ id: 'T', agent: 'a', storageReads: 200 }],
  });
  const r = attribute(m);
  const a = r.agents[0];
  assert.equal(a.coordinationReads, 100);
  assert.equal(a.storageReads, 200, 'max(declared 100, tasks 200) beats the coordination floor of 100');
  assert.equal(r.totals.storageReads, 300);
});

test('every task in a report carries the full dimension set, so a renderer cannot guess', () => {
  const r = attribute(twoDayFleet());
  for (const t of r.tasks) {
    for (const k of ['storageReads', 'llmCalls', 'tokensIn', 'tokensOut', 'tokensTotal', 'estimatedCostUsd']) {
      assert.equal(typeof t[k], 'number', `${t.id}.${k}`);
    }
  }
});

test('burnRate never divides by a sub-day window', () => {
  assert.equal(burnRate(100, 10, 5, 50, 0).readsPerDay, 10);
  assert.equal(burnRate(100, 10, 5, 50, 0.1).readsPerDay, 10);
  assert.equal(burnRate(100, 10, 5, 50, 4).readsPerDay, 2.5);
});

test('taskLabel is safe to print in a CI failure', () => {
  assert.equal(taskLabel({ id: 'T1', title: 'do the thing' }), 'do the thing (T1)');
  assert.equal(taskLabel({ id: 'T1', title: '' }), 'task (T1)');
  assert.match(taskLabel({}), /untitled/);
});
