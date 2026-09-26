// The dashboard's data pipeline, in one auditable place.
//
//   node tools/build-dashboard.mjs
//
// reads data/fleet-sample.json, runs it through the same library the CLI uses,
// and writes site/data.json for the page to fetch. Running this by hand is how
// the committed dashboard data is refreshed; the test suite then fails if the
// committed file has drifted from what the library says, so the site can never
// quietly disagree with the CLI.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMetrics } from '../lib/parse.js';
import { attribute } from '../lib/attribute.js';
import { checkBudget } from '../lib/budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] || path.join(root, 'data', 'fleet-sample.json');
const outPath = process.argv[3] || path.join(root, 'site', 'data.json');

const metrics = parseMetrics(JSON.parse(readFileSync(source, 'utf8')));
const report = attribute(metrics);
// The dashboard shows the caps the metrics document declares. Flags are a CI
// concern; a published page should not be able to fail a build.
const budget = checkBudget(report, {});

const payload = {
  builtFrom: path.relative(root, source),
  dataClass: report.dataClass,
  fleet: report.fleet,
  window: report.window,
  card: report.card,
  coverage: report.coverage,
  totals: {
    storageReads: report.totals.storageReads,
    llmCalls: report.totals.llmCalls,
    tokensTotal: report.totals.tokensTotal,
    tokensIn: report.totals.tokensIn,
    tokensOut: report.totals.tokensOut,
    tokensCacheRead: report.totals.tokensCacheRead,
    estimatedCostUsd: report.totals.estimatedCostUsd,
    costBreakdown: report.totals.costBreakdown,
    burn: report.totals.burn,
    costPerOutcome: report.totals.costPerOutcome,
    tasksCompleted: report.totals.tasksCompleted,
    tasksAttributed: report.totals.tasksAttributed,
    coordinationReads: report.totals.coordinationReads,
  },
  budget: {
    caps: budget.caps,
    ok: budget.ok,
    checked: budget.checked,
    peak: budget.peak,
    violations: budget.violations.map((v) => ({
      kind: v.kind,
      unit: v.unit,
      day: v.day,
      cap: v.cap,
      actual: v.actual,
      overage: v.overage,
      overBy: v.overBy,
      agent: v.agent ? { id: v.agent.id, name: v.agent.name, value: v.agent.value, share: v.agent.share, scope: v.agent.scope } : null,
      task: v.task ? { id: v.task.id, title: v.task.title, agent: v.task.agent, value: v.task.value, share: v.task.share, scope: v.task.scope } : null,
      reason: v.reason,
    })),
  },
  days: report.days.map((d) => ({
    date: d.date,
    storageReads: d.storageReads,
    llmCalls: d.llmCalls,
    tokensTotal: d.tokensTotal,
    estimatedCostUsd: d.estimatedCostUsd,
    completedTasks: d.completedTasks,
    tasksStarted: d.tasksStarted,
    taskAttributedReads: d.taskAttributedReads,
    costPerOutcome: d.costPerOutcome,
  })),
  agents: report.agents.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    storageReads: a.storageReads,
    llmCalls: a.llmCalls,
    tokensTotal: a.tokensTotal,
    estimatedCostUsd: a.estimatedCostUsd,
    taskCount: a.taskCount,
    coordinationReads: a.coordinationReads,
  })),
  tasks: report.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    agent: t.agent,
    status: t.status,
    day: t.day,
    storageReads: t.storageReads,
    llmCalls: t.llmCalls,
    tokensTotal: t.tokensTotal,
    estimatedCostUsd: t.estimatedCostUsd,
    outcomes: t.outcomes,
    costPerOutcome: t.costPerOutcome,
  })),
  // What each delivered task cost. Ranked by the library, trimmed to the ten
  // worst for the page, so the page never re-sorts the library's answer.
  worstCostPerOutcomeTasks: report.rankings.worstCostPerOutcomeTasks.slice(0, 10).map((t) => ({
    id: t.id,
    title: t.title,
    agent: t.agent,
    storageReads: t.storageReads,
    llmCalls: t.llmCalls,
    tokensTotal: t.tokensTotal,
    estimatedCostUsd: t.estimatedCostUsd,
    outcomes: t.outcomes,
    costPerOutcome: t.costPerOutcome,
  })),
  // Operational counters ride through untouched: the page charts them, and it
  // must not have to re-derive them from the cost rows to do it.
  events: report.events,
  provenance: metrics.provenance,
  pricing: metrics.pricing,
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(
  `wrote ${path.relative(root, outPath)}  ` +
    `(${payload.days.length} days, ${payload.agents.length} agents, ${payload.tasks.length} tasks, ` +
    `$${payload.totals.estimatedCostUsd.toFixed(2)} estimated, dataClass=${payload.dataClass})\n`,
);
