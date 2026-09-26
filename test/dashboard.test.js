import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Runs site/app.js for real: the module's own boot() executes against a minimal
// DOM and a stubbed fetch, so the page's render path is exercised rather than
// only syntax-checked. Returns the nodes it wrote plus the raw module source.
function renderPage({ failFetch = false } = {}) {
  const nodes = new Map();
  const mk = (id) => ({ id, innerHTML: '', textContent: '', hidden: true });
  const document = {
    getElementById: (id) => (nodes.has(id) ? nodes.get(id) : (nodes.set(id, mk(id)), nodes.get(id))),
  };
  const fetch = async () => {
    if (failFetch) throw new Error('network down');
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(readFileSync(path.join(root, 'site', 'data.json'), 'utf8')),
    };
  };
  const src = readFileSync(path.join(root, 'site', 'app.js'), 'utf8');
  const context = vm.createContext({ document, fetch, console, Math, JSON, Number, String, Object, Array });
  const boot = new vm.Script(`${src}\nboot;`, { filename: 'site/app.js' }).runInContext(context);
  return { nodes, run: () => boot().then(() => new Promise((r) => setTimeout(r, 20))) };
}

const html = readFileSync(path.join(root, 'index.html'), 'utf8');

test('the page renders every container it declares an id for', async () => {
  const { nodes, run } = renderPage();
  await run();
  const containers = [...html.matchAll(/id="((?:cpo|cpo-tasks|table-|badge|foot-|chart-|burn-|legend|agents|verdict|meta|window)[a-z0-9-]*)"/g)].map((m) => m[1]);
  assert.ok(containers.length >= 10, 'the page has containers to fill');
  for (const id of containers) {
    const n = nodes.get(id);
    assert.ok(n, `the page never wrote to #${id}, so the element is dead weight`);
    assert.ok(
      (n.innerHTML || n.textContent).trim().length > 0,
      `#${id} rendered empty; the dashboard would show a blank panel`,
    );
  }
});

test('the error banner stays empty on a healthy load and says so when data will not load', async () => {
  const ok = renderPage();
  await ok.run();
  assert.equal(ok.nodes.get('notice').hidden, true, 'no scary banner on a good load');
  assert.equal(ok.nodes.get('notice').innerHTML, '');

  const bad = renderPage({ failFetch: true });
  await bad.run();
  assert.equal(bad.nodes.get('notice').hidden, false, 'a failed load must be visible, not a confident empty dashboard');
  assert.match(bad.nodes.get('notice').innerHTML, /Could not load/);
  assert.match(bad.nodes.get('notice').innerHTML, /build-dashboard\.mjs/, 'and it tells the reader how to fix it');
  assert.match(bad.nodes.get('badge-dataclass').textContent, /unavailable/);
});

test('the burn chart plots reads as columns and estimated USD as a line, on two axes', async () => {
  const { nodes, run } = renderPage();
  await run();
  const svg = nodes.get('chart-burn').innerHTML;
  assert.match(svg, /<svg/, 'an inline svg, no chart library');
  assert.match(svg, /class="bar/, 'reads are columns');
  assert.match(svg, /class="cost-line"/, 'USD is a line');
  assert.match(svg, /class="dot"/, 'with a point per day to hover');
  assert.match(svg, /axis-right/, 'on its own right-hand axis');
  assert.match(svg, /class="capline"/, 'and the cap line is drawn');
  assert.match(nodes.get('legend').innerHTML, /k-cost/, 'the legend names the cost series');
  assert.match(nodes.get('burn-hint').textContent, /estimated USD/);
});

test('the chart geometry is real numbers, not NaN from an empty or one-day window', async () => {
  for (const file of ['fleet-sample.json', 'incident-pre-fix-reconstruction.json']) {
    const { nodes, run } = renderPage();
    await run();
    const svg = nodes.get('chart-burn').innerHTML;
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/, `${file} produced broken chart geometry`);
  }
});

test('the dashboard ranks delivered tasks by cost per outcome', async () => {
  const { nodes, run } = renderPage();
  await run();
  const rows = (nodes.get('cpo-tasks').innerHTML.match(/<tr>/g) || []).length;
  assert.ok(rows > 1, `the cost-per-outcome task table is empty (${rows} rows)`);
  assert.match(html, /Worst cost-per-outcome tasks/);
  assert.match(html, /cpo-tasks/);
  assert.match(
    html,
    /no outcome to divide by/,
    'the page has to explain why undelivered work is not ranked',
  );
});

test('nothing unescaped from the data reaches the page as markup', async () => {
  const { nodes, run } = renderPage();
  await run();
  const all = [...nodes.values()].map((n) => n.innerHTML + n.textContent).join('');
  assert.doesNotMatch(all, /<script/i, 'no script tag could ever be injected from data');
  assert.doesNotMatch(all, /onerror=|onload=|javascript:/i);
});

test('every shipped module loads, and the package publishes what it needs', async () => {
  const files = readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 4, 'the library is more than one file');
  for (const f of files) {
    const mod = await import(path.join(root, 'lib', f));
    assert.ok(Object.keys(mod).length > 0, `lib/${f} exports nothing`);
  }
  await import(path.join(root, 'index.js'));

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {}, 'no runtime dependencies, which is the whole point');
  assert.deepEqual(pkg.devDependencies, {}, 'and no dev dependencies to install before you can test');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.bin && pkg.bin['fleet-burn'], 'it installs a command');
  assert.ok(pkg.files.includes('lib'), 'and ships the library');
  assert.ok(pkg.files.includes('data'), 'and the sample, so --sample works from an install');
});
