// Модуль «Расходы»: акты расхода и управление категориями (аналог акта приёма услуг / расходов в 1С и iiko).
import { api, errMsg } from './api.js';
import { editBtnHtml, moreBtnHtml, openEntityModal, openRowMenu } from './ui.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const dm = (s) => s.slice(8, 10) + '.' + s.slice(5, 7);

const PAY_LABEL = { cash: 'Наличные', card: 'Карта', transfer: 'Перечисление' };
let deps = { me: () => null, cur: () => 'сум', toast: () => {}, askText: async () => null };
let categories = [];
let payMethod = 'cash';

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

export async function loadExpenses() {
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
  renderCategoriesSelects();

  const items = r.data.items || [];
  const activeCount = items.filter((x) => x.status === 'active').length;
  $('e-total').textContent = money(r.data.total);
  $('e-cur').textContent = cur;
  $('e-count').textContent = `Актов за период: ${activeCount}`;

  const today = iso(new Date());
  $('e-rows').innerHTML = items.map((x) => {
    const cancelled = x.status === 'cancelled';
    const canCancel = !cancelled && me && (me.role === 'admin' || (me.role === 'keeper' && x.user_name === me.name && x.doc_date === today));
    const meta = [
      `<span class="badge b-director">${esc(x.category_name)}</span>`,
      `${dm(x.doc_date)}`,
      PAY_LABEL[x.payment_method] || x.payment_method,
      x.counterparty ? esc(x.counterparty) : '',
      x.user_name ? esc(x.user_name) : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="hi ${cancelled ? 'cancelled' : ''}" style="--tc:#1b1b1b;align-items:center">
        <div class="bar" style="align-self:stretch"></div>
        <div class="l" style="flex:1;min-width:0">
          <div class="t">Акт №${x.id}${x.comment ? ' · ' + esc(x.comment) : ''}</div>
          <div class="s small muted">${meta}</div>
          ${cancelled ? `<div class="small muted">отмена: ${esc(x.cancel_reason || '')}</div>` : ''}
        </div>
        <div class="r" style="display:flex;align-items:center;gap:6px;flex:none">
          <span style="font-weight:700;white-space:nowrap">${money(x.amount)} <span class="small muted" style="font-weight:500">${esc(cur)}</span></span>
          ${canCancel ? moreBtnHtml(`data-exp-menu="${x.id}"`, 'Действия с актом') : ''}
        </div>
      </div>`;
  }).join('') || '<div class="empty">Расходов за выбранный период нет</div>';

  $('e-rows').querySelectorAll('[data-exp-menu]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = Number(b.dataset.expMenu);
      openRowMenu(b, [
        {
          label: 'Отменить акт',
          danger: true,
          onClick: async () => {
            const reason = await deps.askText({ title: `Отменить акт №${id}`, label: 'Причина отмены', placeholder: 'Укажите причину', okText: 'Отменить акт' });
            if (!reason) return;
            const r2 = await api('PATCH', '/api/report?resource=expenses', { target: 'expense', id, reason });
            deps.toast(r2.ok ? 'Акт отменён' : errMsg(r2), !r2.ok);
            if (r2.ok) loadExpenses();
          },
        },
      ]);
    };
  });
}

export function initExpenses(config) {
  deps = config;

  // Пресеты периода расходов
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

  // Модалка «Новый акт расхода»
  $('exp-pay-chips').onclick = (e) => {
    const b = e.target.closest('[data-pm]');
    if (!b) return;
    payMethod = b.dataset.pm;
    document.querySelectorAll('#exp-pay-chips .chip').forEach((c) => c.classList.toggle('sel', c === b));
  };
  $('e-open-add').onclick = () => {
    $('exp-err').textContent = '';
    $('exp-date').value = iso(new Date());
    $('exp-amt').value = '';
    $('exp-cp').value = '';
    $('exp-comment').value = '';
    $('exp-dlg').showModal();
    $('exp-amt').focus();
  };
  $('exp-cancel').onclick = () => $('exp-dlg').close();
  $('exp-save').onclick = async () => {
    const b = $('exp-save');
    b.disabled = true;
    try {
      const r = await api('POST', '/api/report?resource=expenses', {
        target: 'expense',
        doc_date: $('exp-date').value,
        category_id: Number($('exp-cat').value),
        amount: $('exp-amt').value,
        counterparty: $('exp-cp').value,
        payment_method: payMethod,
        comment: $('exp-comment').value,
      });
      if (!r.ok) { $('exp-err').textContent = errMsg(r); return; }
      $('exp-dlg').close();
      deps.toast(`Акт расхода №${r.data.id} создан`);
      loadExpenses();
    } finally {
      b.disabled = false;
    }
  };

  // Модалка «Категории расходов» (админ)
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
