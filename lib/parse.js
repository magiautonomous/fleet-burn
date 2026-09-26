// Reading, validating and normalising a fleet-burn metrics document.
//
// The input shape is the one a fleet already emits: a JSON object with daily
// rows, per-agent rows and per-task rows of the four burn dimensions
// (storage reads, LLM calls, tokens, estimated cost). Nothing here talks to
// the network or to a database — a metrics file is the whole contract, so the
// same input works from CI, from a cron job, or from a file on a laptop.

import { readFileSync } from 'node:fs';

export const SCHEMA_ID = 'fleet-burn/metrics@1';

// The dimensions fleet-burn meters. Every one is optional in the input and
// defaults to 0, so a fleet that only counts reads is still meterable.
export const DIMENSIONS = [
  'storageReads',
  'llmCalls',
  'tokensIn',
  'tokensOut',
  'tokensReasoning',
  'tokensCacheRead',
  'tokensCacheWrite',
  'estimatedCostUsd',
];

export class MetricsError extends Error {
  constructor(message, { path = null } = {}) {
    super(message);
    this.name = 'MetricsError';
    this.path = path;
  }
}

function num(value, path, { min = 0 } = {}) {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new MetricsError(`${path} must be a finite number, got ${JSON.stringify(value)}`, { path });
  }
  if (n < min) {
    throw new MetricsError(`${path} must be >= ${min}, got ${n}`, { path });
  }
  return n;
}

function str(value, path) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new MetricsError(`${path} must be a string, got ${typeof value}`, { path });
  }
  return value;
}

function arr(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MetricsError(`${path} must be an array, got ${typeof value}`, { path });
  }
  return value;
}

// 'YYYY-MM-DD' in UTC. Rejects anything else so a bad date key can never
// silently become a wrong day bucket downstream.
export function isDayKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

function dayOf(value, path) {
  const s = str(value, path);
  if (!s) return null;
  if (isDayKey(s)) return s;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) {
    throw new MetricsError(`${path} is not a parseable date: ${JSON.stringify(s)}`, { path });
  }
  return new Date(ms).toISOString().slice(0, 10);
}

// Aliases so a fleet can emit the field names it already uses without a
// translation layer. First match wins, in priority order.
const ALIASES = {
  storageReads: ['storageReads', 'storage_reads', 'reads', 'documentReads', 'readOps'],
  llmCalls: ['llmCalls', 'llm_calls', 'modelCalls', 'requests', 'apiCalls'],
  tokensIn: ['tokensIn', 'tokens_in', 'inputTokens', 'promptTokens'],
  tokensOut: ['tokensOut', 'tokens_out', 'outputTokens', 'completionTokens'],
  tokensReasoning: ['tokensReasoning', 'tokens_reasoning', 'reasoningTokens'],
  tokensCacheRead: ['tokensCacheRead', 'tokens_cache_read', 'cacheReadTokens', 'cachedInputTokens'],
  tokensCacheWrite: ['tokensCacheWrite', 'tokens_cache_write', 'cacheWriteTokens', 'cacheCreationTokens'],
  estimatedCostUsd: ['estimatedCostUsd', 'estimated_cost_usd', 'costUsd', 'cost_usd', 'cost'],
};

function pick(row, dim) {
  for (const key of ALIASES[dim]) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return 0;
}

function normaliseRow(row, path) {
  const out = {};
  for (const dim of DIMENSIONS) out[dim] = num(pick(row, dim), `${path}.${dim}`);
  return out;
}

function parseTask(raw, i) {
  const path = `tasks[${i}]`;
  if (!raw || typeof raw !== 'object') {
    throw new MetricsError(`${path} must be an object`, { path });
  }
  const id = str(raw.id ?? raw.taskId ?? raw.task_id, `${path}.id`);
  const startedAt = raw.startedAt ?? raw.started_at ?? raw.started ?? null;
  return {
    id,
    title: str(raw.title ?? raw.name, `${path}.title`),
    agent: str(raw.agent ?? raw.agentId ?? raw.agent_id ?? raw.assigneeId, `${path}.agent`) || 'unattributed',
    status: str(raw.status, `${path}.status`) || 'unknown',
    startedAt,
    day: dayOf(startedAt, `${path}.startedAt`),
    endedAt: raw.endedAt ?? raw.ended_at ?? raw.ended ?? null,
    durationS: raw.durationS ?? raw.duration_s ?? null,
    ...normaliseRow(raw, path),
  };
}

function parseAgent(raw, i) {
  const path = `agents[${i}]`;
  if (!raw || typeof raw !== 'object') {
    throw new MetricsError(`${path} must be an object`, { path });
  }
  const id = str(raw.id ?? raw.agentId ?? raw.agent_id, `${path}.id`) || 'unattributed';
  return {
    id,
    name: str(raw.name, `${path}.name`) || id,
    role: str(raw.role, `${path}.role`),
    coordinationReads: num(raw.coordinationReads ?? raw.coordination_reads, `${path}.coordinationReads`),
    ...normaliseRow(raw, path),
    // `tasks` is either a count or an embedded list of task rows; both are
    // accepted because both shapes show up in the wild.
    tasks: Array.isArray(raw.tasks) ? raw.tasks.length : num(raw.tasks, `${path}.tasks`),
    // Optional per-day split. When a fleet emits it, every "which agent blew
    // this cap" answer becomes exact instead of apportioned from a window total.
    byDay: parseAgentDays(raw.days ?? raw.byDay ?? raw.by_day, `${path}.days`),
  };
}

// Accepts [{date, ...dims}] or { 'YYYY-MM-DD': { ...dims } } and normalises both
// to a Map keyed by UTC day. Returns an empty map when absent.
function parseAgentDays(raw, path) {
  const out = new Map();
  const put = (date, row) => {
    if (!isDayKey(date)) {
      throw new MetricsError(`${path} day key must be 'YYYY-MM-DD', got ${JSON.stringify(date)}`, { path });
    }
    out.set(date, normaliseRow(row, `${path}.${date}`));
  };
  if (Array.isArray(raw)) {
    raw.forEach((row, i) => {
      if (!row || typeof row !== 'object') throw new MetricsError(`${path}[${i}] must be an object`, { path });
      put(row.date ?? row.day, row);
    });
  } else if (raw && typeof raw === 'object') {
    for (const [date, row] of Object.entries(raw)) put(date, row);
  } else if (raw !== undefined && raw !== null) {
    throw new MetricsError(`${path} must be an array or an object`, { path });
  }
  return out;
}

// Optional operational counters: {date, kind, count, note?}, one row per day per
// kind. A burn dimension answers "how much"; an event answers "what happened",
// and on a real fleet the second question is the one that gets fixed — 28
// process boots a day is a sentence a reads column cannot say. They ride
// alongside the dimensions rather than becoming one, because inventing a
// dimension per operational fact is how a schema stops being readable.
function parseEvent(raw, i) {
  const path = `events[${i}]`;
  if (!raw || typeof raw !== 'object') {
    throw new MetricsError(`${path} must be an object`, { path });
  }
  const date = str(raw.date ?? raw.day, `${path}.date`);
  if (!isDayKey(date)) {
    throw new MetricsError(`${path}.date must be a UTC day key 'YYYY-MM-DD', got ${JSON.stringify(date)}`, {
      path: `${path}.date`,
    });
  }
  const kind = str(raw.kind ?? raw.name, `${path}.kind`);
  if (!kind) {
    throw new MetricsError(`${path}.kind is required: an event with no kind cannot be charted`, {
      path: `${path}.kind`,
    });
  }
  return {
    date,
    kind,
    count: num(raw.count ?? raw.value, `${path}.count`),
    note: str(raw.note, `${path}.note`),
  };
}

function parseDay(raw, i) {
  const path = `days[${i}]`;
  if (!raw || typeof raw !== 'object') {
    throw new MetricsError(`${path} must be an object`, { path });
  }
  const date = str(raw.date ?? raw.day, `${path}.date`);
  if (!isDayKey(date)) {
    throw new MetricsError(`${path}.date must be a UTC day key 'YYYY-MM-DD', got ${JSON.stringify(date)}`, {
      path: `${path}.date`,
    });
  }
  return {
    date,
    completedTasks: num(raw.completedTasks ?? raw.completed_tasks ?? raw.completions, `${path}.completedTasks`),
    agentTasksStarted: num(raw.agentTasksStarted ?? raw.agent_tasks_started, `${path}.agentTasksStarted`),
    ...normaliseRow(raw, path),
  };
}

// Parses a metrics document. Throws MetricsError with a JSON-pointer-ish path
// on the first structural problem, because a meter that silently accepts a
// malformed file is a meter that lies about spend.
export function parseMetrics(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new MetricsError('metrics must be a JSON object');
  }
  if (input.schema && input.schema !== SCHEMA_ID) {
    throw new MetricsError(`unsupported schema ${JSON.stringify(input.schema)}, expected ${SCHEMA_ID}`, {
      path: 'schema',
    });
  }

  const days = arr(input.days, 'days').map(parseDay);
  const seen = new Set();
  for (const d of days) {
    if (seen.has(d.date)) {
      throw new MetricsError(`duplicate day row ${d.date}; merge the rows before ingesting`, {
        path: 'days',
      });
    }
    seen.add(d.date);
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));

  const tasks = arr(input.tasks, 'tasks').map(parseTask);
  const agents = arr(input.agents, 'agents').map(parseAgent);
  const events = arr(input.events, 'events').map(parseEvent);
  events.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
  const budget = input.budget && typeof input.budget === 'object' ? input.budget : {};

  const out = {
    schema: SCHEMA_ID,
    dataClass: str(input.dataClass, 'dataClass') || 'UNLABELLED',
    fleet: str(input.fleet, 'fleet'),
    window: input.window && typeof input.window === 'object' ? input.window : {},
    pricing: input.pricing && typeof input.pricing === 'object' ? input.pricing : {},
    budget: {
      capReadsPerDay: budget.capReadsPerDay ?? budget.cap_reads_per_day ?? null,
      capUsdPerDay: budget.capUsdPerDay ?? budget.cap_usd_per_day ?? null,
      capLlmCallsPerDay: budget.capLlmCallsPerDay ?? budget.cap_llm_calls_per_day ?? null,
    },
    totals: {
      ...(input.totals && typeof input.totals === 'object' ? input.totals : {}),
      ...normaliseRow(input.totals || {}, 'totals'),
    },
    days,
    agents,
    tasks,
    events,
    provenance: input.provenance && typeof input.provenance === 'object' ? input.provenance : {},
  };
  out.window.days = Number.isFinite(Number(out.window.days)) ? Number(out.window.days) : days.length;
  return out;
}

// Reads a metrics document from a file path, or from stdin when path is '-'.
// Caching is off (reads are the thing we are metering, after all).
export function readMetricsFile(path, { stdin = null } = {}) {
  let text;
  if (path === '-') {
    if (!stdin) throw new MetricsError('reading from stdin requires a stream');
    text = stdin;
  } else {
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new MetricsError(`cannot read metrics file ${path}: ${err.message}`);
    }
  }
  try {
    return parseMetrics(JSON.parse(text));
  } catch (err) {
    if (err instanceof MetricsError) throw err;
    throw new MetricsError(`${path} is not valid JSON: ${err.message}`);
  }
}
