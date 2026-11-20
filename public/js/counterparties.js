// Модуль «Контрагенты и Акт сверки»: список контрагентов, взаиморасчёты, оплаты и печатный/PNG Акт сверки.
import { api, errMsg } from './api.js';
import { editBtnHtml } from './ui.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const dm = (s) => (s && s.length >= 10 ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : s || '');

const KIND_LABEL = {
  buyer: 'Покупатель',
  supplier: 'Поставщик',
  employee: 'Сотрудник',
  both: 'Покупатель / Поставщик',
};

let deps = { cur: () => 'сум', crop: () => 'Клубника', toast: () => {}, askText: async () => null, onRefsChanged: async () => {} };
let rows = [];
let kindFilter = '';
let editTarget = null;
let payTarget = null;
let payDir = 'in';
let payMethod = 'cash';
let recTargetName = '';
let lastRec = null;

function balanceText(bal, cur) {
  const n = Number(bal || 0);
  if (n > 0) return `Задолженность контрагента в нашу пользу: ${money(n)} ${cur}`;
  if (n < 0) return `Наша задолженность перед контрагентом: ${money(Math.abs(n))} ${cur}`;
  return 'Задолженность отсутствует (сальдо 0)';
}

function renderList() {
  const cur = deps.cur();
  const q = ($('cp-search')?.value || '').trim().toLowerCase();
  const activeRows = rows.filter((r) => r.active);
  const debTotal = activeRows.filter((r) => r.balance > 0).reduce((a, r) => a + r.balance, 0);
  const credTotal = activeRows.filter((r) => r.balance < 0).reduce((a, r) => a + Math.abs(r.balance), 0);

  $('cp-kpis').innerHTML = `
    <div class="kpi">
      <div class="k">Должны нам (дебиторка)</div>
      <div class="v" style="color:var(--grn)">${money(debTotal)} <small>${esc(cur)}</small></div>
      <div class="subk">контрагентов: ${activeRows.filter((r) => r.balance > 0).length}</div>
    </div>
    <div class="kpi">
      <div class="k">Должны мы (кредиторка)</div>
      <div class="v" style="color:${credTotal > 0 ? 'var(--red)' : 'var(--ink)'}">${money(credTotal)} <small>${esc(cur)}</small></div>
      <div class="subk">контрагентов: ${activeRows.filter((r) => r.balance < 0).length}</div>
    </div>`;

  const filtered = rows.filter((c) => {
    if (kindFilter) {
      if (kindFilter === 'buyer' && c.kind !== 'buyer' && c.kind !== 'both') return false;
      if (kindFilter === 'supplier' && c.kind !== 'supplier' && c.kind !== 'both') return false;
      if (kindFilter === 'employee' && c.kind !== 'employee') return false;
    }
    if (q) {
      const hay = `${c.name} ${c.inn || ''} ${c.phone || ''} ${c.note || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  $('cp-list').innerHTML = filtered.map((c) => {
    const bal = Number(c.balance || 0);
    const balBadge = bal > 0
      ? `<span class="bal-pill pos">должен нам ${money(bal)} ${esc(cur)}</span>`
      : bal < 0
        ? `<span class="bal-pill neg">мы должны ${money(Math.abs(bal))} ${esc(cur)}</span>`
        : `<span class="bal-pill zero">сальдо 0</span>`;
    const meta = [
      `<span class="badge b-director">${esc(KIND_LABEL[c.kind] || c.kind)}</span>`,
      c.inn ? `ИНН ${esc(c.inn)}` : '',
      c.phone ? esc(c.phone) : '',
      c.active ? '' : '<span class="badge b-off">скрыт</span>',
    ].filter(Boolean).join(' · ');
    const stats = [
      c.sales_total ? `продажи: ${money(c.sales_total)}` : '',
      c.expenses_total ? `расходы: ${money(c.expenses_total)}` : '',
      c.paid_in ? `оплачено нам: ${money(c.paid_in)}` : '',
      c.paid_out ? `выплачено: ${money(c.paid_out)}` : '',
    ].filter(Boolean).join(' · ');

    return `
      <div class="cp-card${c.active ? '' : ' off'}">
        <div class="cp-top">
          <div style="min-width:0;flex:1">
            <div class="cp-name">${esc(c.name)}</div>
            <div class="small muted" style="margin-top:3px">${meta}</div>
            ${stats ? `<div class="small muted" style="margin-top:4px">${stats}</div>` : ''}
            ${c.note ? `<div class="small muted" style="margin-top:2px">${esc(c.note)}</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex:none">
            ${balBadge}
            ${editBtnHtml(`data-cp-act="edit" data-id="${c.id}"`, 'Редактировать контрагента')}
          </div>
        </div>
        <div class="acts" style="margin-top:10px">
          <button class="btn sm" data-cp-act="rec" data-id="${c.id}">Акт сверки</button>
          <button class="btn sec sm" data-cp-act="pay" data-id="${c.id}">+ Оплата</button>
        </div>
      </div>`;
  }).join('') || '<div class="empty">Контрагентов пока нет</div>';

  $('cp-list').querySelectorAll('[data-cp-act]').forEach((b) => {
    b.onclick = async () => {
      const c = rows.find((x) => String(x.id) === b.dataset.id);
      if (!c) return;
      const act = b.dataset.cpAct;
      if (act === 'rec') return openReconcile(c.name);
      if (act === 'pay') return openPayment(c);
      if (act === 'edit') return openCpModal(c);
    };
  });
}

export async function loadCounterparties() {
  const r = await api('GET', '/api/report?resource=reconcile');
  if (!r.ok) return;
  rows = r.data.counterparties || [];
  renderList();
}

/* ───── создание / редактирование контрагента ───── */
function openCpModal(c = null) {
  editTarget = c;
  $('cp-dlg-title').textContent = c ? 'Редактировать контрагента' : 'Новый контрагент';
  $('cp-f-name').value = c ? c.name : '';
  $('cp-f-kind').value = c ? (c.kind || 'buyer') : 'buyer';
  $('cp-f-inn').value = c ? (c.inn || '') : '';
  $('cp-f-phone').value = c ? (c.phone || '') : '';
  $('cp-f-note').value = c ? (c.note || '') : '';
  $('cp-f-err').textContent = '';
  const tog = $('cp-f-toggle');
  if (tog) {
    tog.hidden = !c;
    if (c) {
      tog.textContent = c.active ? 'Скрыть' : 'Вернуть';
      tog.className = c.active ? 'btn ghost danger' : 'btn ghost';
    }
  }
  $('cp-dlg').showModal();
  $('cp-f-name').focus();
}

/* ───── внесение оплаты ───── */
function openPayment(c) {
  payTarget = c;
  payDir = c.kind === 'supplier' || c.kind === 'employee' || c.balance < 0 ? 'out' : 'in';
  payMethod = 'cash';
  $('pay-dlg-title').textContent = `Оплата · ${c.name}`;
  $('pay-date').value = iso(new Date());
  $('pay-amt').value = c.balance !== 0 ? String(Math.abs(c.balance)) : '';
  $('pay-comment').value = '';
  $('pay-err').textContent = '';
  document.querySelectorAll('#pay-dir-chips .chip').forEach((ch) => ch.classList.toggle('sel', ch.dataset.dir === payDir));
  document.querySelectorAll('#pay-pm-chips .chip').forEach((ch) => ch.classList.toggle('sel', ch.dataset.pm === payMethod));
  $('pay-dlg').showModal();
  $('pay-amt').focus();
}

/* ───── Акт сверки взаимных расчётов ───── */
function buildRecHtml(d) {
  const cur = deps.cur();
  const cp = d.counterparty || { name: recTargetName };
  const docRows = (d.docs || []).map((x) => {
    const canCancel = x.type === 'payment_in' || x.type === 'payment_out';
    return `
      <tr>
        <td style="white-space:nowrap">${dm(x.date)}</td>
        <td>${esc(x.title)}${canCancel ? ` <button class="btn sec sm no-print" style="margin-left:6px;min-height:24px;padding:2px 8px;font-size:11.5px" data-cancel-pay="${x.doc_no}">отменить</button>` : ''}</td>
        <td class="num">${x.debit ? money(x.debit) : ''}</td>
        <td class="num">${x.credit ? money(x.credit) : ''}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="4" class="muted" style="text-align:center;padding:14px">Операций за выбранный период нет</td></tr>`;

  const opDeb = d.opening_balance > 0 ? money(d.opening_balance) : '';
  const opCred = d.opening_balance < 0 ? money(Math.abs(d.opening_balance)) : '';
  const clDeb = d.closing_balance > 0 ? money(d.closing_balance) : '';
  const clCred = d.closing_balance < 0 ? money(Math.abs(d.closing_balance)) : '';

  return `
    <div class="inv-sheet">
      <div class="inv-head">
        <div>
          <div class="inv-title">Акт сверки взаимных расчётов</div>
          <div class="inv-date">за период с ${dm(d.from)} по ${dm(d.to)}</div>
        </div>
        <div class="inv-brand">Склад · ${esc(deps.crop())}</div>
      </div>
      <div class="inv-meta">
        <div><span>Контрагент:</span> <b>${esc(cp.name)}</b>${cp.inn ? ` · ИНН ${esc(cp.inn)}` : ''}${cp.phone ? ` · ${esc(cp.phone)}` : ''}</div>
        <div><span>Валюта:</span> ${esc(cur)}</div>
      </div>
      <table class="inv-tbl">
        <thead>
          <tr>
            <th>Дата</th>
            <th>Документ</th>
            <th class="num">Дебет</th>
            <th class="num">Кредит</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background:var(--soft);font-weight:600">
            <td colspan="2">Сальдо на начало периода (${dm(d.from)})</td>
            <td class="num">${opDeb}</td>
            <td class="num">${opCred}</td>
          </tr>
          ${docRows}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2">Обороты за период</td>
            <td class="num">${money(d.total_debit)}</td>
            <td class="num">${money(d.total_credit)}</td>
          </tr>
          <tr>
            <td colspan="2"><b>Сальдо на конец периода (${dm(d.to)})</b></td>
            <td class="num"><b>${clDeb}</b></td>
            <td class="num"><b>${clCred}</b></td>
          </tr>
        </tfoot>
      </table>
      <div style="font-size:13.5px;font-weight:600;margin:-8px 0 16px">${esc(balanceText(d.closing_balance, cur))}</div>
      <div class="inv-signs">
        <div>От нашей организации: _______________________</div>
        <div>От контрагента: _______________________</div>
      </div>
    </div>`;
}

async function fetchReconcile() {
  const from = $('rec-from').value;
  const to = $('rec-to').value;
  const qs = new URLSearchParams({ resource: 'reconcile', counterparty: recTargetName, from, to });
  const r = await api('GET', `/api/report?${qs.toString()}`);
  if (!r.ok) { deps.toast(errMsg(r), true); return; }
  lastRec = r.data;
  $('rec-body').innerHTML = buildRecHtml(lastRec);

  $('rec-body').querySelectorAll('[data-cancel-pay]').forEach((b) => {
    b.onclick = async () => {
      const reason = await deps.askText({ title: `Отменить оплату №${b.dataset.cancelPay}`, label: 'Причина отмены', placeholder: 'Укажите причину', okText: 'Отменить' });
      if (!reason) return;
      const r2 = await api('PATCH', '/api/report?resource=payments', { id: Number(b.dataset.cancelPay), reason });
      deps.toast(r2.ok ? 'Оплата отменена' : errMsg(r2), !r2.ok);
      if (r2.ok) {
        await fetchReconcile();
        await loadCounterparties();
      }
    };
  });
}

function openReconcile(name) {
  recTargetName = name;
  const today = iso(new Date());
  if (!$('rec-from').value) {
    $('rec-from').value = today.slice(0, 8) + '01';
    $('rec-to').value = today;
  }
  $('rec-body').innerHTML = '<div class="empty">Загрузка…</div>';
  $('rec-dlg').showModal();
  fetchReconcile();
}

async function exportRecPng() {
  if (!lastRec) return;
  const d = lastRec;
  const cur = deps.cur();
  const cp = d.counterparty || { name: recTargetName };
  const docs = d.docs || [];
  const W = 820;
  const rowH = 34;
  const H = 310 + Math.max(1, docs.length) * rowH + 140;
  const dpr = 2;
  const c = document.createElement('canvas');
  c.width = W * dpr;
  c.height = H * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);

  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  const pad = 36;
  let y = 44;

  g.fillStyle = '#1b1b1b';
  g.font = '700 22px Figtree, -apple-system, sans-serif';
  g.fillText('Акт сверки взаимных расчётов', pad, y);
  g.fillStyle = '#6b6b70';
  g.font = '500 13px Figtree, -apple-system, sans-serif';
  g.textAlign = 'right';
  g.fillText(`Склад · ${deps.crop()}`, W - pad, y);
  g.textAlign = 'left';
  y += 22;
  g.fillText(`за период с ${dm(d.from)} по ${dm(d.to)}`, pad, y);
  y += 14;
  g.strokeStyle = '#e5e5e7';
  g.beginPath(); g.moveTo(pad, y); g.lineTo(W - pad, y); g.stroke();
  y += 24;

  g.fillStyle = '#1b1b1b';
  g.font = '600 14px Figtree, -apple-system, sans-serif';
  g.fillText(`Контрагент: ${cp.name}${cp.inn ? ` · ИНН ${cp.inn}` : ''}${cp.phone ? ` · ${cp.phone}` : ''}`, pad, y);
  y += 26;

  // Заголовок таблицы
  g.fillStyle = '#f4f4f6';
  g.fillRect(pad, y, W - pad * 2, 32);
  g.fillStyle = '#55555a';
  g.font = '600 12.5px Figtree, -apple-system, sans-serif';
  g.fillText('Дата', pad + 10, y + 21);
  g.fillText('Документ', pad + 105, y + 21);
  g.textAlign = 'right';
  g.fillText('Дебет', W - pad - 135, y + 21);
  g.fillText('Кредит', W - pad - 10, y + 21);
  g.textAlign = 'left';
  y += 32;

  const drawRow = (leftDate, title, deb, cred, bold = false, bg = null) => {
    if (bg) { g.fillStyle = bg; g.fillRect(pad, y, W - pad * 2, rowH); }
    g.fillStyle = '#1b1b1b';
    g.font = `${bold ? '700' : '400'} 13px Figtree, -apple-system, sans-serif`;
    if (leftDate) g.fillText(leftDate, pad + 10, y + 22);
    const maxLen = 46;
    const t = title.length > maxLen ? title.slice(0, maxLen - 1) + '…' : title;
    g.fillText(t, leftDate ? pad + 105 : pad + 10, y + 22);
    g.textAlign = 'right';
    if (deb) g.fillText(deb, W - pad - 135, y + 22);
    if (cred) g.fillText(cred, W - pad - 10, y + 22);
    g.textAlign = 'left';
    g.strokeStyle = '#ececef';
    g.beginPath(); g.moveTo(pad, y + rowH); g.lineTo(W - pad, y + rowH); g.stroke();
    y += rowH;
  };

  drawRow('', `Сальдо на начало (${dm(d.from)})`, d.opening_balance > 0 ? money(d.opening_balance) : '', d.opening_balance < 0 ? money(Math.abs(d.opening_balance)) : '', true, '#fafafa');
  if (docs.length) {
    for (const x of docs) {
      drawRow(dm(x.date), x.title, x.debit ? money(x.debit) : '', x.credit ? money(x.credit) : '');
    }
  } else {
    drawRow('', 'Операций за выбранный период нет', '', '');
  }
  drawRow('', 'Обороты за период', money(d.total_debit), money(d.total_credit), true);
  drawRow('', `Сальдо на конец (${dm(d.to)})`, d.closing_balance > 0 ? money(d.closing_balance) : '', d.closing_balance < 0 ? money(Math.abs(d.closing_balance)) : '', true, '#f4f4f6');

  y += 28;
  g.fillStyle = '#1b1b1b';
  g.font = '700 14px Figtree, -apple-system, sans-serif';
  g.fillText(balanceText(d.closing_balance, cur), pad, y);

  y += 42;
  g.fillStyle = '#6b6b70';
  g.font = '400 13px Figtree, -apple-system, sans-serif';
  g.fillText('От нашей организации: ______________________', pad, y);
  g.fillText('От контрагента: ______________________', W / 2 + 10, y);

  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  const fileName = `akt_sverki_${cp.name.replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_')}_${d.from}_${d.to}.png`;
  const file = new File([blob], fileName, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `Акт сверки — ${cp.name}` }); return; } catch {}
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  deps.toast('Акт сверки сохранён в PNG');
}

export function initCounterparties(config) {
  deps = config;

  $('cp-kind-chips').onclick = (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    kindFilter = b.dataset.k;
    document.querySelectorAll('#cp-kind-chips .chip').forEach((c) => c.classList.toggle('sel', c === b));
    renderList();
  };
  $('cp-search').oninput = renderList;
  $('cp-open-add').onclick = () => openCpModal(null);

  // Сохранение контрагента
  $('cp-f-cancel').onclick = () => $('cp-dlg').close();
  $('cp-f-toggle').onclick = async () => {
    if (!editTarget) return;
    const b = $('cp-f-toggle');
    b.disabled = true;
    try {
      const r = await api('PATCH', '/api/status?resource=refs', { target: 'customer', id: editTarget.id, active: !editTarget.active });
      if (!r.ok) { $('cp-f-err').textContent = errMsg(r); return; }
      $('cp-dlg').close();
      deps.toast(editTarget.active ? 'Контрагент скрыт' : 'Контрагент возвращён');
      await loadCounterparties();
      await deps.onRefsChanged();
    } finally {
      b.disabled = false;
    }
  };
  $('cp-f-save').onclick = async () => {
    const b = $('cp-f-save');
    b.disabled = true;
    try {
      const payload = {
        target: 'customer',
        name: $('cp-f-name').value,
        kind: $('cp-f-kind').value,
        inn: $('cp-f-inn').value,
        phone: $('cp-f-phone').value,
        note: $('cp-f-note').value,
      };
      const r = editTarget
        ? await api('PATCH', '/api/status?resource=refs', { ...payload, id: editTarget.id })
        : await api('POST', '/api/status?resource=refs', payload);
      if (!r.ok) { $('cp-f-err').textContent = errMsg(r); return; }
      $('cp-dlg').close();
      deps.toast(editTarget ? 'Контрагент обновлён' : 'Контрагент добавлен');
      await loadCounterparties();
      await deps.onRefsChanged();
    } finally {
      b.disabled = false;
    }
  };

  // Сохранение оплаты
  $('pay-dir-chips').onclick = (e) => {
    const b = e.target.closest('[data-dir]');
    if (!b) return;
    payDir = b.dataset.dir;
    document.querySelectorAll('#pay-dir-chips .chip').forEach((c) => c.classList.toggle('sel', c === b));
  };
  $('pay-pm-chips').onclick = (e) => {
    const b = e.target.closest('[data-pm]');
    if (!b) return;
    payMethod = b.dataset.pm;
    document.querySelectorAll('#pay-pm-chips .chip').forEach((c) => c.classList.toggle('sel', c === b));
  };
  $('pay-cancel').onclick = () => $('pay-dlg').close();
  $('pay-save').onclick = async () => {
    if (!payTarget) return;
    const b = $('pay-save');
    b.disabled = true;
    try {
      const r = await api('POST', '/api/report?resource=payments', {
        doc_date: $('pay-date').value,
        counterparty: payTarget.name,
        direction: payDir,
        amount: $('pay-amt').value,
        payment_method: payMethod,
        comment: $('pay-comment').value,
      });
      if (!r.ok) { $('pay-err').textContent = errMsg(r); return; }
      $('pay-dlg').close();
      deps.toast('Оплата проведена');
      await loadCounterparties();
    } finally {
      b.disabled = false;
    }
  };

  // Акт сверки
  $('rec-go').onclick = fetchReconcile;
  $('rec-close').onclick = () => $('rec-dlg').close();
  $('rec-png').onclick = exportRecPng;
  $('rec-print').onclick = () => {
    if (!lastRec) return;
    $('print-root').innerHTML = buildRecHtml(lastRec);
    window.print();
  };
}
