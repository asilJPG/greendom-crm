// Модуль «Справочники» (/refs): управление сортами и покупателями (без хардкода).
import { api, errMsg } from './api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let deps = { toast: () => {}, askText: async () => null, onRefsChanged: () => {} };

export async function loadRefs() {
  const r = await api('GET', '/api/status?resource=refs');
  if (!r.ok) return;
  const { grades = [], customers = [] } = r.data;

  $('ref-grades').innerHTML = grades.map((g) => `
    <li class="li">
      <div class="l">
        <div class="t">${esc(g.name)} ${g.active ? '' : '<span class="badge b-off">скрыт</span>'}</div>
      </div>
      <div style="display:flex;gap:6px;flex:none">
        <button class="btn sec sm" data-g-act="rename" data-id="${g.id}" data-name="${esc(g.name)}">Имя</button>
        <button class="btn sec sm" data-g-act="toggle" data-id="${g.id}" data-active="${g.active ? '1' : '0'}">${g.active ? 'Скрыть' : 'Вернуть'}</button>
      </div>
    </li>`).join('') || '<div class="empty">Сортов нет</div>';

  $('ref-grades').querySelectorAll('[data-g-act]').forEach((b) => {
    b.onclick = async () => {
      const patch = { target: 'grade', id: Number(b.dataset.id) };
      if (b.dataset.gAct === 'rename') {
        const n = await deps.askText({ title: 'Переименовать сорт', label: 'Новое название (обновится и в истории)', value: b.dataset.name });
        if (!n) return;
        patch.name = n;
      } else {
        patch.active = b.dataset.active !== '1';
      }
      const r2 = await api('PATCH', '/api/status?resource=refs', patch);
      deps.toast(r2.ok ? 'Сохранено' : errMsg(r2), !r2.ok);
      if (r2.ok) { await loadRefs(); deps.onRefsChanged(); }
    };
  });

  $('ref-customers').innerHTML = customers.map((c) => `
    <li class="li">
      <div class="l">
        <div class="t">${esc(c.name)} ${c.active ? '' : '<span class="badge b-off">скрыт</span>'}</div>
        ${c.phone || c.note ? `<div class="s">${[c.phone, c.note].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex:none">
        <button class="btn sec sm" data-c-act="rename" data-id="${c.id}" data-name="${esc(c.name)}">Имя</button>
        <button class="btn sec sm" data-c-act="toggle" data-id="${c.id}" data-active="${c.active ? '1' : '0'}">${c.active ? 'Скрыть' : 'Вернуть'}</button>
      </div>
    </li>`).join('') || '<div class="empty">Покупателей пока нет</div>';

  $('ref-customers').querySelectorAll('[data-c-act]').forEach((b) => {
    b.onclick = async () => {
      const patch = { target: 'customer', id: Number(b.dataset.id) };
      if (b.dataset.cAct === 'rename') {
        const n = await deps.askText({ title: 'Переименовать покупателя', label: 'Новое имя', value: b.dataset.name });
        if (!n) return;
        patch.name = n;
      } else {
        patch.active = b.dataset.active !== '1';
      }
      const r2 = await api('PATCH', '/api/status?resource=refs', patch);
      deps.toast(r2.ok ? 'Сохранено' : errMsg(r2), !r2.ok);
      if (r2.ok) { await loadRefs(); deps.onRefsChanged(); }
    };
  });
}

export function initRefs(config) {
  deps = config;
  $('ref-g-add').onclick = async () => {
    const r = await api('POST', '/api/status?resource=refs', { target: 'grade', name: $('ref-g-name').value });
    if (!r.ok) { deps.toast(errMsg(r), true); return; }
    $('ref-g-name').value = '';
    deps.toast('Сорт добавлен');
    await loadRefs();
    deps.onRefsChanged();
  };
  $('ref-c-add').onclick = async () => {
    const r = await api('POST', '/api/status?resource=refs', {
      target: 'customer',
      name: $('ref-c-name').value,
      phone: $('ref-c-phone').value,
    });
    if (!r.ok) { deps.toast(errMsg(r), true); return; }
    $('ref-c-name').value = '';
    $('ref-c-phone').value = '';
    deps.toast('Покупатель добавлен');
    await loadRefs();
    deps.onRefsChanged();
  };
}
