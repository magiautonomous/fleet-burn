# fleet-burn

**Token tracers show you what a model call cost. None of them show you what _coordination_ cost. fleet-burn attributes storage reads, LLM calls, tokens and estimated USD to the agent and task that caused them, and exits non-zero when a daily cap is blown.**

The framework market is saturated. The tracing tools are not the gap either —
LangSmith, MLflow and Langfuse all show you tokens and latency for a call you
already decided to make. What none of them price is the fleet's own overhead:
the redundant polls, the re-claim churn, the retry storm. That is where agent
fleets actually lose days, and it is invisible in every per-call view.

This repo is the fix we built after losing days to exactly that, dogfooded on
the fleet that lost them.

```
$ fleet-burn metrics.json --cap-reads-per-day 50000
...
  [READS CAP] 2026-09-15
    actual  172,320   cap 50,000   over by 122,320 (3.45x)
    agent   Casper  56,160  = 33% of the day
    task    "board poll: query the full task history instead of live cards"
            [inc-board-poll-history]  84,240  = 50% of the day
$ echo $?
1
```

The cap is the product. A meter that only reports is a dashboard you learn to
ignore; a meter that exits 1 and names the agent and the task is a thing that
stops the run.

Live dashboard (real fleet data): **https://magiautonomous.github.io/fleet-burn/**

---

## Status: v0.1, pre-revenue, no payment rail yet

Read this before you install anything:

- This is **v0.1**. It is a working meter with a real budget guard, not a
  product with customers. **Nobody is billing you and there is nothing to buy.**
- There is **no hosted version, no account, no API key, no payment rail.** The
  dashboard is a static page over a committed JSON file; the CLI runs entirely
  on your machine.
- The **USD figures are estimates from a reference price card**, not invoices.
  See [The cost model](#the-cost-model). Point it at your own prices.
- The **sample data is one fleet's**, from a specific window. It is real, but it
  is not a benchmark and your fleet will not look like it.

If you use it and it saves you a freeze, that is the whole of v0.1's ambition.

## The wedge: coordination cost, not model cost

Here is the incident that made this. It is real, and it is the reason the repo
exists.

A three-agent fleet on the Firestore free tier (50,000 document reads/day)
froze itself **every morning at about 09:09 UTC**, with `RESOURCE_EXHAUSTED`.
Between 941 and 2,553 hits a day; 8,532 in one week. Every worker went comatose
— retrying for ten minutes, erroring, retrying — until the daily reset refilled
the budget. Real days lost, repeatedly.

Every *instrumented* consumer looked tiny: workers read 0–1 docs per 120-second
poll, the alert loop ~40 docs per 15 minutes, the watchdog 15-minute. Nothing
looked wrong, which is exactly the problem. The leak was in the one query
nobody had looked at since they wrote it: the board poll asked for each
worker's **full task history** instead of live cards. **~78 document reads per
poll cycle.** At a 120-second cadence that is ~56,000 reads/day *per worker*.

Small-per-call reads is not a budget strategy. **You cannot optimise a number
you cannot see.** So the first fix was not a code change, it was attribution:
and the second fix was a cap that fails loudly instead of a dashboard that
scrolled past.

## Install

Zero dependencies. Clone and run.

```bash
git clone https://github.com/magiautonomous/fleet-burn.git
cd fleet-burn
node --version          # >= 18

# the bundled REAL fleet sample
node bin/fleet-burn.js --sample

# the incident replay: watch the guard fail
node bin/fleet-burn.js data/incident-pre-fix-reconstruction.json --cap-reads-per-day 50000
echo "exit: $?"        # exit: 1
```

Or as a library / global bin:

```bash
npm install -g fleet-burn   # provides the `fleet-burn` command
npm test                    # 130 tests, no network, no services
```

## Quickstart: meter your own fleet

fleet-burn ingests a **metrics JSON in the shape a fleet already emits**. You do
not have to adopt a client library; if you can write out a JSON file with your
counters in it, you can use this.

```bash
# 1. a nightly cron in your fleet writes yesterday's counters to metrics.json
# 2. the guard runs in CI, and fails the pipeline if you are over
fleet-burn metrics.json \
  --cap-reads-per-day 50000 \
  --cap-usd-per-day 25 \
  > burn-report.txt
```

```yaml
# .github/workflows/fleet-burn.yml
- name: fleet budget guard
  run: npx fleet-burn metrics/fleet.json --cap-reads-per-day 50000 --cap-usd-per-day 25
```

If you want the whole thing as a library, the API is four functions:

```js
import { readMetricsFile, attribute, checkBudget, exitCodeFor } from 'fleet-burn';

const metrics = readMetricsFile('metrics.json');
const report = attribute(metrics);            // agent + task + day attribution
const budget = checkBudget(report, { capReadsPerDay: 50_000 });
process.exit(exitCodeFor(budget));             // 0 ok, 1 breach
```

## The metrics document

Every field is optional; anything you leave out counts as zero. Aliases are
accepted so you can keep the field names you already use.

```jsonc
{
  "schema": "fleet-burn/metrics@1",
  "dataClass": "REAL",                       // surfaced everywhere; never lie here
  "fleet": "my agent fleet",
  "window": { "start": "2026-09-14T00:00:00Z", "end": "2026-09-26T23:59:59Z", "days": 13 },

  "budget": { "capReadsPerDay": 50000, "capUsdPerDay": 25 },

  "totals": { "storageReads": 223, "llmCalls": 2029, "tasksCompleted": 132 },

  "days": [
    { "date": "2026-09-25", "storageReads": 22, "llmCalls": 95,
      "tokensIn": 120000, "tokensOut": 40000, "tokensCacheRead": 900000,
      "completedTasks": 1 }
  ],

  "agents": [
    { "id": "alpha", "name": "Alpha", "role": "core", "storageReads": 223,
      "llmCalls": 2029, "coordinationReads": 87,
      // Optional. When present, "which agent blew this cap on this day" is exact
      // rather than apportioned from a window total.
      "days": [ { "date": "2026-09-25", "storageReads": 22, "llmCalls": 95 } ] }
  ],

  "tasks": [
    { "id": "T1", "title": "board poll: query the full task history",
      "agent": "alpha", "status": "Done",
      "startedAt": "2026-09-15T00:00:00Z", "endedAt": "2026-09-15T02:00:00Z",
      "llmCalls": 134, "tokensIn": 284049, "tokensOut": 106631,
      "tokensCacheRead": 9340928, "storageReads": 21 }
  ],

  "provenance": { "storageReads": "counted from the poll log line \"board poll: N doc(s)\"" }
}
```

**Aliases.** `storageReads` also answers to `reads`, `storage_reads`,
`documentReads`, `readOps`. `llmCalls` to `modelCalls`, `requests`, `apiCalls`.
`tokensIn` to `inputTokens`, `promptTokens`. `tokensOut` to `outputTokens`,
`completionTokens`. `estimatedCostUsd` to `costUsd`, `cost_usd`, `cost`.

**Roll-up rules.** An agent's usage is the *larger* of its declared row and what
its tasks claim, per dimension — so a stale agent row is never diluted by a task
roll-up, and a task roll-up never double-counts a declared row. A day takes the
larger of its own row and the tasks that started on it. Whatever is left over is
reported as `unattributed` and reflected in `coverage`, so a gap shows up as a
number instead of quietly disappearing.

## The cost model

```
estimated USD = storageReads   x readUnitUsd
              + llmCalls       x callUnitUsd
              + tokens[class]  / 1e6 x perMillion[class]
```

| field | default | why |
| --- | --- | --- |
| `readUnitUsd` | `0.0000004` | 1M Firestore document reads = $0.40 |
| `callUnitUsd` | `0` | a call's money is in its tokens, not a flat fee |
| `perMillion.tokensIn` | `3.00` | fresh input |
| `perMillion.tokensOut` | `15.00` | output |
| `perMillion.tokensReasoning` | `15.00` | reasoning is billed as output |
| `perMillion.tokensCacheRead` | `0.30` | cache reads are 10x cheaper, on purpose |
| `perMillion.tokensCacheWrite` | `3.75` | cache writes cost more than a fresh input |

Every field is overridable, because the only number that matters is the one your
invoice agrees with:

```bash
fleet-burn metrics.json --price-read-unit 0.0000004 --price-out-per-m 15 --price-in-per-m 3
```

```js
attribute(metrics, { priceCard: { readUnitUsd: 0.0000004, perMillion: { tokensOut: 12 } } });
```

**On the defaults being an estimate.** The bundled price card is a *reference
card*: a round-number list price used so the meter has something honest to
divide by when your provider reports no price. If your metrics document carries
its own `estimatedCostUsd` on a row, fleet-burn believes that row instead of
re-pricing it, and marks the cost breakdown `supplied` rather than `priceCard`
so you can see which number you are looking at.

**The fleet that produced the sample runs an unmetered gateway and reports
$0.00.** So the sample's USD is explicitly a counterfactual: "what this fleet's
real token usage would have cost at list prices." The read and token counts are
measurements; the dollars are arithmetic on top of them.

## The budget guard

```bash
fleet-burn metrics.json --cap-reads-per-day 50000 --cap-usd-per-day 25 --cap-llm-calls-per-day 2000
```

| exit code | meaning |
| --- | --- |
| `0` | within every cap that was set |
| `1` | a daily cap was blown; the violation names the agent and the task |
| `2` | bad input: unreadable file, invalid JSON, or a bad flag |

- Caps come from the flags, falling back to the document's `budget` block. A cap
  of `0` or a junk value is **ignored**, not treated as a free pass.
- A day *exactly at* the cap is a pass. A day one unit over is a breach. The
  boundary is not fuzzy.
- Idle days are not checked and cannot breach.
- A breach on a document **with** a per-day agent split is attributed to that
  day. On a document **without** one, the worst agent is reported with
  `scope: "window"` and the violation says so in words, because apportioning a
  window total across days would invent a precision the data does not contain.

## The dashboard

A dependency-free static page at **`https://magiautonomous.github.io/fleet-burn/`**,
served by GitHub Pages. One `index.html`, one JS module, one stylesheet, and the
committed metrics it renders.

It shows burn over time against the cap, the most expensive agents, the worst
cost-per-outcome days, the expensive tasks and the read-heavy ones side by side,
the cap verdict, and a **provenance table** listing how every field on the page
was produced.

```bash
node tools/build-dashboard.mjs      # data/*.json -> site/data.json, via the library
```

The committed `site/data.json` is generated by running the real library over
`data/fleet-sample.json`, and a test fails if it has drifted from what the CLI
would print. The page cannot quietly disagree with the command line.

## The sample data: what is real and what is not

Two files, labelled `dataClass` in the document itself, carried through the CLI
output, the JSON output and the dashboard banner. **Nothing synthetic is
presented as real anywhere in this repo.**

### `data/fleet-sample.json` — **REAL fleet telemetry**

Exported from the magi fleet's own instrumentation over **2026-09-11 to
2026-09-26**:

| field | how it was produced |
| --- | --- |
| `storageReads` | **MEASURED** — counted from the coordinator's own log line `board poll: N doc(s)`, one document read per card scanned. 849 poll events. |
| per-task `storageReads` | **MEASURED** — each poll's reads charged to the task whose in-flight window contained that poll's timestamp. 136 reads task-attributed, 87 charged to the agent as idle `coordinationReads`. The two sum to the total; the extractor throws if they do not. |
| `llmCalls` | **MEASURED** — counted assistant turns in the agent runtime's session store. One assistant message = one LLM call. 2,029. |
| token counts | **MEASURED** — per-session counters from the runtime, joined to board task ids by session id. 33 of 33 logged task runs matched a session. |
| `completedTasks` | **MEASURED** — the maintained `memory/board-completions` counter. 132 completions. |
| `estimatedCostUsd` | **ESTIMATED** — the reference price card above. The fleet's gateway is unmetered and reports $0.00, so this is a list-price counterfactual. |

Result: **223 storage reads, 2,029 LLM calls, 121.7M tokens, ~$64.50 estimated,
$0.49 per completed task, 18.6 reads/day** — the post-fix, read-thrift fleet.
The reads look tiny because they are: this is the *after* picture, and it is
published precisely so the *before* picture below has something to be measured
against.

### `data/incident-pre-fix-reconstruction.json` — **SYNTHETIC, a configuration replay**

`dataClass: "SYNTHETIC"`. **Computed, not measured.** Generated by
`tools/build-incident-sample.mjs`, which you can read to check every number:

- `78 docs/poll x 720 polls/day x 3 workers = 168,480` reads/day from the
  workers, plus 3,840 for the alert loop = **172,320/day against a 50,000 cap**,
  3.45x over, seven days running.
- **One inconsistency is left visible on purpose.** That replay exhausts the cap
  at about 07:00Z, but the freeze was *observed* at 09:09Z. The gap is real, it
  means the leak was not at full three-worker concurrency on the day it was
  measured, and closing it needs the Cloud Monitoring export that is still
  operator-gated. It is recorded in the file as `measured_cited` with a note
  saying it is unreconciled, rather than being fudged into agreement.

The observed figures in that file — the 09:09Z freeze and the 941–2,553/day,
8,532/week `RESOURCE_EXHAUSTED` counts — are **measured and cited**, kept in
their own `measured_cited` block, and never mixed with the computed ones.

### Why not the Cloud Monitoring export

`firestore.googleapis.com/document/read_ops_count` is the billing-relevant
metric and would be the ideal source, but the fleet's service account holds only
Firestore data roles: reading it needs `roles/monitoring.viewer`, which is an
operator grant. The `read-attribution` tool exits 2 with the exact `gcloud`
command. So the real sample is measured from the fleet's own local
instrumentation instead — the same inference the fleet was already forced into,
written down and reproducible.

## CLI reference

```
fleet-burn <metrics.json> [options]
fleet-burn - [options]                read the metrics document from stdin
fleet-burn --sample                   run against the bundled real-fleet sample

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
```

## Tests

```bash
npm test                  # node --test test/*.test.js
```

The suite covers the parser's rejection of malformed input, the cost formula
term by term, every roll-up rule (including the ones that stop double-counting),
the budget boundary, all three exit codes through **real process spawns**, and
the two invariants that keep this honest: the committed sample's rows must
reconcile to its own totals, and the committed dashboard data must match what
the library computes from it.

## Design decisions worth arguing about

- **A JSON file is the interface, not a client library.** If you can write out
  counters, you can use this. No SDK, no agent to instrument, no lock-in.
- **Zero dependencies, on purpose.** A cost meter that pulls in a tree of
  transitive packages is a cost meter with its own supply chain. Everything here
  is Node built-ins; the whole thing is auditable in one sitting and installs
  from a clone.
- **The guard is the product.** Leaderboards are table stakes; exiting non-zero
  with a named culprit is the thing that stops the freeze.
- **The meter refuses to guess.** Unattributed activity is reported as a number
  with a coverage ratio, and imprecise attributions are labelled `window` rather
  than dressed up as per-day. A cost tool that quietly invents precision is worse
  than no cost tool.
- **Sync, no streams, no workers.** A few hundred tasks is a few milliseconds.
  Complexity here would cost more than it saves.

## Licence

MIT — see [LICENSE](LICENSE).
