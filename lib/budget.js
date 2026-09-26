// The budget guard. This is the part that makes fleet-burn worth installing.
//
// A meter that only *reports* is a dashboard you will learn to ignore. A meter
// that exits non-zero and names the agent and the task is a thing that stops
// the run. So every violation here carries enough detail to act on without
// opening another tool:
//
//   kind        reads | usd | llmCalls
//   day         the UTC day the cap was blown
//   limit/actual/overage/overBy
//   agent       the single worst agent that day, and its share
//   task        the single worst task that day, and its share
//   reason      one sentence naming the cause
//
// Exit codes: 0 clean, 1 breach (this is the "teeth"), 2 bad input.

export const EXIT_OK = 0;
export const EXIT_BREACH = 1;
export const EXIT_USAGE = 2;

const KINDS = [
  { key: 'reads', capKey: 'capReadsPerDay', metric: 'storageReads', unit: 'reads', dim: 'storageReads' },
  { key: 'usd', capKey: 'capUsdPerDay', metric: 'estimatedCostUsd', unit: 'USD', dim: 'estimatedCostUsd' },
  { key: 'llmCalls', capKey: 'capLlmCallsPerDay', metric: 'llmCalls', unit: 'LLM calls', dim: 'llmCalls' },
];

// Resolves the caps for a run: explicit flags beat the document's own budget
// block, so CI can tighten or loosen without editing the data.
export function resolveCaps(report, flags = {}) {
  const fromDoc = report.budget || {};
  const pick = (flag, key) => {
    for (const v of [flag, fromDoc[key]]) {
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      return n;
    }
    return null;
  };
  return {
    capReadsPerDay: pick(flags.capReadsPerDay, 'capReadsPerDay'),
    capUsdPerDay: pick(flags.capUsdPerDay, 'capUsdPerDay'),
    capLlmCallsPerDay: pick(flags.capLlmCallsPerDay, 'capLlmCallsPerDay'),
  };
}

export function hasAnyCap(caps) {
  return KINDS.some((k) => Number(caps[k.capKey]) > 0);
}

// Who to name for a blown cap.
//
// A metrics document can carry a per-day agent split (agents[].days). When it
// does, the answer is exact for that day. When it does not, the honest answer
// is the worst agent over the whole window plus its share of the window, and the
// violation says so — apportioning a window total across days would invent a
// precision the data does not contain, and this product's whole claim is that it
// does not invent things.
function worstAgent(report, day, dim) {
  const exact = report.agents
    .map((a) => ({ a, v: (a.byDay && a.byDay[day.date] ? a.byDay[day.date][dim] : 0) || 0 }))
    .filter((x) => x.v > 0)
    .sort((x, y) => y.v - x.v);
  if (exact.length) {
    const total = exact.reduce((s, x) => s + x.v, 0);
    return {
      id: exact[0].a.id,
      name: exact[0].a.name,
      value: exact[0].v,
      share: total > 0 ? exact[0].v / total : 1,
      scope: 'day',
    };
  }
  const ranked = [...report.agents].filter((a) => (a[dim] || 0) > 0).sort((x, y) => y[dim] - x[dim]);
  if (!ranked.length) return null;
  const total = ranked.reduce((s, a) => s + a[dim], 0);
  return {
    id: ranked[0].id,
    name: ranked[0].name,
    value: ranked[0][dim],
    share: total > 0 ? ranked[0][dim] / total : 1,
    scope: 'window',
  };
}

function worstTask(report, day, dim) {
  const onDay = report.tasks
    .filter((t) => t.day === day.date)
    .sort((a, b) => b[dim] - a[dim]);
  if (onDay.length && onDay[0][dim] > 0) {
    const total = onDay.reduce((s, t) => s + t[dim], 0);
    return {
      id: onDay[0].id,
      title: onDay[0].title,
      agent: onDay[0].agent,
      value: onDay[0][dim],
      share: total > 0 ? onDay[0][dim] / total : 1,
      scope: 'day',
    };
  }
  const ranked = [...report.tasks].filter((t) => (t[dim] || 0) > 0).sort((a, b) => b[dim] - a[dim]);
  if (!ranked.length) return null;
  const total = ranked.reduce((s, t) => s + t[dim], 0);
  return {
    id: ranked[0].id,
    title: ranked[0].title,
    agent: ranked[0].agent,
    value: ranked[0][dim],
    share: total > 0 ? ranked[0][dim] / total : 1,
    scope: 'window',
  };
}

const fmt = (kind, n) =>
  kind === 'usd' ? `$${n.toFixed(4)}` : Math.round(n).toLocaleString('en-US');

/**
 * Checks every day in the report against the caps.
 * Returns { ok, caps, violations, checked, peak } — never throws on a breach,
 * because the caller needs to print all of them before exiting non-zero.
 */
export function checkBudget(report, flags = {}) {
  const caps = resolveCaps(report, flags);
  const violations = [];
  let checked = 0;
  // Peak is a property of the data, not of the caps, so it is computed whether
  // or not anything is being enforced. A cap you never set still deserves a
  // number next to it.
  const peak = { readsPerDay: 0, usdPerDay: 0, llmCallsPerDay: 0 };
  for (const d of report.days) {
    if (Number(d.storageReads) > peak.readsPerDay) peak.readsPerDay = Number(d.storageReads);
    if (Number(d.estimatedCostUsd) > peak.usdPerDay) peak.usdPerDay = Number(d.estimatedCostUsd);
    if (Number(d.llmCalls) > peak.llmCallsPerDay) peak.llmCallsPerDay = Number(d.llmCalls);
  }

  for (const spec of KINDS) {
    const cap = Number(caps[spec.capKey]) || 0;
    if (cap <= 0) continue;
    for (const day of report.days) {
      const actual = Number(day[spec.dim]) || 0;
      if (actual <= 0) continue;
      checked += 1;
      if (actual <= cap) continue;
      const agent = worstAgent(report, day, spec.dim);
      const task = worstTask(report, day, spec.dim);
      violations.push({
        kind: spec.key,
        unit: spec.unit,
        day: day.date,
        cap,
        actual,
        overage: actual - cap,
        overBy: actual / cap,
        agent,
        task,
        reason: reasonFor(spec, day, cap, actual, agent, task),
      });
    }
  }

  violations.sort((a, b) => b.actual / b.cap - a.actual / a.cap || (a.day < b.day ? -1 : 1));
  return { ok: violations.length === 0, caps, violations, checked, peak };
}

function reasonFor(spec, day, cap, actual, agent, task) {
  const kind = spec.key;
  const who = agent ? `agent ${agent.name}` : 'no agent';
  const what = task
    ? task.title
      ? `task "${task.title}" (${task.id})`
      : `task ${task.id}`
    : 'no single task';
  const scopeNote = (x) =>
    !x || x.scope !== 'window' ? '' : ' [worst over the whole window: this document carries no per-day agent split]';
  return (
    `${who} blew the ${spec.unit} cap on ${day.date}: ${fmt(kind, actual)} against a cap of ` +
    `${fmt(kind, cap)} (${(actual / cap).toFixed(2)}x). Worst single ${what}` +
    ` at ${fmt(kind, task ? task.value : 0)}` +
    (agent && agent.share !== null
      ? `; ${who} accounts for ${(agent.share * 100).toFixed(0)}% of the ${agent.scope}` +
        (agent.scope === 'day' ? ` on ${day.date}` : '')
      : '') +
    scopeNote(agent) +
    scopeNote(task)
  );
}

// The exit code a caller should hand back to the shell.
export function exitCodeFor(result) {
  return result.ok ? EXIT_OK : EXIT_BREACH;
}
