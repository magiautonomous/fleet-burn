import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { parseMetrics } from '../lib/parse.js';
import { attribute } from '../lib/attribute.js';
import { checkBudget } from '../lib/budget.js';
import { telemetryFromLogs, quotaDayOf } from '../tools/cc-fleet-telemetry.mjs';
import { exportMetrics, sampleTelemetry } from '../tools/export-cc-fleet.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TELEMETRY = JSON.parse(readFileSync(path.join(root, 'data', 'cc-fleet-telemetry.json'), 'utf8'));
const METRICS = JSON.parse(readFileSync(path.join(root, 'data', 'cc-fleet-metrics.json'), 'utf8'));
const CC_DATA = JSON.parse(readFileSync(path.join(root, 'site', 'cc-data.json'), 'utf8'));

// Three lines, three quota days, written the way the coordinator writes them.
// Quota refusals carry the quota metric name; the retry-timeout variant of the
// same error must not be mistaken for a fresh attempt.
const LOG = [
  '[2026-09-20T07:00:05.000Z] registered in agents/core-a as Online',
  '[2026-09-20T07:02:00.000Z] board poll: 2 doc(s)',
  '[2026-09-20T07:04:00.000Z] board poll: 0 doc(s)',
  '[2026-09-20T07:06:00.000Z] board poll error: 8 RESOURCE_EXHAUSTED: Quota limit exceeded. ' +
    "Cause - Quota exceeded for quota metric 'Free daily read units per project (free tier database)'",
  '[2026-09-20T07:08:00.000Z] heartbeat ping failed: GoogleError: Total timeout of API exceeded 600000 ms ' +
    "retrying error Error: 8 RESOURCE_EXHAUSTED: 'Free daily read units per project (free tier database)'",
  '[2026-09-20T09:00:00.000Z] updating T-1 → Done',
  '[2026-09-20T09:00:01.000Z] board poll error: 8 RESOURCE_EXHAUSTED: quota metric ' +
    "'Free daily read units per project (free tier database)'",
  // A different quota entirely: not a read-budget event, must not be counted.
  '[2026-09-20T09:10:00.000Z] board poll error: 8 RESOURCE_EXHAUSTED: Quota exceeded for quota metric ' +
    "'Cloud Firestore Admin v1 API requests per minute per project'",
].join('\n');

// ---------------------------------------------------------------- telemetry

test('a quota day starts at the reset hour, not at midnight UTC', () => {
  assert.equal(quotaDayOf('2026-09-20T06:59:59.000Z').key, '2026-09-19');
  assert.equal(quotaDayOf('2026-09-20T07:00:00.000Z').key, '2026-09-20');
  assert.equal(quotaDayOf('2026-09-20T23:59:59.000Z').key, '2026-09-20');
  assert.equal(quotaDayOf('2026-09-21T00:00:00.000Z').key, '2026-09-20');
  assert.equal(quotaDayOf('not a date'), null);
});

test('the log parser counts polls, refusals, boots and completions — and nothing else', () => {
  const t = telemetryFromLogs([LOG], { fleet: 'test' });
  assert.equal(t.quotaDays.length, 1);
  const [d] = t.quotaDays;
  assert.equal(d.date, '2026-09-20');
  assert.equal(d.pollsSucceeded, 2, 'two polls got through');
  assert.equal(d.pollsRejected, 2, 'two polls were refused');
  assert.equal(d.heartbeatRejections, 1);
  assert.equal(d.quotaRejections, 3, 'and the writes-quota refusal is not a read event');
  assert.equal(d.boots, 1);
  assert.equal(d.tasksCompleted, 1);
  // 1 read unit per query plus 1 per document returned. A refused request reads
  // nothing, so it costs nothing: the two successful polls cost 3 + 1.
  assert.equal(d.pollDocReads, 4);
});

test('burn-through is only reported when a successful poll proves the fleet was alive', () => {
  const [d] = telemetryFromLogs([LOG], {}).quotaDays;
  assert.equal(d.quotaExhausted, true);
  assert.ok(d.burnThrough, 'a refusal 2 minutes after a successful poll is a real burn-through');
  assert.equal(d.burnThrough.minutes, 6);
  assert.equal(d.burnThrough.lastOkAtUtc, '2026-09-20T07:04:00.000Z');

  // Same day, but the only refusal is 40 minutes after the last good poll: the
  // log cannot say when the budget actually ran out, so it says nothing.
  const stale = LOG.replace('[2026-09-20T07:06:00.000Z] board poll error', '[2026-09-20T07:44:00.000Z] board poll error')
    .replace(/^\[2026-09-20T07:08:00.000Z\] heartbeat[\s\S]*$/m, '[2026-09-20T07:08:00.000Z] nothing to see')
    .replace(/^\[2026-09-20T09:00:01.000Z\] board poll error[\s\S]*$/m, '');
  const [s] = telemetryFromLogs([stale], {}).quotaDays;
  assert.equal(s.burnThrough, null, 'a stale liveness proof is not a burn-through time');
  assert.equal(s.quotaExhausted, true, 'but the day is still known to have been refused');
});

test('the committed telemetry is sanitized: counters, timestamps and agent ids only', () => {
  const text = JSON.stringify(TELEMETRY);
  assert.equal(TELEMETRY.schema, 'cc-fleet/telemetry@1');
  assert.doesNotMatch(text, /balthasar@|\/home\/|https?:\/\/|\.firebaseio|project_number/i, 'no host, path or project id');
  for (const day of TELEMETRY.quotaDays) {
    for (const [k, v] of Object.entries(day)) {
      assert.ok(
        typeof v === 'number' || v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'object',
        `quotaDays[].${k} should be a counter, a flag, a timestamp, a burn-through or null, got ${typeof v}`,
      );
      if (typeof v === 'string') {
        assert.match(v, /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/, `quotaDays[].${k} should be a date or a timestamp, got ${v}`);
      }
      if (k === 'burnThrough' && v) {
        assert.deepEqual(Object.keys(v).sort(), ['atUtc', 'lastOkAtUtc', 'minutes'], 'a burn-through is a time, not a paragraph');
        assert.ok(v.minutes > 0);
      }
    }
  }
  // The agent is identified by the public agent id, not by a logins.com address.
  assert.equal(TELEMETRY.agents[0].id, 'Balthasar');
  assert.doesNotMatch(JSON.stringify(TELEMETRY.agents), /@/);
});

// ------------------------------------------------------------------ exporter

test('the exporter emits a document fleet-burn itself accepts', () => {
  const parsed = parseMetrics(METRICS);
  assert.equal(parsed.dataClass, 'REAL');
  assert.ok(parsed.days.length >= 14, `the committed dataset covers ${parsed.days.length} days, want at least 14`);
  assert.equal(parsed.budget.capReadsPerDay, 50_000);
  assert.equal(attribute(parsed).window.activeDays, parsed.days.length);
});

test('a day the API refused is recorded at the ceiling; a day nothing refused is recorded as counted', () => {
  const t = sampleTelemetry({ days: 3 });
  const doc = exportMetrics(t);
  assert.equal(doc.days.length, 3);
  assert.ok(doc.days.every((d) => d.storageReads === 50_000), 'every sample day was refused, so every day sits at the ceiling');

  t.quotaDays[1].quotaExhausted = false;
  t.quotaDays[1].pollDocReads = 7;
  t.agents[0].measuredReads = 7;
  const mixed = exportMetrics(t);
  assert.equal(mixed.days[1].storageReads, 7, 'with no refusal there is no evidence for the ceiling, so it is not claimed');
  assert.equal(mixed.days[0].storageReads, 50_000);
});

test('the exporter reports the unattributed share instead of closing the gap', () => {
  const doc = exportMetrics(TELEMETRY);
  const report = attribute(parseMetrics(doc));
  const attributed = report.agents.reduce((s, a) => s + a.storageReads, 0);
  assert.ok(report.totals.storageReads > attributed, 'the dataset must contain burn that no agent row claims');
  assert.ok(report.coverage < 0.01, `coverage is ${report.coverage}, and a real fleet at the ceiling is nowhere near 1`);
  assert.equal(report.unattributed.storageReads, report.totals.storageReads - attributed);
  assert.match(String(doc.provenance.storageReads), /LOWER BOUND \(MEASURED\)/);
  // The provenance text has to quote the same numbers as the document, or it
  // understates what was measured and the page repeats the understatement.
  const fleetTotal = doc.days.reduce((s, d) => s + d.storageReads, 0);
  assert.match(
    String(doc.provenance.attributedShare),
    new RegExp(`${attributed.toLocaleString('en-US')} of ${fleetTotal.toLocaleString('en-US')}`),
    'provenance must quote the real attributed/total pair',
  );
  assert.doesNotMatch(String(doc.provenance.attributedShare), /account for 0 of/, 'never claim nothing was instrumented when rows exist');
  assert.match(
    String(doc.provenance.minutesToExhaust),
    /within \d+ minutes/,
    'and the liveness window it claims is the one the parser uses',
  );
});

test('the exporter refuses telemetry it cannot vouch for', () => {
  assert.throws(() => exportMetrics(null), /telemetry must be an object/);
  assert.throws(() => exportMetrics({ schema: 'nope' }), /unsupported telemetry schema/);
  assert.throws(() => exportMetrics({ schema: 'cc-fleet/telemetry@1' }), /no quota days/);
});

test('the sample mode is labelled as generated everywhere it can be seen', () => {
  const doc = exportMetrics(sampleTelemetry({ days: 14 }), { sample: true });
  assert.equal(doc.dataClass, 'SAMPLE');
  assert.equal(doc.provenance.sample, 'true');
  assert.match(String(doc.provenance.source), /SAMPLE-GENERATED/);
  assert.equal(doc.days.length, 14, 'a newcomer gets a full 14-day page, clearly marked as not measured');
  assert.equal(
    JSON.stringify(exportMetrics(sampleTelemetry({ days: 14, seed: 7 }), { sample: true })),
    JSON.stringify(doc),
    'the generator is seeded, so the same seed reproduces the same document',
  );
});

test('the budget guard has teeth, and never names an agent it cannot prove', () => {
  const report = attribute(parseMetrics(METRICS));
  const withCap = checkBudget(report, { capReadsPerDay: 20_000 });
  assert.equal(withCap.ok, false, 'a tighter cap than the tier turns every refused day into a breach');
  assert.ok(withCap.violations.length >= 14);
  assert.ok(withCap.violations.every((v) => v.kind === 'reads'));
  for (const v of withCap.violations) {
    assert.ok(['day', 'window'].includes(v.agent.scope), 'every breach declares how it named the agent');
    if (v.agent.scope === 'day') {
      assert.ok(v.agent.value > 0, 'a day-scoped attribution is backed by reads measured that day');
    } else {
      assert.match(v.reason, /no per-day agent split/, 'and a window-scoped one says the split was not available');
    }
  }
  const atTier = checkBudget(report, {});
  assert.equal(atTier.ok, true, 'sitting exactly on the tier ceiling is not over it');
  assert.equal(atTier.peak.readsPerDay, 50_000);
});

// ------------------------------------------------------------- cc page build

test('the built CC page data agrees with the metrics document', () => {
  const report = attribute(parseMetrics(METRICS));
  assert.equal(CC_DATA.builtFrom, path.join('data', 'cc-fleet-metrics.json'));
  assert.equal(CC_DATA.days.length, report.days.length);
  assert.equal(CC_DATA.totals.storageReads, report.totals.storageReads);
  assert.equal(CC_DATA.quota.readsPerDay, 50_000);
  assert.equal(CC_DATA.atCeiling, report.days.filter((d) => d.storageReads >= 50_000).length);
  assert.ok(CC_DATA.atCeiling >= 14, 'the live fleet sat at the ceiling on at least 14 of the days');
  assert.equal(CC_DATA.attribution.attributedReads, report.agents.reduce((s, a) => s + a.storageReads, 0));
  assert.equal(
    CC_DATA.attribution.attributedReads + CC_DATA.attribution.unattributedReads,
    CC_DATA.totals.storageReads,
  );
  assert.ok(CC_DATA.burnThrough.measured > 0 && CC_DATA.burnThrough.medianMinutes > 0);
  assert.ok(CC_DATA.days.every((d) => d.minutesToExhaust === null || d.minutesToExhaust > 0));
  assert.ok(Object.keys(CC_DATA.provenance).length >= 8, 'every field states how it was produced');
});

test('the committed cc-data.json is exactly what the builder produces today', () => {
  // The same guarantee the main dashboard makes: the page cannot show a number
  // the library would not produce, because the committed file is regenerated and
  // diffed here. Only the build timestamp is allowed to differ.
  const out = path.join(tmpdir(), `cc-data-${process.pid}.json`);
  try {
    execFileSync(
      process.execPath,
      [path.join(root, 'tools', 'build-cc-dashboard.mjs'), path.join(root, 'data', 'cc-fleet-metrics.json'), out],
      { cwd: root },
    );
    const fresh = JSON.parse(readFileSync(out, 'utf8'));
    const strip = (d) => {
      const { builtAt, ...rest } = d;
      return rest;
    };
    assert.deepEqual(strip(fresh), strip(CC_DATA), 'site/cc-data.json has drifted: rerun node tools/build-cc-dashboard.mjs');
  } finally {
    rmSync(out, { force: true });
  }
});

// -------------------------------------------------------------- cc page render

// Runs site/cc-app.js for real against a minimal DOM and a stubbed fetch.
function renderCcPage(data, { failFetch = false } = {}) {
  const nodes = new Map();
  const mk = (id) => ({ id, innerHTML: '', textContent: '', hidden: true });
  const document = {
    getElementById: (id) => (nodes.has(id) ? nodes.get(id) : (nodes.set(id, mk(id)), nodes.get(id))),
  };
  const fetch = async () => {
    if (failFetch) throw new Error('network down');
    return { ok: true, status: 200, json: async () => data };
  };
  const src = readFileSync(path.join(root, 'site', 'cc-app.js'), 'utf8');
  const context = vm.createContext({ document, fetch, console, Math, JSON, Number, String, Object, Array });
  const boot = new vm.Script(`${src}\nboot;`, { filename: 'site/cc-app.js' }).runInContext(context);
  return { nodes, run: () => boot().then(() => new Promise((r) => setTimeout(r, 20))) };
}

const ccHtml = readFileSync(path.join(root, 'cc.html'), 'utf8');

test('the CC page fills every container the app writes to', async () => {
  const { nodes, run } = renderCcPage(CC_DATA);
  await run();
  const app = readFileSync(path.join(root, 'site', 'cc-app.js'), 'utf8');
  const targets = [...new Set([...app.matchAll(/el\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))];
  assert.ok(targets.length >= 8, `the app writes to ${targets.length} containers`);
  for (const id of targets) {
    assert.match(ccHtml, new RegExp(`id="${id}"`), `cc.html has no #${id} for the app to fill`);
    const n = nodes.get(id);
    assert.ok(n, `the page never wrote to #${id}`);
    assert.ok((n.innerHTML || n.textContent).trim().length > 0, `#${id} rendered empty`);
  }
});

test('the CC page shows the ceiling, the cost-equivalent, the attribution and the boot chart', async () => {
  const { nodes, run } = renderCcPage(CC_DATA);
  await run();
  const tiles = nodes.get('tiles').innerHTML;
  assert.match(tiles, /reads \/ day/);
  assert.match(tiles, /50,000-read daily ceiling/);
  assert.match(tiles, /cost-equivalent/);
  assert.match(tiles, /unattributed/);
  assert.match(tiles, /coordinator boots \/ 24h/);
  const all = [...nodes.values()].map((n) => n.innerHTML + n.textContent).join('');
  assert.match(nodes.get('chart-reads').innerHTML, /<svg/, 'reads against the ceiling are an inline svg');
  assert.match(nodes.get('chart-reads').innerHTML, /class="capline"/, 'and the ceiling line is drawn');
  assert.match(nodes.get('chart-boots').innerHTML, /<svg/, 'the 24h boot count is its own chart');
  assert.match(nodes.get('agents').innerHTML, /no agent row claims this/, 'the unattributed remainder is on the page');
  assert.match(nodes.get('agents').innerHTML, /left unattributed rather than split/, 'and it is not dressed up as counted');
  assert.match(nodes.get('notice').innerHTML, /unattributed/);
  assert.match(nodes.get('table-provenance').innerHTML, /LOWER BOUND \(MEASURED\)/);
  // The subtile copy is inserted as trusted HTML, so an entity written by hand
  // would reach the reader verbatim.
  assert.doesNotMatch(nodes.get('tiles').innerHTML, /&#\d+;/, 'no hand-escaped entity is left in a string built in JS');
});

test('the CC page never draws a chart from nothing', async () => {
  const nothing = {
    'no days at all': { dataClass: 'REAL', days: [], agents: [], totals: {}, window: {}, budget: {} },
    'a single zero day': {
      dataClass: 'REAL',
      days: [{ date: '2026-01-01', storageReads: 0, estimatedCostUsd: 0, completedTasks: 0 }],
      agents: [],
      totals: { storageReads: 0 },
      window: {},
      quota: { readsPerDay: 0 },
      budget: {},
    },
    'days with no numbers in them': {
      dataClass: 'REAL',
      days: [{ date: '2026-01-01' }, { date: '2026-01-02' }],
      agents: [{ id: 'x', storageReads: 0 }],
      totals: { storageReads: 0 },
      window: {},
    },
  };
  for (const [name, data] of Object.entries(nothing)) {
    const { nodes, run } = renderCcPage(data);
    await run();
    const all = [...nodes.values()].map((n) => n.innerHTML + n.textContent).join('');
    assert.doesNotMatch(all, /NaN|Infinity|undefined/, `${name} produced broken output`);
    assert.doesNotMatch(nodes.get('chart-reads').innerHTML, /<svg/, `${name} must not draw a chart`);
    assert.doesNotMatch(nodes.get('chart-boots').innerHTML, /<svg/, `${name} must not draw a chart`);
    assert.match(nodes.get('notice').innerHTML, /No data yet/, `${name} must say so explicitly`);
    assert.match(nodes.get('badge-state').textContent, /no data yet/);
  }
});

test('the CC page renders a real number without tripping over the nulls beside it', async () => {
  const { nodes, run } = renderCcPage({
    dataClass: 'REAL',
    days: [
      { date: '2026-01-01', storageReads: 10, minutesToExhaust: null, boots: null, quotaRejections: null },
      { date: '2026-01-02', storageReads: 0, minutesToExhaust: undefined, boots: 0, quotaRejections: 0 },
    ],
    agents: [{ id: 'x', name: 'X', storageReads: null }],
    tasks: [],
    totals: { storageReads: 10, estimatedCostUsd: 0, tasksCompleted: 0, burn: {} },
    attribution: { attributedReads: 0, unattributedReads: 10, agents: [] },
    window: {},
    quota: { readsPerDay: 0 },
    budget: { capReadsPerDay: 0 },
    atCeiling: 0,
  });
  await run();
  const all = [...nodes.values()].map((n) => n.innerHTML + n.textContent).join('');
  assert.doesNotMatch(all, /NaN|Infinity|undefined/, 'a null in one field must not spread to the page');
  assert.match(nodes.get('chart-reads').innerHTML, /<svg/, 'one measured day is still a chart');
  assert.match(nodes.get('table-days').innerHTML, /not measurable/, 'the null field is shown as not measurable');
});

test('the CC page says "no data yet" when the data file will not load', async () => {
  const { nodes, run } = renderCcPage(null, { failFetch: true });
  await run();
  assert.equal(nodes.get('notice').hidden, false);
  assert.match(nodes.get('notice').innerHTML, /No data yet/);
  assert.match(nodes.get('notice').innerHTML, /cc-fleet-telemetry\.mjs/, 'and says how to fix it');
  assert.doesNotMatch(nodes.get('tiles').innerHTML, /NaN/);
  assert.match(nodes.get('badge-dataclass').textContent, /unavailable/);
});

test('the CC page shouts when the dataset is sample-generated, not measured', async () => {
  const sample = JSON.parse(readFileSync(path.join(root, 'site', 'cc-data.json'), 'utf8'));
  sample.dataClass = 'SAMPLE';
  const { nodes, run } = renderCcPage(sample);
  await run();
  assert.match(nodes.get('notice').innerHTML, /SAMPLE-GENERATED data, not a measurement/);
});

test('every relative URL both pages reference resolves to a file that exists', () => {
  // A page can look perfect in a test that stubs fetch and still 404 in
  // production, because a relative URL is resolved against the document, not
  // against the module that uses it. This one hit exactly that: cc.html was
  // written for the site root and then committed into site/, and the data URL
  // resolved to /data.json, which GitHub Pages does not serve. So: resolve each
  // page's references from where the page itself sits, and require the file.
  for (const page of ['index.html', 'cc.html']) {
    const html = readFileSync(path.join(root, page), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 2, `${page} references its assets`);
    for (const ref of refs) {
      const resolved = path.join(root, path.dirname(page), ref);
      assert.ok(existsSync(resolved), `${page} references ${ref}, which resolves to ${path.relative(root, resolved)} — not a file`);
    }
  }

  // And the same for the URL each page fetches, which lives in the module and
  // is resolved against the document.
  for (const [module, page] of [
    ['site/app.js', 'index.html'],
    ['site/cc-app.js', 'cc.html'],
  ]) {
    const src = readFileSync(path.join(root, module), 'utf8');
    const dataUrl = /const DATA_URL = '([^']+)'/.exec(src);
    assert.ok(dataUrl, `${module} declares where it fetches from`);
    const resolved = path.join(root, path.dirname(page), dataUrl[1]);
    assert.ok(existsSync(resolved), `${module} fetches ${dataUrl[1]}, which from ${page} resolves to a missing file`);
    assert.doesNotMatch(dataUrl[1], /^\//, `${module} must not use a root-absolute path: the site is served from a subpath`);
  }
});

test('the CC page carries no cookie, no analytics and no login', () => {
  for (const banned of [/googletagmanager/i, /gtag\(/i, /plausible/i, /segment\.io/i, /hotjar/i, /set-cookie/i, /<form/i]) {
    assert.doesNotMatch(ccHtml, banned, `the page must not ship ${banned}`);
  }
  assert.match(ccHtml, /no cookies/);
  assert.match(ccHtml, /no analytics/);
  assert.match(ccHtml, /no login/);
});

test('nothing in the public tree leaks a host, an address or a credential', () => {
  const files = [
    'data/cc-fleet-telemetry.json',
    'data/cc-fleet-metrics.json',
    'site/cc-data.json',
    'cc.html',
    'site/cc-app.js',
    'tools/cc-fleet-telemetry.mjs',
    'tools/export-cc-fleet.mjs',
    'tools/build-cc-dashboard.mjs',
  ];
  for (const f of files) {
    const text = readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(text, /ghp_|github_pat_|AIza|-----BEGIN|\.env\b/i, `${f} looks like it carries a credential`);
    assert.doesNotMatch(text, /\b\d{1,3}(\.\d{1,3}){3}\b/, `${f} carries an IP address`);
    assert.doesNotMatch(text, /firebaseio\.com|gen-lang-client|project_number:\d+/i, `${f} carries a project id`);
    assert.doesNotMatch(text, /\/home\/[a-z]/i, `${f} carries a local path`);
  }
});
