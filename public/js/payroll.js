// Модуль «Зарплата» (/payroll): штатные работники теплицы (без доступа к сайту) и выдача ЗП / авансов / премий.
import { api, errMsg, newRequestId } from './api.js';
import { readDecimal, round2 } from './num.js';
import { editBtnHtml, moreBtnHtml, openRowMenu } from './ui.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const dm = (s) => (s && s.length >= 10 ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : s || '');

const PAY_LABEL = { cash: 'Наличные', card: 'Карта', transfer: 'Перечисление' };

let deps = { me: () => null, cur: () => 'сум', toast: () => {}, askText: async () => null };
const isAdmin = () => { const me = deps.me && deps.me(); return !!me && me.role === 'admin'; };

let subTab = 'payouts'; // payouts | staff
let staffList = [];
let byEmpMap = {};
let selWorker = '';
let payKind = 'Зарплата';
let payMethod = 'cash';
let editStaffTarget = null;
let payReqId = newRequestId();
let staffReqId = newRequestId();

function showPrView(mode) {
  $('pr-main-view').hidden = mode !== 'main';
  $('pr-pay-view').hidden = mode !== 'pay';
  $('pr-staff-view').hidden = mode !== 'staff';
  window.scrollTo(0, 0);
}

function switchSubTab(tab) {
  subTab = tab;
  document.querySelectorAll('#pr-subtabs button').forEach((b) => b.classList.toggle('sel', b.dataset.prt === tab));
  $('pr-tab-payouts').hidden = tab !== 'payouts';
  $('pr-tab-staff').hidden = tab !== 'staff';
}

function setDefaultPeriod() {
  const today = iso(new Date());
  if (!$('pr-from').value) {
    $('pr-from').value = today.slice(0, 8) + '01';
    $('pr-to').value = today;
  }
}

function renderWorkerChips() {
  const active = staffList.filter((s) => s.active);
  const box = $('pr-w-chips');
  if (!box) return;
  if (selWorker && !active.some((s) => s.name === selWorker)) selWorker = active[0]?.name || '';
  if (!selWorker && active.length) selWorker = active[0].name;

  box.innerHTML = active.map((s) =>
    `<button type="button" class="chip${selWorker === s.name ? ' sel' : ''}" data-w="${esc(s.name)}">${esc(s.name)}${s.position ? ` · ${esc(s.position)}` : ''}</button>`
  ).join('') || '<div class="small muted">Сначала добавьте работника кнопкой «+ Работник»</div>';

  box.onclick = (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    selWorker = b.dataset.w;
    box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('sel', c === b));
    const st = active.find((s) => s.name === selWorker);
    if (st && st.salary > 0 && !$('pr-p-amt').value) $('pr-p-amt').value = String(st.salary);
  };
}

function openPayoutPage(preselectName = '') {
  if (!isAdmin()) return;
  payReqId = newRequestId();
  selWorker = preselectName || '';
  payKind = 'Зарплата';
  payMethod = 'cash';
  const today = iso(new Date());
  $('pr-p-date').value = today;
  $('pr-p-period').value = `${today.slice(5, 7)}.${today.slice(0, 4)}`;
  $('pr-p-comment').value = '';
  $('pr-p-err').textContent = '';

  const st = staffList.find((s) => s.name === preselectName);
  $('pr-p-amt').value = st && st.salary > 0 ? String(st.salary) : '';

  renderWorkerChips();
  document.querySelectorAll('#pr-p-kind .chip').forEach((c) => c.classList.toggle('sel', c.dataset.pk === payKind));
  document.querySelectorAll('#pr-p-pm .chip').forEach((c) => c.classList.toggle('sel', c.dataset.pm === payMethod));
  showPrView('pay');
  $('pr-p-amt').focus();
}

function openStaffPage(s = null) {
  if (!isAdmin()) return;
  editStaffTarget = s;
  staffReqId = newRequestId();
  $('pr-st-title').textContent = s ? s.name : 'Новый работник теплицы';
  $('pr-st-name').value = s ? s.name : '';
  $('pr-st-pos').value = s ? (s.position || '') : '';
  $('pr-st-sal').value = s && s.salary ? String(s.salary) : '';
  $('pr-st-phone').value = s ? (s.phone || '') : '';
  $('pr-st-note').value = s ? (s.note || '') : '';
  $('pr-st-err').textContent = '';
  const tog = $('pr-st-toggle');
  tog.hidden = !s;
  if (s) {
    tog.textContent = s.active ? 'Уволить / Скрыть' : 'Вернуть в штат';
    tog.className = s.active ? 'btn ghost danger' : 'btn ghost';
  }
  showPrView('staff');
  $('pr-st-name').focus();
}

export async function loadPayroll() {
  showPrView('main');
  setDefaultPeriod();
  const cur = deps.cur();
  const admin = isAdmin();
  $('pr-open-pay').hidden = !admin;
  $('pr-open-staff').hidden = !admin;

  const qs = new URLSearchParams({ resource: 'payroll', from: $('pr-from').value, to: $('pr-to').value });
  const r = await api('GET', `/api/report?${qs.toString()}`);
  if (!r.ok) return;

  const { total = 0, count = 0, staff = [], by_employee = [], payments = [] } = r.data;
  staffList = staff;
  byEmpMap = Object.fromEntries(by_employee.map((x) => [x.employee.toLowerCase(), x]));

  $('pr-total').textContent = money(total);
  $('pr-cur').textContent = cur;
  $('pr-count').textContent = `Выплат за период: ${count} · Работников в штате: ${staff.filter((s) => s.active).length}`;

  // Сводка по работникам за период
  $('pr-by-emp').innerHTML = by_employee.length
    ? `<ul class="list">${by_employee.map((x) => {
      const st = staff.find((s) => s.name.toLowerCase() === x.employee.toLowerCase());
      const salInfo = st && st.salary > 0 ? ` · оклад ${money(st.salary)}` : '';
      return `
        <li class="li">
          <div class="l">
            <div class="t">${esc(x.employee)}${st && st.position ? ` <span class="small muted" style="font-weight:400">· ${esc(st.position)}</span>` : ''}</div>
            <div class="s">выплат: ${x.count}${salInfo}</div>
          </div>
          <div class="r"><b>${money(x.amount)}</b> <span class="small muted">${esc(cur)}</span></div>
        </li>`;
    }).join('')}</ul>`
    : '<div class="empty">Выплат ЗП за период нет</div>';

  // История выплат ЗП
  $('pr-rows').innerHTML = payments.map((p) => {
    const cancelled = p.status === 'cancelled';
    const meta = [
      dm(p.doc_date),
      PAY_LABEL[p.payment_method] || p.payment_method,
      p.comment ? esc(p.comment) : '',
      p.user_name ? esc(p.user_name) : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="hi ${cancelled ? 'cancelled' : ''}" style="--tc:#1b1b1b;align-items:center">
        <div class="bar" style="align-self:stretch"></div>
        <div class="l" style="flex:1;min-width:0">
          <div class="t">${esc(p.employee || 'Сотрудник не указан')}</div>
          <div class="s small muted">${meta}</div>
          ${cancelled ? `<div class="small muted">отмена: ${esc(p.cancel_reason || '')}</div>` : ''}
        </div>
        <div class="r" style="display:flex;align-items:center;gap:6px;flex:none">
          <span style="font-weight:700;white-space:nowrap">${money(p.amount)} <span class="small muted" style="font-weight:500">${esc(cur)}</span></span>
          ${!cancelled && admin ? moreBtnHtml(`data-pr-menu="${p.id}"`, 'Действия') : ''}
        </div>
      </div>`;
  }).join('') || '<div class="empty">Выплат за выбранный период нет</div>';

  $('pr-rows').querySelectorAll('[data-pr-menu]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = Number(b.dataset.prMenu);
      openRowMenu(b, [
        {
          label: 'Отменить выплату',
          danger: true,
          onClick: async () => {
            const reason = await deps.askText({ title: `Отменить выплату №${id}`, label: 'Причина отмены', placeholder: 'Укажите причину', okText: 'Отменить' });
            if (!reason) return;
            const r2 = await api('PATCH', '/api/report?resource=payroll', { target: 'payout', id, reason });
            deps.toast(r2.ok ? 'Выплата отменена' : errMsg(r2), !r2.ok);
            if (r2.ok) loadPayroll();
          },
        },
      ]);
    };
  });

  // Вкладка «Работники»
  $('pr-staff-list').innerHTML = staff.map((s) => {
    const paid = byEmpMap[s.name.toLowerCase()]?.amount || 0;
    const meta = [
      s.position ? esc(s.position) : '',
      s.salary > 0 ? `оклад ${money(s.salary)} ${esc(cur)}` : '',
      s.phone ? esc(s.phone) : '',
      s.active ? '' : '<span class="badge b-off">Уволен</span>',
    ].filter(Boolean).join(' · ');
    return `
      <div class="cp-card${s.active ? '' : ' off'}">
        <div class="cp-top">
          <div style="min-width:0;flex:1">
            <div class="cp-name">${esc(s.name)}</div>
            ${meta ? `<div class="small muted" style="margin-top:3px">${meta}</div>` : ''}
            ${s.note ? `<div class="small muted" style="margin-top:2px">${esc(s.note)}</div>` : ''}
            <div class="small muted" style="margin-top:4px">Выдано за период: <b style="color:var(--ink)">${money(paid)} ${esc(cur)}</b></div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex:none">
            ${admin && s.active ? `<button type="button" class="btn sm" data-give-zp="${esc(s.name)}">Выдать ЗП</button>` : ''}
            ${admin ? editBtnHtml(`data-edit-st="${s.id}"`, 'Редактировать работника') : ''}
          </div>
        </div>
      </div>`;
  }).join('') || '<div class="empty">Работников пока нет. Нажмите «+ Работник», чтобы добавить сотрудников теплицы.</div>';

  $('pr-staff-list').querySelectorAll('[data-give-zp]').forEach((b) => {
    b.onclick = () => openPayoutPage(b.dataset.giveZp);
  });
  $('pr-staff-list').querySelectorAll('[data-edit-st]').forEach((b) => {
    b.onclick = () => {
      const s = staffList.find((x) => String(x.id) === b.dataset.editSt);
      if (s) openStaffPage(s);
    };
  });

  switchSubTab(subTab);
}

export function initPayroll(config) {
  deps = config;

  $('pr-subtabs').onclick = (e) => {
    const b = e.target.closest('[data-prt]');
    if (!b) return;
    switchSubTab(b.dataset.prt);
  };

  document.querySelectorAll('[data-prrange]').forEach((b) => {
    b.onclick = () => {
      const now = new Date();
      const today = iso(now);
      if (b.dataset.prrange === 'month') {
        $('pr-from').value = today.slice(0, 8) + '01';
        $('pr-to').value = today;
      } else if (b.dataset.prrange === 'prevmonth') {
        $('pr-from').value = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        $('pr-to').value = iso(new Date(now.getFullYear(), now.getMonth(), 0));
      } else {
        $('pr-from').value = today;
        $('pr-to').value = today;
      }
      loadPayroll();
    };
  });
  $('pr-from').onchange = loadPayroll;
  $('pr-to').onchange = loadPayroll;

  $('pr-open-pay').onclick = () => openPayoutPage('');
  $('pr-open-staff').onclick = () => openStaffPage(null);
  $('pr-p-add-w').onclick = () => openStaffPage(null);
  $('pr-p-back').onclick = () => showPrView('main');
  $('pr-p-cancel').onclick = () => showPrView('main');
  $('pr-st-back').onclick = () => showPrView('main');
  $('pr-st-cancel').onclick = () => showPrView('main');

  $('pr-p-kind').onclick = (e) => {
    const b = e.target.closest('[data-pk]');
    if (!b) return;
    payKind = b.dataset.pk;
    document.querySelectorAll('#pr-p-kind .chip').forEach((c) => c.classList.toggle('sel', c === b));
  };
  $('pr-p-pm').onclick = (e) => {
    const b = e.target.closest('[data-pm]');
    if (!b) return;
    payMethod = b.dataset.pm;
    document.querySelectorAll('#pr-p-pm .chip').forEach((c) => c.classList.toggle('sel', c === b));
  };

  // Выдать ЗП
  $('pr-p-save').onclick = async () => {
    const b = $('pr-p-save');
    if (b.disabled) return;
    if (!selWorker) { $('pr-p-err').textContent = 'Выберите работника'; return; }
    const amt = readDecimal('pr-p-amt', { label: 'Сумма', positive: true, max: 1e12 });
    if (!amt.ok) { $('pr-p-err').textContent = amt.error; return; }
    $('pr-p-err').textContent = '';
    b.disabled = true;
    try {
      const r = await api('POST', '/api/report?resource=payroll', {
        target: 'payout',
        doc_date: $('pr-p-date').value,
        employee: selWorker,
        pay_kind: payKind,
        period: $('pr-p-period').value,
        amount: round2(amt.value),
        payment_method: payMethod,
        comment: $('pr-p-comment').value,
        request_id: payReqId,
      });
      if (!r.ok) { $('pr-p-err').textContent = errMsg(r); return; }
      payReqId = newRequestId();
      deps.toast(r.data.duplicate ? 'Эта выплата уже проведена' : `Выплата ЗП для «${selWorker}» проведена`);
      subTab = 'payouts';
      await loadPayroll();
    } finally {
      b.disabled = false;
    }
  };

  // Сохранить работника
  $('pr-st-toggle').onclick = async () => {
    if (!editStaffTarget) return;
    const b = $('pr-st-toggle');
    b.disabled = true;
    try {
      const r = await api('PATCH', '/api/report?resource=payroll', { target: 'staff', id: editStaffTarget.id, active: !editStaffTarget.active });
      if (!r.ok) { $('pr-st-err').textContent = errMsg(r); return; }
      deps.toast(editStaffTarget.active ? 'Работник скрыт' : 'Работник возвращён в штат');
      subTab = 'staff';
      await loadPayroll();
    } finally {
      b.disabled = false;
    }
  };

  $('pr-st-save').onclick = async () => {
    const b = $('pr-st-save');
    if (b.disabled) return;
    const salRaw = $('pr-st-sal').value.trim();
    let salary = 0;
    if (salRaw) {
      const sal = readDecimal('pr-st-sal', { label: 'Оклад', max: 1e12 });
      if (!sal.ok) { $('pr-st-err').textContent = sal.error; return; }
      salary = round2(sal.value);
    }
    $('pr-st-err').textContent = '';
    b.disabled = true;
    try {
      const payload = {
        target: 'staff',
        name: $('pr-st-name').value,
        position: $('pr-st-pos').value,
        salary,
        phone: $('pr-st-phone').value,
        note: $('pr-st-note').value,
      };
      const r = editStaffTarget
        ? await api('PATCH', '/api/report?resource=payroll', { ...payload, id: editStaffTarget.id })
        : await api('POST', '/api/report?resource=payroll', { ...payload, request_id: staffReqId });
      if (!r.ok) { $('pr-st-err').textContent = errMsg(r); return; }
      if (!editStaffTarget) staffReqId = newRequestId();
      deps.toast(editStaffTarget ? 'Карточка работника обновлена' : 'Работник добавлен в штат');
      subTab = 'staff';
      await loadPayroll();
    } finally {
      b.disabled = false;
    }
  };
}
