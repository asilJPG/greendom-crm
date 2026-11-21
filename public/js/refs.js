// Модуль «Справочники» (/refs): управление сортами и покупателями (без хардкода).
import { api, errMsg, newRequestId } from './api.js';
import { editBtnHtml, openEntityModal } from './ui.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let deps = { me: () => null, toast: () => {}, gradeColor: () => '#1b1b1b', onRefsChanged: () => {} };
let custReqId = newRequestId(); // request_id добавления покупателя: новый после успеха
const isAdmin = () => { const me = deps.me && deps.me(); return !!me && me.role === 'admin'; };

export async function loadRefs() {
  const r = await api('GET', '/api/status?resource=refs');
  if (!r.ok) return;
  const { grades = [], customers = [] } = r.data;
  const admin = isAdmin();
  // Добавление и правка справочников — только администратор
  $('ref-g-name').closest('.wrow').hidden = !admin;
  $('ref-c-add').closest('.stack').hidden = !admin;

  $('ref-grades').innerHTML = grades.map((g) => `
    <li class="li li-edit${g.active ? '' : ' off'}" data-edit-grade="${g.id}">
      <div class="l">
        <div class="t" style="display:flex;align-items:center;gap:8px">
          <span class="sw" style="--gc:${deps.gradeColor(g.name)}"></span>
          <span>${esc(g.name)}</span>
          ${g.active ? '' : '<span class="badge b-off">Скрыт</span>'}
        </div>
      </div>
      ${admin ? editBtnHtml(`data-edit-grade="${g.id}"`, 'Редактировать сорт') : ''}
    </li>`).join('') || '<div class="empty">Сортов нет</div>';

  $('ref-grades').querySelectorAll('li[data-edit-grade]').forEach((li) => {
    li.onclick = () => {
      if (!admin) return;
      const g = grades.find((x) => String(x.id) === li.dataset.editGrade);
      if (!g) return;
      openEntityModal({
        title: 'Редактировать сорт',
        subtitle: 'При переименовании сорт автоматически обновится в истории операций',
        active: !!g.active,
        archiveLabel: 'Скрыть сорт',
        restoreLabel: 'Вернуть в список',
        fields: [{ key: 'name', label: 'Название сорта', value: g.name, placeholder: 'Напр. Высший', required: true }],
        onSave: async (vals) => {
          const r2 = await api('PATCH', '/api/status?resource=refs', { target: 'grade', id: g.id, name: vals.name });
          if (!r2.ok) return errMsg(r2);
          deps.toast('Сорт обновлён');
          await loadRefs();
          deps.onRefsChanged();
          return true;
        },
        onToggleActive: async (nextActive) => {
          const r2 = await api('PATCH', '/api/status?resource=refs', { target: 'grade', id: g.id, active: nextActive });
          if (!r2.ok) return errMsg(r2);
          deps.toast(nextActive ? 'Сорт возвращён' : 'Сорт скрыт');
          await loadRefs();
          deps.onRefsChanged();
          return true;
        },
      });
    };
  });

  $('ref-customers').innerHTML = customers.map((c) => `
    <li class="li li-edit${c.active ? '' : ' off'}" data-edit-cust="${c.id}">
      <div class="l">
        <div class="t" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span>${esc(c.name)}</span>
          ${c.active ? '' : '<span class="badge b-off">Скрыт</span>'}
        </div>
        ${c.phone || c.note ? `<div class="s">${[c.phone, c.note].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
      </div>
      ${admin ? editBtnHtml(`data-edit-cust="${c.id}"`, 'Редактировать покупателя') : ''}
    </li>`).join('') || '<div class="empty">Покупателей пока нет</div>';

  $('ref-customers').querySelectorAll('li[data-edit-cust]').forEach((li) => {
    li.onclick = () => {
      if (!admin) return;
      const c = customers.find((x) => String(x.id) === li.dataset.editCust);
      if (!c) return;
      openEntityModal({
        title: 'Редактировать покупателя',
        active: !!c.active,
        archiveLabel: 'Скрыть из списка',
        restoreLabel: 'Вернуть в список',
        fields: [
          { key: 'name', label: 'Название или имя', value: c.name, required: true },
          { key: 'phone', label: 'Телефон', value: c.phone || '', placeholder: '+998…' },
          { key: 'note', label: 'Заметка', value: c.note || '', placeholder: 'Комментарий' },
        ],
        onSave: async (vals) => {
          const r2 = await api('PATCH', '/api/status?resource=refs', { target: 'customer', id: c.id, ...vals });
          if (!r2.ok) return errMsg(r2);
          deps.toast('Покупатель обновлён');
          await loadRefs();
          deps.onRefsChanged();
          return true;
        },
        onToggleActive: async (nextActive) => {
          const r2 = await api('PATCH', '/api/status?resource=refs', { target: 'customer', id: c.id, active: nextActive });
          if (!r2.ok) return errMsg(r2);
          deps.toast(nextActive ? 'Покупатель возвращён' : 'Покупатель скрыт');
          await loadRefs();
          deps.onRefsChanged();
          return true;
        },
      });
    };
  });
}

async function withBtn(b, fn) {
  if (b.disabled) return;
  b.disabled = true;
  try { await fn(); } finally { b.disabled = false; }
}

export function initRefs(config) {
  deps = config;
  $('ref-g-add').onclick = () => withBtn($('ref-g-add'), async () => {
    const r = await api('POST', '/api/status?resource=refs', { target: 'grade', name: $('ref-g-name').value });
    if (!r.ok) { deps.toast(errMsg(r), true); return; }
    $('ref-g-name').value = '';
    deps.toast('Сорт добавлен');
    await loadRefs();
    deps.onRefsChanged();
  });
  $('ref-c-add').onclick = () => withBtn($('ref-c-add'), async () => {
    const r = await api('POST', '/api/status?resource=refs', {
      target: 'customer',
      name: $('ref-c-name').value,
      phone: $('ref-c-phone').value,
      request_id: custReqId,
    });
    if (!r.ok) { deps.toast(errMsg(r), true); return; }
    custReqId = newRequestId();
    $('ref-c-name').value = '';
    $('ref-c-phone').value = '';
    deps.toast(r.data && r.data.duplicate ? 'Покупатель уже был добавлен' : 'Покупатель добавлен');
    await loadRefs();
    deps.onRefsChanged();
  });
}
