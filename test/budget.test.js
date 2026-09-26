import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseMetrics } from '../lib/parse.js';
import { attribute } from '../lib/attribute.js';
import {
  checkBudget,
  resolveCaps,
  hasAnyCap,
  exitCodeFor,
  EXIT_OK,
  EXIT_BREACH,
  EXIT_USAGE,
} from '../lib/budget.js';
import { twoDayFleet, uncappedFleet, inCapsFleet } from './fixtures.js';

const report = (m, opts) => attribute(m, opts);

test('a fleet inside its caps is OK and exits zero', () => {
  const r = checkBudget(report(inCapsFleet()));
  assert.equal(r.ok, true);
  assert.equal(exitCodeFor(r), EXIT_OK);
  assert.equal(r.violations.length, 0);
  assert.ok(r.checked > 0, 'the days were actually checked, not skipped');
  assert.equal(r.peak.readsPerDay, 120);
});

test('a blown reads cap exits non-zero', () => {
  const r = checkBudget(report(twoDayFleet()));
  assert.equal(r.ok, false);
  assert.equal(exitCodeFor(r), EXIT_BREACH);
  assert.notEqual(exitCodeFor(r), EXIT_OK);
  assert.notEqual(exitCodeFor(r), EXIT_USAGE, 'a breach is 1, not a usage error');
});

test('a breach names the day, the cap, the actual and the overage', () => {
  const [v] = checkBudget(report(twoDayFleet())).violations;
  assert.equal(v.kind, 'reads');
  assert.equal(v.day, '2026-09-02');
  assert.equal(v.cap, 1000);
  assert.equal(v.actual, 5000);
  assert.equal(v.overage, 4000);
  assert.equal(v.overBy, 5);
});

test('a breach names the agent that blew the cap, day-scoped when the data allows it', () => {
  const [v] = checkBudget(report(twoDayFleet())).violations;
  assert.equal(v.agent.id, 'alpha');
  assert.equal(v.agent.name, 'Alpha');
  assert.equal(v.agent.value, 1950, 'the exact per-day figure from agents[].days, not a window share');
  assert.equal(v.agent.scope, 'day');
  assert.ok(v.agent.share > 0 && v.agent.share < 1, 'and its share of the day');
});

test('a breach names the task that blew the cap', () => {
  const [v] = checkBudget(report(twoDayFleet())).violations;
  assert.equal(v.task.id, 'T2');
  assert.equal(v.task.title, 'the fat query');
  assert.equal(v.task.agent, 'beta');
  assert.equal(v.task.value, 1400);
  assert.equal(v.task.scope, 'day');
});

test('a breach carries a one-sentence reason naming agent, task and numbers', () => {
  const [v] = checkBudget(report(twoDayFleet())).violations;
  assert.match(v.reason, /agent Alpha/);
  assert.match(v.reason, /the fat query/);
  assert.match(v.reason, /2026-09-02/);
  assert.match(v.reason, /5,000/);
  assert.match(v.reason, /1,000/);
});

test('when the document has no per-day agent split, the agent is window-scoped and says so', () => {
  const m = parseMetrics({
    days: [{ date: '2026-09-01', storageReads: 9_000 }],
    agents: [{ id: 'a', name: 'A', storageReads: 3_000 }],
    tasks: [{ id: 'T', agent: 'a', storageReads: 1_000, startedAt: '2026-09-01T00:00:00Z' }],
  });
  const [v] = checkBudget(report(m), { capReadsPerDay: 1000 }).violations;
  assert.equal(v.agent.scope, 'window');
  assert.match(v.reason, /no per-day agent split/);
  assert.equal(v.agent.value, 3000, 'the window total, honestly labelled');
});

test('every capped day produces its own violation, worst first', () => {
  const m = parseMetrics({
    days: [
      { date: '2026-09-01', storageReads: 2_000 },
      { date: '2026-09-02', storageReads: 8_000 },
      { date: '2026-09-03', storageReads: 4_000 },
    ],
  });
  const r = checkBudget(report(m), { capReadsPerDay: 1000 });
  assert.equal(r.violations.length, 3);
  assert.deepEqual(r.violations.map((v) => v.day), ['2026-09-02', '2026-09-03', '2026-09-01']);
  for (let i = 1; i < r.violations.length; i++) {
    assert.ok(r.violations[i - 1].overBy >= r.violations[i].overBy, 'sorted by how badly the cap was blown');
  }
});

test('a day exactly at the cap is not a breach', () => {
  const m = parseMetrics({ days: [{ date: '2026-09-01', storageReads: 1000 }] });
  const r = checkBudget(report(m), { capReadsPerDay: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.checked, 1, 'it was still checked');
});

test('a day one read over the cap is a breach — the boundary is not fuzzy', () => {
  const m = parseMetrics({ days: [{ date: '2026-09-01', storageReads: 1001 }] });
  assert.equal(checkBudget(report(m), { capReadsPerDay: 1000 }).ok, false);
});

test('idle days are not counted as checked and cannot breach', () => {
  const m = parseMetrics({ days: [{ date: '2026-09-01', storageReads: 5_000 }, { date: '2026-09-02' }] });
  const r = checkBudget(report(m), { capReadsPerDay: 1000 });
  assert.equal(r.checked, 1);
  assert.equal(r.violations.length, 1);
});

test('a USD cap fires independently of the reads cap', () => {
  const m = parseMetrics({ days: [{ date: '2026-09-01', tokensOut: 10_000_000 }] });
  const r = checkBudget(report(m), { capUsdPerDay: 10 });
  assert.equal(r.ok, false);
  const [v] = r.violations;
  assert.equal(v.kind, 'usd');
  assert.equal(v.unit, 'USD');
  assert.equal(v.cap, 10);
  assert.ok(v.actual > 100, 'ten million output tokens at the reference rate');
  assert.match(v.reason, /USD cap/);
});

test('an LLM-calls cap fires independently of the other two', () => {
  const m = parseMetrics({ days: [{ date: '2026-09-01', llmCalls: 500 }] });
  const r = checkBudget(report(m), { capLlmCallsPerDay: 100 });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].kind, 'llmCalls');
  assert.equal(r.violations[0].unit, 'LLM calls');
});

test('all three caps can fire on the same day and all three are reported', () => {
  const m = parseMetrics({ days: [{ date: '2026-09-01', storageReads: 9_000, llmCalls: 900, tokensOut: 9_000_000 }] });
  const r = checkBudget(report(m), { capReadsPerDay: 1000, capLlmCallsPerDay: 100, capUsdPerDay: 1 });
  assert.deepEqual(new Set(r.violations.map((v) => v.kind)), new Set(['reads', 'llmCalls', 'usd']));
});

test('with no caps at all nothing is checked and nothing fails', () => {
  const r = checkBudget(report(uncappedFleet()), {});
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
  assert.equal(hasAnyCap(r.caps), false);
});

test('a flag cap overrides the document budget block', () => {
  const m = parseMetrics({ budget: { capReadsPerDay: 1000 }, days: [{ date: '2026-09-01', storageReads: 5_000 }] });
  assert.equal(checkBudget(report(m)).ok, false, 'the document cap alone breaches');
  assert.equal(checkBudget(report(m), { capReadsPerDay: 99_999 }).ok, true, 'a looser flag cap clears it');
});

test('a cap of zero or a junk cap is ignored rather than treated as a free pass', () => {
  const m = parseMetrics({ budget: { capReadsPerDay: 0 }, days: [{ date: '2026-09-01', storageReads: 5_000 }] });
  const r = checkBudget(report(m));
  assert.equal(r.caps.capReadsPerDay, null, 'zero is not a cap');
  assert.equal(r.checked, 0);
  assert.equal(resolveCaps(report(m), { capReadsPerDay: 'lots' }).capReadsPerDay, null);
});

test('a negative cap is ignored, not treated as an impossible-to-pass gate', () => {
  const r = checkBudget(report(uncappedFleet()), { capReadsPerDay: -5 });
  assert.equal(r.caps.capReadsPerDay, null);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
});

test('an invalid flag falls back to the document cap rather than disabling the check', () => {
  const r = checkBudget(report(twoDayFleet()), { capReadsPerDay: 'nope' });
  assert.equal(r.caps.capReadsPerDay, 1000, 'the document budget block still applies');
  assert.equal(r.ok, false);
});

test('the peak is reported even when nothing breaches', () => {
  const r = checkBudget(report(twoDayFleet()));
  assert.equal(r.peak.readsPerDay, 5000);
  assert.ok(r.peak.usdPerDay > 0);
});

test('exit codes are the documented 0/1/2', () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_BREACH, 1);
  assert.equal(EXIT_USAGE, 2);
});

test('a document with no agents at all still reports a breach without inventing a culprit', () => {
  const m = parseMetrics({ days: [{ date: '2026-09-01', storageReads: 9_000 }] });
  const [v] = checkBudget(report(m), { capReadsPerDay: 1000 }).violations;
  assert.equal(v.agent, null, 'no agent is named when no agent is reported');
  assert.equal(v.task, null);
  assert.match(v.reason, /no agent/);
  assert.match(v.reason, /no single task/);
});

test('the incident replay blows the free-tier cap and names agent and task', () => {
  const m = parseMetrics(
    JSON.parse(readFileSync(new URL('../data/incident-pre-fix-reconstruction.json', import.meta.url), 'utf8')),
  );
  const r = checkBudget(report(m), { capReadsPerDay: 50_000 });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 7, 'one breach for each of the seven replay days');
  const v = r.violations[0];
  assert.equal(v.day, '2026-09-15');
  assert.equal(v.actual, 172_320);
  assert.equal(v.overBy, 3.4464);
  assert.ok(v.agent, 'an agent is named');
  assert.equal(v.agent.scope, 'day');
  assert.equal(v.agent.value, 56_160);
  assert.ok(v.task, 'a task is named');
  assert.match(v.task.id, /^inc-/);
  assert.match(v.reason, /board poll/);
});
