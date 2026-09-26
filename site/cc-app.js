// The CC fleet burn page. Same rules as the main dashboard: no framework, no
// build step, no dependency, and every number comes from a JSON file produced
// by running the real library over the committed metrics document. This file
// formats; it computes no costs of its own.
//
// The one thing it is careful about is a bad dataset. A page that is quietly
// empty, or that draws a chart from a division by zero, is worse than a page
// that says "no data yet" — so zero days, missing fields and a failed fetch all
// land in the same explicit state, and no path in here can emit NaN.

// Resolved against the document (cc.html at the site root), not this module, so
// the path has to name site/ explicitly. A bare "cc-data.json" would ask for
// /cc-data.json and 404 — which is exactly what it did before a test said so.
const DATA_URL = 'site/cc-data.json';
const el = (id) => document.getElementById(id);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const int = (v) => Math.round(num(v)).toLocaleString('en-US');
const usd = (v) => {
  const n = num(v);
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
};
const pct = (v, places = 2) => (Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(places)}%` : '—');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ratio = (a, b) => (Number(b) > 0 ? Number(a) / Number(b) : null);

function hasNumbers(d) {
  return Array.isArray(d.days) && d.days.some((x) => num(x.storageReads) > 0 || num(x.completedTasks) > 0);
}

// ------------------------------------------------------------------ no data
function renderNoData(reason) {
  el('notice').hidden = false;
  el('notice').innerHTML =
    `<b>No data yet.</b> ${esc(reason)} Nothing below is a measurement, so nothing below is drawn. ` +
    'Point the exporter at a fleet and rebuild: <code>node tools/cc-fleet-telemetry.mjs &lt;log&gt; ' +
    '--out data/cc-fleet-telemetry.json &amp;&amp; node tools/export-cc-fleet.mjs ' +
    '--telemetry data/cc-fleet-telemetry.json --out data/cc-fleet-metrics.json &amp;&amp; ' +
    'node tools/build-cc-dashboard.mjs</code>.';
  el('badge-state').textContent = 'no data yet';
  el('tiles').innerHTML = '<p class="hint">no data yet — every tile on this page needs at least one measured day.</p>';
  for (const id of ['chart-reads', 'chart-boots']) {
    el(id).innerHTML = '<p class="hint">no data yet — no chart is drawn from an empty dataset.</p>';
  }
  for (const id of ['legend', 'reads-hint', 'boots-hint']) el(id).textContent = '';
  for (const id of ['table-days', 'table-provenance']) {
    el(id).innerHTML = '<tbody><tr><td class="hint">no data yet</td></tr></tbody>';
  }
  el('agents').innerHTML = '<p class="hint">no data yet — no agent telemetry to attribute.</p>';
}

// -------------------------------------------------------------------- tiles
function tile(label, value, sub, state = '') {
  return (
    `<div class="tile${state ? ` ${state}` : ''}"><div class="tile-label">${esc(label)}</div>` +
    `<div class="tile-value">${esc(value)}</div><div class="tile-sub">${sub || ''}</div></div>`
  );
}

function renderTiles(d) {
  const cap = num(d.quota?.readsPerDay);
  const perDay = num(d.totals?.burn?.readsPerDay);
  const ceilingShare = ratio(perDay, cap);
  const atCap = num(d.atCeiling);
  const of = d.days.length;
  const attributed = num(d.attribution?.attributedReads);
  const fleet = num(d.totals?.storageReads);
  const boots = d.days.map((x) => num(x.boots));
  const bt = d.burnThrough || {};

  el('tiles').innerHTML = [
    tile(
      'reads / day',
      int(perDay),
      `against a hard ${int(cap)}-read daily ceiling${ceilingShare === null ? '' : ` · ${pct(ceilingShare, 1)} of it`}`,
      ceilingShare !== null && ceilingShare >= 1 ? 'alarm' : '',
    ),
    tile(
      'days at the ceiling',
      `${int(atCap)}/${int(of)}`,
      "days the database refused the fleet's reads",
      atCap > 0 ? 'alarm' : '',
    ),
    tile('cost-equivalent', `${usd(d.totals?.burn?.usdPerDay)}/day`, `${usd(d.totals?.estimatedCostUsd)} over the window · list price, the tier itself is $0`),
    tile(
      'unattributed',
      pct(ratio(fleet - attributed, fleet)),
      `${int(fleet - attributed)} of ${int(fleet)} reads no agent row claims`,
    ),
    tile(
      'coordinator boots / 24h',
      `${int(boots.length ? Math.max(...boots) : 0)} peak`,
      `${int(boots.reduce((a, b) => a + b, 0))} in the window · every boot re-mirrors fleet state`,
    ),
    tile(
      'minutes to exhaust the daily quota',
      bt.medianMinutes === null || bt.medianMinutes === undefined ? '—' : `${num(bt.medianMinutes).toFixed(0)} min`,
      bt.measured
        ? `median of ${int(bt.measured)} measured day(s) · range ${num(bt.minMinutes).toFixed(0)}–${num(bt.maxMinutes).toFixed(0)}`
        : 'not measurable in this window',
    ),
  ].join('');
}

// ------------------------------------------------------------------- charts
// A shared column-chart builder. Both charts on this page are "one number per
// day", so they share the geometry and differ only in what they draw — and the
// scale is floored at 1 so a day of zeroes cannot divide by zero.
function columns({ days, value, cap = 0, height = 220, format, title, cls = '' }) {
  const W = 960;
  const H = height;
  const padL = 56;
  const padB = 26;
  const padT = 14;
  const plotW = W - padL - 10;
  const plotH = H - padB - padT;
  const max = Math.max(1, cap, ...days.map((d) => num(value(d))));
  const bw = plotW / Math.max(1, days.length);

  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = padT + plotH - f * plotH;
      return (
        `<line class="grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - 10}" y2="${y.toFixed(1)}"/>` +
        `<text class="axis" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${format(max * f)}</text>`
      );
    })
    .join('');

  const bars = days
    .map((d, i) => {
      const v = num(value(d));
      const h = Math.max(0, (v / max) * plotH);
      const x0 = padL + i * bw + bw * 0.18;
      const w = bw * 0.64;
      const y = padT + plotH - h;
      const over = cap > 0 && v > cap;
      const at = cap > 0 && v === cap;
      return (
        `<g class="bar${over ? ' over' : at ? ' at' : ''}"><title>${esc(title(d, v))}</title>` +
        `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>` +
        (i % Math.ceil(days.length / 15) === 0
          ? `<text class="tick" x="${(x0 + w / 2).toFixed(1)}" y="${(padT + plotH + 13).toFixed(1)}" text-anchor="middle">${esc(String(d.date).slice(5))}</text>`
          : '') +
        '</g>'
      );
    })
    .join('');

  const capLine =
    cap > 0
      ? `<line class="capline" x1="${padL}" y1="${(padT + plotH - (Math.min(1, cap / max) * plotH)).toFixed(1)}" x2="${W - 10}" y2="${(padT + plotH - (Math.min(1, cap / max) * plotH)).toFixed(1)}"/>` +
        `<text class="caplabel" x="${W - 12}" y="${(padT + plotH - (Math.min(1, cap / max) * plotH) - 5).toFixed(1)}" text-anchor="end">ceiling ${format(cap)}</text>`
      : '';

  return (
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" width="100%">` +
    ticks +
    `<line class="axis-line" x1="${padL}" y1="${padT + plotH}" x2="${W - 10}" y2="${padT + plotH}"/>` +
    capLine +
    bars +
    '</svg>'
  );
}

function renderReadsChart(d) {
  const cap = num(d.quota?.readsPerDay);
  el('chart-reads').innerHTML = columns({
    days: d.days,
    cap,
    value: (x) => x.storageReads,
    format: int,
    title: (x, v) =>
      `${x.date}: ${int(v)} reads recorded, ${usd(x.estimatedCostUsd)} cost-equivalent, ` +
      `${int(x.quotaRejections)} operations refused, ${int(x.completedTasks)} task(s) completed`,
  });
  el('legend').innerHTML =
    '<span class="key"><i class="k-bar"></i>reads recorded</span>' +
    '<span class="key"><i class="k-cap"></i>daily ceiling</span>' +
    '<span class="key"><i class="k-at"></i>at the ceiling</span>';
  el('reads-hint').textContent =
    'One column per daily read budget, from the daily reset. A column at the ceiling is a day the ' +
    'database refused the fleet’s reads, so the real number is at least that; a column below it is a ' +
    'day nothing was refused and the column is what the exporting host actually counted.';
}

function renderBootsChart(d) {
  el('chart-boots').innerHTML = columns({
    days: d.days,
    value: (x) => x.boots,
    format: int,
    height: 200,
    title: (x, v) => `${x.date}: ${int(v)} coordinator boot(s)`,
  });
  el('boots-hint').textContent =
    'Coordinator process starts per 24h, counted from the log line each boot writes when it registers. ' +
    'This is the number a read meter exists to explain: a boot re-reads fleet state, so a bad restart loop ' +
    'is a read bill, and a day of zeroes is a day the coordinator stayed up.';
}

// ------------------------------------------------------------------- tables
function table(id, head, rows, empty) {
  if (!rows.length) {
    el(id).innerHTML = `<tbody><tr><td class="hint">${esc(empty)}</td></tr></tbody>`;
    return;
  }
  el(id).innerHTML =
    `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
    '</tbody>';
}

function renderDays(d) {
  const cap = num(d.quota?.readsPerDay);
  table(
    'table-days',
    ['budget day', 'reads recorded', 'of ceiling', 'cost-equiv.', 'ops refused', 'boots', 'min to exhaust', 'log hours', 'tasks done'],
    d.days.map((x) => {
      const share = ratio(x.storageReads, cap);
      const at = cap > 0 && x.storageReads >= cap;
      return [
        `<code>${esc(x.date)}</code>`,
        `<span class="${at ? 'over' : ''}">${int(x.storageReads)}</span>`,
        share === null ? '—' : pct(share, 1),
        usd(x.estimatedCostUsd),
        x.quotaRejections === null ? '—' : int(x.quotaRejections),
        x.boots === null ? '—' : int(x.boots),
        x.minutesToExhaust === null ? '<span class="muted">not measurable</span>' : `${num(x.minutesToExhaust).toFixed(1)} min`,
        x.observedHours === null ? '—' : `${num(x.observedHours).toFixed(1)} h`,
        int(x.completedTasks),
      ];
    }),
    'no measured days in this document',
  );
}

function renderAgents(d) {
  const a = d.attribution || {};
  const fleet = num(d.totals?.storageReads);
  const unattributed = Math.max(0, num(a.unattributedReads));
  const rows = (a.agents || []).slice().sort((x, y) => num(y.storageReads) - num(x.storageReads));
  if (!rows.length && unattributed <= 0) {
    el('agents').innerHTML = '<p class="hint">no agent rows and nothing unattributed — the document carries no read telemetry.</p>';
    return;
  }
  const max = Math.max(1, ...rows.map((r) => num(r.storageReads)), unattributed);
  const bar = (label, role, value, share, cls, meta) => {
    const w = Math.max(0, Math.min(100, (num(value) / max) * 100)).toFixed(2);
    return (
      `<div class="agent">` +
      `<div class="a-head"><b>${esc(label)}</b> <span class="muted">${esc(role)}</span>` +
      `<span class="a-cost">${pct(share)} of the burn</span></div>` +
      `<div class="a-bar"><i class="${cls}" style="width:${w}%"></i></div>` +
      `<div class="a-meta">${meta}</div>` +
      `</div>`
    );
  };
  const unit = num(d.priceCard?.readUnitUsd);
  el('agents').innerHTML =
    rows
      .map((r) =>
        bar(
          r.name,
          r.role || r.id,
          r.storageReads,
          r.share,
          'measured',
          `${int(r.storageReads)} reads counted on its own host · ${usd(num(r.storageReads) * unit)} cost-equivalent`,
        ),
      )
      .join('') +
    (unattributed > 0
      ? bar(
          'no agent row claims this',
          'requests this host never sees',
          unattributed,
          ratio(unattributed, fleet),
          'unattributed',
          `${int(unattributed)} reads spent by code with no telemetry here · ${usd(unattributed * unit)} cost-equivalent, ` +
            'left unattributed rather than split between the rows above',
        )
      : '') +
    `<p class="hint">Bars are the same 0–100% scale, so the unattributed row is the one that matters. ` +
    `This is the honest state of a real fleet: the code that logs the window accounts for ` +
    `${pct(ratio(num(a.attributedReads), fleet))} of the reads it caused, and the rest is consumed by ` +
    `requests it never sees. Closing that gap needs read counts from the database's own usage export, not ` +
    `another log line.</p>`;
}

function renderProvenance(d) {
  const rows = Object.entries(d.provenance || {});
  if (!rows.length) {
    table('table-provenance', ['field', 'how it was produced'], [], 'this document carries no provenance block');
    return;
  }
  table(
    'table-provenance',
    ['field', 'measured, derived or generated'],
    rows.map(([k, v]) => [`<code>${esc(k)}</code>`, esc(v)]),
    'this document carries no provenance block',
  );
}

// --------------------------------------------------------------------- boot
function render(d) {
  const sample = d.dataClass === 'REAL' ? 'real' : 'synthetic';
  el('badge-dataclass').innerHTML = `data: <b class="${sample}">${esc(d.dataClass || 'UNLABELLED')}</b>`;
  el('badge-state').textContent = `${int(d.atCeiling)}/${int(d.days.length)} budget day(s) at the ceiling`;
  el('badge-window').textContent = `${d.window?.activeStart || '—'} → ${d.window?.activeEnd || '—'} · ${num(d.window?.activeDays)} day(s)`;
  el('foot-dataclass').innerHTML = `<b class="${sample}">${esc(d.dataClass || 'UNLABELLED')}</b> (${esc(d.builtFrom || 'unknown source')})`;

  if (!hasNumbers(d)) {
    renderNoData('The metrics document has no day with a measured read count or a completed task.');
    return;
  }

  const notice = el('notice');
  if (d.dataClass !== 'REAL') {
    notice.hidden = false;
    notice.innerHTML =
      '<b>This page is showing SAMPLE-GENERATED data, not a measurement.</b> ' +
      'It exists so the page is never blank. The committed dataset is measured; see the provenance table.';
  }
  const share = ratio(num(d.attribution?.unattributedReads), num(d.totals?.storageReads));
  if (share !== null && share > 0.005) {
    notice.hidden = false;
    notice.innerHTML +=
      ` <b>${pct(share)} of the recorded burn is unattributed</b> — the requests that consumed it are not ` +
      'made by the code on the host that exported this window. The page reports the gap instead of filling it.';
  }

  renderTiles(d);
  renderReadsChart(d);
  renderBootsChart(d);
  renderDays(d);
  renderAgents(d);
  renderProvenance(d);
}

async function boot() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    renderNoData(`The data file could not be loaded (${err.message}).`);
    el('badge-dataclass').textContent = 'data: unavailable';
  }
}

boot();
