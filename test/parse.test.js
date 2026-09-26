import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseMetrics, readMetricsFile, isDayKey, MetricsError, SCHEMA_ID, DIMENSIONS } from '../lib/parse.js';
import { twoDayFleet, emptyFleet } from './fixtures.js';

// assert.throws does not hand back the error, and half of what these tests
// check is the message. So: run it, catch it, assert on both.
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a throw, got none');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');

test('isDayKey accepts only UTC day keys', () => {
  assert.equal(isDayKey('2026-09-01'), true);
  assert.equal(isDayKey('2026-02-30'), false, 'Feb 30 is not a real day');
  assert.equal(isDayKey('2026-9-1'), false);
  assert.equal(isDayKey('2026-09-01T00:00:00Z'), false);
  assert.equal(isDayKey(''), false);
  assert.equal(isDayKey(null), false);
});

test('a document with no dimensions at all is still a valid metrics document', () => {
  const m = emptyFleet();
  assert.equal(m.schema, SCHEMA_ID);
  assert.equal(m.days.length, 1);
  for (const k of DIMENSIONS) assert.equal(m.days[0][k], 0, `${k} should default to 0`);
});

test('field aliases are accepted so a fleet keeps its own names', () => {
  const m = parseMetrics({
    days: [{ day: '2026-09-01', reads: 12, promptTokens: 300, completionTokens: 30, cost: 1.5 }],
  });
  assert.equal(m.days[0].storageReads, 12);
  assert.equal(m.days[0].tokensIn, 300);
  assert.equal(m.days[0].tokensOut, 30);
  assert.equal(m.days[0].estimatedCostUsd, 1.5);
});

test('a supplied cost is believed, not overwritten by the price card', () => {
  const m = parseMetrics({ days: [{ date: '2026-09-01', cost: 42 }] });
  assert.equal(m.days[0].estimatedCostUsd, 42);
});

test('rejects a non-object document', () => {
  assert.throws(() => parseMetrics([]), MetricsError);
  assert.throws(() => parseMetrics('nope'), MetricsError);
  assert.throws(() => parseMetrics(null), MetricsError);
});

test('rejects an unknown schema instead of guessing', () => {
  assert.throws(() => parseMetrics({ schema: 'other/metrics@9', days: [] }), /unsupported schema/);
});

test('rejects a malformed day key with the offending path', () => {
  const err = thrown(() => parseMetrics({ days: [{ date: 'Sept 1' }] }), MetricsError);
  assert.match(err.message, /days\[0\]\.date/);
  assert.match(err.message, /YYYY-MM-DD/);
});

test('rejects duplicate day rows rather than silently summing them', () => {
  assert.throws(
    () => parseMetrics({ days: [{ date: '2026-09-01' }, { date: '2026-09-01' }] }),
    /duplicate day row/,
  );
});

test('rejects a negative dimension', () => {
  const err = thrown(() => parseMetrics({ days: [{ date: '2026-09-01', reads: -1 }] }), MetricsError);
  assert.match(err.message, /must be >= 0/);
});

test('rejects a non-numeric dimension and names the field', () => {
  const err = thrown(() => parseMetrics({ days: [{ date: '2026-09-01', reads: 'lots' }] }), MetricsError);
  assert.match(err.message, /days\[0\]\.storageReads/);
});

test('rejects a non-array where an array is required', () => {
  assert.throws(() => parseMetrics({ days: {}, tasks: 3 }), /days must be an array/);
  assert.throws(() => parseMetrics({ days: [], tasks: 3 }), /tasks must be an array/);
});

test('day rows are sorted so the report is chronological whatever the input order', () => {
  const m = parseMetrics({ days: [{ date: '2026-09-03' }, { date: '2026-09-01' }, { date: '2026-09-02' }] });
  assert.deepEqual(m.days.map((d) => d.date), ['2026-09-01', '2026-09-02', '2026-09-03']);
});

test('a task start timestamp becomes a UTC day bucket', () => {
  const m = parseMetrics({
    tasks: [{ id: 'T', startedAt: '2026-09-02T23:30:00+02:00' }],
  });
  assert.equal(m.tasks[0].day, '2026-09-02', '23:30+02:00 is 21:30Z on the 2nd');
});

test('a task with no start timestamp has no day rather than a fake one', () => {
  const m = parseMetrics({ tasks: [{ id: 'T' }] });
  assert.equal(m.tasks[0].day, null);
});

test('a task with no agent becomes unattributed, not lost', () => {
  const m = parseMetrics({ tasks: [{ id: 'T', storageReads: 5 }] });
  assert.equal(m.tasks[0].agent, 'unattributed');
  assert.equal(m.tasks[0].storageReads, 5);
});

test('agents[].tasks accepts a count or an embedded list', () => {
  const counted = parseMetrics({ agents: [{ id: 'a', tasks: 7 }] });
  assert.equal(counted.agents[0].tasks, 7);
  const listed = parseMetrics({ agents: [{ id: 'a', tasks: [{ id: 'x' }, { id: 'y' }] }] });
  assert.equal(listed.agents[0].tasks, 2);
});

test('per-day agent splits parse from both an array and a map', () => {
  const arr = parseMetrics({ agents: [{ id: 'a', days: [{ date: '2026-09-01', reads: 3 }] }] });
  assert.equal(arr.agents[0].byDay.get('2026-09-01').storageReads, 3);
  const map = parseMetrics({ agents: [{ id: 'a', days: { '2026-09-01': { reads: 4 } } }] });
  assert.equal(map.agents[0].byDay.get('2026-09-01').storageReads, 4);
  const none = parseMetrics({ agents: [{ id: 'a' }] });
  assert.equal(none.agents[0].byDay.size, 0);
});

test('a bad per-day agent key is rejected with its path', () => {
  const err = thrown(
    () => parseMetrics({ agents: [{ id: 'a', days: { yesterday: { reads: 1 } } }] }),
    MetricsError,
  );
  assert.match(err.message, /agents\[0\]\.days/);
});

test('readMetricsFile reads a document from disk', () => {
  const m = readMetricsFile(path.join(dataDir, 'fleet-sample.json'));
  assert.equal(m.schema, SCHEMA_ID);
  assert.ok(m.days.length > 0);
  assert.ok(m.tasks.length > 0);
});

test('readMetricsFile reads a document from a string (stdin)', () => {
  const m = readMetricsFile('-', { stdin: JSON.stringify({ days: [{ date: '2026-09-01', reads: 9 }] }) });
  assert.equal(m.days[0].storageReads, 9);
});

test('readMetricsFile reports a missing file as a MetricsError, not an ENOENT', () => {
  const err = thrown(() => readMetricsFile('/nope/missing.json'), MetricsError);
  assert.match(err.message, /cannot read metrics file/);
});

test('readMetricsFile reports invalid JSON with the file name', () => {
  const err = thrown(() => readMetricsFile('-', { stdin: '{oops' }), MetricsError);
  assert.match(err.message, /is not valid JSON/);
});

test('the committed real sample is labelled REAL and is internally consistent', () => {
  const raw = JSON.parse(readFileSync(path.join(dataDir, 'fleet-sample.json'), 'utf8'));
  assert.equal(raw.dataClass, 'REAL');
  const m = parseMetrics(raw);
  const daySum = m.days.reduce((a, d) => a + d.storageReads, 0);
  const taskSum = m.tasks.reduce((a, t) => a + t.storageReads, 0);
  const agentSum = m.agents.reduce((a, x) => a + x.storageReads, 0);
  assert.equal(daySum, raw.totals.storageReads, 'day rows must sum to the declared total');
  assert.equal(taskSum + (raw.totals.coordinationReads || 0), raw.totals.storageReads,
    'task-attributed reads plus coordination reads must equal the total');
  assert.equal(agentSum, raw.totals.storageReads, 'agent rows must sum to the declared total');
  assert.ok(raw.provenance && Object.keys(raw.provenance).length > 0, 'a REAL sample must carry provenance');
});

test('the incident reconstruction is labelled SYNTHETIC and never claims to be measured', () => {
  const raw = JSON.parse(readFileSync(path.join(dataDir, 'incident-pre-fix-reconstruction.json'), 'utf8'));
  assert.equal(raw.dataClass, 'SYNTHETIC');
  assert.equal(raw.reconstruction.kind, 'configuration-replay');
  for (const v of Object.values(raw.reconstruction.computed)) {
    assert.ok(v !== undefined, 'every replay input is stated');
  }
  assert.match(raw.reconstruction.measured_cited.note, /Unreconciled on purpose/);
  assert.ok(raw.days.every((d) => d.storageReads > 50_000), 'the replay must actually blow the free-tier cap');
});

test('twoDayFleet fixture stays the shape the other test files assume', () => {
  const m = twoDayFleet();
  assert.equal(m.days.length, 2);
  assert.equal(m.agents.length, 3);
  assert.equal(m.tasks.length, 3);
  assert.equal(m.budget.capReadsPerDay, 1000);
});
