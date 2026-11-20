// Модуль отчётности: KPI со сравнением периодов, % потерь, SVG-график, вкладки разрезов, фильтры и выгрузка Excel.
import { api } from './api.js';
import { openInvoice } from './invoice.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kg = (v) => (v == null ? '—' : Number(v).toFixed(3));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const dm = (s) => s.slice(8, 10) + '.' + s.slice(5, 7);

let lastData = null;
let subTab = 'summary'; // summary | days | buyers
let chartMetric = 'amount'; // amount | out_kg | in_kg
let deps = { cur: () => 'сум', crop: () => 'Клубника', gradeColor: () => '#1b1b1b', openHistoryDay: () => {} };

function deltaBadge(cur, prev, invert = false) {
  if (!prev || prev <= 0) return '';
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return `<span class="delta">0%</span>`;
  const good = invert ? pct < 0 : pct > 0;
  const arrow = pct > 0 ? '▲' : '▼';
  return `<span class="delta ${good ? 'up' : 'dn'}">${arrow} ${Math.abs(pct)}%</span>`;
}

function renderBarChart(days) {
  if (!days.length) return '<div class="empty">Нет данных за выбранный период</div>';
  const cur = deps.cur();
  const label = chartMetric === 'amount' ? `Выручка (${cur})` : chartMetric === 'out_kg' ? 'Продано (кг)' : 'Собрано (кг)';
  const fmt = (v) => (chartMetric === 'amount' ? `${money(v)} ${cur}` : `${kg(v)} кг`);
  const vals = days.map((d) => Number(d[chartMetric] || 0));
  const max = Math.max(...vals, 0.001);

  const W = 680;
  const H = 180;
  const padB = 26;
  const padT = 12;
  const chartH = H - padB - padT;
  const slot = W / Math.max(days.length, 1);
  const barW = Math.min(36, Math.max(6, slot * 0.62));
  const stepLabel = Math.max(1, Math.ceil(days.length / 8));

  const bars = days.map((d, i) => {
    const v = vals[i];
    const h = Math.max(v > 0 ? 4 : 0, (v / max) * chartH);
    const x = i * slot + (slot - barW) / 2;
    const y = padT + chartH - h;
    const showLbl = i % stepLabel === 0 || i === days.length - 1;
    return `
      <g class="bar-g" data-idx="${i}">
        <rect class="bar-hit" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}" fill="transparent"/>
        <rect class="bar-r" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4"/>
        ${showLbl ? `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="bar-lbl">${dm(d.day)}</text>` : ''}
      </g>`;
  }).join('');

  const last = days[days.length - 1];
  return `
    <div class="card">
      <div class="chart-top">
        <div>
          <h2 style="margin:0">Динамика по дням</h2>
          <div class="small muted" id="ch-tip">${dm(last.day)} · ${label}: <b style="color:var(--ink)">${esc(fmt(last[chartMetric]))}</b></div>
        </div>
        <div class="chips" id="ch-metrics">
          <button class="chip${chartMetric === 'amount' ? ' sel' : ''}" data-m="amount">Выручка</button>
          <button class="chip${chartMetric === 'out_kg' ? ' sel' : ''}" data-m="out_kg">Продажи</button>
          <button class="chip${chartMetric === 'in_kg' ? ' sel' : ''}" data-m="in_kg">Сбор</button>
        </div>
      </div>
      <div class="chart-wrap">
        <svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="none">
          <line x1="0" y1="${padT + chartH}" x2="${W}" y2="${padT + chartH}" stroke="rgba(0,0,0,.08)" stroke-width="1"/>
          <line x1="0" y1="${padT + chartH / 2}" x2="${W}" y2="${padT + chartH / 2}" stroke="rgba(0,0,0,.05)" stroke-dasharray="3 3" stroke-width="1"/>
          ${bars}
        </svg>
      </div>
    </div>`;
}

function renderSummary(d) {
  const s = d.summary;
  const p = d.prev;
  const cur = deps.cur();

  const stackBar = d.by_grade.length && s.amount > 0
    ? `<div class="stackbar">${d.by_grade.filter((g) => g.share_pct > 0).map((g) =>
        `<span style="width:${g.share_pct}%;background:${deps.gradeColor(g.grade)}" title="${esc(g.grade)}: ${g.share_pct}%"></span>`
      ).join('')}</div>`
    : '';

  const gradeRows = d.by_grade.map((x) => `
    <li class="li">
      <div class="l">
        <div class="t"><span class="sw" style="--gc:${deps.gradeColor(x.grade)};margin-right:8px"></span>${esc(x.grade)}${x.share_pct ? ` <span class="small muted" style="font-weight:500">${x.share_pct}%</span>` : ''}</div>
        <div class="s">приход ${kg(x.in_kg)} · продано ${kg(x.out_kg)} · списано ${kg(x.writeoff_kg)}${x.avg_price ? ` · ср. ${money(x.avg_price)}` : ''}</div>
      </div>
      <div class="r">${money(x.amount)} <span class="small muted" style="font-weight:500">${esc(cur)}</span></div>
    </li>`).join('');

  const expRows = (d.by_expense_category || []).map((x) => `
    <li class="li">
      <div class="l">
        <div class="t">${esc(x.category)} <span class="small muted" style="font-weight:500">${x.share_pct}%</span></div>
        <div class="s">актов: ${x.acts}</div>
        <div class="prog"><span style="width:${Math.min(100, x.share_pct)}%"></span></div>
      </div>
      <div class="r">${money(x.amount)} <span class="small muted" style="font-weight:500">${esc(cur)}</span></div>
    </li>`).join('');

  const profitNeg = (s.net_profit || 0) < 0;
  return `
    <div class="kpis kpis4">
      <div class="kpi">
        <div class="k">Выручка ${deltaBadge(s.amount, p.amount)}</div>
        <div class="v">${money(s.amount)} <small>${esc(cur)}</small></div>
        <div class="subk">пред. период: ${money(p.amount)}</div>
      </div>
      <div class="kpi">
        <div class="k">Расходы ${deltaBadge(s.expenses_total, p.expenses_total, true)}</div>
        <div class="v">${money(s.expenses_total)} <small>${esc(cur)}</small></div>
        <div class="subk">пред. период: ${money(p.expenses_total)}</div>
      </div>
      <div class="kpi">
        <div class="k">Чистая прибыль ${deltaBadge(s.net_profit, p.net_profit)}</div>
        <div class="v" style="${profitNeg ? 'color:var(--red)' : ''}">${money(s.net_profit)} <small>${esc(cur)}</small></div>
        <div class="subk">выручка − расходы</div>
      </div>
      <div class="kpi">
        <div class="k">Продано ${deltaBadge(s.out_kg, p.out_kg)}</div>
        <div class="v">${kg(s.out_kg)} <small>кг</small></div>
        <div class="subk">ср. цена: ${s.avg_price ? money(s.avg_price) + ' ' + esc(cur) + '/кг' : '—'}</div>
      </div>
      <div class="kpi">
        <div class="k">Собрано (приход) ${deltaBadge(s.in_kg, p.in_kg)}</div>
        <div class="v">${kg(s.in_kg)} <small>кг</small></div>
        <div class="subk">пред. период: ${kg(p.in_kg)} кг</div>
      </div>
      <div class="kpi">
        <div class="k">Потери (списание + брак) ${deltaBadge(s.loss_kg, p.loss_kg, true)}</div>
        <div class="v">${kg(s.loss_kg)} <small>кг</small></div>
        <div class="subk">${s.loss_pct}% от сбора (списано ${kg(s.writeoff_kg)})</div>
      </div>
    </div>
    <div class="muted small" style="margin:-2px 2px 14px">
      Продаж: <b>${s.sales_count}</b> · Ручных записей веса: <b>${d.manual_entries}</b> · Отменённых: <b>${d.cancelled_entries}</b>
      <span style="margin-left:6px">· сравнение с ${dm(p.from)}–${dm(p.to)}</span>
    </div>
    ${renderBarChart(d.by_day)}
    <div class="card">
      <h2>По сортам</h2>
      ${stackBar}
      ${gradeRows ? `<ul class="list">${gradeRows}</ul>` : '<div class="empty">Нет данных за период</div>'}
    </div>
    ${expRows ? `<div class="card"><h2>Расходы по категориям</h2><ul class="list">${expRows}</ul></div>` : ''}`;
}

function renderDays(d) {
  const cur = deps.cur();
  if (!d.by_day.length) return '<div class="card"><div class="empty">Нет данных за период</div></div>';
  const rows = [...d.by_day].reverse().map((x) => `
    <li class="li click-row" data-day="${esc(x.day)}">
      <div class="l">
        <div class="t">${dm(x.day)} <span class="small muted" style="font-weight:400">${esc(x.day)}</span></div>
        <div class="s">приход ${kg(x.in_kg)} кг · продано ${kg(x.out_kg)} кг${x.writeoff_kg ? ` · списано ${kg(x.writeoff_kg)} кг` : ''}</div>
      </div>
      <div class="r">${money(x.amount)} <span class="small muted" style="font-weight:500">${esc(cur)}</span></div>
    </li>`).join('');
  return `<div class="card"><h2>По дням <span class="small muted" style="font-weight:400">(нажмите на день, чтобы открыть операции)</span></h2><ul class="list">${rows}</ul></div>`;
}

function renderBuyers(d) {
  const cur = deps.cur();
  if (!d.by_customer.length) return '<div class="card"><div class="empty">Продаж за период нет</div></div>';
  const blocks = d.by_customer.map((c) => {
    const custSales = d.sales.filter((s) => s.customer === c.customer);
    const salesHtml = custSales.map((s) => `
      <div class="subsale">
        <div>
          <b>Продажа №${esc(s.sale_id)}</b> · <span class="small muted">${esc(s.ts.slice(5))}</span>
          <div class="small muted">${s.items.map((i) => `${esc(i.grade)} ${kg(i.net_kg)} кг`).join(', ')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex:none">
          <b>${money(s.total_amount)} ${esc(cur)}</b>
          <button class="btn sec sm" data-inv="${esc(`${s.device}:${s.sale_id}`)}">Накладная</button>
        </div>
      </div>`).join('');
    return `
      <details class="buyer-det">
        <summary class="li" style="border-bottom:0;padding:12px 0">
          <div class="l">
            <div class="t">${esc(c.customer)} <span class="small muted" style="font-weight:500">${c.share_pct}%</span></div>
            <div class="s">${kg(c.kg)} кг · отгрузок: ${c.sales_count}${c.avg_price ? ` · ср. ${money(c.avg_price)} ${esc(cur)}/кг` : ''}</div>
            <div class="prog"><span style="width:${Math.min(100, c.share_pct)}%"></span></div>
          </div>
          <div class="r">${money(c.amount)} <span class="small muted" style="font-weight:500">${esc(cur)}</span></div>
        </summary>
        <div class="subsales">${salesHtml || '<div class="small muted">Нет деталей</div>'}</div>
      </details>`;
  }).join('');
  return `<div class="card"><h2>Покупатели <span class="small muted" style="font-weight:400">(нажмите на покупателя для накладных)</span></h2>${blocks}</div>`;
}

function renderBody() {
  if (!lastData) return;
  const d = lastData;
  const tabsHtml = `
    <div class="seg" id="r-subtabs">
      <button class="${subTab === 'summary' ? 'sel' : ''}" data-st="summary">Сводка</button>
      <button class="${subTab === 'days' ? 'sel' : ''}" data-st="days">По дням</button>
      <button class="${subTab === 'buyers' ? 'sel' : ''}" data-st="buyers">Покупатели</button>
    </div>`;

  const content = subTab === 'summary' ? renderSummary(d)
    : subTab === 'days' ? renderDays(d)
    : renderBuyers(d);

  $('r-body').innerHTML = tabsHtml + content;

  // Переключение вкладок внутри отчёта
  $('r-subtabs').onclick = (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    subTab = b.dataset.st;
    renderBody();
  };

  // Переключение метрики графика + наведение/тап по столбикам
  const chM = $('ch-metrics');
  if (chM) {
    chM.onclick = (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      chartMetric = b.dataset.m;
      renderBody();
    };
    const tip = $('ch-tip');
    const cur = deps.cur();
    const label = chartMetric === 'amount' ? `Выручка (${cur})` : chartMetric === 'out_kg' ? 'Продано (кг)' : 'Собрано (кг)';
    const fmt = (v) => (chartMetric === 'amount' ? `${money(v)} ${cur}` : `${kg(v)} кг`);
    $('r-body').querySelectorAll('.bar-g').forEach((g) => {
      const show = () => {
        const day = d.by_day[Number(g.dataset.idx)];
        if (day && tip) tip.innerHTML = `${dm(day.day)} · ${label}: <b style="color:var(--ink)">${esc(fmt(day[chartMetric]))}</b>`;
      };
      g.onmouseenter = show;
      g.onclick = show;
    });
  }

  // Клик по дню -> переход в Историю за этот день
  $('r-body').querySelectorAll('[data-day]').forEach((el) => {
    el.onclick = () => deps.openHistoryDay(el.dataset.day);
  });

  // Кнопка «Накладная» у покупателей
  const salesIndex = Object.fromEntries(d.sales.map((s) => [`${s.device}:${s.sale_id}`, s]));
  $('r-body').querySelectorAll('[data-inv]').forEach((b) => {
    b.onclick = () => {
      const s = salesIndex[b.dataset.inv];
      if (s) openInvoice(s, { crop: deps.crop(), cur: deps.cur() });
    };
  });
}

function syncFilterSelects(filters) {
  const fill = (id, list, placeholder) => {
    const el = $(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = `<option value="">${placeholder}</option>` + list.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    if (list.includes(prev)) el.value = prev;
  };
  fill('r-grade', filters.grades || [], 'Все сорта');
  fill('r-cust', filters.customers || [], 'Все покупатели');
}

function buildReportQuery(extra = '') {
  const qs = new URLSearchParams();
  if ($('r-from').value) qs.set('from', $('r-from').value);
  if ($('r-to').value) qs.set('to', $('r-to').value);
  if ($('r-grade').value) qs.set('grade', $('r-grade').value);
  if ($('r-cust').value) qs.set('customer', $('r-cust').value);
  if (extra) qs.set('format', extra);
  return `/api/report?${qs.toString()}`;
}

export async function loadReport() {
  const r = await api('GET', buildReportQuery());
  if (!r.ok) return;
  lastData = r.data;
  syncFilterSelects(r.data.filters || {});
  renderBody();
}

export function initReport(config) {
  deps = config;
  $('r-grade').onchange = loadReport;
  $('r-cust').onchange = loadReport;
  $('r-csv').onclick = () => {
    window.location.href = buildReportQuery('csv');
  };
}
