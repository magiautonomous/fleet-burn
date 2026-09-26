// Public API. Everything here is dependency-free and synchronous so it can be
// dropped into a cron job, a CI step, or a status endpoint without ceremony.

export { parseMetrics, readMetricsFile, isDayKey, MetricsError, SCHEMA_ID, DIMENSIONS } from './lib/parse.js';
export {
  REFERENCE_PRICE_CARD,
  withPriceCard,
  estimateRowCost,
  rowCost,
  tokensTotal,
  formatUsd,
  TOKEN_CLASSES,
} from './lib/price.js';
export { attribute, burnRate, activeSpan, hasActivity, taskLabel } from './lib/attribute.js';
export { checkBudget, resolveCaps, hasAnyCap, exitCodeFor, EXIT_OK, EXIT_BREACH, EXIT_USAGE } from './lib/budget.js';
export { renderReport, renderBudget } from './lib/report.js';
export { run, parseArgs, USAGE } from './bin/cli.js';
