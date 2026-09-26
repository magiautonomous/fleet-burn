// Plain-text rendering. Terminal-safe, no colour codes (a CI log should not
// need a parser to be greppable), no dependencies, no width assumptions beyond
// a fixed column budget that degrades gracefully.

import { formatUsd } from './price.js';
import { taskLabel } from './attribute.js';

const n = (v) => Number(v || 0);
const int = (v) => Math.round(n(v)).toLocaleString('en-US');
const dec = (v) => n(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (v) => `${(n(v) * 100).toFixed(0)}%`;

export function rule(width = 72) {
  return '-'.repeat(width);
}

export function header(text) {
  return [text, rule()].join('\n');
}

export function renderReport(report, { top = 10, budget = null, verbose = false } = {}) {
  const L = [];
  const t = report.totals;
  const burn = t.burn;

  L.push(header('fleet-burn  ' + (report.fleet || 'fleet') + '  [' + report.dataClass + ' data]'));
  L.push(
    `window   ${report.window.activeStart || '-'} .. ${report.window.activeEnd || '-'} ` +
      `(${report.window.activeDays} active day(s) of ${report.window.days} reported)`,
  );
  L.push(
    `totals   ${int(t.storageReads)} reads | ${int(t.llmCalls)} LLM calls | ` +
      `${int(t.tokensTotal)} tokens | ${formatUsd(t.estimatedCostUsd)}`,
  );
  L.push(
    `burn     ${int(burn.readsPerDay)} reads/day | ${formatUsd(burn.usdPerDay)}/day | ` +
      `${int(burn.llmCallsPerDay)} calls/day | ${int(burn.tokensPerDay)} tokens/day`,
  );
  if (t.costBreakdown) {
    L.push(
      `cost     storage ${formatUsd(t.costBreakdown.storageUsd)} + llm ${formatUsd(t.costBreakdown.llmUsd)} + ` +
        `tokens ${formatUsd(t.costBreakdown.tokenUsd)} (${t.costBreakdown.source})`,
    );
  }
  if (t.costPerOutcome !== null && Number.isFinite(t.costPerOutcome)) {
    L.push(
      `outcome  ${formatUsd(t.costPerOutcome)} per completed task ` +
        `(${int(t.tasksCompleted)} completed, ${int(t.tasksAttributed)} attributed)`,
    );
  }
  if (report.coverage < 0.999) {
    L.push(
      `note     ${pct(report.coverage)} of activity is attributed; ` +
        `${int(report.unattributed.storageReads)} reads / ${int(report.unattributed.llmCalls)} calls are unattributed`,
    );
  }
  L.push('');

  // ---- agents -------------------------------------------------------------
  L.push(header(`agents by cost  (top ${top})`));
  if (!report.agents.length) L.push('  none reported');
  report.agents.slice(0, top).forEach((a, i) => {
    L.push(
      `  ${String(i + 1).padStart(2)}. ${pad(a.name, 14)} ${pad(a.role || '-', 8)} ` +
        `${pad(formatUsd(a.estimatedCostUsd), 10)} ${pad(int(a.storageReads), 9)} reads  ` +
        `${pad(int(a.llmCalls), 7)} calls  ${pad(int(a.tokensTotal), 15)} tok  ` +
        `${pad(String(a.taskCount), 3)} tasks  ${padUsdPerDay(a.estimatedCostUsd, report.window.activeDays)}`,
    );
  });
  L.push('');

  // ---- tasks --------------------------------------------------------------
  L.push(header(`tasks by cost  (top ${top})`));
  if (!report.tasks.length) L.push('  none reported');
  report.tasks.slice(0, top).forEach((t2, i) => {
    L.push(
      `  ${String(i + 1).padStart(2)}. ${pad(formatUsd(t2.estimatedCostUsd), 10)} ` +
        `${pad(int(t2.storageReads), 7)} rd  ${pad(int(t2.llmCalls), 6)} calls  ` +
        `${pad(int(t2.tokensTotal), 15)} tok  ${pad(t2.agent, 12)} ${truncate(t2.title || t2.id, 58)}`,
    );
  });
  L.push('');

  // ---- reads --------------------------------------------------------------
  L.push(header(`tasks by reads  (top ${top})  <- coordination, not intelligence`));
  const readers = report.rankings.readiestTasks.filter((x) => x.storageReads > 0).slice(0, top);
  if (!readers.length) L.push('  no task-attributed reads');
  readers.forEach((t2, i) => {
    L.push(
      `  ${String(i + 1).padStart(2)}. ${pad(int(t2.storageReads), 7)} reads  ${pad(t2.day || '-', 12)} ` +
        `${pad(t2.agent, 12)} ${truncate(t2.title || t2.id, 62)}`,
    );
  });
  L.push('');

  // ---- cost per outcome ---------------------------------------------------
  L.push(header('worst cost-per-outcome tasks'));
  const cpoTasks = report.rankings.worstCostPerOutcomeTasks.slice(0, top);
  if (!cpoTasks.length) L.push('  no completed task reported any spend');
  cpoTasks.forEach((t, i) => {
    L.push(
      `  ${String(i + 1).padStart(2)}. ${pad(formatUsd(t.costPerOutcome), 12)} /outcome  ` +
        `${pad(t.agent || '-', 10)} ${truncate(t.title || t.id, 48)}`,
    );
  });
  L.push('');

  L.push(header('worst cost-per-outcome days'));
  const cpo = report.rankings.worstCostPerOutcomeDays.slice(0, top);
  if (!cpo.length) L.push('  no day reported both spend and completions');
  cpo.forEach((d, i) => {
    L.push(
      `  ${String(i + 1).padStart(2)}. ${pad(d.date, 12)} ${pad(formatUsd(d.costPerOutcome), 12)} /task  ` +
        `${pad(int(d.completedTasks), 4)} done  ${pad(formatUsd(d.estimatedCostUsd), 10)} spend  ` +
        `${pad(int(d.storageReads), 8)} reads`,
    );
  });
  L.push('');

  // ---- day table ----------------------------------------------------------
  L.push(header('daily burn'));
  L.push(
    `  ${pad('date', 12)}${pad('reads', 10)}${pad('calls', 9)}${pad('tokens', 15)}` +
      `${pad('usd', 12)}${pad('done', 7)}${pad('$/task', 12)}reads/day cap`,
  );
  for (const d of report.days) {
    const cap = budget?.caps?.capReadsPerDay || 0;
    const mark = cap > 0 && d.storageReads > cap ? ' OVER' : '';
    L.push(
      `  ${pad(d.date, 12)}${pad(int(d.storageReads), 10)}${pad(int(d.llmCalls), 9)}` +
        `${pad(int(d.tokensTotal), 15)}${pad(formatUsd(d.estimatedCostUsd), 12)}` +
        `${pad(int(d.completedTasks), 7)}${pad(cpoFmt(d.costPerOutcome), 12)}` +
        `${pad(int(d.burn.readsPerDay), 9)}${cap > 0 ? int(cap) : '-'}${mark}`,
    );
  }
  L.push('');

  if (verbose) {
    L.push(header(`all ${report.tasks.length} tasks`));
    for (const t2 of report.tasks) {
      L.push(
        `  ${pad(t2.id, 22)}${pad(formatUsd(t2.estimatedCostUsd), 11)}${pad(int(t2.storageReads), 8)} rd  ` +
          `${pad(int(t2.llmCalls), 7)} calls  ${pad(t2.agent, 12)} ${t2.status.padEnd(12)} ${t2.title || ''}`,
      );
    }
    L.push('');
  }

  if (budget) L.push(renderBudget(budget));
  return L.join('\n');
}

export function renderBudget(result) {
  const L = [header('budget guard')];
  const caps = [];
  if (result.caps.capReadsPerDay) caps.push(`reads/day <= ${int(result.caps.capReadsPerDay)}`);
  if (result.caps.capUsdPerDay) caps.push(`usd/day <= ${formatUsd(result.caps.capUsdPerDay)}`);
  if (result.caps.capLlmCallsPerDay) caps.push(`llm calls/day <= ${int(result.caps.capLlmCallsPerDay)}`);
  L.push(`  caps    ${caps.length ? caps.join('  |  ') : 'none set'}`);
  if (!result.checked) {
    L.push('  status  no caps to check (nothing to enforce)');
    return L.join('\n');
  }
  L.push(
    `  peak    ${int(result.peak.readsPerDay)} reads/day | ${formatUsd(result.peak.usdPerDay)}/day | ` +
      `${int(result.peak.llmCallsPerDay)} calls/day`,
  );
  if (result.ok) {
    L.push('  status  OK - every capped day is inside its cap');
    return L.join('\n');
  }
  L.push(`  status  BREACH - ${result.violations.length} capped day(s) over budget`);
  for (const v of result.violations) {
    L.push('');
    L.push(`  [${v.kind.toUpperCase()} CAP] ${v.day}`);
    L.push(`    actual  ${fmt(v.kind, v.actual)}   cap ${fmt(v.kind, v.cap)}   over by ${fmt(v.kind, v.overage)} (${v.overBy.toFixed(2)}x)`);
    if (v.agent) {
      L.push(
        `    agent   ${v.agent.name}${v.agent.id !== v.agent.name ? ` (${v.agent.id})` : ''}` +
          `  ${fmt(v.kind, v.agent.value)}${v.agent.share !== null ? `  = ${pct(v.agent.share)} of the ${v.agent.scope}` : ''}`,
      );
    }
    if (v.task && v.task.value > 0) {
      L.push(
        `    task    ${v.task.title ? `"${truncate(v.task.title, 70)}"` : '(untitled)'}` +
          `  [${v.task.id}]  ${fmt(v.kind, v.task.value)}${v.task.share !== null ? `  = ${pct(v.task.share)} of the ${v.task.scope}` : ''}`,
      );
    } else {
      L.push('    task    no single task dominates this day');
    }
    L.push(`    why     ${v.reason}`);
  }
  return L.join('\n');
}

function cpoFmt(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '-' : formatUsd(v);
}

function padUsdPerDay(usd, days) {
  return formatUsd(n(usd) / Math.max(1, n(days))) + '/d';
}

function fmt(kind, v) {
  if (kind === 'usd') return formatUsd(v);
  return int(v);
}

function pad(s, width) {
  const str = String(s ?? '');
  return str.length >= width ? `${str.slice(0, width - 1)} ` : str.padEnd(width);
}

function truncate(s, width) {
  const str = String(s ?? '');
  return str.length > width ? `${str.slice(0, width - 1)}\u2026` : str;
}

export { taskLabel, truncate, pad, int, dec };
