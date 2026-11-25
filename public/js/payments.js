// Модуль «Акты оплаты» (/payments): журнал всех оплат по контрагентам (поступления и выплаты, как выписка в 1С).
// Все записи автоматически попадают в Акт сверки соответствующего контрагента.
import { api, errMsg, newRequestId } from './api.js';
import { readDecimal, round2 } from './num.js';
import { moreBtnHtml, openRowMenu } from './ui.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const dm = (s) => (s && s.length >= 10 ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : s || '');

const PAY_LABEL = { cash: 'Наличные', card: 'Карта', transfer: 'Перечисление' };

let deps = { me: () => null, cur: () => 'сум', toast: () => {}, askText: async () => null };
const isAdmin = () => { const me = deps.me && deps.me(); return !!me && me.role === 'admin'; };
const canAdd = () => { const me = deps.me && deps.me(); return !!me && (me.role === 'admin' || me.role === 'accountant'); };

let dirFilter = '';
let formDir = 'in';
let formPm = 'cash';
let saveReqId = newRequestId();

function showPayView(mode) {
  $('pay-list-view').hidden = mode !== 'list';
  $('pay-new-view').hidden = mode !== 'new';
  window.scrollTo(0, 0);
}

function setDefaultPeriod() {
  const today = iso(new Date());
  if (!$('pm-from').value) {
    $('pm-from').value = today.slice(0, 8) + '01';
    $('pm-to').value = today;
  }
}

function openNewPayAct() {
  if (!isAdmin()) return;
  saveReqId = newRequestId();
  formDir = 'in';
  formPm = 'cash';
  $('pm-f-date').value = iso(new Date());
  $('pm-f-cp').value = '';
  $('pm-f-amt').value = '';
  $('pm-f-comment').value = '';
  $('pm-f-err').textContent = '';
  document.querySelectorAll('#pm-f-dir .chip').forEach((c) => c.classList.toggle('sel', c.dataset.dir === formDir));
  document.querySelectorAll('#pm-f-pm .chip').forEach((c) => c.classList.toggle('sel', c.dataset.pm === formPm));
  showPayView('new');
  $('pm-f-cp').focus();
}

export async function loadPayments() {
  showPayView('list');
  setDefaultPeriod();
  const cur = deps.cur();
  $('pm-open-add').hidden = !canAdd();

  const qs = new URLSearchParams({ resource: 'payments', from: $('pm-from').value, to: $('pm-to').value });
  if (dirFilter) qs.set('direction', dirFilter);
  const r = await api('GET', `/api/report?${qs.toString()}`);
  if (!r.ok) return;

  const { total_in = 0, total_out = 0, net = 0, items = [] } = r.data;
  $('pm-kpis').innerHTML = `
    <div class="kpi">
      <div class="k">Поступления (нам)</div>
      <div class="v" style="color:var(--grn)">+${money(total_in)} <small>${esc(cur)}</small></div>
      <div class="subk">оплаты от покупателей</div>
    </div>
    <div class="kpi">
      <div class="k">Выплаты (мы)</div>
      <div class="v" style="color:${total_out > 0 ? 'var(--red)' : 'var(--ink)'}">−${money(total_out)} <small>${esc(cur)}</small></div>
      <div class="subk">поставщикам и сотрудникам</div>
    </div>
    <div class="kpi">
      <div class="k">Сальдо за период</div>
      <div class="v" style="color:${net >= 0 ? 'var(--grn)' : 'var(--red)'}">${net >= 0 ? '+' : ''}${money(net)} <small>${esc(cur)}</small></div>
      <div class="subk">документов: ${items.filter((x) => x.status === 'active').length}</div>
    </div>`;

  $('pm-rows').innerHTML = items.map((x) => {
    const cancelled = x.status === 'cancelled';
    const isIn = x.direction === 'in';
    const badge = isIn
      ? '<span class="badge b-in">Поступление</span>'
      : '<span class="badge b-writeoff">Выплата</span>';
    const meta = [
      badge,
      dm(x.doc_date),
      PAY_LABEL[x.payment_method] || x.payment_method,
      x.user_name ? esc(x.user_name) : '',
    ].filter(Boolean).join(' · ');
    const amtColor = cancelled ? 'var(--mut)' : (isIn ? 'var(--grn)' : 'var(--red)');
    return `
      <div class="hi ${cancelled ? 'cancelled' : ''}" style="--tc:${isIn ? '#2c7a4e' : '#b1362d'};align-items:center">
        <div class="bar" style="align-self:stretch"></div>
        <div class="l" style="flex:1;min-width:0">
          <div class="t">Акт оплаты №${x.id} · ${esc(x.counterparty)}</div>
          <div class="s small muted">${meta}</div>
          ${x.comment ? `<div class="small muted" style="margin-top:2px">${esc(x.comment)}</div>` : ''}
          ${cancelled ? `<div class="small muted">отмена: ${esc(x.cancel_reason || '')}</div>` : ''}
        </div>
        <div class="r" style="display:flex;align-items:center;gap:6px;flex:none">
          <span style="font-weight:700;white-space:nowrap;color:${amtColor}">${isIn ? '+' : '−'}${money(x.amount)} <span class="small muted" style="font-weight:500">${esc(cur)}</span></span>
          ${isAdmin() ? moreBtnHtml(`data-pm-menu="${x.id}"`, 'Действия') : ''}
        </div>
      </div>`;
  }).join('') || '<div class="empty">Оплат за выбранный период нет</div>';

  $('pm-rows').querySelectorAll('[data-pm-menu]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = Number(b.dataset.pmMenu);
      const item = items.find((x) => x.id === id);
      if (!item) return;
      if (item.status === 'cancelled') {
        openRowMenu(b, [
          {
            label: 'Восстановить оплату',
            onClick: async () => {
              const r2 = await api('PATCH', '/api/report?resource=payments', { id, action: 'restore' });
              deps.toast(r2.ok ? 'Оплата восстановлена' : errMsg(r2), !r2.ok);
              if (r2.ok) loadPayments();
            },
          },
        ]);
        return;
      }
      openRowMenu(b, [
        {
          label: 'Отменить оплату',
          danger: true,
          onClick: async () => {
            const reason = await deps.askText({ title: `Отменить акт оплаты №${id}`, label: 'Причина отмены', placeholder: 'Укажите причину', okText: 'Отменить' });
            if (!reason) return;
            const r2 = await api('PATCH', '/api/report?resource=payments', { id, reason });
            deps.toast(r2.ok ? 'Оплата отменена' : errMsg(r2), !r2.ok);
            if (r2.ok) loadPayments();
          },
        },
      ]);
    };
  });
}

export function initPayments(config) {
  deps = config;

  document.querySelectorAll('[data-pmrange]').forEach((b) => {
    b.onclick = () => {
      const now = new Date();
      const today = iso(now);
      if (b.dataset.pmrange === 'month') {
        $('pm-from').value = today.slice(0, 8) + '01';
        $('pm-to').value = today;
      } else if (b.dataset.pmrange === 'prevmonth') {
        $('pm-from').value = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        $('pm-to').value = iso(new Date(now.getFullYear(), now.getMonth(), 0));
      } else {
        $('pm-from').value = today;
        $('pm-to').value = today;
      }
      loadPayments();
    };
  });
  $('pm-from').onchange = loadPayments;
  $('pm-to').onchange = loadPayments;

  $('pm-dir-filter').onclick = (e) => {
    const b = e.target.closest('[data-df]');
    if (!b) return;
    dirFilter = b.dataset.df;
    document.querySelectorAll('#pm-dir-filter .chip').forEach((c) => c.classList.toggle('sel', c === b));
    loadPayments();
  };

  $('pm-open-add').onclick = openNewPayAct;
  $('pm-back').onclick = () => showPayView('list');
  $('pm-f-cancel').onclick = () => showPayView('list');

  $('pm-f-dir').onclick = (e) => {
    const b = e.target.closest('[data-dir]');
    if (!b) return;
    formDir = b.dataset.dir;
    document.querySelectorAll('#pm-f-dir .chip').forEach((c) => c.classList.toggle('sel', c === b));
  };
  $('pm-f-pm').onclick = (e) => {
    const b = e.target.closest('[data-pm]');
    if (!b) return;
    formPm = b.dataset.pm;
    document.querySelectorAll('#pm-f-pm .chip').forEach((c) => c.classList.toggle('sel', c === b));
  };

  $('pm-f-save').onclick = async () => {
    const b = $('pm-f-save');
    if (b.disabled) return;
    const cp = $('pm-f-cp').value.trim();
    if (cp.length < 2) { $('pm-f-err').textContent = 'Выберите или введите контрагента'; return; }
    const amt = readDecimal('pm-f-amt', { label: 'Сумма', positive: true, max: 1e12 });
    if (!amt.ok) { $('pm-f-err').textContent = amt.error; return; }
    b.disabled = true;
    try {
      const r = await api('POST', '/api/report?resource=payments', {
        doc_date: $('pm-f-date').value,
        counterparty: cp,
        direction: formDir,
        amount: round2(amt.value),
        payment_method: formPm,
        comment: $('pm-f-comment').value,
        request_id: saveReqId,
      });
      if (!r.ok) { $('pm-f-err').textContent = errMsg(r); return; }
      saveReqId = newRequestId();
      deps.toast(r.data.duplicate ? 'Этот акт оплаты уже проведён' : `Акт оплаты №${r.data.id} проведён`);
      await loadPayments();
    } finally {
      b.disabled = false;
    }
  };
}
