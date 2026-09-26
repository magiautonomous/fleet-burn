// Shared fixtures. Every test file imports from here so the numbers in the
// tests and the numbers in the docs cannot drift apart.
import { parseMetrics } from '../lib/parse.js';

export const day = (d, over = {}) => ({ date: d, completedTasks: 0, ...over });

// A three-agent, two-day fleet with a deliberate leak on day 2.
export const twoDayFleet = () =>
  parseMetrics({
    schema: 'fleet-burn/metrics@1',
    dataClass: 'SYNTHETIC',
    fleet: 'test fleet',
    window: { days: 2 },
    totals: { tasksCompleted: 5 },
    budget: { capReadsPerDay: 1000, capUsdPerDay: 10 },
    days: [
      day('2026-09-01', { storageReads: 100, llmCalls: 10, tokensIn: 1_000_000, tokensOut: 100_000, completedTasks: 4 }),
      day('2026-09-02', { storageReads: 5_000, llmCalls: 40, tokensIn: 500_000, tokensOut: 250_000, completedTasks: 1 }),
    ],
    agents: [
      {
        id: 'alpha',
        name: 'Alpha',
        role: 'core',
        storageReads: 2_000,
        llmCalls: 25,
        tokensIn: 1_000_000,
        tokensOut: 200_000,
        days: [
          { date: '2026-09-01', storageReads: 50, llmCalls: 5 },
          { date: '2026-09-02', storageReads: 1_950, llmCalls: 20 },
        ],
      },
      {
        id: 'beta',
        name: 'Beta',
        role: 'core',
        storageReads: 1_500,
        llmCalls: 15,
        tokensIn: 400_000,
        tokensOut: 100_000,
        days: [
          { date: '2026-09-01', storageReads: 30, llmCalls: 4 },
          { date: '2026-09-02', storageReads: 1_470, llmCalls: 11 },
        ],
      },
      { id: 'gamma', name: 'Gamma', role: 'worker', storageReads: 1_600, llmCalls: 10, tokensIn: 100_000, tokensOut: 50_000 },
    ],
    tasks: [
      {
        id: 'T1',
        title: 'cheap and useful',
        agent: 'alpha',
        status: 'Done',
        startedAt: '2026-09-01T10:00:00Z',
        llmCalls: 5,
        tokensIn: 500_000,
        tokensOut: 50_000,
        storageReads: 20,
      },
      {
        id: 'T2',
        title: 'the fat query',
        agent: 'beta',
        status: 'Done',
        startedAt: '2026-09-02T06:00:00Z',
        llmCalls: 30,
        tokensIn: 400_000,
        tokensOut: 200_000,
        storageReads: 1_400,
      },
      {
        id: 'T3',
        title: 'retry storm',
        agent: 'gamma',
        status: 'Blocked',
        startedAt: '2026-09-02T07:00:00Z',
        llmCalls: 10,
        tokensIn: 100_000,
        tokensOut: 50_000,
        storageReads: 500,
      },
    ],
  });

// Minimal valid document: every dimension optional, must not throw.
export const emptyFleet = () => parseMetrics({ days: [{ date: '2026-01-01' }] });

// A fleet comfortably inside its caps: the "nothing is wrong" baseline.
export const inCapsFleet = () =>
  parseMetrics({
    budget: { capReadsPerDay: 10_000, capUsdPerDay: 10 },
    days: [{ date: '2026-09-01', storageReads: 120, llmCalls: 8, tokensIn: 200_000, tokensOut: 20_000, completedTasks: 5 }],
    agents: [{ id: 'alpha', name: 'Alpha', storageReads: 120, llmCalls: 8, tokensIn: 200_000, tokensOut: 20_000 }],
    tasks: [
      {
        id: 'OK1',
        title: 'a healthy task',
        agent: 'alpha',
        status: 'Done',
        startedAt: '2026-09-01T09:00:00Z',
        llmCalls: 8,
        tokensIn: 200_000,
        tokensOut: 20_000,
        storageReads: 120,
      },
    ],
  });

// The same fleet shape with no budget block at all, for the "no cap is set"
// cases. Keeps `twoDayFleet` the one place that carries document caps.
export const uncappedFleet = (over = {}) =>
  parseMetrics({
    days: [{ date: '2026-09-01', storageReads: 5_000, tokensOut: 250_000 }],
    ...over,
  });
