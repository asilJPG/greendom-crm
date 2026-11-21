// Модуль «Инвестиции» (/investments): капитальные вложения в теплицу, учредители и окупаемость (ROI).
import { api, errMsg, newRequestId } from './api.js';
import { readDecimal, round2 } from './num.js';
import { moreBtnHtml, openRowMenu } from './ui.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const dm = (s) => (s && s.length >= 10 ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : s || '');

const PAY_LABEL = { cash: 'Наличные', card: 'Карта', transfer: 'Перечисление' };
const INV_CATS = [
  'Постройка теплицы',
  'Оборудование и полив',
  'Плёнка и укрытие',
  'Рассада и субстрат',
  'Техника и транспорт',
  'Коммуникации и отопление',
  'Прочие вложения',
];

let deps = { me: () => null, cur: () => 'сум', toast: () => {}, askText: async () => null };
let payMethod = 'transfer';
let editingInvId = null;
let invReqId = newRequestId(); // request_id формы нового вложения: один на форму, новый после успеха
let selectedYear = String(new Date().getFullYear());
const isAdmin = () => { const me = deps.me && deps.me(); return !!me && me.role === 'admin'; };

function showSubView(mode) {
  $('inv-list-view').hidden = mode !== 'list';
  $('inv-doc-view').hidden = mode !== 'doc';
  window.scrollTo(0, 0);
}

function openInvestmentForm(x = null) {
  editingInvId = x ? x.id : null;
  payMethod = x ? (x.payment_method || 'transfer') : 'transfer';
  $('inv-form-title').textContent = x ? `Редактирование вложения №${x.id}` : 'Новое капитальное вложение';
  $('inv-f-save').textContent = x ? 'Сохранить изменения' : 'Сохранить вложение';
  $('inv-f-date').value = x ? x.doc_date : iso(new Date());
  $('inv-f-title').value = x ? x.title : '';
  $('inv-f-cat').value = x && INV_CATS.includes(x.category) ? x.category : INV_CATS[0];
  $('inv-f-investor').value = x ? (x.investor || '') : '';
  $('inv-f-amt').value = x ? String(x.amount) : '';
  $('inv-f-docno').value = x ? (x.doc_number || '') : '';
  $('inv-f-comment').value = x ? (x.comment || '') : '';
  $('inv-f-err').textContent = '';
  document.querySelectorAll('#inv-f-pm .chip').forEach((c) => c.classList.toggle('sel', c.dataset.pm === payMethod));
  showSubView('doc');
  $('inv-f-title').focus();
}

export async function loadInvestments() {
  showSubView('list');
  $('inv-open-add').hidden = !isAdmin();
  const qs = selectedYear && selectedYear !== 'all' ? `&year=${encodeURIComponent(selectedYear)}` : '';
  const r = await api('GET', `/api/report?resource=investments${qs}`);
  if (!r.ok) return;
  const { year = 'all', years = [], summary: s, by_investor = [], by_category = [], items = [] } = r.data;
  const cur = deps.cur();
  const isYear = typeof year === 'number';
  const pctClamped = Math.max(0, Math.min(100, s.payback_pct || 0));

  // Чипы выбора года + «Всё время»
  const chipsEl = $('inv-year-chips');
  if (chipsEl) {
    chipsEl.innerHTML = [
      ...years.map((y) => `<button type="button" class="chip${String(year) === String(y) ? ' sel' : ''}" data-iy="${y}">${y} год</button>`),
      `<button type="button" class="chip${year === 'all' ? ' sel' : ''}" data-iy="all">Всё время</button>`,
    ].join('');
    chipsEl.onclick = (e) => {
      const b = e.target.closest('[data-iy]');
      if (!b) return;
      selectedYear = b.dataset.iy;
      loadInvestments();
    };
  }

  // Первая карточка: при переносе неокупленного остатка с прошлого года заголовок меняется на «Осталось окупить»
  let k1Title = 'Всего вложено (CAPEX)';
  let k1Sub = `документов: ${s.count}`;
  if (isYear) {
    if (s.carryover_in > 0) {
      k1Title = 'Осталось окупить';
      k1Sub = s.year_invested > 0
        ? `перенос ${money(s.carryover_in)} + вложено в ${year}: ${money(s.year_invested)}`
        : `перенесено с ${year - 1} г.`;
    } else {
      k1Title = `Вложено в ${year} г.`;
      k1Sub = `документов: ${s.count}`;
    }
  }
  const k2Title = isYear ? `Прибыль за ${year} г.` : 'Накопленная прибыль';
  const k4Title = isYear ? `Остаток на конец ${year} г.` : 'Осталось окупить';
  const k4Sub = s.remaining === 0 && s.to_recover > 0
    ? 'Проект окупился'
    : (isYear && s.remaining > 0 ? `перейдёт на ${year + 1} г.` : 'до выхода в чистый плюс');

  $('inv-kpis').innerHTML = `
    <div class="kpi">
      <div class="k">${k1Title}</div>
      <div class="v">${money(s.total_invested)} <small>${esc(cur)}</small></div>
      <div class="subk">${k1Sub}</div>
    </div>
    <div class="kpi">
      <div class="k">${k2Title}</div>
      <div class="v" style="color:${s.cumulative_profit >= 0 ? 'var(--grn)' : 'var(--red)'}">${money(s.cumulative_profit)} <small>${esc(cur)}</small></div>
      <div class="subk">выручка − опер. расходы</div>
    </div>
    <div class="kpi">
      <div class="k">Окупаемость (ROI)</div>
      <div class="v">${s.payback_pct || 0}<small>%</small></div>
      <div class="prog" style="max-width:none;margin-top:8px"><span style="width:${pctClamped}%;background:${pctClamped >= 100 ? 'var(--grn)' : 'var(--btn)'}"></span></div>
    </div>
    <div class="kpi">
      <div class="k">${k4Title}</div>
      <div class="v">${money(s.remaining)} <small>${esc(cur)}</small></div>
      <div class="subk">${k4Sub}</div>
    </div>`;

  const renderBreakdown = (list, keyField, emptyText) => list.length
    ? `<ul class="list">${list.map((x) => `
      <li class="li">
        <div class="l">
          <div class="t">${esc(x[keyField])} <span class="small muted" style="font-weight:500">${x.share_pct}%</span></div>
          <div class="prog"><span style="width:${Math.min(100, x.share_pct)}%"></span></div>
        </div>
        <div class="r"><b>${money(x.amount)}</b> <span class="small muted">${esc(cur)}</span></div>
      </li>`).join('')}</ul>`
    : `<div class="empty">${emptyText}</div>`;

  $('inv-by-investor').innerHTML = renderBreakdown(by_investor, 'investor', 'Вложений ещё нет');
  $('inv-by-cat').innerHTML = renderBreakdown(by_category, 'category', 'Вложений ещё нет');

  $('inv-rows').innerHTML = items.map((x) => {
    const cancelled = x.status === 'cancelled';
    const meta = [
      `<span class="badge b-director">${esc(x.category)}</span>`,
      dm(x.doc_date),
      x.investor ? `Инвестор: ${esc(x.investor)}` : '',
      PAY_LABEL[x.payment_method] || x.payment_method,
      x.doc_number ? `№ ${esc(x.doc_number)}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="hi ${cancelled ? 'cancelled' : ''}" style="--tc:#1b1b1b;align-items:center">
        <div class="bar" style="align-self:stretch"></div>
        <div class="l" style="flex:1;min-width:0">
          <div class="t">${esc(x.title)}</div>
          <div class="s small muted">${meta}</div>
          ${x.comment ? `<div class="small muted" style="margin-top:2px">${esc(x.comment)}</div>` : ''}
          ${cancelled ? `<div class="small muted">отмена: ${esc(x.cancel_reason || '')}</div>` : ''}
        </div>
        <div class="r" style="display:flex;align-items:center;gap:6px;flex:none">
          <span style="font-weight:700;white-space:nowrap">${money(x.amount)} <span class="small muted" style="font-weight:500">${esc(cur)}</span></span>
          ${isAdmin() ? moreBtnHtml(`data-inv-menu="${x.id}"`, 'Действия') : ''}
        </div>
      </div>`;
  }).join('') || '<div class="empty">Записей об инвестициях пока нет. Нажмите «+ Вложение», чтобы внести стартовые расходы теплицы.</div>';

  $('inv-rows').querySelectorAll('[data-inv-menu]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = Number(b.dataset.invMenu);
      const item = items.find((x) => x.id === id);
      if (item && item.status === 'cancelled') {
        openRowMenu(b, [
          {
            label: 'Восстановить вложение',
            onClick: async () => {
              const r2 = await api('PATCH', '/api/report?resource=investments', { id, action: 'restore' });
              deps.toast(r2.ok ? 'Вложение восстановлено' : errMsg(r2), !r2.ok);
              if (r2.ok) loadInvestments();
            },
          },
        ]);
        return;
      }
      openRowMenu(b, [
        {
          label: 'Изменить вложение',
          onClick: () => { if (item) openInvestmentForm(item); },
        },
        {
          label: 'Отменить вложение',
          danger: true,
          onClick: async () => {
            const reason = await deps.askText({ title: `Отменить вложение №${id}`, label: 'Причина отмены', placeholder: 'Укажите причину', okText: 'Отменить' });
            if (!reason) return;
            if (b.disabled) return;
            b.disabled = true;
            try {
              const r2 = await api('PATCH', '/api/report?resource=investments', { id, reason });
              deps.toast(r2.ok ? 'Запись отменена' : errMsg(r2), !r2.ok);
              if (r2.ok) loadInvestments();
            } finally {
              b.disabled = false;
            }
          },
        },
      ]);
    };
  });
}

export function initInvestments(config) {
  deps = config;
  $('inv-f-cat').innerHTML = INV_CATS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('inv-open-add').onclick = () => { if (isAdmin()) openInvestmentForm(null); };
  $('inv-back').onclick = () => showSubView('list');
  $('inv-f-cancel').onclick = () => showSubView('list');

  $('inv-f-pm').onclick = (e) => {
    const b = e.target.closest('[data-pm]');
    if (!b) return;
    payMethod = b.dataset.pm;
    document.querySelectorAll('#inv-f-pm .chip').forEach((c) => c.classList.toggle('sel', c === b));
  };

  $('inv-f-save').onclick = async () => {
    const b = $('inv-f-save');
    if (b.disabled) return;
    if (!isAdmin()) { $('inv-f-err').textContent = 'Вносить вложения может только администратор'; return; }
    const amt = readDecimal('inv-f-amt', { label: 'Сумма', positive: true, max: 1e13 });
    if (!amt.ok) { $('inv-f-err').textContent = amt.error; $('inv-f-amt').focus(); return; }
    $('inv-f-err').textContent = '';
    b.disabled = true;
    try {
      const payload = {
        doc_date: $('inv-f-date').value,
        category: $('inv-f-cat').value,
        title: $('inv-f-title').value,
        investor: $('inv-f-investor').value,
        amount: round2(amt.value),
        payment_method: payMethod,
        doc_number: $('inv-f-docno').value,
        comment: $('inv-f-comment').value,
      };
      const r = editingInvId
        ? await api('PATCH', '/api/report?resource=investments', { ...payload, id: editingInvId, action: 'edit' })
        : await api('POST', '/api/report?resource=investments', { ...payload, request_id: invReqId });
      if (!r.ok) { $('inv-f-err').textContent = errMsg(r); return; }
      if (!editingInvId) invReqId = newRequestId();
      deps.toast(editingInvId ? 'Вложение обновлено' : r.data && r.data.duplicate ? 'Это вложение уже было записано' : 'Инвестиция записана');
      await loadInvestments();
    } finally {
      b.disabled = false;
    }
  };
}
