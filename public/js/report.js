// Отчёт о прибылях и убытках (ОПиУ / P&L как в iiko): иерархическая таблица, KPI, график, По дням, Покупатели и Excel.
import { api } from './api.js';
import { openInvoice } from './invoice.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kg = (v) => (v == null ? '—' : Number(v).toFixed(3));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const dm = (s) => s.slice(8, 10) + '.' + s.slice(5, 7);

let lastData = null;
let subTab = 'pnl'; // pnl | days | buyers
let chartMetric = 'amount'; // amount | out_kg | in_kg
let deps = { cur: () => 'сум', crop: () => 'Клубника', gradeColor: () => '#1b1b1b', openHistoryDay: () => {}, openExpenseAct: () => {} };

function deltaBadge(cur, prev, invert = false) {
  if (!prev || prev === 0) return '';
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
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
  const H = 175;
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

// Классический Отчёт о прибылях и убытках (ОПиУ / P&L как в iiko)
function renderPnl(d) {
  const s = d.summary;
  const p = d.prev;
  const cur = deps.cur();
  const profitNeg = (s.net_profit || 0) < 0;
  const expPctOfRev = s.amount > 0 ? Math.round((s.expenses_total / s.amount) * 1000) / 10 : 0;

  const gradeSubRows = d.by_grade.filter((g) => g.amount > 0 || g.out_kg > 0).map((g) => `
    <tr class="pnl-sub pnl-click" data-drill="rev-grade" data-key="${esc(g.grade)}">
      <td><span class="sw" style="--gc:${deps.gradeColor(g.grade)};margin-right:8px"></span>${esc(g.grade)} <span class="small muted">(${kg(g.out_kg)} кг${g.avg_price ? ` × ${money(g.avg_price)}` : ''})</span> <span class="pnl-arr">›</span></td>
      <td class="num">${money(g.amount)}</td>
      <td class="num muted">${g.share_pct}%</td>
      <td class="num muted hide-sm">—</td>
    </tr>`).join('');

  const expSubRows = (d.by_expense_category || []).map((e) => `
    <tr class="pnl-sub pnl-click" data-drill="exp-cat" data-key="${esc(e.category)}">
      <td>${esc(e.category)} <span class="small muted">(актов: ${e.acts})</span> <span class="pnl-arr">›</span></td>
      <td class="num">−${money(e.amount)}</td>
      <td class="num muted">${e.rev_pct || 0}%</td>
      <td class="num muted hide-sm">${e.share_pct}% расх.</td>
    </tr>`).join('') || `<tr class="pnl-sub"><td colspan="4" class="muted">Актов расхода за период нет</td></tr>`;

  return `
    <div class="kpis kpis4">
      <div class="kpi">
        <div class="k">Выручка ${deltaBadge(s.amount, p.amount)}</div>
        <div class="v">${money(s.amount)} <small>${esc(cur)}</small></div>
        <div class="subk">${kg(s.out_kg)} кг · ср. ${s.avg_price ? money(s.avg_price) : '—'}</div>
      </div>
      <div class="kpi">
        <div class="k">Операционные расходы ${deltaBadge(s.expenses_total, p.expenses_total, true)}</div>
        <div class="v">${money(s.expenses_total)} <small>${esc(cur)}</small></div>
        <div class="subk">${expPctOfRev}% от выручки</div>
      </div>
      <div class="kpi">
        <div class="k">Чистая прибыль ${deltaBadge(s.net_profit, p.net_profit)}</div>
        <div class="v" style="${profitNeg ? 'color:var(--red)' : 'color:var(--grn)'}">${money(s.net_profit)} <small>${esc(cur)}</small></div>
        <div class="subk">пред. период: ${money(p.net_profit)}</div>
      </div>
      <div class="kpi">
        <div class="k">Рентабельность</div>
        <div class="v">${s.margin_pct || 0}<small>%</small></div>
        <div class="subk">потери: ${kg(s.loss_kg)} кг (${s.loss_pct}%)</div>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <h2 style="margin:0">Отчёт о прибылях и убытках (ОПиУ)</h2>
        <span class="small muted">нажмите на статью для документов · сравнение с ${dm(p.from)}–${dm(p.to)}</span>
      </div>
      <div class="pnl-wrap">
        <table class="pnl-tbl">
          <thead>
            <tr>
              <th>Статья</th>
              <th class="num">Сумма, ${esc(cur)}</th>
              <th class="num">% выр.</th>
              <th class="num hide-sm">Пред. период</th>
            </tr>
          </thead>
          <tbody>
            <tr class="pnl-grp pnl-click" data-drill="rev-all">
              <td>+ Выручка от реализации <span class="pnl-arr">›</span></td>
              <td class="num">${money(s.amount)}</td>
              <td class="num">100%</td>
              <td class="num hide-sm">${money(p.amount)} ${deltaBadge(s.amount, p.amount)}</td>
            </tr>
            ${gradeSubRows}
            <tr class="pnl-grp pnl-click" data-drill="exp-all">
              <td>− Операционные расходы <span class="pnl-arr">›</span></td>
              <td class="num">−${money(s.expenses_total)}</td>
              <td class="num">${expPctOfRev}%</td>
              <td class="num hide-sm">−${money(p.expenses_total)} ${deltaBadge(s.expenses_total, p.expenses_total, true)}</td>
            </tr>
            ${expSubRows}
            <tr class="pnl-info pnl-click" data-drill="loss">
              <td>Справочно: потери (списание + брак) <span class="pnl-arr">›</span></td>
              <td class="num muted">${kg(s.loss_kg)} кг${s.loss_value ? ` (~${money(s.loss_value)})` : ''}</td>
              <td class="num muted">${s.loss_pct}% сб.</td>
              <td class="num muted hide-sm">${kg(p.loss_kg)} кг</td>
            </tr>
            <tr class="pnl-total ${profitNeg ? 'neg' : 'pos'}">
              <td>= ЧИСТАЯ ПРИБЫЛЬ</td>
              <td class="num">${money(s.net_profit)} ${esc(cur)}</td>
              <td class="num">${s.margin_pct || 0}%</td>
              <td class="num hide-sm">${money(p.net_profit)} ${deltaBadge(s.net_profit, p.net_profit)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="muted small" style="margin:-2px 2px 14px">
      Собрано: <b>${kg(s.in_kg)} кг</b> · Продано: <b>${kg(s.out_kg)} кг</b> (${s.sales_count} отгр.) · Ручных весов: <b>${d.manual_entries}</b> · Отменённых: <b>${d.cancelled_entries}</b>
    </div>
    ${renderBarChart(d.by_day)}`;
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

const PAY_LABEL = { cash: 'Наличные', card: 'Карта', transfer: 'Перечисление' };

function showReportView(mode) {
  if ($('r-main-view')) $('r-main-view').hidden = mode !== 'main';
  if ($('r-drill-view')) $('r-drill-view').hidden = mode !== 'drill';
  window.scrollTo(0, 0);
}

function openDrill(kind, key, d) {
  if (!$('r-drill-view')) return;
  const cur = deps.cur();
  let title = '';
  let sub = `${dm(d.from)}–${dm(d.to)}`;
  let html = '';

  if (kind === 'rev-all' || kind === 'rev-grade') {
    const list = kind === 'rev-all'
      ? (d.sales || [])
      : (d.sales || []).filter((s) => s.items.some((i) => i.grade === key));
    title = kind === 'rev-all' ? 'Выручка — все продажи' : `Выручка — сорт «${key}»`;
    const sum = list.reduce((a, s) => a + (kind === 'rev-all'
      ? Number(s.total_amount || 0)
      : s.items.filter((i) => i.grade === key).reduce((x, i) => x + Number(i.amount || 0), 0)), 0);
    sub += ` · документов: ${list.length} · ${money(sum)} ${cur}`;
    html = list.length ? `<ul class="list">${list.map((s) => {
      const items = kind === 'rev-all' ? s.items : s.items.filter((i) => i.grade === key);
      const amt = items.reduce((x, i) => x + Number(i.amount || 0), 0);
      const desc = items.map((i) => `${esc(i.grade)} ${kg(i.net_kg)} кг${i.price_per_kg ? ` × ${money(i.price_per_kg)}` : ''}`).join(', ');
      return `<li class="li">
        <div class="l">
          <div class="t">Продажа №${esc(s.sale_id)} · ${esc(s.customer)}</div>
          <div class="s">${esc(s.ts)} · ${desc}${s.note ? ' · ' + esc(s.note) : ''}</div>
        </div>
        <div class="r" style="display:flex;align-items:center;gap:8px;flex:none">
          <b>${money(amt)} ${esc(cur)}</b>
          <button class="btn sec sm" data-drill-inv="${esc(`${s.device}:${s.sale_id}`)}">Накладная</button>
        </div>
      </li>`;
    }).join('')}</ul>` : '<div class="empty">Продаж за период нет</div>';
  } else if (kind === 'exp-all' || kind === 'exp-cat') {
    const list = kind === 'exp-all'
      ? (d.expense_docs || [])
      : (d.expense_docs || []).filter((e) => e.category === key);
    title = kind === 'exp-all' ? 'Операционные расходы — все акты' : `Расходы — «${key}»`;
    const sum = list.reduce((a, e) => a + Number(e.amount || 0), 0);
    sub += ` · актов: ${list.length} · −${money(sum)} ${cur}`;
    html = list.length ? `<ul class="list">${list.map((e) => {
      const meta = [dm(e.doc_date), esc(e.category), PAY_LABEL[e.payment_method] || e.payment_method, e.counterparty ? esc(e.counterparty) : '', e.user_name ? esc(e.user_name) : ''].filter(Boolean).join(' · ');
      return `<li class="li click-row" data-drill-exp="${e.id}">
        <div class="l">
          <div class="t">Акт №${e.id}${e.comment ? ' · ' + esc(e.comment) : ''}</div>
          <div class="s">${meta}</div>
        </div>
        <div class="r" style="display:flex;align-items:center;gap:6px;flex:none"><b>−${money(e.amount)} ${esc(cur)}</b><span class="pnl-arr">›</span></div>
      </li>`;
    }).join('')}</ul>` : '<div class="empty">Актов расхода за период нет</div>';
  } else if (kind === 'loss') {
    const list = d.loss_docs || [];
    title = 'Потери (списание и брак)';
    const sumKg = list.reduce((a, x) => a + Number(x.net_kg || 0), 0);
    sub += ` · записей: ${list.length} · ${kg(sumKg)} кг`;
    html = list.length ? `<ul class="list">${list.map((x) => `
      <li class="li">
        <div class="l">
          <div class="t">${x.type === 'writeoff' ? 'Списание' : 'Брак (приход)'} · ${esc(x.grade)}</div>
          <div class="s">${esc(x.ts)}${x.note ? ' · ' + esc(x.note) : ''}${x.user_name ? ' · ' + esc(x.user_name) : ''}</div>
        </div>
        <div class="r"><b>${kg(x.net_kg)} кг</b></div>
      </li>`).join('')}</ul>` : '<div class="empty">Потерь за период нет</div>';
  }

  $('drill-title').textContent = title;
  $('drill-sub').textContent = sub;
  $('drill-body').innerHTML = html;

  const salesIndex = Object.fromEntries((d.sales || []).map((s) => [`${s.device}:${s.sale_id}`, s]));
  $('drill-body').querySelectorAll('[data-drill-inv]').forEach((b) => {
    b.onclick = () => {
      const s = salesIndex[b.dataset.drillInv];
      if (s) openInvoice(s, { crop: deps.crop(), cur: deps.cur() });
    };
  });
  $('drill-body').querySelectorAll('[data-drill-exp]').forEach((el) => {
    el.onclick = () => deps.openExpenseAct(Number(el.dataset.drillExp));
  });
  showReportView('drill');
}

function renderBody() {
  if (!lastData) return;
  const d = lastData;
  const tabsHtml = `
    <div class="seg" id="r-subtabs">
      <button class="${subTab === 'pnl' ? 'sel' : ''}" data-st="pnl">ОПиУ (P&amp;L)</button>
      <button class="${subTab === 'days' ? 'sel' : ''}" data-st="days">По дням</button>
      <button class="${subTab === 'buyers' ? 'sel' : ''}" data-st="buyers">Покупатели</button>
    </div>`;

  const content = subTab === 'pnl' ? renderPnl(d) : subTab === 'days' ? renderDays(d) : renderBuyers(d);
  $('r-body').innerHTML = tabsHtml + content;

  $('r-subtabs').onclick = (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    subTab = b.dataset.st;
    renderBody();
  };

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

  $('r-body').querySelectorAll('[data-day]').forEach((el) => {
    el.onclick = () => deps.openHistoryDay(el.dataset.day);
  });

  $('r-body').querySelectorAll('[data-drill]').forEach((tr) => {
    tr.onclick = () => openDrill(tr.dataset.drill, tr.dataset.key || '', d);
  });

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
  showReportView('main');
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
  $('r-csv').onclick = () => { window.location.href = buildReportQuery('csv'); };
  if ($('drill-back')) $('drill-back').onclick = () => showReportView('main');
}
