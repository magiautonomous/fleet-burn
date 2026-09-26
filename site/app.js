// fleet-burn dashboard. No framework, no build step, no dependencies — the same
// rules as the library, so the page and the CLI can never tell different
// stories about the same file.
//
// Every number rendered here comes from site/data.json, which is produced by
// tools/build-dashboard.mjs running the real library over data/*.json. This
// file only formats; it computes no costs of its own.

const DATA_URL = 'data.json';
const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- formatting
const int = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');
const usd = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
};
const pct = (v) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(0)}%`);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t;
};

// ------------------------------------------------------------------- tiles
function tile(label, value, sub) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div>` +
    `<div class="tile-value">${esc(value)}</div>` +
    `<div class="tile-sub">${sub || ''}</div></div>`;
}

function renderTiles(d) {
  const t = d.totals;
  const b = t.burn;
  el('tiles').innerHTML = [
    tile('estimated cost', usd(t.estimatedCostUsd), `storage ${usd(t.costBreakdown.storageUsd)} + tokens ${usd(t.costBreakdown.tokenUsd)}`),
    tile('per day', usd(b.usdPerDay), `over ${b.days} active days`),
    tile('storage reads', int(t.storageReads), `${int(b.readsPerDay)}/day · ${int(t.coordinationReads)} with no task in flight`),
    tile('llm calls', int(t.llmCalls), `${int(b.llmCallsPerDay)}/day`),
    tile('tokens', int(t.tokensTotal), `${int(t.tokensCacheRead)} from cache`),
    tile(
      'per completed task',
      t.costPerOutcome === null ? '—' : usd(t.costPerOutcome),
      `${int(t.tasksCompleted)} completed · ${int(t.tasksAttributed)} attributed`,
    ),
  ].join('');
}

// ------------------------------------------------------------------ budget
function renderBudget(d) {
  const b = d.budget;
  const caps = b.caps || {};
  const rows = [
    ['storage reads / day', caps.capReadsPerDay, b.peak.readsPerDay, 'reads'],
    ['estimated USD / day', caps.capUsdPerDay, b.peak.usdPerDay, 'usd'],
    ['llm calls / day', caps.capLlmCallsPerDay, b.peak.llmCallsPerDay, 'calls'],
  ].filter((r) => Number(r[1]) > 0);

  if (!rows.length) {
    el('budget').innerHTML = '<p class="hint">No caps declared in this metrics document.</p>';
    return;
  }

  const bars = rows
    .map(([label, cap, peak, kind]) => {
      const frac = Math.min(1, peak / cap);
      const state = peak > cap ? 'over' : frac > 0.8 ? 'near' : 'ok';
      const value = kind === 'usd' ? usd(peak) : int(peak);
      const limit = kind === 'usd' ? usd(cap) : int(cap);
      return `<div class="cap">
        <div class="cap-head"><span>${esc(label)}</span>
          <span class="cap-num ${state}">${esc(value)} of ${esc(limit)}</span></div>
        <div class="cap-bar"><i class="${state}" style="width:${(frac * 100).toFixed(1)}%"></i></div>
      </div>`;
    })
    .join('');

  const verdict = b.ok
    ? `<p class="verdict ok">Within every cap. ${b.checked} capped day(s) checked; peak day is ` +
      `${int(b.peak.readsPerDay)} reads and ${usd(b.peak.usdPerDay)}.</p>`
    : `<p class="verdict over">${b.violations.length} capped day(s) over budget. ` +
      `The CLI exits 1 on this data.</p>` +
      b.violations
        .map(
          (v) => `<div class="violation">
            <div class="v-head"><code>${esc(v.day)}</code> ${esc(v.kind)} cap: ` +
            `<strong>${esc(v.kind === 'usd' ? usd(v.actual) : int(v.actual))}</strong> against ` +
            `${esc(v.kind === 'usd' ? usd(v.cap) : int(v.cap))} (${v.overBy.toFixed(2)}\u00d7)</div>
            ${v.agent ? `<div class="v-line"><b>agent</b> ${esc(v.agent.name)} — ` +
              `${esc(v.kind === 'usd' ? usd(v.agent.value) : int(v.agent.value))}, ` +
              `${pct(v.agent.share)} of the ${esc(v.agent.scope)}</div>` : ''}
            ${v.task ? `<div class="v-line"><b>task</b> ${esc(v.task.title ? `"${v.task.title}"` : '(untitled)')} ` +
              `<code>[${esc(v.task.id)}]</code> — ${esc(v.kind === 'usd' ? usd(v.task.value) : int(v.task.value))}, ` +
              `${pct(v.task.share)} of the ${esc(v.task.scope)}</div>` : ''}
            <div class="v-why">${esc(v.reason)}</div>
          </div>`,
        )
        .join('');

  el('budget').innerHTML = bars + verdict;
}

// -------------------------------------------------------------- burn chart
// An SVG column chart with a stacked reads axis. Inline SVG rather than canvas:
// it scales, it prints, and it needs no second download.
function renderChart(d) {
  const days = d.days;
  const cap = Number(d.budget.caps?.capReadsPerDay) || 0;
  const maxReads = Math.max(1, ...days.map((x) => x.storageReads), cap > 0 ? cap : 0);
  const W = 960;
  const H = 240;
  const padL = 52;
  const padB = 26;
  const padT = 12;
  const plotW = W - padL - 8;
  const plotH = H - padB - padT;
  const bw = plotW / days.length;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = f * maxReads;
    const y = padT + plotH - f * plotH;
    return `<line class="grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - 8}" y2="${y.toFixed(1)}"/>` +
      `<text class="axis" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${int(v)}</text>`;
  });

  const bars = days
    .map((x, i) => {
      const h = (x.storageReads / maxReads) * plotH;
      const x0 = padL + i * bw + bw * 0.15;
      const w = bw * 0.7;
      const y = padT + plotH - h;
      const over = cap > 0 && x.storageReads > cap;
      const label = `${x.date}: ${int(x.storageReads)} reads, ${usd(x.estimatedCostUsd)} estimated, ` +
        `${int(x.completedTasks)} tasks completed`;
      return `<g class="bar${over ? ' over' : ''}"><title>${esc(label)}</title>` +
        `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}"/>` +
        `<text class="tick" x="${(x0 + w / 2).toFixed(1)}" y="${(padT + plotH + 12).toFixed(1)}" text-anchor="middle">${esc(x.date.slice(5))}</text>` +
        `</g>`;
    })
    .join('');

  const capLine = cap > 0
    ? `<line class="capline" x1="${padL}" y1="${(padT + plotH - (Math.min(1, cap / maxReads) * plotH)).toFixed(1)}" x2="${W - 8}" y2="${(padT + plotH - (Math.min(1, cap / maxReads) * plotH)).toFixed(1)}"/>` +
      `<text class="caplabel" x="${W - 10}" y="${(padT + plotH - (Math.min(1, cap / maxReads) * plotH) - 5).toFixed(1)}" text-anchor="end">cap ${int(cap)}</text>`
    : '';

  // Second series on its own scale, so burn is readable as both the thing you
  // are billed for (USD) and the thing that actually takes the fleet down
  // (reads). One axis for both would make the cheaper one a flat line.
  const costMax = Math.max(...days.map((x) => Number(x.estimatedCostUsd) || 0), 0.0001);
  const costY = (v) => padT + plotH - ((Number(v) || 0) / costMax) * plotH;
  const costX = (i) => padL + i * bw + bw / 2;
  const costPath = days.map((x, i) => `${i ? 'L' : 'M'}${costX(i).toFixed(1)} ${costY(x.estimatedCostUsd).toFixed(1)}`).join(' ');
  const costDots = days
    .map((x, i) => `<circle class="dot" cx="${costX(i).toFixed(1)}" cy="${costY(x.estimatedCostUsd).toFixed(1)}" r="2.6"><title>${esc(x.date)}: ${usd(x.estimatedCostUsd)} estimated</title></circle>`)
    .join('');
  const costAxis = [0, 0.5, 1]
    .map((f) => `<text class="axis axis-right" x="${W - 10}" y="${(padT + plotH - f * plotH + 3).toFixed(1)}" text-anchor="start">${usd(costMax * f)}</text>`)
    .join('');

  el('chart-burn').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" width="100%">` +
    yTicks.join('') +
    `<line class="axis-line" x1="${padL}" y1="${padT + plotH}" x2="${W - 8}" y2="${padT + plotH}"/>` +
    capLine +
    bars +
    `<path class="cost-line" d="${costPath}"/>` +
    costDots +
    costAxis +
    `</svg>`;

  el('burn-hint').textContent =
    `Columns are storage reads per day (left axis, with the cap line). The line is estimated USD for the ` +
    `same days (right axis, ${usd(0)} to ${usd(costMax)}); hover a column or a point for the exact day.`;

  el('legend').innerHTML =
    `<span class="key"><i class="k-bar"></i>storage reads</span>` +
    (cap > 0 ? `<span class="key"><i class="k-cap"></i>budget cap</span>` : '') +
    `<span class="key"><i class="k-over"></i>over cap</span>` +
    `<span class="key"><i class="k-cost"></i>estimated USD</span>`;
}

// ------------------------------------------------------------------ tables
function table(id, head, rows, empty) {
  if (!rows.length) {
    el(id).innerHTML = `<p class="hint">${esc(empty)}</p>`;
    return;
  }
  el(id).innerHTML =
    `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
    `</tbody>`;
}

function renderDays(d) {
  const cap = Number(d.budget.caps?.capReadsPerDay) || 0;
  table(
    'table-days',
    ['date', 'reads', 'task-attributed', 'coordination', 'calls', 'tokens', 'est. USD', 'done', '$/task'],
    d.days.map((x) => {
      const over = cap > 0 && x.storageReads > cap;
      return [
        `<code>${esc(x.date)}</code>`,
        `<span class="${over ? 'over' : ''}">${int(x.storageReads)}</span>`,
        int(x.taskAttributedReads),
        int(Math.max(0, x.storageReads - x.taskAttributedReads)),
        int(x.llmCalls),
        int(x.tokensTotal),
        usd(x.estimatedCostUsd),
        int(x.completedTasks),
        x.costPerOutcome === null ? '<span class="muted">—</span>' : usd(x.costPerOutcome),
      ];
    }),
    'no days reported',
  );
}

function renderAgents(d) {
  const max = Math.max(...d.agents.map((a) => a.estimatedCostUsd), 0.0001);
  if (!d.agents.length) {
    el('agents').innerHTML = '<p class="hint">no agents reported</p>';
    return;
  }
  el('agents').innerHTML = d.agents
    .map((a) => {
      const w = ((a.estimatedCostUsd / max) * 100).toFixed(1);
      return `<div class="agent">
        <div class="a-head"><b>${esc(a.name)}</b> <span class="muted">${esc(a.role || a.id)}</span>
          <span class="a-cost">${usd(a.estimatedCostUsd)}</span></div>
        <div class="a-bar"><i style="width:${w}%"></i></div>
        <div class="a-meta">${int(a.storageReads)} reads · ${int(a.llmCalls)} calls · ${int(a.tokensTotal)} tokens · ${int(a.taskCount)} tasks` +
        (a.coordinationReads ? ` · ${int(a.coordinationReads)} reads with no task in flight` : '') + `</div>
      </div>`;
    })
    .join('');
}

function renderCpoTasks(d) {
  const rows = (d.worstCostPerOutcomeTasks || []).slice(0, 10);
  table(
    'cpo-tasks',
    ['task', 'agent', 'est. USD / outcome', 'est. USD', 'reads', 'calls', 'tokens'],
    rows.map((t) => [
      esc(short(t.title || t.id, 58)),
      `<span class="muted">${esc(t.agent || '-')}</span>`,
      `<b>${usd(t.costPerOutcome)}</b>`,
      usd(t.estimatedCostUsd),
      int(t.storageReads),
      int(t.llmCalls),
      int(t.tokensTotal),
    ]),
    'no completed task reported any spend',
  );
}

function renderCpo(d) {
  const rows = d.days
    .filter((x) => x.completedTasks > 0 && x.estimatedCostUsd > 0)
    .sort((a, b) => b.costPerOutcome - a.costPerOutcome)
    .slice(0, 8);
  table(
    'cpo',
    ['date', 'est. USD / completed task', 'completed', 'est. USD', 'reads'],
    rows.map((x) => [
      `<code>${esc(x.date)}</code>`,
      `<b>${usd(x.costPerOutcome)}</b>`,
      int(x.completedTasks),
      usd(x.estimatedCostUsd),
      int(x.storageReads),
    ]),
    'no day reported both spend and completions',
  );
}

function renderTasks(d) {
  table(
    'table-cost',
    ['est. USD', 'calls', 'tokens', 'agent', 'task'],
    [...d.tasks]
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
      .slice(0, 12)
      .map((t) => [
        usd(t.estimatedCostUsd),
        int(t.llmCalls),
        int(t.tokensTotal),
        esc(t.agent),
        `<span title="${esc(t.title || t.id)}">${esc(short(t.title || t.id, 64))}</span>`,
      ]),
    'no tasks reported',
  );
  table(
    'table-reads',
    ['reads', 'day', 'agent', 'task'],
    [...d.tasks]
      .filter((t) => t.storageReads > 0)
      .sort((a, b) => b.storageReads - a.storageReads)
      .slice(0, 12)
      .map((t) => [
        int(t.storageReads),
        `<code>${esc(t.day || '—')}</code>`,
        esc(t.agent),
        `<span title="${esc(t.title || t.id)}">${esc(short(t.title || t.id, 64))}</span>`,
      ]),
    'no task-attributed reads in this window',
  );
}

function renderEvents(d) {
  const kinds = [...new Set((d.events || []).map((e) => e.kind))];
  if (!kinds.length) {
    el('table-events').innerHTML =
      '<tbody><tr><td class="hint">this document declares no operational events</td></tr></tbody>';
    return;
  }
  const byDay = new Map();
  for (const e of d.events) {
    if (!byDay.has(e.date)) byDay.set(e.date, new Map());
    byDay.get(e.date).set(e.kind, e);
  }
  el('table-events').innerHTML =
    `<thead><tr><th>date</th>${kinds.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>` +
    [...byDay.entries()]
      .map(
        ([date, row]) =>
          `<tr><td><code>${esc(date)}</code></td>` +
          kinds
            .map((k) => {
              const e = row.get(k);
              return e ? `<td title="${esc(e.note || '')}">${int(e.count)}</td>` : '<td class="muted">—</td>';
            })
            .join('') +
          '</tr>',
      )
      .join('') +
    '</tbody>';
}

function renderProvenance(d) {
  const rows = Object.entries(d.provenance || {});
  const price = d.pricing?.note ? [['estimated cost', d.pricing.note]] : [];
  const all = rows.concat(price);
  table(
    'table-provenance',
    ['field', 'how it was produced'],
    all.map(([k, v]) => [`<code>${esc(k)}</code>`, esc(v)]),
    'this document carries no provenance block',
  );
}

// -------------------------------------------------------------------- boot
function render(d) {
  const cls = d.dataClass === 'REAL' ? 'real' : 'synthetic';
  el('badge-dataclass').innerHTML = `data: <b class="${cls}">${esc(d.dataClass)}</b> fleet telemetry`;
  el('badge-window').textContent = `${d.window.activeStart} \u2192 ${d.window.activeEnd} (${d.window.activeDays} active days)`;
  el('foot-dataclass').innerHTML = `<b class="${cls}">${esc(d.dataClass)}</b> (${esc(d.builtFrom || 'unknown source')})`;

  const notice = el('notice');
  if (d.dataClass !== 'REAL') {
    notice.hidden = false;
    notice.innerHTML =
      '<b>This page is showing SYNTHETIC data.</b> It is a replay of a documented configuration, not a measurement. ' +
      'The real-fleet sample is <code>data/fleet-sample.json</code> in the repo.';
  }
  if (d.coverage < 0.999) {
    notice.hidden = false;
    notice.innerHTML +=
      ` <b>${pct(1 - d.coverage)} of counted activity has no owning agent or task row</b>, ` +
      'so this meter can name a cause for the rest only.';
  }

  renderTiles(d);
  renderBudget(d);
  renderChart(d);
  renderDays(d);
  renderEvents(d);
  renderAgents(d);
  renderCpoTasks(d);
  renderCpo(d);
  renderTasks(d);
  renderProvenance(d);
}

async function boot() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    // A published page that cannot load its data must say so rather than
    // render a confident empty dashboard.
    el('notice').hidden = false;
    el('notice').innerHTML =
      `<b>Could not load ${DATA_URL}</b> (${esc(err.message)}). ` +
      'Run <code>node tools/build-dashboard.mjs</code> to regenerate it.';
    el('badge-dataclass').textContent = 'data: unavailable';
  }
}

boot();
