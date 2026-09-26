// The exporter: CC fleet telemetry in, fleet-burn's own metrics document out.
//
//   node tools/export-cc-fleet.mjs --telemetry data/cc-fleet-telemetry.json \
//        --out data/cc-fleet-metrics.json
//   node tools/export-cc-fleet.mjs --sample --days 14 --out /tmp/sample.json
//
// It does not invent a format. The output is `fleet-burn/metrics@1`, the same
// document the CLI and the library already read, and it is validated through
// the real parser before it is written — so if this exporter ever emits
// something fleet-burn cannot read, it fails here instead of publishing.
//
// The one judgement call worth stating up front, because it is the whole
// honesty question on the page: a quota day in which the database refused the
// fleet's reads is recorded at the quota ceiling, not at the sum of the reads
// this host could count. The refusal is the evidence; the counted reads are
// only ever a lower bound, and the gap between the two is reported as
// unattributed rather than closed with a guess.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseMetrics, MetricsError } from '../lib/parse.js';
import { TELEMETRY_SCHEMA, FREE_TIER_READS_PER_DAY } from './cc-fleet-telemetry.mjs';

export const FLEET = 'CC fleet — 3 autonomous workers + 1 coordinator, Firestore free tier';

// A day in which the API refused the fleet's reads is recorded at the ceiling:
// the fleet demonstrably asked for at least this much and was told no. A day
// with no refusal is recorded at what was actually counted, because on such a
// day the ceiling is a claim nobody has evidence for.
function dayReads(row, ceiling) {
  return row.quotaExhausted ? ceiling : row.pollDocReads;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Converts a telemetry document into a fleet-burn metrics@1 document.
 * Pure: same telemetry in, same document out.
 */
export function exportMetrics(telemetry, options = {}) {
  if (!telemetry || typeof telemetry !== 'object') throw new Error('telemetry must be an object');
  if (telemetry.schema !== TELEMETRY_SCHEMA) {
    throw new Error(`unsupported telemetry schema ${JSON.stringify(telemetry.schema)}, expected ${TELEMETRY_SCHEMA}`);
  }
  const quotaDays = Array.isArray(telemetry.quotaDays) ? telemetry.quotaDays : [];
  if (!quotaDays.length) throw new Error('telemetry carries no quota days; there is nothing to meter');

  const ceiling = num(telemetry.quota?.readsPerDay, FREE_TIER_READS_PER_DAY) || FREE_TIER_READS_PER_DAY;
  const sample = options.sample === true;
  const provenance = {
    ...(telemetry.provenance && typeof telemetry.provenance === 'object' ? telemetry.provenance : {}),
  };

  const days = quotaDays.map((row) => ({
    date: row.date,
    storageReads: dayReads(row, ceiling),
    completedTasks: num(row.tasksCompleted),
  }));

  const events = [];
  for (const row of quotaDays) {
    const push = (kind, count, note = '') => {
      if (count === null || count === undefined) return;
      events.push({ date: row.date, kind, count, note });
    };
    push('quotaRejections', num(row.quotaRejections), 'operations refused with RESOURCE_EXHAUSTED on the free daily read quota');
    push('coordinatorBoots', num(row.boots), 'process starts on the coordinator host');
    push('observedHours', num(row.observedHours), 'hours of coordinator-log coverage in this quota day');
    push('minutesToExhaust', row.burnThrough ? num(row.burnThrough.minutes) : null, 'minutes from the quota reset to the first refusal, measured only where a successful poll lands within 10 minutes before it');
  }

  const agents = (Array.isArray(telemetry.agents) ? telemetry.agents : []).map((a) => ({
    id: a.id,
    name: a.name || a.id,
    role: a.role || '',
    // Only what this agent's own host counted. The fleet total is the quota
    // ceiling, so whatever is left over stays unattributed on purpose.
    storageReads: num(a.measuredReads),
    coordinationReads: num(a.measuredReads),
    days: quotaDays.map((row) => ({ date: row.date, storageReads: num(row.pollDocReads) })),
  }));

  const exhausted = quotaDays.filter((r) => r.quotaExhausted).length;
  const withBurnThrough = quotaDays.filter((r) => r.burnThrough).length;
  // Counted off the mapped rows, not off the raw telemetry: `agents` is the
  // exported shape, and reading measuredReads off it would silently report zero
  // instrumented reads — understating what was measured, which is the one error
  // this product does not get to make.
  const instrumented = agents.reduce((s, a) => s + num(a.storageReads), 0);
  const fleetTotal = days.reduce((s, d) => s + d.storageReads, 0);

  provenance.dayKey = 'A row is one Firestore quota day — the 24 hours from one daily read-quota reset to the next — keyed by the UTC date it began.';
  provenance.storageReads = sample
    ? 'SAMPLE-GENERATED - not measured. A seeded generator run, so the page has something to render before a real fleet is connected.'
    : `LOWER BOUND (MEASURED) - recorded at the ${ceiling.toLocaleString('en-US')}-read free-tier daily quota on the ${exhausted} of ${quotaDays.length} days the API refused the fleet's reads. Consumption was at least that; the exact count is not observable from the SDK.`;
  provenance.attributedShare = `MEASURED - instrumented consumers on the exporting host account for ${instrumented.toLocaleString('en-US')} of ${fleetTotal.toLocaleString('en-US')} recorded reads (${fleetTotal > 0 ? ((instrumented / fleetTotal) * 100).toFixed(2) : '0.00'}%). The remainder is unattributed: the requests that consumed it are not made by the code that logged this window.`;
  provenance.burnThrough = `MEASURED on ${withBurnThrough} of ${quotaDays.length} days. Unmeasured days are left null rather than estimated.`;
  provenance.priceUsd = 'ESTIMATED - reference price card in the repo ($0.40 per 1M Firestore document reads). The free tier is unmetered and bills $0; this is the counterfactual cost of the same reads on a pay-as-you-go plan.';
  if (sample) provenance.sample = 'true';

  const doc = {
    schema: 'fleet-burn/metrics@1',
    dataClass: sample ? 'SAMPLE' : 'REAL',
    fleet: telemetry.fleet || FLEET,
    window: {
      start: quotaDays[0].startUtc,
      end: quotaDays[quotaDays.length - 1].endUtc,
      days: quotaDays.length,
    },
    pricing: {
      currency: 'USD',
      note: 'Reads only: this fleet meters no tokens through fleet-burn. Estimated with the reference price card, so USD here is a counterfactual, not an invoice.',
    },
    budget: {
      capReadsPerDay: ceiling,
      rationale: 'The Firestore free-tier daily read quota this fleet runs against. It is a hard ceiling in the API, not a target we chose.',
    },
    totals: {
      tasksCompleted: days.reduce((s, d) => s + d.completedTasks, 0),
    },
    days,
    agents,
    events,
    provenance,
  };

  // Dogfood the parser: whatever this writes has to be a document fleet-burn
  // itself accepts, or the page and the CLI would be reading two dialects. The
  // plain document is what gets written — the parsed copy is only the proof.
  try {
    parseMetrics(doc);
  } catch (err) {
    if (err instanceof MetricsError) throw new Error(`exported document is not valid fleet-burn input: ${err.message}`);
    throw err;
  }
  return doc;
}

// A seeded generator, so a stranger can see the page work before pointing it at
// a real fleet. It is never the committed dataset and it says so four times:
// in the CLI output, in `sample`, in dataClass and in provenance.
export function sampleTelemetry({ days = 14, quota = FREE_TIER_READS_PER_DAY, seed = 7, fleet = FLEET } = {}) {
  // Deterministic: the same seed gives the same document, so a test can assert
  // on it and a reviewer can re-run the generator and diff the result.
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const end = Date.now();
  const quotaDays = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = Date.UTC(
      new Date(end).getUTCFullYear(),
      new Date(end).getUTCMonth(),
      new Date(end).getUTCDate() - i,
      7,
    );
    const exhausted = true;
    const minutes = 90 + Math.round(rand() * 90);
    quotaDays.push({
      date: new Date(start).toISOString().slice(0, 10),
      startUtc: new Date(start).toISOString(),
      endUtc: new Date(start + 86_400_000).toISOString(),
      observedHours: 24,
      pollAttempts: 40 + Math.round(rand() * 60),
      pollsSucceeded: 40 + Math.round(rand() * 60),
      pollsRejected: 500 + Math.round(rand() * 200),
      pollDocReads: 40 + Math.round(rand() * 80),
      heartbeatRejections: 300 + Math.round(rand() * 150),
      quotaRejections: 800 + Math.round(rand() * 350),
      quotaExhausted: exhausted,
      burnThrough: {
        atUtc: new Date(start + minutes * 60_000).toISOString(),
        lastOkAtUtc: new Date(start + (minutes - 2) * 60_000).toISOString(),
        minutes,
      },
      boots: rand() < 0.2 ? 1 + Math.round(rand() * 3) : 0,
      tasksCompleted: Math.round(rand() * 5),
    });
  }
  return {
    schema: TELEMETRY_SCHEMA,
    fleet,
    quota: { kind: 'firestore-free-tier-daily-read-units', readsPerDay: quota, resetsAtUtc: '07:00Z' },
    logLinesScanned: 0,
    agents: [{ id: 'coordinator', name: 'coordinator', role: 'coordinator', quotaDays: days, measuredReads: quotaDays.reduce((s, d) => s + d.pollDocReads, 0) }],
    quotaDays,
    provenance: {
      source: 'SAMPLE-GENERATED - a seeded random walk, not a measurement of any fleet.',
      pollDocReads: 'SAMPLE-GENERATED.',
      burnThrough: 'SAMPLE-GENERATED.',
      boots: 'SAMPLE-GENERATED.',
      tasksCompleted: 'SAMPLE-GENERATED.',
      observedHours: 'SAMPLE-GENERATED.',
    },
  };
}

function main(argv) {
  const out = { telemetry: null, out: null, sample: false, days: 14, seed: 7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--telemetry') out.telemetry = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--sample') out.sample = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      process.stderr.write(`export-cc-fleet: unexpected argument ${a}\n`);
      return 2;
    }
  }
  if (out.help) {
    process.stdout.write(
      'usage: node tools/export-cc-fleet.mjs --telemetry FILE --out FILE\n' +
        '       node tools/export-cc-fleet.mjs --sample --out FILE [--days 14] [--seed 7]\n',
    );
    return 0;
  }
  if (!out.out || (!out.telemetry && !out.sample)) {
    process.stderr.write('export-cc-fleet: need --telemetry FILE or --sample, plus --out FILE\n');
    return 2;
  }

  let telemetry;
  try {
    telemetry = out.sample
      ? sampleTelemetry({ days: out.days, seed: out.seed })
      : JSON.parse(readFileSync(out.telemetry, 'utf8'));
  } catch (err) {
    process.stderr.write(`export-cc-fleet: cannot read telemetry: ${err.message}\n`);
    return 2;
  }

  let metrics;
  try {
    metrics = exportMetrics(telemetry, { sample: out.sample });
  } catch (err) {
    process.stderr.write(`export-cc-fleet: ${err.message}\n`);
    return 2;
  }

  writeFileSync(out.out, `${JSON.stringify(metrics, null, 2)}\n`);
  if (out.sample) {
    process.stderr.write(
      'export-cc-fleet: WARNING — wrote a SAMPLE-GENERATED document (provenance.sample=true). ' +
        'Do not publish it as measured data.\n',
    );
  }
  process.stdout.write(
    `wrote ${out.out}: ${metrics.days.length} day(s), ${metrics.agents.length} agent(s), ` +
      `${metrics.events.length} event row(s), dataClass=${metrics.dataClass}\n`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('export-cc-fleet.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
