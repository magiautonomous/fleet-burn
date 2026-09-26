// The CLI core, kept separate from the bin shim so tests can drive it with an
// in-memory stdin and a captured stdout instead of spawning a process.

import { readFileSync } from 'node:fs';
import { readMetricsFile, parseMetrics, MetricsError } from '../lib/parse.js';
import { withPriceCard, formatUsd } from '../lib/price.js';
import { attribute } from '../lib/attribute.js';
import { checkBudget, exitCodeFor, hasAnyCap, EXIT_OK, EXIT_BREACH, EXIT_USAGE } from '../lib/budget.js';
import { renderReport, renderBudget } from '../lib/report.js';

export const USAGE = `fleet-burn - cost and usage meter for agent fleets

usage:
  fleet-burn <metrics.json> [options]
  fleet-burn - [options]                read the metrics document from stdin
  fleet-burn --sample                   run against the bundled real-fleet sample

options:
  --cap-reads-per-day N      fail if any day exceeds N storage reads
  --cap-usd-per-day N        fail if any day exceeds N USD (estimated)
  --cap-llm-calls-per-day N  fail if any day exceeds N LLM calls
  --price-read-unit N        USD per document read            (default 0.0000004)
  --price-call-unit N        USD per LLM call                 (default 0)
  --price-in-per-m N         USD per 1M input tokens          (default 3.00)
  --price-out-per-m N        USD per 1M output tokens         (default 15.00)
  --price-reasoning-per-m N  USD per 1M reasoning tokens      (default 15.00)
  --price-cache-read-per-m N USD per 1M cache-read tokens     (default 0.30)
  --price-cache-write-per-m N USD per 1M cache-write tokens   (default 3.75)
  --top N                    rows per leaderboard             (default 10)
  --json                     emit the attributed report as JSON
  --budget-only              only print the budget verdict
  --all                      print every task, not just the top N
  --no-color                 accepted and ignored: output is never coloured
  -h, --help                 this text

exit codes:
  0  within every cap set
  1  a daily cap was blown (the violation names the agent and the task)
  2  bad input: unreadable file, invalid JSON, or a bad flag`;

const NUMERIC = new Set([
  'capReadsPerDay',
  'capUsdPerDay',
  'capLlmCallsPerDay',
  'top',
]);
const PRICE_FLAGS = {
  '--price-read-unit': 'readUnitUsd',
  '--price-call-unit': 'callUnitUsd',
};

export class UsageError extends Error {}

export function parseArgs(argv) {
  const out = {
    file: null,
    help: false,
    sample: false,
    json: false,
    budgetOnly: false,
    all: false,
    top: 10,
    priceCard: {},
  };
  const need = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--sample') out.sample = true;
    else if (a === '--json') out.json = true;
    else if (a === '--budget-only') out.budgetOnly = true;
    else if (a === '--all' || a === '-a') out.all = true;
    else if (a === '--no-color') continue;
    else if (a === '--cap-reads-per-day') out.capReadsPerDay = need(++i, a);
    else if (a === '--cap-usd-per-day') out.capUsdPerDay = need(++i, a);
    else if (a === '--cap-llm-calls-per-day') out.capLlmCallsPerDay = need(++i, a);
    else if (a === '--top') out.top = need(++i, a);
    else if (PRICE_FLAGS[a]) out.priceCard[PRICE_FLAGS[a]] = Number(need(++i, a));
    else if (a.startsWith('--price-') && a.endsWith('-per-m')) {
      const key = {
        '--price-in-per-m': 'tokensIn',
        '--price-out-per-m': 'tokensOut',
        '--price-reasoning-per-m': 'tokensReasoning',
        '--price-cache-read-per-m': 'tokensCacheRead',
        '--price-cache-write-per-m': 'tokensCacheWrite',
      }[a];
      if (!key) throw new UsageError(`unknown flag ${a}`);
      out.priceCard.perMillion = out.priceCard.perMillion || {};
      out.priceCard.perMillion[key] = Number(need(++i, a));
    } else if (NUMERIC.has(a.replace(/^--/, ''))) {
      out[a.replace(/^--/, '')] = need(++i, a);
    } else if (a.startsWith('-') && a !== '-') {
      throw new UsageError(`unknown flag ${a}`);
    } else if (out.file === null) {
      out.file = a;
    } else {
      throw new UsageError(`unexpected argument ${a}`);
    }
  }
  if (!out.sample && !out.file && !out.help) throw new UsageError('need a metrics file, - for stdin, or --sample');
  const top = Number(out.top);
  if (!Number.isFinite(top) || top <= 0) throw new UsageError('--top must be a positive number');
  out.top = Math.floor(top);
  for (const k of ['capReadsPerDay', 'capUsdPerDay', 'capLlmCallsPerDay']) {
    if (out[k] === undefined) continue;
    const v = Number(out[k]);
    if (!Number.isFinite(v) || v <= 0) throw new UsageError(`--${k} must be a positive number`);
    out[k] = v;
  }
  for (const [k, v] of Object.entries(out.priceCard)) {
    if (k === 'perMillion') continue;
    if (!Number.isFinite(v) || v < 0) throw new UsageError(`price flag for ${k} must be a non-negative number`);
  }
  for (const [k, v] of Object.entries(out.priceCard.perMillion || {})) {
    if (!Number.isFinite(v) || v < 0) throw new UsageError(`price flag for ${k} must be a non-negative number`);
  }
  return out;
}

// Reads the input metrics document. `--sample` is resolved against this file's
// own directory so the CLI works from a clone, an install, or a checkout.
export function loadMetrics(args, { stdin = null } = {}) {
  if (args.sample) {
    const here = new URL('../data/fleet-sample.json', import.meta.url);
    return readMetricsFile(new URL(here).pathname, { stdin });
  }
  if (args.file === '-') {
    if (stdin === null) throw new UsageError('reading from stdin requires a stream');
    return readMetricsFile('-', { stdin });
  }
  return readMetricsFile(args.file, { stdin });
}

// The whole CLI, as a pure-ish function: options in, {code, out, err} out.
export function run(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`fleet-burn: ${e.message}\n\n${USAGE}\n`);
    return { code: EXIT_USAGE, stdout: '', stderr: e.message };
  }
  if (args.help) {
    out(`${USAGE}\n`);
    return { code: EXIT_OK, stdout: USAGE, stderr: '' };
  }

  let metrics;
  try {
    metrics = loadMetrics(args, { stdin: io.stdin ?? null });
  } catch (e) {
    const msg = e instanceof MetricsError ? e.message : e.message;
    err(`fleet-burn: ${msg}\n`);
    return { code: EXIT_USAGE, stdout: '', stderr: msg };
  }

  const report = attribute(metrics, { priceCard: withPriceCard(args.priceCard) });
  const budget = checkBudget(report, args);

  let text;
  if (args.json) {
    text = `${JSON.stringify({ report, budget }, null, 2)}\n`;
  } else if (args.budgetOnly) {
    text = `${renderBudget(budget)}\n`;
  } else {
    text = `${renderReport(report, { top: args.top, budget, verbose: args.all })}\n`;
  }
  out(text);

  const code = exitCodeFor(budget);
  if (!budget.ok) {
    const unit = (k) => (k === 'usd' ? 'USD' : k === 'reads' ? 'reads' : 'LLM calls');
    const amt = (k, v) => (k === 'usd' ? formatUsd(v) : Math.round(v).toLocaleString('en-US'));
    err(
      `fleet-burn: BUDGET BREACH — ${budget.violations.length} capped day(s) over budget. ` +
        `Worst: ${budget.violations[0].kind} on ${budget.violations[0].day}: ` +
        `${amt(budget.violations[0].kind, budget.violations[0].actual)} ${unit(budget.violations[0].kind)} ` +
        `against a cap of ${amt(budget.violations[0].kind, budget.violations[0].cap)}.\n` +
        budget.violations
          .map(
            (v) =>
              `  ${v.day} ${v.kind}: agent ${v.agent ? v.agent.name : 'n/a'}` +
              `${v.agent && v.agent.scope === 'window' ? ' (window-wide)' : ''}` +
              `${v.task ? `, task ${v.task.title ? `"${v.task.title}"` : '(untitled)'} [${v.task.id}]` : ''}`,
          )
          .join('\n') + '\n',
    );
  } else if (hasAnyCap(budget.caps)) {
    err(`fleet-burn: within all caps (${budget.checked} capped day(s) checked).\n`);
  }
  return { code, stdout: text, stderr: '', report, budget };
}

export { readFileSync, parseMetrics, attribute, checkBudget, renderReport, renderBudget, EXIT_BREACH };
