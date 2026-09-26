import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { run, parseArgs, UsageError, USAGE } from '../bin/cli.js';
import { EXIT_OK, EXIT_BREACH, EXIT_USAGE } from '../lib/budget.js';
import { twoDayFleet, inCapsFleet } from './fixtures.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'bin', 'fleet-burn.js');
const SAMPLE = path.join(root, 'data', 'fleet-sample.json');
const INCIDENT = path.join(root, 'data', 'incident-pre-fix-reconstruction.json');

const tmp = mkdtempSync(path.join(tmpdir(), 'fleet-burn-'));
const tmpFile = (name, obj) => {
  const p = path.join(tmp, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};
const doc = (m) => JSON.parse(JSON.stringify({ schema: 'fleet-burn/metrics@1', ...m }));

// A real process spawn, so the exit code under test is the shell's exit code
// and not a value our own code handed back to itself.
function spawn(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', ...opts });
    return { code: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

test('--help prints usage and exits 0', () => {
  const r = spawn(['--help']);
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /fleet-burn - cost and usage meter for agent fleets/);
  assert.match(r.stdout, /--cap-reads-per-day/);
});

test('no arguments at all is a usage error, not a crash', () => {
  const r = spawn([]);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /need a metrics file/);
});

test('an unknown flag is a usage error naming the flag', () => {
  const r = spawn(['--nope', SAMPLE]);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /unknown flag --nope/);
});

test('a missing file exits 2 and does not print a stack trace', () => {
  const r = spawn(['/nope/missing.json']);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /cannot read metrics file/);
  assert.doesNotMatch(r.stderr, /at Object|at Module/);
});

test('invalid JSON exits 2', () => {
  const p = path.join(tmp, 'broken.json');
  writeFileSync(p, '{not json');
  const r = spawn([p]);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /not valid JSON/);
});

test('a document with a bad day key exits 2 and names the field', () => {
  const p = tmpFile('badday.json', { days: [{ date: 'yesterday' }] });
  const r = spawn([p]);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /days\[0\]\.date/);
});

test('the real sample runs clean under its own documented caps and exits 0', () => {
  const r = spawn([SAMPLE]);
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /REAL data/);
  assert.match(r.stdout, /budget guard/);
  assert.match(r.stdout, /status  OK/);
});

test('--sample reads the bundled real sample', () => {
  const a = spawn(['--sample']);
  const b = spawn([SAMPLE]);
  assert.equal(a.code, EXIT_OK);
  assert.equal(a.stdout, b.stdout);
});

test('the incident replay exits 1 under a 50,000-read cap', () => {
  const r = spawn([INCIDENT, '--cap-reads-per-day', '50000']);
  assert.equal(r.code, EXIT_BREACH);
  assert.match(r.stdout, /status  BREACH/);
});

test('the breach names the agent and the task on stderr as well as stdout', () => {
  const r = spawn([INCIDENT, '--cap-reads-per-day', '50000']);
  assert.match(r.stderr, /BUDGET BREACH/);
  assert.match(r.stderr, /agent Casper/);
  assert.match(r.stderr, /board poll/);
  assert.match(r.stderr, /inc-board-poll-history/);
  assert.match(r.stdout, /\[READS CAP\] 2026-09-15/);
  assert.match(r.stdout, /agent   Casper/);
});

test('the same replay passes when the cap is raised above the replay burn', () => {
  const r = spawn([INCIDENT, '--cap-reads-per-day', '500000']);
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /status  OK/);
});

test('--cap-usd-per-day fires on a token-heavy day and names the agent', () => {
  const p = tmpFile('usd.json', doc({
    days: [{ date: '2026-09-01', tokensOut: 20_000_000 }],
    agents: [{ id: 'alpha', name: 'Alpha', tokensOut: 20_000_000 }],
    tasks: [{ id: 'BIG', title: 'the big one', agent: 'alpha', tokensOut: 20_000_000, startedAt: '2026-09-01T00:00:00Z' }],
  }));
  const r = spawn([p, '--cap-usd-per-day', '10']);
  assert.equal(r.code, EXIT_BREACH);
  assert.match(r.stdout, /\[USD CAP\] 2026-09-01/);
  assert.match(r.stdout, /agent   Alpha/);
  assert.match(r.stdout, /the big one/);
});

test('--cap-llm-calls-per-day fires and prints the calls cap', () => {
  const p = tmpFile('calls.json', doc({ days: [{ date: '2026-09-01', llmCalls: 900 }] }));
  const r = spawn([p, '--cap-llm-calls-per-day', '100']);
  assert.equal(r.code, EXIT_BREACH);
  assert.match(r.stdout, /llm calls\/day <= 100/);
  assert.match(r.stdout, /\[LLMCALLS CAP\]/);
});

test('reading from stdin with - works', () => {
  const p = tmpFile('in.json', doc({ days: [{ date: '2026-09-01', storageReads: 7 }] }));
  const r = spawn(['-'], { input: readFileSync(p, 'utf8') });
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /7 reads/);
});

test('--json emits the report and the budget result as parseable JSON', () => {
  const r = spawn([SAMPLE, '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.report.totals, 'the report is there');
  assert.ok(parsed.budget, 'the budget verdict is there');
  assert.equal(typeof parsed.report.coverage, 'number');
  assert.ok(Array.isArray(parsed.report.agents));
  assert.ok(parsed.report.agents.every((a) => a.byDay !== undefined), 'per-day splits survive serialisation');
});

test('--budget-only prints the verdict and nothing else', () => {
  const r = spawn([INCIDENT, '--cap-reads-per-day', '50000', '--budget-only']);
  const lines = r.stdout.split('\n').filter((l) => l.trim());
  assert.equal(lines[0], 'budget guard');
  assert.ok(!r.stdout.includes('agents by cost'));
});

test('--top limits the leaderboards', () => {
  const wide = spawn([SAMPLE, '--top', '40']);
  const narrow = spawn([SAMPLE, '--top', '2']);
  const count = (r) => (r.stdout.match(/^agents by cost  \(top (\d+)\)/m) || [])[1];
  assert.equal(count(wide), '40');
  assert.equal(count(narrow), '2');
  assert.ok(wide.stdout.length > narrow.stdout.length);
});

test('--all prints every task, not just the leaderboard', () => {
  const r = spawn([SAMPLE, '--all']);
  const m = r.stdout.match(/^all \d+ tasks$/m);
  assert.ok(m, 'the verbose task table is present');
  assert.equal(Number(m[0].split(' ')[1]), JSON.parse(readFileSync(SAMPLE, 'utf8')).tasks.length);
});

test('--no-color is accepted and changes nothing', () => {
  const plain = spawn([SAMPLE]);
  const noColor = spawn([SAMPLE, '--no-color']);
  assert.equal(noColor.code, EXIT_OK);
  assert.equal(noColor.stdout, plain.stdout);
  assert.doesNotMatch(plain.stdout, /\\u001b\[/, 'no ANSI escapes anywhere in the output');
});

test('price flags change the reported cost', () => {
  const cheap = spawn([SAMPLE, '--price-out-per-m', '1']);
  const dear = spawn([SAMPLE, '--price-out-per-m', '100']);
  const usd = (r) => {
    const m = r.stdout.match(/^totals .*?\| (\$[\d.]+)$/m);
    assert.ok(m, `no total in:\n${r.stdout.slice(0, 400)}`);
    return Number(m[1].slice(1));
  };
  assert.ok(Number.isFinite(usd(dear)) && Number.isFinite(usd(cheap)), 'both runs print a total');
  assert.ok(usd(dear) > usd(cheap), `${usd(dear)} should exceed ${usd(cheap)}`);
});

test('a negative price flag is a usage error', () => {
  const r = spawn([SAMPLE, '--price-out-per-m', '-5']);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /non-negative/);
});

test('a non-numeric --top is a usage error', () => {
  const r = spawn([SAMPLE, '--top', 'lots']);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /--top must be a positive number/);
});

test('a cap flag that needs a value says so', () => {
  const r = spawn([SAMPLE, '--cap-reads-per-day']);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /needs a value/);
});

test('two files at once is a usage error', () => {
  const r = spawn([SAMPLE, SAMPLE]);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /unexpected argument/);
});

test('in-process run() returns the same verdict the shell sees', () => {
  let out = '';
  let err = '';
  const p = tmpFile('ip.json', doc({ days: [{ date: '2026-09-01', storageReads: 5000 }] }));
  const r = run([p, '--cap-reads-per-day', '1000'], { stdout: (s) => (out += s), stderr: (s) => (err += s) });
  assert.equal(r.code, EXIT_BREACH);
  assert.match(out, /status  BREACH/);
  assert.match(err, /BUDGET BREACH/);
  assert.ok(r.report && r.budget, 'run() hands back the report and the verdict for programmatic use');
  const ok = run([tmpFile('ip2.json', doc(JSON.parse(JSON.stringify(inCapsFleet()))))], {
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(ok.code, EXIT_OK);
  void twoDayFleet;
});

test('parseArgs is pure: it does not touch the environment or the filesystem', () => {
  const a = parseArgs([SAMPLE, '--cap-usd-per-day', '3', '--top', '4']);
  const b = parseArgs([SAMPLE, '--cap-usd-per-day', '3', '--top', '4']);
  assert.deepEqual(a, b);
  assert.equal(a.capUsdPerDay, 3);
  assert.equal(a.top, 4);
});

test('parseArgs throws UsageError, not a bare Error', () => {
  let caught = null;
  try {
    parseArgs(['--bogus']);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof UsageError, `got ${caught && caught.name}`);
});

test('USAGE documents both cap flags this product promises', () => {
  assert.match(USAGE, /--cap-reads-per-day/);
  assert.match(USAGE, /--cap-usd-per-day/);
  assert.match(USAGE, /exit codes/);
});
