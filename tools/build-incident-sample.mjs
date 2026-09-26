// Regenerates data/incident-pre-fix-reconstruction.json.
//
// READ THIS BEFORE TRUSTING THE NUMBERS. This file is a REPLAY of the
// documented pre-fix configuration, not a measurement:
//
//   COMPUTED here    reads/day  = 78 docs/poll x 720 polls/day x 3 workers
//   COMPUTED here    the per-task and per-agent splits of that total
//   MEASURED (cited) the 09:09Z freeze time, and the 941-2,553/day (8,532/week)
//                    RESOURCE_EXHAUSTED counts from the incident write-up
//
// The replay total (168,480 reads/day) exhausts a 50,000 read cap at about
// 07:00Z if all three workers are leaking at once, which is earlier than the
// observed 09:09Z freeze. That gap is real and is left visible on purpose: it
// means the leak was not running at full three-worker concurrency on the day it
// was measured. Reconciling it needs the Cloud Monitoring export that is still
// operator-gated, so it stays an open item rather than a number we invent.
//
// Usage: node tools/build-incident-sample.mjs > data/incident-pre-fix-reconstruction.json

const READS_PER_POLL = 78; // the fat query: full task history, fanned out
const POLL_INTERVAL_S = 120; // 720 polls per day
const WORKERS = ['Casper', 'Balthasar', 'Melchior'];
const FREE_TIER_CAP = 50_000;
const WINDOW_DAYS = 7;

// Which worker was doing what on the incident day, from the incident record.
const TASKS = [
  {
    id: 'inc-board-poll-history',
    title: 'board poll: query the full task history instead of live cards',
    agent: 'Casper',
    weight: 0.5,
    status: 'Done',
  },
  {
    id: 'inc-reclaim-churn',
    title: 're-claim churn: re-read every card in flight on each poll cycle',
    agent: 'Melchior',
    weight: 0.3,
    status: 'Done',
  },
  {
    id: 'inc-retry-storm',
    title: 'retry storm after RESOURCE_EXHAUSTED: 10 min of retries per worker',
    agent: 'Balthasar',
    weight: 0.2,
    status: 'Blocked',
  },
];

const pollsPerDay = 24 * 60 * 60 / POLL_INTERVAL_S;
const readsPerWorkerPerDay = READS_PER_POLL * pollsPerDay;
const coordinationReadsPerDay = 3_840; // alert loop: 40 docs / 15 min
const workerReadsPerDay = readsPerWorkerPerDay * WORKERS.length;
const totalReadsPerDay = workerReadsPerDay + coordinationReadsPerDay;

const days = [];
for (let i = 0; i < WINDOW_DAYS; i++) {
  const d = new Date(Date.UTC(2026, 8, 15 + i));
  const date = d.toISOString().slice(0, 10);
  days.push({
    date,
    storageReads: totalReadsPerDay,
    llmCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    completedTasks: 0,
    agentTasksStarted: TASKS.length,
  });
}

const agents = WORKERS.map((id) => {
  const mine = TASKS.filter((t) => t.agent === id);
  return {
    id,
    name: id,
    role: 'core',
    storageReads: readsPerWorkerPerDay,
    coordinationReads: 0,
    llmCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    tasks: mine.length * WINDOW_DAYS,
    // The replay is uniform across the window, so it can state its per-day
    // split exactly. Emitting it is what makes "which agent blew the cap on
    // 2026-09-19" a day-scoped answer instead of a window-wide guess.
    days: days.map((d) => ({ date: d.date, storageReads: readsPerWorkerPerDay })),
  };
});
const perAgentPerDay = agents.reduce((s, a) => s + a.days[0].storageReads, 0) + coordinationReadsPerDay;
if (perAgentPerDay !== totalReadsPerDay) {
  throw new Error(`per-day agent split ${perAgentPerDay} does not reconcile with ${totalReadsPerDay}`);
}

// One task row per failure mode per day, so every capped day has an exact
// task to name instead of a window-wide fallback. The split of the workers'
// combined poll reads is apportioned by weight, with the rounding remainder
// given to the largest task so the day reconciles to the penny.
const tasks = [];
for (const d of days) {
  const shares = TASKS.map((t) => Math.floor((workerReadsPerDay * t.weight)));
  const remainder = workerReadsPerDay - shares.reduce((a, b) => a + b, 0);
  shares[0] += remainder;
  TASKS.forEach((t, i) => {
    tasks.push({
      id: `${t.id}@${d.date}`,
      title: t.title,
      agent: t.agent,
      status: t.status,
      startedAt: `${d.date}T00:00:00.000Z`,
      endedAt: `${d.date}T23:59:59.000Z`,
      durationS: 86_340,
      llmCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      storageReads: shares[i],
    });
  });
}
const taskReadsPerDay = tasks
  .filter((t) => t.startedAt.startsWith(days[0].date))
  .reduce((s, t) => s + t.storageReads, 0);
if (taskReadsPerDay !== workerReadsPerDay) {
  throw new Error(`task split ${taskReadsPerDay} does not reconcile with ${workerReadsPerDay}`);
}

const doc = {
  schema: 'fleet-burn/metrics@1',
  dataClass: 'SYNTHETIC',
  fleet: 'magi agent fleet, pre-fix replay (3 cores, 1 host, Firestore free tier)',
  window: { start: '2026-09-15T00:00:00.000Z', end: '2026-09-21T23:59:59.999Z', days: WINDOW_DAYS },
  pricing: { currency: 'USD', note: 'No token usage in this replay; the whole bill is storage reads.' },
  budget: {
    capReadsPerDay: FREE_TIER_CAP,
    capUsdPerDay: 1,
    rationale: '50,000 Firestore free-tier document reads/day; the USD cap is a demo value, not a provider limit.',
  },
  totals: {
    storageReads: totalReadsPerDay * WINDOW_DAYS,
    llmCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    tasksAttributed: tasks.length,
    tasksCompleted: 0,
    pollEvents: pollsPerDay * WINDOW_DAYS * WORKERS.length,
    coordinationReads: coordinationReadsPerDay * WINDOW_DAYS,
  },
  days,
  agents,
  tasks,
  reconstruction: {
    kind: 'configuration-replay',
    computed: {
      readsPerPoll: READS_PER_POLL,
      pollIntervalS: POLL_INTERVAL_S,
      pollsPerDay,
      workers: WORKERS.length,
      readsPerWorkerPerDay,
      workerReadsPerDay,
      coordinationReadsPerDay,
      totalReadsPerDay,
      cap: FREE_TIER_CAP,
      timesCap: Number((totalReadsPerDay / FREE_TIER_CAP).toFixed(3)),
      exhaustsCapAtUtc: '~07:00Z (if all three workers leak simultaneously)',
    },
    measured_cited: {
      observedFreezeAtUtc: '09:09Z',
      resourceExhaustedPerDay: [941, 2553],
      resourceExhaustedPerWeek: 8532,
      note: 'Observed on the fleet, cited from the read-budget incident write-up. The replay exhausts the cap earlier than 09:09Z, so the leak was not at full three-worker concurrency on the day it was measured. Unreconciled on purpose: closing it needs the Cloud Monitoring export that is still operator-gated.',
    },
  },
  provenance: {
    storageReads: 'COMPUTED - 78 docs/poll x 720 polls/day x 3 workers. Not measured.',
    tokens: 'n/a - this replay is a storage-read incident only.',
    completions: 'COMPUTED as 0 - the fleet completed nothing while the budget was frozen.',
    purpose: 'Demo input for the budget guard. Use data/fleet-sample.json for real data.',
  },
};

process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
