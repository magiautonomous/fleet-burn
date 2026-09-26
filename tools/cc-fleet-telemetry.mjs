// Reduces a CC-fleet coordinator log to a sanitized telemetry document.
//
// This is the step that keeps the public repo clean. The coordinator log is a
// private artefact full of task titles, board ids and prose; what fleet-burn
// needs from it is counters and timestamps. So this tool recognises a fixed set
// of line shapes, keeps only the number and the timestamp, and never copies a
// line of free text into its output. Everything it emits is a value somebody
// measured on a running fleet.
//
//   node tools/cc-fleet-telemetry.mjs <log> [<log> ...] --out FILE
//        [--quota 50000] [--reset-hour 7] [--fleet "..."] [--agent id=role ...]
//
// Why the day key is not midnight UTC: the budget being measured is a Firestore
// free-tier *daily* read quota, and that quota resets on a fixed UTC hour
// (07:00Z = midnight Pacific, the tier's documented reset). A day therefore
// starts when the budget refills, not when the UTC date flips, or every row
// would straddle two budgets and no row could name an exhaustion time.

import { readFileSync, writeFileSync } from 'node:fs';

export const TELEMETRY_SCHEMA = 'cc-fleet/telemetry@1';

// Firestore free tier: 50,000 document reads/day, reset at midnight Pacific.
export const FREE_TIER_READS_PER_DAY = 50_000;
export const DEFAULT_RESET_HOUR_UTC = 7;

// The read-quota error the SDK raises. Matched on the quota metric name rather
// than on the error code, so a *different* RESOURCE_EXHAUSTED (writes, CPU) is
// never counted as a read-budget event.
const isReadQuotaRejection = (line) =>
  line.includes('RESOURCE_EXHAUSTED') && line.includes('Free daily read units');

const STAMP = /^\[([^\]]+)\]/;
const POLL_REJECTED = /^\[[^\]]+\] board poll error:/;

const LINES = {
  pollOk: /^\[(?<ts>[^\]]+)\] board poll: (?<docs>\d+) doc/,
  boot: /^\[(?<ts>[^\]]+)\] registered in agents\/(?<agent>[\w-]+) as Online/,
  taskDone: /^\[(?<ts>[^\]]+)\] updating \S+ → Done/,
};

const HOUR = 3600_000;

// How stale a "the fleet was working" proof may be and still count as proof.
const LIVE_WINDOW_MS = 10 * 60_000;

// Records the moment this quota day ran out, if the log proves the fleet was
// working just before it did. The first rejection of a quota day is almost
// always yesterday's exhaustion still in force, so only a rejection that
// follows a *fresh successful poll* is the real end of the window.
function noteBurnThrough(day, rejectedAtIso) {
  if (day.burnThrough) return;
  if (!day.lastPollOkAtUtc) return;
  const gap = Date.parse(rejectedAtIso) - Date.parse(day.lastPollOkAtUtc);
  if (gap < 0 || gap > LIVE_WINDOW_MS) return;
  day.burnThrough = {
    atUtc: rejectedAtIso,
    lastOkAtUtc: day.lastPollOkAtUtc,
    minutes: Math.round(((Date.parse(rejectedAtIso) - Date.parse(day.startUtc)) / 60_000) * 10) / 10,
  };
}

function parseArgs(argv) {
  const out = {
    logs: [],
    out: null,
    quota: FREE_TIER_READS_PER_DAY,
    resetHour: DEFAULT_RESET_HOUR_UTC,
    fleet: 'CC fleet — 3 autonomous workers + 1 coordinator on a Firestore free-tier database',
    roles: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--quota') out.quota = Number(argv[++i]);
    else if (a === '--reset-hour') out.resetHour = Number(argv[++i]);
    else if (a === '--fleet') out.fleet = argv[++i];
    else if (a === '--agent') out.roles.push(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else out.logs.push(a);
  }
  if (!out.help) {
    if (!out.logs.length) throw new Error('need at least one log file');
    if (!out.out) throw new Error('need --out FILE');
    if (!Number.isInteger(out.resetHour) || out.resetHour < 0 || out.resetHour > 23) {
      throw new Error('--reset-hour must be an hour of the day');
    }
    if (!(out.quota > 0)) throw new Error('--quota must be positive');
  }
  return out;
}

// The quota day a timestamp belongs to, as {key, start, end}. The key is the
// UTC date the day *began*, so it is a plain 'YYYY-MM-DD' and the day boundary
// is always stated rather than implied.
export function quotaDayOf(iso, resetHour = DEFAULT_RESET_HOUR_UTC) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), resetHour, 0, 0, 0);
  const from = ms >= start ? start : start - 24 * HOUR;
  return {
    key: new Date(from).toISOString().slice(0, 10),
    start: new Date(from).toISOString(),
    end: new Date(from + 24 * HOUR).toISOString(),
  };
}

function emptyDay(key, start, end) {
  return {
    date: key,
    startUtc: start,
    endUtc: end,
    observedHours: 0,
    pollAttempts: 0,
    pollsSucceeded: 0,
    pollsRejected: 0,
    pollDocReads: 0,
    heartbeatRejections: 0,
    quotaRejections: 0,
    quotaExhausted: false,
    burnThrough: null,
    lastPollOkAtUtc: null,
    boots: 0,
    tasksCompleted: 0,
  };
}

/**
 * Parses one or more coordinator logs into the telemetry document.
 * Pure: text in, document out, so the numbers can be tested without a fleet.
 */
export function telemetryFromLogs(texts, options = {}) {
  const { quota = FREE_TIER_READS_PER_DAY, resetHour = DEFAULT_RESET_HOUR_UTC, fleet = '', roles = [] } = options;
  const days = new Map();
  const agents = new Map();
  let lines = 0;

  const dayFor = (iso) => {
    const q = quotaDayOf(iso, resetHour);
    if (!q) return null;
    if (!days.has(q.key)) days.set(q.key, emptyDay(q.key, q.start, q.end));
    return days.get(q.key);
  };

  for (const text of texts) {
    for (const line of text.split('\n')) {
      lines += 1;
      const m = LINES.pollOk.exec(line);
      if (m) {
        const d = dayFor(m.groups.ts);
        if (!d) continue;
        const docs = Number(m.groups.docs);
        d.pollAttempts += 1;
        d.pollsSucceeded += 1;
        // A query that returns nothing still costs one read unit, so the floor
        // for a successful poll is 1 + the documents it actually returned.
        d.pollDocReads += 1 + docs;
        d.lastPollOkAtUtc = m.groups.ts;
        continue;
      }
      if (POLL_REJECTED.test(line) && isReadQuotaRejection(line)) {
        const ts = STAMP.exec(line)[1];
        const d = dayFor(ts);
        if (!d) continue;
        d.pollAttempts += 1;
        d.pollsRejected += 1;
        d.quotaRejections += 1;
        // A rejected request is refused before it reads anything, so it costs
        // zero read units. Counting it would inflate the fleet's own bill.
        d.quotaExhausted = true;
        noteBurnThrough(d, ts);
        continue;
      }
      if (line.includes('heartbeat ping failed:') && isReadQuotaRejection(line)) {
        const d = dayFor(STAMP.exec(line)[1]);
        if (!d) continue;
        d.heartbeatRejections += 1;
        d.quotaRejections += 1;
        d.quotaExhausted = true;
        continue;
      }
      const boot = LINES.boot.exec(line);
      if (boot) {
        const d = dayFor(boot.groups.ts);
        if (d) d.boots += 1;
        if (!agents.has(boot.groups.agent)) {
          agents.set(boot.groups.agent, { id: boot.groups.agent, role: 'worker', quotaDays: 0, measuredReads: 0 });
        }
        continue;
      }
      const done = LINES.taskDone.exec(line);
      if (done) {
        const d = dayFor(done.groups.ts);
        if (d) d.tasksCompleted += 1;
      }
    }
  }

  // Burn-through time is the one number on this page that has to be earned, so
  // it is only recorded when the fleet was demonstrably alive and then stopped:
  // a successful poll within LIVE_WINDOW_MS before the rejection that ends the
  // window. Two ways to be wrong otherwise, both seen in the wild on this very
  // fleet — a rejection logged after a 10-minute retry budget expired describes
  // a call that *started* before the reset, and the first rejection of a quota
  // day is usually the previous day's exhaustion still in force. Either one
  // turns a 50,000-read burn into a 1,000,000-read-per-minute fantasy.
  // Log coverage per day, so a reader can tell a quiet day from an unwatched
  // one. Clipped to the day, and never rounded up to look better than it is.
  const stamps = [];
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const m = STAMP.exec(line);
      if (m && Number.isFinite(Date.parse(m[1]))) stamps.push(Date.parse(m[1]));
    }
  }
  stamps.sort((a, b) => a - b);
  for (const d of days.values()) {
    const from = Date.parse(d.startUtc);
    const to = from + 24 * HOUR;
    const inside = stamps.filter((s) => s >= from && s < to);
    d.observedHours = inside.length
      ? Math.round(((inside[inside.length - 1] - inside[0]) / HOUR) * 100) / 100
      : 0;
  }

  // Burn-through time is the one number on this page that has to be earned, so
  // it is only recorded when the fleet was demonstrably alive and then stopped:
  // a successful poll within LIVE_WINDOW_MS before the rejection that ends the
  // window. Two ways to be wrong otherwise, both seen on this very fleet — a
  // rejection logged after a 10-minute retry budget expired describes a call
  // that *started* before the reset, and the first rejection of a quota day is
  // usually the previous day's exhaustion still in force. Either one turns a
  // 50,000-read burn into a 1,000,000-read-per-minute fantasy.
  const rows = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastLogLine = stamps.length ? new Date(stamps[stamps.length - 1]).toISOString() : null;

  for (const [id, a] of agents) {
    a.quotaDays = rows.length;
    a.measuredReads = rows.reduce((s, d) => s + d.pollDocReads, 0);
    const role = roles.find((r) => r.split('=')[0] === id);
    a.role = role ? role.split('=')[1] : a.role;
  }

  return {
    schema: TELEMETRY_SCHEMA,
    fleet,
    // A snapshot of a log that is still being appended to. Stamping the cutoff
    // makes the committed dataset a fixed window with a stated end, instead of a
    // number that quietly changes every time someone re-runs the exporter.
    window: {
      startUtc: rows.length ? rows[0].startUtc : null,
      endUtc: rows.length ? rows[rows.length - 1].endUtc : null,
      lastLogLineUtc: lastLogLine,
      complete: Boolean(lastLogLine && rows.length && lastLogLine >= rows[rows.length - 1].endUtc),
    },
    quota: {
      kind: 'firestore-free-tier-daily-read-units',
      readsPerDay: quota,
      resetsAtUtc: `${String(resetHour).padStart(2, '0')}:00Z`,
    },
    logLinesScanned: lines,
    agents: [...agents.values()],
    quotaDays: rows,
    provenance: {
      source: 'MEASURED - counters parsed out of the CC fleet coordinator log on the host that runs the coordinator.',
      pollAttempts: 'MEASURED - one coordinator board poll every 120s, logged per attempt as "board poll: N doc(s)" or a quota rejection.',
      pollDocReads: 'MEASURED - one read unit per successful poll plus one per document it returned. Rejected attempts cost nothing: the API refuses them before reading anything.',
      quotaRejections: 'MEASURED - operations the API refused with RESOURCE_EXHAUSTED on the "Free daily read units per project (free tier database)" quota.',
      minutesToExhaust: `MEASURED - minutes from the quota reset to the first poll rejection, reported only when a successful poll lands within ${LIVE_WINDOW_MS / 60_000} minutes before it.`,
      boots: 'MEASURED - one process start per "registered in agents/<id> as Online" line.',
      tasksCompleted: 'MEASURED - one per task transition to Done on the board.',
      observedHours: 'MEASURED - span of timestamps this day has in the scanned log, clipped to the day.',
      sanitized: 'YES - this document carries counters, timestamps and agent ids only. No task titles, board ids, hostnames or paths are copied out of the log.',
      window: 'MEASURED - the span of quota days the scanned log covers, and the last timestamp it contains. The final day may be partial; the committed dataset is a fixed snapshot of that moment.',
    },
  };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`cc-fleet-telemetry: ${err.message}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(
      'usage: node tools/cc-fleet-telemetry.mjs <log> [<log> ...] --out FILE\n' +
        '         [--quota 50000] [--reset-hour 7] [--fleet NAME] [--agent id=role]\n',
    );
    return 0;
  }
  const doc = telemetryFromLogs(
    args.logs.map((p) => readFileSync(p, 'utf8')),
    { quota: args.quota, resetHour: args.resetHour, fleet: args.fleet, roles: args.roles },
  );
  writeFileSync(args.out, `${JSON.stringify(doc, null, 2)}\n`);
  const withExhaust = doc.quotaDays.filter((d) => d.burnThrough).length;
  process.stdout.write(
    `wrote ${args.out}: ${doc.quotaDays.length} quota day(s), ${withExhaust} with a measured burn-through time, ` +
      `${doc.quotaDays.reduce((s, d) => s + d.quotaRejections, 0)} quota rejections, ` +
      `${doc.quotaDays.reduce((s, d) => s + d.boots, 0)} boot(s)\n`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('cc-fleet-telemetry.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
