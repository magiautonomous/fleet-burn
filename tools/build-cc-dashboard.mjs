// Builds site/cc-data.json: the CC fleet burn page's only data source.
//
//   node tools/build-cc-dashboard.mjs
//   node tools/build-cc-dashboard.mjs data/cc-fleet-metrics.json site/cc-data.json
//
// Same rule as the main dashboard and for the same reason: the numbers on the
// page are produced by running the real library over the committed metrics
// document, so the page and `node bin/fleet-burn.js` cannot disagree about the
// same file. The test suite fails if the committed JSON drifts from this.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMetrics } from '../lib/parse.js';
import { attribute } from '../lib/attribute.js';
import { checkBudget } from '../lib/budget.js';
import { REFERENCE_PRICE_CARD } from '../lib/price.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] || path.join(root, 'data', 'cc-fleet-metrics.json');
const outPath = process.argv[3] || path.join(root, 'site', 'cc-data.json');

const metrics = parseMetrics(JSON.parse(readFileSync(source, 'utf8')));
const report = attribute(metrics);
const budget = checkBudget(report, {});

const cap = Number(report.budget?.capReadsPerDay) || 0;
const eventsByDay = new Map();
for (const e of report.events) {
  if (!eventsByDay.has(e.date)) eventsByDay.set(e.date, {});
  eventsByDay.get(e.date)[e.kind] = e.count;
}

const days = report.days.map((d) => ({
  date: d.date,
  storageReads: d.storageReads,
  estimatedCostUsd: d.estimatedCostUsd,
  completedTasks: d.completedTasks,
  costPerOutcome: d.costPerOutcome,
  quotaRejections: eventsByDay.get(d.date)?.quotaRejections ?? null,
  boots: eventsByDay.get(d.date)?.coordinatorBoots ?? null,
  minutesToExhaust: eventsByDay.get(d.date)?.minutesToExhaust ?? null,
  observedHours: eventsByDay.get(d.date)?.observedHours ?? null,
}));

// A day recorded at the ceiling is a day the API refused the fleet's reads, so
// its true consumption is at least the cap. A day under it is a day nothing
// was refused, and the number is what the exporting host actually counted.
const atCeiling = cap > 0 ? days.filter((d) => d.storageReads >= cap).length : 0;
const overCap = cap > 0 ? days.filter((d) => d.storageReads > cap).length : 0;
const burnThrough = days.map((d) => d.minutesToExhaust).filter((v) => typeof v === 'number' && v > 0);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
};

const attributed = report.agents.reduce((s, a) => s + (a.storageReads || 0), 0);
const payload = {
  builtFrom: path.relative(root, source),
  builtAt: new Date().toISOString(),
  dataClass: report.dataClass,
  fleet: report.fleet,
  window: report.window,
  quota: {
    readsPerDay: cap,
    // Which day a row covers: the budget resets on a fixed UTC hour, so a row
    // is the 24 hours between two resets, not a UTC calendar day.
    dayKey: metrics.provenance?.dayKey || '',
  },
  priceCard: {
    id: report.card.id,
    readUnitUsd: report.card.readUnitUsd,
  },
  totals: {
    storageReads: report.totals.storageReads,
    estimatedCostUsd: report.totals.estimatedCostUsd,
    costBreakdown: report.totals.costBreakdown,
    burn: report.totals.burn,
    costPerOutcome: report.totals.costPerOutcome,
    tasksCompleted: report.totals.tasksCompleted,
  },
  budget: {
    caps: budget.caps,
    ok: budget.ok,
    checked: budget.checked,
    peak: budget.peak,
    violations: budget.violations.map((v) => ({
      kind: v.kind,
      day: v.day,
      cap: v.cap,
      actual: v.actual,
      overBy: v.overBy,
      reason: v.reason,
    })),
  },
  atCeiling,
  overCap,
  burnThrough: {
    measured: burnThrough.length,
    of: days.length,
    medianMinutes: median(burnThrough),
    minMinutes: burnThrough.length ? Math.min(...burnThrough) : null,
    maxMinutes: burnThrough.length ? Math.max(...burnThrough) : null,
  },
  attribution: {
    attributedReads: attributed,
    unattributedReads: Math.max(0, report.totals.storageReads - attributed),
    coverage: report.coverage,
    agents: report.agents.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      storageReads: a.storageReads,
      estimatedCostUsd: a.estimatedCostUsd,
      share: report.totals.storageReads > 0 ? a.storageReads / report.totals.storageReads : 0,
    })),
  },
  days,
  events: report.events,
  provenance: metrics.provenance,
  pricing: metrics.pricing,
  referencePriceCard: REFERENCE_PRICE_CARD.id,
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(
  `wrote ${path.relative(root, outPath)}  (${payload.days.length} day(s), ` +
    `${payload.atCeiling} at the ${cap.toLocaleString('en-US')}-read ceiling, ` +
    `${(payload.attribution.coverage * 100).toFixed(2)}% attributed, dataClass=${payload.dataClass})\n`,
);
