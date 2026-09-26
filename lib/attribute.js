// Attribution: turn a flat metrics document into a bill you can act on.
//
// The unit of the product is not "how much did we spend" — every vendor meter
// already knows that. It is *which agent, doing which task, caused the spend*,
// because that is the only form in which a human can stop it. So:
//
//   agent  <- its own row, plus every task row that names it
//   task   <- its own row, plus the day row share it is the cause of
//   day    <- its own row, plus tasks bucketed by their start day
//
// Every roll-up reconciles: sum(agents) == fleet total, sum(days) == fleet
// total. `unattributed` holds whatever no row claims, so a gap shows up as a
// number instead of quietly disappearing.

import { rowCost, tokensTotal, withPriceCard } from './price.js';

const zero = () => ({
  storageReads: 0,
  llmCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  tokensReasoning: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  estimatedCostUsd: 0,
});

function add(target, row) {
  for (const k of Object.keys(target)) target[k] += Number(row[k]) || 0;
  return target;
}

function snapshot(acc, card) {
  const cost = rowCost(acc, card);
  return {
    ...acc,
    tokensTotal: tokensTotal(acc),
    estimatedCostUsd: cost.usd,
    costBreakdown: {
      storageUsd: cost.storageUsd,
      llmUsd: cost.llmUsd,
      tokenUsd: cost.tokenUsd,
      source: cost.source,
    },
  };
}

// A day bucket is as long as the data actually covers: from the first day with
// any activity to the last. Burn rate divides by that, so a window with one
// busy day is not reported as a 16-day average of one day.
export function activeSpan(metrics) {
  const days = metrics.days.filter((d) => hasActivity(d));
  if (!days.length) return { days: 0, start: null, end: null };
  return { days: days.length, start: days[0].date, end: days[days.length - 1].date };
}

export function hasActivity(row) {
  return DIM_KEYS.some((k) => (Number(row[k]) || 0) > 0);
}

const DIM_KEYS = [
  'storageReads',
  'llmCalls',
  'tokensIn',
  'tokensOut',
  'tokensReasoning',
  'tokensCacheRead',
  'tokensCacheWrite',
  'estimatedCostUsd',
];

// Human label for a task, safe to print in a CI failure.
export function taskLabel(task) {
  const t = (task.title || '').trim();
  const id = task.id ? ` (${task.id})` : '';
  return t ? `${t}${id}` : `task${id || ' <untitled>'}`;
}

export function attribute(metrics, options = {}) {
  const card = withPriceCard(options.priceCard);
  const days = metrics.days;

  // --- fleet total: the day's own rows if present, else rolled up -----------
  const declared = metrics.totals || {};
  const daySum = days.reduce((a, d) => add(a, d), zero());
  const hasDeclared = DIM_KEYS.some((k) => (Number(declared[k]) || 0) > 0);
  const fleet = hasDeclared
    ? { ...zero(), ...DIM_KEYS.reduce((o, k) => ((o[k] = Number(declared[k]) || 0), o), {}) }
    : daySum;

  // --- per-task -------------------------------------------------------------
  // `rawAcc` keeps the unpriced dimensions of each task. Roll-ups add from
  // `rawAcc`, never from the priced `tasks` rows: adding an already-priced row
  // and then pricing the sum again would double-count every dollar and would
  // mark a derived number as a supplied one.
  const rawAcc = [];
  const tasks = metrics.tasks.map((t, i) => {
    rawAcc.push({ ...zero() });
    add(rawAcc[i], t);
    const cost = rowCost(t, card);
    return {
      id: t.id,
      title: t.title,
      agent: t.agent,
      status: t.status,
      day: t.day,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationS: t.durationS,
      storageReads: t.storageReads,
      llmCalls: t.llmCalls,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      tokensReasoning: t.tokensReasoning,
      tokensCacheRead: t.tokensCacheRead,
      tokensCacheWrite: t.tokensCacheWrite,
      tokensTotal: tokensTotal(t),
      estimatedCostUsd: cost.usd,
      costBreakdown: { storageUsd: cost.storageUsd, llmUsd: cost.llmUsd, tokenUsd: cost.tokenUsd },
      // One delivered task is one outcome. Anything that did not land has no
      // outcome to divide by, and is left out of cost-per-outcome rather than
      // being scored as free.
      outcomes: t.status === 'Done' ? 1 : 0,
      costPerOutcome: t.status === 'Done' ? cost.usd : null,
    };
  });

  const span = activeSpan(metrics);

  // --- per-agent: own row plus the tasks it owns ---------------------------
  const agentMap = new Map();
  const agentOf = (id, name = id) => {
    if (!agentMap.has(id)) {
      agentMap.set(id, {
        id,
        name,
        role: '',
        tasks: 0,
        declared: zero(),
        fromTasks: zero(),
        coordinationReads: 0,
        byDay: new Map(),
        ...zero(),
      });
    }
    const a = agentMap.get(id);
    if (name && name !== id && a.name === id) a.name = name;
    return a;
  };
  for (const a of metrics.agents) {
    const acc = agentOf(a.id, a.name);
    acc.role = a.role || acc.role;
    add(acc.declared, a);
    acc.coordinationReads += a.coordinationReads || 0;
    if (a.byDay && a.byDay.size) acc.byDay = a.byDay;
  }
  for (let i = 0; i < tasks.length; i++) {
    const acc = agentOf(tasks[i].agent);
    add(acc.fromTasks, rawAcc[i]);
    acc.tasks += 1;
  }
  // An agent's usage is the larger of what it declared and what its tasks
  // claim, per dimension, so a task roll-up can never double-count a declared
  // row and can never be diluted by one.
  const agents = [...agentMap.values()].map((a) => {
    const acc = zero();
    for (const k of DIM_KEYS) acc[k] = Math.max(a.declared[k], a.fromTasks[k]);
    if (a.coordinationReads > acc.storageReads) acc.storageReads = a.coordinationReads;
    return {
      ...snapshot(acc, card),
      id: a.id,
      name: a.name,
      role: a.role,
      taskCount: a.tasks,
      coordinationReads: a.coordinationReads,
      // A plain object, not a Map: --json has to carry it to the dashboard.
      byDay: Object.fromEntries(a.byDay || []),
    };
  });
  agents.sort((x, y) => y.estimatedCostUsd - x.estimatedCostUsd || y.storageReads - x.storageReads);

  // --- what no row claims --------------------------------------------------
  const agentSum = agents.reduce((a, x) => add(a, x), zero());
  const taskSum = tasks.reduce((a, x) => add(a, x), zero());
  const unattributed = zero();
  for (const k of DIM_KEYS) {
    unattributed[k] = Math.max(0, fleet[k] - agentSum[k] - taskSum[k]);
  }
  const unattributedTotal = DIM_KEYS.reduce((a, k) => a + unattributed[k], 0);
  const claimedTotal = DIM_KEYS.reduce((a, k) => a + agentSum[k] + taskSum[k], 0);
  // Coverage is the share of fleet activity that some row actually claims.
  // 1.0 means the meter can name a cause for everything it counted.
  const coverage = claimedTotal + unattributedTotal > 0 ? claimedTotal / (claimedTotal + unattributedTotal) : 1;

  // --- per-day: own row, plus task start buckets, plus outcome economics ---
  const dayTasks = new Map();
  tasks.forEach((t, i) => {
    if (!t.day) return;
    if (!dayTasks.has(t.day)) dayTasks.set(t.day, []);
    dayTasks.get(t.day).push({ task: t, raw: rawAcc[i] });
  });
  const byDate = new Map(days.map((d) => [d.date, d]));
  const dayRows = [];
  const allDates = [...new Set([...days.map((d) => d.date), ...dayTasks.keys()])].sort();
  for (const date of allDates) {
    const own = byDate.get(date);
    const started = dayTasks.get(date) || [];
    const fromTasks = started.reduce((a, x) => add(a, x.raw), zero());
    const acc = zero();
    for (const k of DIM_KEYS) acc[k] = Math.max(own ? Number(own[k]) || 0 : 0, fromTasks[k]);
    const row = {
      date,
      ...snapshot(acc, card),
      completedTasks: own ? own.completedTasks : 0,
      tasksStarted: started.length,
      tasksCompletedHere: started.filter((x) => x.task.status === 'Done').length,
      taskAttributedReads: fromTasks.storageReads,
    };
    row.burn = burnRate(row.estimatedCostUsd, acc.storageReads, acc.llmCalls, row.tokensTotal, 1);
    row.costPerOutcome =
      row.completedTasks > 0 ? row.estimatedCostUsd / row.completedTasks : null;
    dayRows.push(row);
  }

  // Fleet burn rate, averaged over the active span (>= 1 so a single-day
  // window still reports a rate instead of dividing by zero).
  const divisor = Math.max(1, span.days);
  const totals = {
    ...snapshot(fleet, card),
    tokensTotal: tokensTotal(fleet),
    costBreakdown: undefined,
  };
  const fleetCost = rowCost(fleet, card);
  totals.costBreakdown = {
    storageUsd: fleetCost.storageUsd,
    llmUsd: fleetCost.llmUsd,
    tokenUsd: fleetCost.tokenUsd,
    source: fleetCost.source,
  };
  totals.burn = burnRate(totals.estimatedCostUsd, fleet.storageReads, fleet.llmCalls, totals.tokensTotal, divisor);
  // Outcome counts live beside the dimensions in `totals` but are not
  // dimensions, so they are read from the document rather than from the
  // roll-up. Cost per outcome is the number this whole product exists for.
  const completed = Number(metrics.totals?.tasksCompleted ?? fleet.tasksCompleted) || 0;
  totals.tasksCompleted = completed;
  totals.tasksAttributed = tasks.length;
  totals.coordinationReads = agents.reduce((a, x) => a + (x.coordinationReads || 0), 0);
  totals.costPerOutcome = completed > 0 ? totals.estimatedCostUsd / completed : null;

  // --- rankings: the four questions an operator actually asks --------------
  const byAgentCost = [...agents].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  const byAgentReads = [...agents].sort((a, b) => b.storageReads - a.storageReads);
  const byTaskCost = [...tasks].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  const byTaskReads = [...tasks].sort((a, b) => b.storageReads - a.storageReads);
  const byCostPerOutcome = [...dayRows]
    .filter((d) => d.completedTasks > 0 && d.estimatedCostUsd > 0)
    .sort((a, b) => b.costPerOutcome - a.costPerOutcome);

  // Task-level cost per outcome. A delivered task is one outcome, so its cost
  // per outcome is what it cost to get that one thing done. Done-but-failed and
  // still-in-flight tasks are excluded: a task that did not finish has no
  // outcome to divide by, and pretending otherwise would rank abandoned work as
  // cheap.
  const byTaskCostPerOutcome = [...tasks]
    .filter((t) => t.outcomes > 0 && t.estimatedCostUsd > 0)
    .sort((a, b) => b.costPerOutcome - a.costPerOutcome);

  return {
    schema: metrics.schema,
    dataClass: metrics.dataClass,
    fleet: metrics.fleet,
    window: { ...metrics.window, activeDays: span.days, activeStart: span.start, activeEnd: span.end },
    card: { id: card.id, readUnitUsd: card.readUnitUsd, callUnitUsd: card.callUnitUsd, perMillion: { ...card.perMillion } },
    budget: metrics.budget,
    totals,
    days: dayRows,
    agents,
    tasks,
    unattributed,
    coverage,
    rankings: {
      mostExpensiveAgents: byAgentCost,
      heaviestReaders: byAgentReads,
      mostExpensiveTasks: byTaskCost,
      readiestTasks: byTaskReads,
      worstCostPerOutcomeDays: byCostPerOutcome,
      worstCostPerOutcomeTasks: byTaskCostPerOutcome,
    },
  };
}

export function burnRate(usd, reads, calls, tokens, days) {
  const d = Math.max(1, Number(days) || 1);
  return {
    days: d,
    readsPerDay: (Number(reads) || 0) / d,
    usdPerDay: (Number(usd) || 0) / d,
    llmCallsPerDay: (Number(calls) || 0) / d,
    tokensPerDay: (Number(tokens) || 0) / d,
  };
}

// Exported for tests and for callers that want the same roll-up guarantees.
export { zero, add, snapshot };
