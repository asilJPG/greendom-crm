// Модуль «Расходы»: полноценный документ «Акт расхода» на отдельной странице (как в iiko / 1С) + категории.
import { api, errMsg } from './api.js';
import { editBtnHtml, openEntityModal } from './ui.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const dm = (s) => (s && s.length >= 10 ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : s || '');

const PAY_LABEL = { cash: 'Наличные', card: 'Карта', transfer: 'Перечисление' };
const UNITS = ['шт', 'кг', 'л', 'усл', 'час', 'м', 'уп'];

let deps = { me: () => null, cur: () => 'сум', crop: () => 'Клубника', toast: () => {}, askText: async () => null };
let categories = [];
let loadedItems = [];
let payMethod = 'cash';
let draftLines = [];
let editingActId = null;
let viewingAct = null;

function showExpView(mode) {
  $('e-list-view').hidden = mode !== 'list';
  $('e-new-view').hidden = mode !== 'new';
  $('e-view-doc').hidden = mode !== 'view';
  window.scrollTo(0, 0);
}

function setDefaultPeriod() {
  const today = iso(new Date());
  if (!$('e-from').value) {
    $('e-from').value = today.slice(0, 8) + '01';
    $('e-to').value = today;
  }
}

function renderCategoriesSelects() {
  const active = categories.filter((c) => c.active);
  const fSel = $('e-cat-filter');
  const prevF = fSel.value;
  fSel.innerHTML = '<option value="">Все категории</option>' + categories.map((c) => `<option value="${c.id}">${esc(c.name)}${c.active ? '' : ' (скрыта)'}</option>`).join('');
  if (prevF) fSel.value = prevF;

  const dSel = $('exp-cat');
  const prevD = dSel.value;
  dSel.innerHTML = active.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (active.some((c) => String(c.id) === String(prevD))) dSel.value = prevD;
}

function renderCategoryModal() {
  $('exp-cat-list').innerHTML = categories.map((c) => `
    <li class="li li-edit${c.active ? '' : ' off'}" data-edit-cat="${c.id}">
      <div class="l">
        <div class="t" style="display:flex;align-items:center;gap:8px">
          <span>${esc(c.name)}</span>
          ${c.active ? '' : '<span class="badge b-off">Скрыта</span>'}
        </div>
      </div>
      ${editBtnHtml(`data-edit-cat="${c.id}"`, 'Редактировать категорию')}
    </li>`).join('') || '<div class="empty">Категорий нет</div>';

  $('exp-cat-list').querySelectorAll('li[data-edit-cat]').forEach((li) => {
    li.onclick = () => {
      const cat = categories.find((x) => String(x.id) === li.dataset.editCat);
      if (!cat) return;
      openEntityModal({
        title: 'Редактировать категорию',
        active: !!cat.active,
        archiveLabel: 'Скрыть категорию',
        restoreLabel: 'Вернуть в список',
        fields: [{ key: 'name', label: 'Название категории', value: cat.name, required: true }],
        onSave: async (vals) => {
          const r = await api('PATCH', '/api/report?resource=expenses', { target: 'category', id: cat.id, name: vals.name });
          if (!r.ok) return errMsg(r);
          deps.toast('Категория обновлена');
          await loadExpenses();
          renderCategoryModal();
          return true;
        },
        onToggleActive: async (nextActive) => {
          const r = await api('PATCH', '/api/report?resource=expenses', { target: 'category', id: cat.id, active: nextActive });
          if (!r.ok) return errMsg(r);
          deps.toast(nextActive ? 'Категория возвращена' : 'Категория скрыта');
          await loadExpenses();
          renderCategoryModal();
          return true;
        },
      });
    };
  });
}

/* ───── Табличная часть документа «Новый акт расхода» ───── */
function recalcDraftTotal() {
  const total = draftLines.reduce((a, l) => a + (Number(l.sum) || 0), 0);
  $('exp-doc-total').textContent = `${money(total)} ${deps.cur()}`;
}

function renderDraftLines() {
  const box = $('exp-lines');
  box.innerHTML = draftLines.map((l, idx) => `
    <div class="doc-line" data-li="${idx}">
      <input class="dl-name" data-f="name" value="${esc(l.name)}" placeholder="Наименование услуги или товара">
      <div class="dl-nums">
        <input class="dl-qty" data-f="qty" type="number" inputmode="decimal" min="0" step="any" value="${l.qty}" placeholder="Кол-во" aria-label="Количество">
        <select class="dl-unit" data-f="unit" aria-label="Ед. изм.">${UNITS.map((u) => `<option value="${u}"${l.unit === u ? ' selected' : ''}>${u}</option>`).join('')}</select>
        <input class="dl-price" data-f="price" type="number" inputmode="decimal" min="0" step="any" value="${l.price === '' ? '' : l.price}" placeholder="Цена" aria-label="Цена">
        <input class="dl-sum" data-f="sum" type="number" inputmode="decimal" min="0" step="any" value="${l.sum === '' ? '' : l.sum}" placeholder="Сумма" aria-label="Сумма">
        ${draftLines.length > 1 ? `<button type="button" class="row-act-btn" data-rm="${idx}" aria-label="Убрать строку" title="Убрать строку">×</button>` : ''}
      </div>
    </div>`).join('');

  box.querySelectorAll('.doc-line').forEach((row) => {
    const idx = Number(row.dataset.li);
    const line = draftLines[idx];
    const sumEl = row.querySelector('[data-f="sum"]');
    row.querySelectorAll('[data-f]').forEach((inp) => {
      inp.oninput = () => {
        const f = inp.dataset.f;
        if (f === 'name' || f === 'unit') {
          line[f] = inp.value;
        } else if (f === 'qty' || f === 'price') {
          line[f] = inp.value === '' ? '' : Number(inp.value);
          const q = Number(line.qty || 0);
          const p = Number(line.price || 0);
          if (q > 0 && p >= 0 && line.price !== '') {
            line.sum = Math.round(q * p * 100) / 100;
            sumEl.value = line.sum;
          }
        } else if (f === 'sum') {
          line.sum = inp.value === '' ? '' : Number(inp.value);
        }
        recalcDraftTotal();
      };
    });
    const rm = row.querySelector('[data-rm]');
    if (rm) {
      rm.onclick = () => {
        draftLines.splice(idx, 1);
        renderDraftLines();
      };
    }
  });
  recalcDraftTotal();
}

function openNewActPage() {
  editingActId = null;
  payMethod = 'cash';
  $('exp-form-title').textContent = 'Новый акт расхода';
  $('exp-save').textContent = 'Провести акт расхода';
  $('exp-err').textContent = '';
  $('exp-date').value = iso(new Date());
  $('exp-docno').value = '';
  $('exp-cp').value = '';
  $('exp-comment').value = '';
  document.querySelectorAll('#exp-pay-chips .chip').forEach((c) => c.classList.toggle('sel', c.dataset.pm === payMethod));
  draftLines = [{ name: '', qty: 1, unit: 'усл', price: '', sum: '' }];
  renderDraftLines();
  showExpView('new');
  $('exp-cp').focus();
}

function openEditActPage(x) {
  editingActId = x.id;
  payMethod = x.payment_method || 'cash';
  $('exp-form-title').textContent = `Редактирование акта №${x.id}`;
  $('exp-save').textContent = 'Сохранить изменения';
  $('exp-err').textContent = '';
  $('exp-date').value = x.doc_date || iso(new Date());
  $('exp-docno').value = x.doc_number || '';
  $('exp-cat').value = String(x.category_id);
  $('exp-cp').value = x.counterparty || '';
  $('exp-comment').value = x.comment || '';
  document.querySelectorAll('#exp-pay-chips .chip').forEach((c) => c.classList.toggle('sel', c.dataset.pm === payMethod));
  const items = Array.isArray(x.items) && x.items.length ? x.items : null;
  draftLines = items
    ? items.map((it) => ({ name: it.name || '', qty: it.qty ?? 1, unit: it.unit || 'шт', price: it.price ?? '', sum: it.sum ?? '' }))
    : [{ name: x.comment || x.category_name || '', qty: 1, unit: 'усл', price: x.amount, sum: x.amount }];
  renderDraftLines();
  showExpView('new');
  $('exp-cp').focus();
}

/* ───── Просмотр проведённого акта расхода на весь экран ───── */
function buildActSheetHtml(x) {
  const cur = deps.cur();
  const items = Array.isArray(x.items) ? x.items : [];
  const rowsHtml = items.length
    ? items.map((it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(it.name || x.category_name)}</td>
        <td class="num">${it.qty ?? 1} ${esc(it.unit || 'шт')}</td>
        <td class="num">${it.price ? money(it.price) : '—'}</td>
        <td class="num"><b>${money(it.sum)}</b></td>
      </tr>`).join('')
    : `<tr><td>1</td><td>${esc(x.category_name)}${x.comment ? ' — ' + esc(x.comment) : ''}</td><td class="num">1 усл</td><td class="num">${money(x.amount)}</td><td class="num"><b>${money(x.amount)}</b></td></tr>`;

  return `
    <div class="inv-sheet">
      <div class="inv-head">
        <div>
          <div class="inv-title">Акт расхода №${x.id}${x.doc_number ? ` (внешн. №${esc(x.doc_number)})` : ''}</div>
          <div class="inv-date">от ${dm(x.doc_date)} · ${x.status === 'cancelled' ? 'ОТМЕНЁН' : 'Проведён'}</div>
        </div>
        <div class="inv-brand">Склад · ${esc(deps.crop())}</div>
      </div>
      <div class="inv-meta">
        <div><span>Категория:</span> <b>${esc(x.category_name)}</b></div>
        ${x.counterparty ? `<div><span>Контрагент / Поставщик:</span> <b>${esc(x.counterparty)}</b></div>` : ''}
        <div><span>Способ оплаты:</span> ${esc(PAY_LABEL[x.payment_method] || x.payment_method)}</div>
        ${x.user_name ? `<div><span>Оформил:</span> ${esc(x.user_name)}</div>` : ''}
        ${x.comment ? `<div><span>Назначение:</span> ${esc(x.comment)}</div>` : ''}
        ${x.status === 'cancelled' ? `<div style="color:var(--red)"><span>Причина отмены:</span> ${esc(x.cancel_reason || '')}</div>` : ''}
      </div>
      <table class="inv-tbl">
        <thead>
          <tr><th>№</th><th>Наименование</th><th class="num">Кол-во</th><th class="num">Цена</th><th class="num">Сумма, ${esc(cur)}</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr><td colspan="4"><b>Итого по акту</b></td><td class="num"><b>${money(x.amount)} ${esc(cur)}</b></td></tr>
        </tfoot>
      </table>
      <div class="inv-signs">
        <div>Утвердил: _______________________</div>
        <div>Получил: _______________________</div>
      </div>
    </div>`;
}

function openActViewPage(x) {
  viewingAct = x;
  const me = deps.me();
  const today = iso(new Date());
  const canEdit = x.status === 'active' && me && (me.role === 'admin' || me.role === 'director');
  const canCancel = x.status === 'active' && me && (me.role === 'admin' || (me.role === 'director' && x.user_name === me.name && x.doc_date === today));
  $('ev-title').textContent = `Акт расхода №${x.id}`;
  $('ev-sheet').innerHTML = buildActSheetHtml(x);
  $('ev-edit-btn').hidden = !canEdit;
  $('ev-cancel-btn').hidden = !canCancel;
  showExpView('view');
}

export async function openExpenseById(id) {
  let found = loadedItems.find((a) => String(a.id) === String(id));
  if (!found) {
    const r = await api('GET', '/api/report?resource=expenses&all=1');
    if (r.ok) {
      categories = r.data.categories || categories;
      renderCategoriesSelects();
      found = (r.data.items || []).find((a) => String(a.id) === String(id));
    }
  }
  if (found) openActViewPage(found);
}

export async function loadExpenses() {
  showExpView('list');
  setDefaultPeriod();
  const me = deps.me();
  const cur = deps.cur();
  $('e-open-add').hidden = !(me && (me.role === 'admin' || me.role === 'director'));
  $('e-open-cats').hidden = !(me && me.role === 'admin');

  const qs = new URLSearchParams({ resource: 'expenses', from: $('e-from').value, to: $('e-to').value });
  if ($('e-cat-filter').value) qs.set('category_id', $('e-cat-filter').value);
  const r = await api('GET', `/api/report?${qs.toString()}`);
  if (!r.ok) return;

  categories = r.data.categories || [];
  loadedItems = r.data.items || [];
  renderCategoriesSelects();

  const activeCount = loadedItems.filter((x) => x.status === 'active').length;
  $('e-total').textContent = money(r.data.total);
  $('e-cur').textContent = cur;
  $('e-count').textContent = `Актов за период: ${activeCount}`;

  $('e-rows').innerHTML = loadedItems.map((x) => {
    const cancelled = x.status === 'cancelled';
    const posCount = Array.isArray(x.items) && x.items.length ? `позиций: ${x.items.length}` : '';
    const meta = [
      `<span class="badge b-director">${esc(x.category_name)}</span>`,
      dm(x.doc_date),
      PAY_LABEL[x.payment_method] || x.payment_method,
      x.counterparty ? esc(x.counterparty) : '',
      posCount,
    ].filter(Boolean).join(' · ');
    return `
      <div class="hi click-row ${cancelled ? 'cancelled' : ''}" style="--tc:#1b1b1b;align-items:center" data-open-act="${x.id}">
        <div class="bar" style="align-self:stretch"></div>
        <div class="l" style="flex:1;min-width:0">
          <div class="t">Акт №${x.id}${x.doc_number ? ` (${esc(x.doc_number)})` : ''}${x.comment ? ' · ' + esc(x.comment) : ''}</div>
          <div class="s small muted">${meta}</div>
          ${cancelled ? `<div class="small muted">отмена: ${esc(x.cancel_reason || '')}</div>` : ''}
        </div>
        <div class="r" style="display:flex;align-items:center;gap:8px;flex:none">
          <span style="font-weight:700;white-space:nowrap">${money(x.amount)} <span class="small muted" style="font-weight:500">${esc(cur)}</span></span>
          <span class="pnl-arr">›</span>
        </div>
      </div>`;
  }).join('') || '<div class="empty">Расходов за выбранный период нет</div>';

  $('e-rows').querySelectorAll('[data-open-act]').forEach((el) => {
    el.onclick = () => {
      const x = loadedItems.find((a) => String(a.id) === el.dataset.openAct);
      if (x) openActViewPage(x);
    };
  });
}

export function initExpenses(config) {
  deps = config;

  document.querySelectorAll('[data-erange]').forEach((b) => {
    b.onclick = () => {
      const now = new Date();
      const today = iso(now);
      if (b.dataset.erange === 'month') {
        $('e-from').value = today.slice(0, 8) + '01';
        $('e-to').value = today;
      } else if (b.dataset.erange === 'prevmonth') {
        $('e-from').value = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        $('e-to').value = iso(new Date(now.getFullYear(), now.getMonth(), 0));
      } else {
        $('e-from').value = today;
        $('e-to').value = today;
      }
      loadExpenses();
    };
  });
  $('e-from').onchange = loadExpenses;
  $('e-to').onchange = loadExpenses;
  $('e-cat-filter').onchange = loadExpenses;

  // Страница создания акта
  $('e-open-add').onclick = openNewActPage;
  $('exp-back').onclick = () => showExpView('list');
  $('exp-cancel').onclick = () => showExpView('list');
  $('exp-add-line').onclick = () => {
    draftLines.push({ name: '', qty: 1, unit: 'шт', price: '', sum: '' });
    renderDraftLines();
  };
  $('exp-pay-chips').onclick = (e) => {
    const b = e.target.closest('[data-pm]');
    if (!b) return;
    payMethod = b.dataset.pm;
    document.querySelectorAll('#exp-pay-chips .chip').forEach((c) => c.classList.toggle('sel', c === b));
  };
  $('exp-save').onclick = async () => {
    const b = $('exp-save');
    const items = draftLines
      .map((l) => ({ name: (l.name || '').trim(), qty: Number(l.qty || 1), unit: l.unit || 'шт', price: Number(l.price || 0), sum: Number(l.sum || 0) }))
      .filter((l) => l.name || l.sum > 0);
    const total = items.reduce((a, l) => a + l.sum, 0);
    if (!items.length || total <= 0) {
      $('exp-err').textContent = 'Заполните хотя бы одну позицию с суммой больше 0';
      return;
    }
    b.disabled = true;
    try {
      const payload = {
        target: 'expense',
        doc_date: $('exp-date').value,
        doc_number: $('exp-docno').value,
        category_id: Number($('exp-cat').value),
        amount: total,
        items,
        counterparty: $('exp-cp').value,
        payment_method: payMethod,
        comment: $('exp-comment').value,
      };
      const r = editingActId
        ? await api('PATCH', '/api/report?resource=expenses', { ...payload, id: editingActId, action: 'edit' })
        : await api('POST', '/api/report?resource=expenses', payload);
      if (!r.ok) { $('exp-err').textContent = errMsg(r); return; }
      deps.toast(editingActId ? `Акт №${editingActId} обновлён` : `Акт расхода №${r.data.id} проведён`);
      await loadExpenses();
    } finally {
      b.disabled = false;
    }
  };

  // Страница просмотра акта
  $('ev-back').onclick = () => showExpView('list');
  $('ev-edit-btn').onclick = () => { if (viewingAct) openEditActPage(viewingAct); };
  $('ev-print').onclick = () => {
    if (!viewingAct) return;
    $('print-root').innerHTML = buildActSheetHtml(viewingAct);
    window.print();
  };
  $('ev-cancel-btn').onclick = async () => {
    if (!viewingAct) return;
    const reason = await deps.askText({ title: `Отменить акт №${viewingAct.id}`, label: 'Причина отмены', placeholder: 'Укажите причину', okText: 'Отменить акт' });
    if (!reason) return;
    const r = await api('PATCH', '/api/report?resource=expenses', { target: 'expense', id: viewingAct.id, reason });
    deps.toast(r.ok ? 'Акт отменён' : errMsg(r), !r.ok);
    if (r.ok) await loadExpenses();
  };

  // Категории расходов (компактная модалка, т.к. 1 поле)
  $('e-open-cats').onclick = () => {
    $('exp-cat-err').textContent = '';
    $('exp-cat-new').value = '';
    renderCategoryModal();
    $('exp-cat-dlg').showModal();
  };
  $('exp-cat-close').onclick = () => $('exp-cat-dlg').close();
  $('exp-cat-add').onclick = async () => {
    const r = await api('POST', '/api/report?resource=expenses', { target: 'category', name: $('exp-cat-new').value });
    if (!r.ok) { $('exp-cat-err').textContent = errMsg(r); return; }
    $('exp-cat-err').textContent = '';
    $('exp-cat-new').value = '';
    deps.toast('Категория добавлена');
    await loadExpenses();
    renderCategoryModal();
  };
}
