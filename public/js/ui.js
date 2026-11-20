// Единые профессиональные UI-компоненты: кнопка редактирования, универсальная модалка редактирования и выпадающее меню действий.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** HTML круглой/скруглённой кнопки редактирования (карандаш) */
export function editBtnHtml(attrs = '', title = 'Редактировать') {
  return `<button type="button" class="row-act-btn" ${attrs} aria-label="${esc(title)}" title="${esc(title)}"><svg><use href="#i-edit"/></svg></button>`;
}

/** HTML кнопки меню действий (⋯) */
export function moreBtnHtml(attrs = '', title = 'Действия') {
  return `<button type="button" class="row-act-btn" ${attrs} aria-label="${esc(title)}" title="${esc(title)}"><svg><use href="#i-more"/></svg></button>`;
}

/**
 * Универсальное модальное окно редактирования сущности (сорт, категория, покупатель и т.д.).
 * @param {object} opts
 * @param {string} opts.title - Заголовок окна
 * @param {string} [opts.subtitle] - Подзаголовок / подсказка
 * @param {Array<{key:string, label:string, value?:string, placeholder?:string, required?:boolean, type?:string}>} opts.fields
 * @param {boolean} [opts.active] - Текущий статус (если передан, в футере появится кнопка Скрыть / Вернуть)
 * @param {string} [opts.archiveLabel] - Текст кнопки скрытия (по умолчанию «Скрыть»)
 * @param {string} [opts.restoreLabel] - Текст кнопки восстановления (по умолчанию «Вернуть»)
 * @param {function(object): Promise<string|true|null>} opts.onSave - Возвращает true при успехе или текст ошибки
 * @param {function(boolean): Promise<string|true|null>} [opts.onToggleActive] - Вызывается при нажатии Скрыть/Вернуть
 */
export function openEntityModal(opts) {
  const dlg = $('entity-dlg');
  if (!dlg) return;

  $('ent-title').textContent = opts.title || 'Редактирование';
  const subEl = $('ent-sub');
  subEl.textContent = opts.subtitle || '';
  subEl.hidden = !opts.subtitle;
  $('ent-err').textContent = '';

  const fieldsEl = $('ent-fields');
  fieldsEl.innerHTML = (opts.fields || []).map((f) => `
    <div>
      <label class="f" for="ent-f-${esc(f.key)}">${esc(f.label)}</label>
      <input id="ent-f-${esc(f.key)}" type="${esc(f.type || 'text')}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}">
    </div>`).join('');

  const toggleBtn = $('ent-toggle');
  if (typeof opts.active === 'boolean' && opts.onToggleActive) {
    toggleBtn.hidden = false;
    toggleBtn.textContent = opts.active ? (opts.archiveLabel || 'Скрыть') : (opts.restoreLabel || 'Вернуть');
    toggleBtn.className = opts.active ? 'btn ghost danger' : 'btn ghost';
    toggleBtn.onclick = async () => {
      toggleBtn.disabled = true;
      $('ent-err').textContent = '';
      try {
        const res = await opts.onToggleActive(!opts.active);
        if (res === true) dlg.close();
        else if (typeof res === 'string') $('ent-err').textContent = res;
      } finally {
        toggleBtn.disabled = false;
      }
    };
  } else {
    toggleBtn.hidden = true;
    toggleBtn.onclick = null;
  }

  const saveBtn = $('ent-save');
  const submit = async () => {
    const values = {};
    for (const f of opts.fields || []) {
      const val = ($('ent-f-' + f.key)?.value || '').trim();
      if (f.required && !val) {
        $('ent-err').textContent = `Заполните поле «${f.label}»`;
        $('ent-f-' + f.key)?.focus();
        return;
      }
      values[f.key] = val;
    }
    saveBtn.disabled = true;
    $('ent-err').textContent = '';
    try {
      const res = await opts.onSave(values);
      if (res === true) dlg.close();
      else if (typeof res === 'string') $('ent-err').textContent = res;
    } finally {
      saveBtn.disabled = false;
    }
  };

  saveBtn.onclick = submit;
  $('ent-cancel').onclick = () => dlg.close();
  fieldsEl.querySelectorAll('input').forEach((inp) => {
    inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  });

  dlg.showModal();
  fieldsEl.querySelector('input')?.focus();
}

/* ───── Выпадающее меню действий для строк (История, Расходы и т.д.) ───── */
let activeMenu = null;

export function closeRowMenu() {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onDocKey);
  window.removeEventListener('scroll', closeRowMenu, true);
}

function onDocClick(e) {
  if (activeMenu && !activeMenu.contains(e.target)) closeRowMenu();
}

function onDocKey(e) {
  if (e.key === 'Escape') closeRowMenu();
}

/**
 * Открывает аккуратное контекстное меню рядом с кнопкой-якорем.
 * @param {HTMLElement} anchor
 * @param {Array<{label:string, danger?:boolean, onClick:Function}>} items
 */
export function openRowMenu(anchor, items) {
  closeRowMenu();
  if (!items || !items.length) return;

  const menu = document.createElement('div');
  menu.className = 'act-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) =>
    `<button type="button" class="act-menu-item${it.danger ? ' danger' : ''}" data-mi="${i}">${esc(it.label)}</button>`
  ).join('');

  document.body.appendChild(menu);
  activeMenu = menu;

  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 100;
  let left = r.right - mw;
  if (left < 10) left = 10;
  if (left + mw > window.innerWidth - 10) left = window.innerWidth - mw - 10;

  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 10) top = Math.max(10, r.top - mh - 6);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.onclick = (e) => {
    const b = e.target.closest('[data-mi]');
    if (!b) return;
    const item = items[Number(b.dataset.mi)];
    closeRowMenu();
    if (item && item.onClick) item.onClick();
  };

  setTimeout(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onDocKey);
    window.addEventListener('scroll', closeRowMenu, true);
  }, 0);
}
