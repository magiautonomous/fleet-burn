import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readMetricsFile } from '../lib/parse.js';
import { attribute } from '../lib/attribute.js';
import { checkBudget } from '../lib/budget.js';
import { renderReport, renderBudget, rule } from '../lib/report.js';
import { twoDayFleet, inCapsFleet } from './fixtures.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');

test('the report names the data class, so REAL and SYNTHETIC can never be confused', () => {
  assert.match(renderReport(attribute(twoDayFleet())), /\[SYNTHETIC data\]/);
  assert.match(
    renderReport(attribute(readMetricsFile(path.join(dataDir, 'fleet-sample.json')))),
    /\[REAL data\]/,
  );
});

test('the report states the window, the totals and the burn rate', () => {
  const out = renderReport(attribute(twoDayFleet()));
  assert.match(out, /window {3}2026-09-01 \.\. 2026-09-02/);
  assert.match(out, /^totals {3}/m);
  assert.match(out, /^burn {5}/m);
  assert.match(out, /5,100 reads/);
});

test('the cost breakdown appears and the three terms add up to the total', () => {
  const r = attribute(twoDayFleet());
  const out = renderReport(r);
  assert.match(out, /^cost {5}storage/m);
  const parts = r.totals.costBreakdown;
  assert.ok(
    Math.abs(parts.storageUsd + parts.llmUsd + parts.tokenUsd - r.totals.estimatedCostUsd) < 1e-6,
    'the printed breakdown is the same arithmetic the total came from',
  );
});

test('cost per outcome is printed when the document reports completions', () => {
  assert.match(renderReport(attribute(twoDayFleet())), /\$1\.\d+ per completed task/);
  assert.match(renderReport(attribute(readMetricsFile(path.join(dataDir, 'fleet-sample.json')))), /per completed task/);
});

test('cost per outcome is omitted, not zeroed, when no completions are reported', () => {
  const m = readMetricsFile(path.join(dataDir, 'fleet-sample.json'));
  const stripped = { ...m, totals: { ...m.totals, tasksCompleted: 0 } };
  const out = renderReport(attribute(stripped));
  assert.doesNotMatch(out, /per completed task/);
  assert.doesNotMatch(out, /per completed task/, 'a zero denominator must not print $0.00');
});

test('every leaderboard is sorted descending by the number in its heading', () => {
  // Deliberately hand the report its tasks in a scrambled order: a top-N table
  // that slices the input instead of a ranking is sorted-looking until the
  // input happens to arrive pre-sorted, which is exactly when it ships.
  const m = readMetricsFile(path.join(dataDir, 'fleet-sample.json'));
  const scrambled = { ...m, tasks: [...m.tasks].reverse() };
  const a = attribute(scrambled);
  const b = attribute(m);
  assert.notDeepEqual(
    a.tasks.map((t) => t.id),
    b.tasks.map((t) => t.id),
    'the fixture really was reversed',
  );
  const out = renderReport(a, { top: 10 });
  const block = out.slice(out.indexOf('tasks by cost'), out.indexOf('tasks by reads'));
  const costs = [...block.matchAll(/\$\s*([\d,]+\.\d\d)/g)].map((m2) => Number(m2[1].replace(/,/g, '')));
  assert.ok(costs.length > 1, 'the block has rows to compare');
  for (let i = 1; i < costs.length; i++) {
    assert.ok(costs[i] <= costs[i - 1], `row ${i} costs ${costs[i]} but row ${i - 1} cost ${costs[i - 1]}`);
  }
  const readBlock = out.slice(out.indexOf('tasks by reads'), out.indexOf('worst cost-per-outcome tasks'));
  const reads = [...readBlock.matchAll(/^\s+\d+\.\s+([\d,]+)\s+reads/gm)].map((m2) => Number(m2[1].replace(/,/g, '')));
  for (let i = 1; i < reads.length; i++) {
    assert.ok(reads[i] <= reads[i - 1], `reads row ${i} is ${reads[i]} but row ${i - 1} is ${reads[i - 1]}`);
  }
});

test('all four leaderboards are present with their headings', () => {
  const out = renderReport(attribute(twoDayFleet()));
  assert.match(out, /agents by cost/);
  assert.match(out, /tasks by cost/);
  assert.match(out, /tasks by reads/);
  assert.match(out, /worst cost-per-outcome days/);
  assert.match(out, /daily burn/);
});

test('the daily burn table has one row per day plus a header', () => {
  const out = renderReport(attribute(twoDayFleet()));
  const rows = out.split('\n').filter((l) => /^ {2}\d{4}-\d{2}-\d{2} {2,}/.test(l));
  assert.equal(rows.length, 2);
});

test('a day over the cap is marked OVER in the daily table', () => {
  const r = attribute(twoDayFleet());
  const out = renderReport(r, { budget: checkBudget(r) });
  assert.match(out, /2026-09-02.*OVER/);
  assert.doesNotMatch(out, /2026-09-01.*OVER/);
});

test('a fleet with no agents or tasks still renders without crashing', () => {
  const out = renderReport(
    attribute(readMetricsFile(path.join(dataDir, 'fleet-sample.json'))),
  );
  assert.ok(out.length > 100);
  assert.match(out, /daily burn/);
});

test('--all adds a full task table containing every task id', () => {
  const r = attribute(twoDayFleet());
  const plain = renderReport(r);
  const all = renderReport(r, { verbose: true });
  assert.doesNotMatch(plain, /all 3 tasks/);
  assert.match(all, /all 3 tasks/);
  for (const t of r.tasks) assert.ok(all.includes(t.id), `verbose table is missing ${t.id}`);
});

test('--top limits each leaderboard to N rows', () => {
  const block = (top) => {
    const out = renderReport(attribute(twoDayFleet()), { top });
    const after = out.slice(out.indexOf('agents by cost'));
    const end = after.indexOf('tasks by cost');
    return after.slice(0, end).split('\n').filter((l) => /^\s+\d+\. /.test(l));
  };
  assert.equal(block(1).length, 1);
  assert.equal(block(2).length, 2);
  assert.equal(block(3).length, 3);
  assert.equal(block(99).length, 3, 'never more rows than there are agents');
});

test('the budget section reports OK, the caps and the peak', () => {
  const r = attribute(inCapsFleet());
  const out = renderBudget(checkBudget(r));
  assert.match(out, /caps {4}reads\/day <= 10,000/);
  assert.match(out, /peak {4}120 reads\/day/);
  assert.match(out, /status  OK/);
});

test('the budget section reports a breach with agent, task and a why line', () => {
  const r = attribute(twoDayFleet());
  const out = renderBudget(checkBudget(r));
  assert.match(out, /status  BREACH - 1 capped day\(s\) over budget/);
  assert.match(out, /\[READS CAP\] 2026-09-02/);
  assert.match(out, /agent {3}Alpha/);
  assert.match(out, /task {4}"the fat query"/);
  assert.match(out, /why {5}agent Alpha blew the reads cap on 2026-09-02/);
  assert.match(out, /over by 4,000 \(5\.00x\)/);
});

test('the budget section says OK when a generous cap is set', () => {
  const out = renderBudget(checkBudget(attribute(twoDayFleet()), { capReadsPerDay: 1e9, capUsdPerDay: 1e9 }));
  assert.match(out, /status  OK - every capped day is inside its cap/);
});

test('the budget section says so when there is nothing at all to enforce', () => {
  const uncapped = attribute(readMetricsFile(path.join(dataDir, 'fleet-sample.json')));
  uncapped.budget = { capReadsPerDay: null, capUsdPerDay: null, capLlmCallsPerDay: null };
  const out = renderBudget(checkBudget(uncapped, {}));
  assert.match(out, /caps {4}none set/);
  assert.match(out, /no caps to check/);
});

test('the report contains no ANSI escapes and no tabs, so a CI log stays greppable', () => {
  const out = renderReport(attribute(twoDayFleet()), { budget: checkBudget(attribute(twoDayFleet())) });
  assert.doesNotMatch(out, /\u001b/, 'no escape sequences');
  assert.doesNotMatch(out, /\t/, 'no tabs');
});

test('every rendered line fits a sane terminal width for a long agent name', () => {
  const wide = renderReport(
    attribute(
      readMetricsFile(path.join(dataDir, 'fleet-sample.json')),
    ),
  );
  for (const line of wide.split('\n')) {
    assert.ok(line.length < 200, `line too long (${line.length}): ${line.slice(0, 80)}`);
  }
});

test('rule() produces a plain dashed rule of the requested width', () => {
  assert.equal(rule(10), '----------');
  assert.equal(rule(3), '---');
});

test('the committed dashboard data matches what the library computes, byte for byte', () => {
  const siteData = path.join(root, 'site', 'data.json');
  assert.ok(existsSync(siteData), 'site/data.json is committed');
  const committed = JSON.parse(readFileSync(siteData, 'utf8'));

  const metrics = readMetricsFile(path.join(dataDir, 'fleet-sample.json'));
  const report = attribute(metrics);
  const budget = checkBudget(report, {});

  assert.equal(committed.dataClass, report.dataClass);
  assert.equal(committed.fleet, report.fleet);
  assert.equal(committed.totals.storageReads, report.totals.storageReads);
  assert.equal(committed.totals.llmCalls, report.totals.llmCalls);
  assert.equal(committed.totals.tokensTotal, report.totals.tokensTotal);
  assert.equal(committed.totals.estimatedCostUsd, report.totals.estimatedCostUsd);
  assert.equal(committed.totals.costPerOutcome, report.totals.costPerOutcome);
  assert.equal(committed.days.length, report.days.length);
  assert.equal(committed.tasks.length, report.tasks.length);
  assert.equal(committed.agents.length, report.agents.length);
  assert.equal(committed.budget.ok, budget.ok);
  assert.deepEqual(committed.budget.caps, budget.caps);
  for (let i = 0; i < committed.days.length; i++) {
    assert.equal(committed.days[i].date, report.days[i].date, `day ${i} date drifted`);
    assert.equal(committed.days[i].storageReads, report.days[i].storageReads, `day ${i} reads drifted`);
    assert.equal(committed.days[i].estimatedCostUsd, report.days[i].estimatedCostUsd, `day ${i} cost drifted`);
  }
});

test('the dashboard page fetches the committed data file and nothing else at runtime', () => {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /site\/app\.js/, 'the page loads the module');
  assert.match(html, /site\/styles\.css/);
  const js = readFileSync(path.join(root, 'site', 'app.js'), 'utf8');
  const fetches = [...js.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetches, ["DATA_URL"], 'exactly one fetch, through the DATA_URL constant');
  assert.match(js, /const DATA_URL = 'data\.json'/, 'and it is the committed local file');
  const urls = [...(html + js).matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
  for (const u of urls) {
    assert.ok(
      u === 'https://magiautonomous.github.io/fleet-burn/' ||
        u.startsWith('https://github.com/magiautonomous/fleet-burn') ||
        u.includes('w3.org'),
      `the page must not call out to ${u}`,
    );
  }
});

test('the dashboard imports nothing', () => {
  const js = readFileSync(path.join(root, 'site', 'app.js'), 'utf8');
  assert.doesNotMatch(js, /^\s*import\s/m, 'no imports at all');
  assert.doesNotMatch(js, /require\(/, 'and nothing required');
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="site\/app\.js">/, 'loaded as a module for async/await');
});

test('the page ships its own honesty banner logic for synthetic data', () => {
  const js = readFileSync(path.join(root, 'site', 'app.js'), 'utf8');
  assert.match(js, /dataClass !== 'REAL'/, 'synthetic data gets a visible warning');
  assert.match(js, /This page is showing SYNTHETIC data/);
  assert.match(js, /coverage/, 'and a coverage warning is wired up');
});
