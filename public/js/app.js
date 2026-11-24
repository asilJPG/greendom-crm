import { api, rawCall, errMsg, configureAuthHandlers, newRequestId, net } from './api.js';
import { readDecimal, parseDecimal, clearInvalidOnInput, round2, round3 } from './num.js';
import { initScale, autoConnectScale, getActiveWeightKg, clearManualWeight, renderDisplay } from './scale.js';
import { isPasskeySupported, registerPasskey, loginWithPasskey } from './passkey.js';
import { initReport, loadReport } from './report.js';
import { initInvoice, openInvoice } from './invoice.js';
import { initExpenses, loadExpenses, openExpenseById } from './expenses.js';
import { initPayments, loadPayments } from './payments.js';
import { initPayroll, loadPayroll } from './payroll.js';
import { initRefs, loadRefs } from './refs.js';
import { initCounterparties, loadCounterparties } from './counterparties.js';
import { initInvestments, loadInvestments } from './investments.js';
import { editBtnHtml, moreBtnHtml, openRowMenu, attachAutocomplete } from './ui.js';
import { initNumpad } from './numpad.js';
import { initOffline, cacheSet, cacheGet, isQueueableKind, enqueueOffline, listOutbox, flushOfflineQueue, applyOutboxToStock } from './offline.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kg = (v) => (v == null ? '—' : Number(v).toFixed(3));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const shift = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const dm = (s) => s.slice(8, 10) + '.' + s.slice(5, 7);
const rid = newRequestId;

const GRADE_COLORS = ['#c79a1c', '#2c7a4e', '#2a6aa8', '#8a5fb0', '#b1362d', '#2f8f89', '#a86a2a', '#5a6b80'];
const ROLE_NAME = { admin: 'Администратор', director: 'Директор', keeper: 'Складовщик' };
const TYPE_META = { in: ['Приход', 'b-in', '#2c7a4e'], out: ['Продажа', 'b-out', '#2a6aa8'], writeoff: ['Списание', 'b-writeoff', '#a8650c'] };
const KIND = { intake: 'Приход', sale: 'Продажа', writeoff: 'Списание', cancel_movement: 'Отмена записи', cancel_sale: 'Отмена продажи', edit: 'Исправление' };
const ST = { pending: ['ждёт склад', 'b-pending'], applied: ['выполнено', 'b-applied'], rejected: ['отклонено', 'b-rejected'], expired: ['просрочено', 'b-expired'] };

// Маршруты приложения: [id, path, название, иконка, роли|null, группа]
const ROUTES = [
  ['stock', '/stock', 'Остатки', 'i-stock', null, 'Склад'],
  ['intake', '/intake', 'Приход', 'i-in', ['keeper', 'admin'], 'Склад'],
  ['sale', '/sale', 'Продажа', 'i-out', ['keeper', 'admin'], 'Склад'],
  ['writeoff', '/writeoff', 'Списание', 'i-wo', ['keeper', 'admin'], 'Склад'],
  ['history', '/history', 'История', 'i-history', null, 'Склад'],
  ['report', '/report', 'Отчёт (ОПиУ)', 'i-report', ['director', 'admin'], 'Административное'],
  ['expenses', '/expenses', 'Расходы', 'i-exp', ['director', 'admin'], 'Административное'],
  ['payroll', '/payroll', 'Зарплата', 'i-zp', ['director', 'admin'], 'Административное'],
  ['payments', '/payments', 'Акты оплаты', 'i-pay', ['director', 'admin'], 'Административное'],
  ['investments', '/investments', 'Инвестиции', 'i-inv', ['director', 'admin'], 'Административное'],
  ['counterparties', '/counterparties', 'Контрагенты', 'i-cp', ['director', 'admin'], 'Административное'],
  ['refs', '/refs', 'Справочники', 'i-refs', ['admin'], 'Администрирование'],
  ['users', '/users', 'Сотрудники', 'i-users', ['admin'], 'Администрирование'],
  ['log', '/log', 'Журнал', 'i-log', ['admin'], 'Администрирование'],
  ['queue', '/queue', 'Очередь', 'i-queue', ['admin'], 'Администрирование'],
];

const state = {
  me: null,
  tab: 'stock',
  cur: 'сум',
  crop: 'Клубника',
  grades: [],
  customers: [],
  stockMap: {},
  gradeIdx: {},
  histMap: {},
  histRows: [],
  hType: '',
  lastSeenSec: 0,
  today: '', // серверная дата (Asia/Tashkent) из /api/status
  timer: null,
  opsTimer: null,
  toastTimer: null,
  edTarget: null,
  edReqId: null,
  selGrade: { in: '', sl: '', wo: '' },
  selCustomer: '',
  woReason: 'Брак',
  saleCart: [],
};

function toast(text, bad = false, ms = 3200) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => (el.className = 'toast'), ms);
}

// Сегодняшняя дата по серверу (Asia/Tashkent); дата телефона — только запасной вариант
const today = () => state.today || iso(new Date());

function gradeColor(g) {
  if (!(g in state.gradeIdx)) state.gradeIdx[g] = Object.keys(state.gradeIdx).length;
  return GRADE_COLORS[state.gradeIdx[g] % GRADE_COLORS.length];
}

const row = (l, s, r, extra = '') =>
  `<li class="li ${extra}"><div class="l"><div class="t">${l}</div>${s ? `<div class="s">${s}</div>` : ''}</div><div class="r">${r}</div></li>`;

// Универсальное модальное окно ввода текста
function askText({ title, label, value = '', placeholder = '', okText = 'Сохранить' }) {
  return new Promise((resolve) => {
    const dlg = $('prompt-dlg');
    $('pr-title').textContent = title;
    $('pr-label').textContent = label;
    const inp = $('pr-input');
    inp.value = value;
    inp.placeholder = placeholder;
    $('pr-err').textContent = '';
    $('pr-ok').textContent = okText;

    const cleanup = (val) => {
      dlg.onclose = null;
      $('pr-ok').onclick = null;
      $('pr-cancel').onclick = null;
      inp.onkeydown = null;
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const submit = () => {
      const v = inp.value.trim();
      if (!v) { $('pr-err').textContent = 'Заполните поле'; return; }
      cleanup(v);
    };
    $('pr-ok').onclick = submit;
    $('pr-cancel').onclick = () => cleanup(null);
    dlg.onclose = () => resolve(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    dlg.showModal();
    inp.focus();
  });
}

/* ───── экраны, меню и клиентский роутер (History API) ───── */
function showScreen(which) {
  ['login', 'app'].forEach((k) => ($(k).hidden = k !== which));
}

function openDrawer() { $('drawer').classList.add('open'); $('overlay').classList.add('open'); }
function closeDrawer() { $('drawer').classList.remove('open'); $('overlay').classList.remove('open'); }

function showLogin() {
  clearInterval(state.timer);
  clearInterval(state.opsTimer);
  state.me = null;
  closeDrawer();
  showScreen('login');
  $('lg-pw').value = '';
  $('lg-pw').focus();
}

// Сменить свой пароль нельзя: пароль задаёт только администратор.
// Если сервер всё ещё требует смену временного пароля — объясняем и возвращаем на вход.
function showMustChangeBlocked() {
  rawCall('POST', '/api/logout');
  showLogin();
  $('lg-err').textContent = 'Пароль временный. Попросите администратора задать вам новый пароль.';
}

configureAuthHandlers({ unauthorized: showLogin, mustChange: showMustChangeBlocked });

function allowedRoutes() {
  return ROUTES.filter((r) => !r[4] || (state.me && r[4].includes(state.me.role)));
}

function resolveRouteFromPath(pathname) {
  const clean = (pathname || '/').replace(/\/+$/, '') || '/';
  const allowed = allowedRoutes();
  const found = allowed.find((r) => r[1] === clean);
  return found ? found[0] : (allowed[0] ? allowed[0][0] : 'stock');
}

function buildNav() {
  const groups = [];
  for (const r of allowedRoutes()) {
    let g = groups.find((x) => x.name === r[5]);
    if (!g) { g = { name: r[5], items: [] }; groups.push(g); }
    g.items.push(r);
  }
  $('nav').innerHTML = groups.map((g) => `<div class="nav-group"><div class="glabel">${esc(g.name)}</div>${
    g.items.map(([id, path, name, ic]) =>
      `<a class="nav-item" href="${path}" data-tab="${id}"><svg><use href="#${ic}"/></svg><span>${esc(name)}</span>${id === 'queue' ? '<span class="nav-badge" id="q-badge" hidden></span>' : ''}</a>`
    ).join('')
  }</div>`).join('');

  document.querySelectorAll('#nav .nav-item').forEach((a) => {
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(a.dataset.tab);
    };
  });

  // Нижняя панель быстрого доступа для телефонов (1 тап большим пальцем)
  const mnav = $('mnav');
  if (mnav) {
    const allowed = allowedRoutes();
    const role = state.me?.role;
    const preferred = role === 'keeper'
      ? ['stock', 'intake', 'sale', 'writeoff']
      : ['stock', 'expenses', 'report', 'counterparties'];
    const picks = preferred.map((id) => allowed.find((r) => r[0] === id)).filter(Boolean);
    const shortName = { counterparties: 'Контраг.', report: 'Отчёт' };
    mnav.innerHTML =
      picks.map(([id, path, name, ic]) =>
        `<a class="mnav-item" href="${path}" data-tab="${id}"><svg><use href="#${ic}"/></svg><span>${esc(shortName[id] || name)}</span></a>`
      ).join('') +
      `<button type="button" class="mnav-item" id="mnav-more"><svg><use href="#i-menu"/></svg><span>Меню</span></button>`;
    mnav.querySelectorAll('a[data-tab]').forEach((a) => {
      a.onclick = (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(a.dataset.tab);
      };
    });
    const moreBtn = $('mnav-more');
    if (moreBtn) moreBtn.onclick = openDrawer;
  }
}

function navigate(id, { push = true, replace = false } = {}) {
  const route = allowedRoutes().find((r) => r[0] === id) || allowedRoutes()[0];
  if (!route) return;
  const [ridTab, path, label] = route;
  state.tab = ridTab;

  if (location.pathname !== path) {
    if (replace) history.replaceState({ tab: ridTab }, '', path);
    else if (push) history.pushState({ tab: ridTab }, '', path);
  }
  document.title = `${label} · Склад`;

  document.querySelectorAll('#nav .nav-item, #mnav .mnav-item[data-tab]').forEach((a) => a.classList.toggle('sel', a.dataset.tab === ridTab));
  ROUTES.forEach(([key]) => { const el = $('p-' + key); if (el) el.hidden = key !== ridTab; });
  const isOp = ridTab === 'intake' || ridTab === 'sale' || ridTab === 'writeoff';
  $('ops-shell').hidden = !isOp;
  document.body.classList.toggle('ops-mode', isOp); // экраны операций: всё в высоту экрана, без прокрутки страницы

  clearInterval(state.opsTimer);
  closeDrawer();
  window.scrollTo(0, 0);

  if (ridTab === 'stock') loadStock();
  if (ridTab === 'report') {
    if (!$('r-from').value) {
      const t = today();
      $('r-from').value = t.slice(0, 8) + '01';
      $('r-to').value = t;
    }
    loadReport();
  }
  if (ridTab === 'history') loadHistory();
  if (isOp) {
    loadStock().then(() => { renderOpsTiles(); renderCustomerChips(); });
    autoConnectScale();
    renderDisplay();
    renderSaleCart();
  }
  if (ridTab === 'queue') {
    loadOps();
    state.opsTimer = setInterval(loadOps, 8000);
  }
  if (ridTab === 'expenses') loadExpenses();
  if (ridTab === 'payroll') loadPayroll();
  if (ridTab === 'payments') loadPayments();
  if (ridTab === 'investments') loadInvestments();
  if (ridTab === 'counterparties') loadCounterparties();
  if (ridTab === 'refs') loadRefs();
  if (ridTab === 'users') loadUsers();
  if (ridTab === 'log') loadLog();
}

window.addEventListener('popstate', () => {
  if (!state.me) return;
  navigate(resolveRouteFromPath(location.pathname), { push: false });
});

/* ───── вход и выход ───── */
async function login() {
  const b = $('lg-go');
  if (b.disabled) return;
  b.disabled = true;
  try {
    const r = await rawCall('POST', '/api/login', { password: $('lg-pw').value });
    if (!r.ok) { $('lg-err').textContent = errMsg(r); return; }
    $('lg-err').textContent = '';
    await start();
  } finally {
    b.disabled = false;
  }
}

async function logout() {
  await rawCall('POST', '/api/logout');
  showLogin();
}

let offlineState = { online: true, pending: 0 };

function paintConn(st) {
  if (st) offlineState = st;
  const dot = $('dot');
  const seen = $('seen');
  if (!dot || !seen) return;
  if (!offlineState.online) {
    dot.className = 'dot bad';
    seen.textContent = offlineState.pending > 0 ? `Оффлайн · очередь: ${offlineState.pending}` : 'Оффлайн';
  } else if (offlineState.pending > 0) {
    dot.className = 'dot ok';
    seen.textContent = `Синхр. (${offlineState.pending})…`;
  } else {
    dot.className = 'dot ok';
    seen.textContent = 'Онлайн';
  }
}

/* ───── старт, статус и справочники ───── */
function paintStatus(d) {
  if (typeof d.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.today)) state.today = d.today;
  if (Array.isArray(d.grades) && d.grades.length) state.grades = d.grades;
  if (Array.isArray(d.customers)) {
    state.customers = d.customers;
    const dl = $('cp-datalist');
    if (dl) dl.innerHTML = d.customers.map((c) => `<option value="${esc(c.name)}">`).join('');
  }
  const dev = (d.devices || [])[0];
  if (dev) {
    if (!state.grades.length && Array.isArray(dev.grades)) state.grades = dev.grades;
    state.cur = dev.currency || 'сум';
    state.crop = dev.crop || 'Клубника';
  }
  $('title').textContent = 'Склад' + (state.crop ? ' · ' + state.crop : '');
  paintConn();
}

async function refreshAll() {
  const s = await api('GET', '/api/status'); // заодно проверка связи: ответ есть — «Онлайн», нет — «Оффлайн»
  if (s.ok) {
    cacheSet('status', s.data);
    paintStatus(s.data);
  }
  if (state.tab === 'stock') loadStock();
  // экраны операций: плитки «на складе» тоже свежие (иначе моноблок не видит продаж с телефона, пока не уйти со страницы)
  else if (['intake', 'sale', 'writeoff'].includes(state.tab)) { await loadStock(); renderOpsTiles(); }
}
// вернулись на вкладку или появилась сеть — сразу обновить, не дожидаясь таймера
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.me) refreshAll(); });
window.addEventListener('focus', () => { if (state.me) refreshAll(); });

async function start() {
  let r = await rawCall('GET', '/api/status');
  let fromCache = false;
  if (r.status === 401) return showLogin();
  if (!r.ok) {
    if (r.status === 0) {
      const cached = await cacheGet('status');
      if (cached && cached.user) {
        r = { ok: true, data: cached };
        fromCache = true;
      }
    }
    if (!r.ok) return toast(errMsg(r), true);
  } else {
    cacheSet('status', r.data);
  }
  state.me = r.data.user;
  if (state.me.must_change) { state.me = null; return showMustChangeBlocked(); }

  showScreen('app');
  $('menu').textContent = state.me.name.trim().charAt(0).toUpperCase();
  $('me-name').textContent = state.me.name;
  $('me-role').textContent = ROLE_NAME[state.me.role] || state.me.role;

  buildNav();
  paintStatus(r.data);
  navigate(resolveRouteFromPath(location.pathname), { push: false, replace: true });
  if (fromCache) toast('Нет интернета — работа в оффлайн-режиме', false, 5000);
  else {
    flushOfflineQueue();
    if (state.me.role === 'admin') loadOps();
  }

  clearInterval(state.timer);
  state.timer = setInterval(refreshAll, 15000);
}

/* ───── остатки ───── */
async function loadStock() {
  let base = null;
  const r = await api('GET', '/api/stock');
  if (r.ok) {
    base = r.data;
    cacheSet('stock', base);
  }
  if (!base) base = await cacheGet('stock');
  if (!base) return;
  const outbox = await listOutbox();
  const d = applyOutboxToStock(base, outbox);
  state.stockMap = Object.fromEntries(d.rows.map((x) => [x.grade, x.balance_kg]));
  $('total').textContent = kg(d.total_kg);
  $('stock-cards').innerHTML = d.rows.map((x) =>
    `<div class="gcard"><div class="nm"><span class="sw" style="--gc:${gradeColor(x.grade)}"></span>${esc(x.grade)}</div>` +
    `<div class="bal">${kg(x.balance_kg)} <small>кг</small></div>` +
    `<div class="mini"><div>приход<b>${kg(x.in_kg)}</b></div><div>продано<b>${kg(x.out_kg)}</b></div><div>списано<b>${kg(x.writeoff_kg)}</b></div></div></div>`
  ).join('') || '<div class="empty">Данных ещё нет</div>';
}

/* ───── сенсорные плитки сортов и покупателей (Приход / Продажа / Списание) ───── */
function renderOpsTiles() {
  const grades = state.grades;
  for (const [key, elId] of [['in', 'in-grades'], ['sl', 'sl-grades'], ['wo', 'wo-grades']]) {
    if (!grades.includes(state.selGrade[key])) state.selGrade[key] = grades[0] || '';
    const box = $(elId);
    if (!box) continue;
    box.innerHTML = grades.map((g) => {
      const bal = state.stockMap[g] ?? 0;
      const sel = state.selGrade[key] === g ? ' sel' : '';
      return `<button type="button" class="gtile${sel}" style="--gc:${gradeColor(g)}" data-g="${esc(g)}"><b>${esc(g)}</b><small>на складе: ${kg(bal)} кг</small></button>`;
    }).join('') || '<div class="small muted">Добавьте сорта в разделе «Справочники»</div>';
    box.onclick = (e) => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      state.selGrade[key] = b.dataset.g;
      box.querySelectorAll('.gtile').forEach((t) => t.classList.toggle('sel', t === b));
    };
  }
  const ed = $('ed-grade');
  if (ed) {
    const v = ed.value;
    ed.innerHTML = grades.map((g) => `<option>${esc(g)}</option>`).join('');
    if (grades.includes(v)) ed.value = v;
  }
}

// Покупатель продажи: крупная кнопка в форме → окно со всеми покупателями плитками и поиском.
function renderCustomerChips() {
  const list = state.customers;
  if (state.selCustomer && !list.some((c) => c.name === state.selCustomer)) state.selCustomer = '';
  $('sl-cust-name').textContent = state.selCustomer || (list.length ? 'Выберите покупателя' : 'Добавьте покупателя');
  $('sl-cust-btn').classList.toggle('empty', !state.selCustomer);
  renderCustGrid();
}
function renderCustGrid() {
  const q = ($('cust-q').value || '').trim().toLowerCase();
  const list = state.customers.filter((c) => !q || c.name.toLowerCase().includes(q));
  $('cust-grid').innerHTML = list.map((c) =>
    `<button type="button" class="cust-tile${c.name === state.selCustomer ? ' sel' : ''}" data-c="${esc(c.name)}">${esc(c.name)}</button>`
  ).join('') || `<div class="small muted" style="padding:12px 2px">${q ? 'Никого не нашлось — добавьте нового покупателя' : 'Покупателей пока нет'}</div>`;
}
$('cust-grid').onclick = (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  state.selCustomer = b.dataset.c;
  renderCustomerChips();
  $('cust-dlg').close();
};
$('sl-cust-btn').onclick = () => { $('cust-q').value = ''; renderCustGrid(); $('cust-dlg').showModal(); };
$('cust-q').oninput = renderCustGrid;
$('cust-dlg-x').onclick = () => $('cust-dlg').close();

function renderSaleCart() {
  const box = $('sl-cart');
  if (!box) return;
  if (!state.saleCart.length) {
    box.innerHTML = '';
    $('sl-total').textContent = `0 ${state.cur}`;
    return;
  }
  box.innerHTML = state.saleCart.map((it, idx) => `
    <div class="sale-line">
      <div>
        <b>${esc(it.grade)}</b> · ${kg(round3(it.net_kg - (it.free_kg || 0)))} кг
        <div class="small muted">${it.price_per_kg != null ? `${money(it.price_per_kg)} ${esc(state.cur)}/кг` : 'цена не указана'}${it.free_kg > 0 ? ` · взвешено ${kg(it.net_kg)}, скидка ${Math.round(it.free_kg * 1000)} г` : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <b>${money(it.amount)} ${esc(state.cur)}</b>
        <button type="button" class="btn sec sm" data-rm="${idx}" aria-label="Убрать">×</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = () => { state.saleCart.splice(Number(b.dataset.rm), 1); renderSaleCart(); };
  });
  const totalAmt = state.saleCart.reduce((a, i) => a + Number(i.amount || 0), 0);
  $('sl-total').textContent = `${money(totalAmt)} ${state.cur}`;
}

/* ───── история ───── */
// Права на строку истории:
//  • накладная — для любой активной продажи;
//  • исправить — только администратор (любая запись);
//  • отменить — администратор (любая запись) или складовщик: только свои записи с сайта (device 'web') за сегодня.
//    Записи моноблока правит/отменяет только администратор, и такие правки ждут склад.
const isWebRow = (m) => m.device === 'web';
function rowPerms(m) {
  const me = state.me;
  if (!me) return { invoice: false, edit: false, cancel: false, restore: false };
  const admin = me.role === 'admin';
  const active = m.status !== 'cancelled';
  if (!active) {
    // Отменённую запись видит только админ: может открыть накладную и восстановить документ
    return { invoice: admin && m.type === 'out', edit: false, cancel: false, restore: admin };
  }
  return { invoice: m.type === 'out', edit: admin, cancel: admin, restore: false };
}

function hasRowActions(m) {
  const p = rowPerms(m);
  return p.invoice || p.edit || p.cancel || p.restore;
}

async function openSaleInvoice(m) {
  // Все строки продажи берём с сервера (а не из отфильтрованной/урезанной истории).
  // Сервер ищет по COALESCE(sale_id, id), поэтому работает и для продажи из одной строки без sale_id.
  const qs = new URLSearchParams({ sale_id: String(m.sale_id || m.id), device: m.device });
  const r = await api('GET', `/api/movements?${qs.toString()}`);
  if (!r.ok) { toast('Не удалось загрузить накладную: ' + errMsg(r), true); return; }
  const rows = (Array.isArray(r.data) ? r.data : r.data?.rows || []).filter((x) => x.device === m.device && x.type === 'out');
  const active = rows.filter((x) => x.status !== 'cancelled');
  const list = active.length ? active : rows.length ? rows : [m];
  const first = list[0] || m;
  const sale = {
    device: m.device,
    sale_id: m.sale_id || m.id,
    ts: first.ts || m.ts,
    customer: first.customer || m.customer || '—',
    user_name: first.user_name || m.user_name || '',
    note: first.note || m.note || '',
    total_kg: round3(list.reduce((a, i) => a + Number(i.net_kg || 0), 0)),
    total_amount: round2(list.reduce((a, i) => a + Number(i.amount || 0), 0)),
    items: list,
  };
  openInvoice(sale, { crop: state.crop, cur: state.cur });
}

function buildHistMenuItems(m) {
  const p = rowPerms(m);
  const pendingNote = isWebRow(m) ? '' : ' (через моноблок)';
  const items = [];
  if (p.invoice) items.push({ label: 'Накладная', onClick: () => openSaleInvoice(m) });
  if (p.edit) items.push({ label: 'Исправить запись' + pendingNote, onClick: () => openEdit(m) });
  if (p.cancel) {
    const title = m.sale_id ? 'Отменить продажу' : 'Отменить запись';
    items.push({
      label: title + pendingNote,
      danger: true,
      onClick: async () => {
        const reason = await askText({
          title,
          label: isWebRow(m) ? 'Причина отмены' : 'Причина отмены (запись моноблока: отмена применится, когда склад выйдет на связь)',
          placeholder: 'Укажите причину',
          okText: 'Отменить',
        });
        if (!reason) return;
        await sendCmd(m.sale_id ? 'cancel_sale' : 'cancel_movement', { id: m.sale_id || m.id, device: m.device, reason });
      },
    });
  }
  if (p.restore) {
    const title = m.sale_id ? 'Восстановить продажу' : 'Восстановить запись';
    items.push({
      label: title,
      onClick: async () => {
        await sendCmd(m.sale_id ? 'restore_sale' : 'restore_movement', { id: m.sale_id || m.id, device: m.device });
      },
    });
  }
  return items;
}

async function loadHistory() {
  const r = await api('GET', `/api/movements?type=${state.hType}&day=${$('h-day').value}&limit=200`);
  if (!r.ok) return;
  state.histMap = {};
  state.histRows = r.data;
  $('h-rows').innerHTML = r.data.map((m) => {
    const [tn, tc, col] = TYPE_META[m.type];
    const who = m.type === 'out' ? (m.customer || '') : m.type === 'in' ? (m.worker || '') : (m.note || '');
    const cancelled = m.status === 'cancelled';
    const key = `${m.device}:${m.id}`;
    const canAct = hasRowActions(m);
    if (canAct) state.histMap[key] = m;
    return `<div class="hi ${cancelled ? 'cancelled' : ''}" style="--tc:${col};align-items:center"><div class="bar" style="align-self:stretch"></div><div class="l" style="flex:1;min-width:0">` +
      `<div class="t" style="font-weight:600">${esc(m.grade)} · ${kg(m.net_kg)} кг${m.manual ? ' *' : ''}</div>` +
      `<div class="s small muted"><span class="badge ${tc}">${tn}</span> ${dm(m.ts.slice(0, 10))} ${esc(m.ts.slice(11, 16))}${who ? ' · ' + esc(who) : ''}</div>` +
      `${cancelled ? `<div class="small muted">отмена: ${esc(m.cancel_reason || '')}</div>` : ''}</div>` +
      `<div class="r" style="display:flex;align-items:center;gap:6px;flex:none">` +
      `${m.type === 'out' ? `<span style="font-weight:700;white-space:nowrap">${money(m.amount)}</span>` : ''}` +
      `${canAct ? moreBtnHtml(`data-hm="${esc(key)}"`, 'Действия с записью') : ''}</div></div>`;
  }).join('') || '<div class="empty">Записей нет</div>';
}

/* ───── сотрудники и журнал (админ) — полноценная страница карточки сотрудника ───── */
let editUserTarget = null;

function showUserView(mode) {
  $('u-list-view').hidden = mode !== 'list';
  $('u-detail-view').hidden = mode !== 'detail';
  window.scrollTo(0, 0);
}

function openUserDetail(u = null) {
  editUserTarget = u;
  let pwShown = false;
  $('ue-title').textContent = u ? u.name : 'Новый сотрудник';
  $('ue-sub').textContent = u ? `Последний вход: ${u.last_login || 'ещё не входил'}` : 'Создайте учётную запись и задайте постоянный пароль';
  $('ue-name').value = u ? u.name : '';
  $('ue-role').value = u ? u.role : 'director';
  $('ue-new-pw').value = '';
  $('ue-new-pw-l').textContent = u ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль (от 6 символов)';
  $('ue-err').textContent = '';

  const pwBox = $('ue-pw-box');
  const pwVal = $('ue-pw-val');
  const pwShow = $('ue-pw-show');
  const pwCopy = $('ue-pw-copy');
  // У администраторов сервер отдаёт password: null — показывать нечего
  $('ue-pw-note').hidden = !(u && u.role === 'admin' && u.password == null);
  if (u && typeof u.password === 'string' && u.password) {
    pwBox.hidden = false;
    pwVal.textContent = '••••••';
    pwShow.textContent = 'Показать';
    pwCopy.hidden = true;
    pwShow.onclick = () => {
      pwShown = !pwShown;
      pwVal.textContent = pwShown ? u.password : '••••••';
      pwShow.textContent = pwShown ? 'Скрыть' : 'Показать';
      pwCopy.hidden = !pwShown;
    };
    pwCopy.onclick = () => {
      navigator.clipboard?.writeText(u.password).then(() => toast('Пароль скопирован')).catch(() => {});
    };
  } else {
    pwBox.hidden = true;
    pwShow.onclick = null;
    pwCopy.onclick = null;
  }

  // Face ID (passkeys): количество ключей и сброс администратором
  const pkBox = $('ue-pk-box');
  const pkReset = $('ue-pk-reset');
  pkBox.hidden = !u;
  if (u) {
    const n = Number(u.passkeys || 0);
    $('ue-pk-val').textContent = n > 0 ? `подключено ключей: ${n}` : 'не подключён';
    const isAdmin = state.me && state.me.role === 'admin';
    pkReset.hidden = !(isAdmin && n > 0);
    pkReset.onclick = async () => {
      if (!confirm(`Сбросить Face ID у «${u.name}»? Все ключи входа (${n}) будут удалены, вход только по паролю.`)) return;
      pkReset.disabled = true;
      try {
        const r = await api('PATCH', '/api/users', { id: u.id, reset_passkeys: true });
        if (!r.ok) { $('ue-err').textContent = errMsg(r); return; }
        toast('Face ID сброшен');
        await loadUsers();
      } finally {
        pkReset.disabled = false;
      }
    };
  }

  const tog = $('ue-toggle');
  tog.hidden = !u;
  if (u) {
    tog.textContent = u.active ? 'Отключить доступ' : 'Включить доступ';
    tog.className = u.active ? 'btn ghost danger' : 'btn ghost';
    tog.onclick = async () => {
      tog.disabled = true;
      try {
        const r = await api('PATCH', '/api/users', { id: u.id, active: !u.active });
        if (!r.ok) { $('ue-err').textContent = errMsg(r); return; }
        toast(u.active ? 'Сотрудник отключён' : 'Сотрудник включён');
        await loadUsers();
      } finally {
        tog.disabled = false;
      }
    };
  }

  $('ue-save').textContent = u ? 'Сохранить изменения' : 'Создать сотрудника';
  $('ue-save').onclick = async () => {
    const b = $('ue-save');
    const name = $('ue-name').value.trim();
    const role = $('ue-role').value;
    const password = $('ue-new-pw').value;
    if (!name) { $('ue-err').textContent = 'Укажите имя'; return; }
    if (b.disabled) return;
    b.disabled = true;
    try {
      if (!u) {
        const r = await api('POST', '/api/users', { name, role, password });
        if (!r.ok) { $('ue-err').textContent = errMsg(r); return; }
        toast('Сотрудник добавлен');
        await loadUsers();
        return;
      }
      const patch = { id: u.id };
      if (name !== u.name) patch.name = name;
      if (role !== u.role) patch.role = role;
      if (password) patch.password = password;
      if (Object.keys(patch).length === 1) { showUserView('list'); return; }
      const r = await api('PATCH', '/api/users', patch);
      if (!r.ok) { $('ue-err').textContent = errMsg(r); return; }
      toast('Изменения сохранены');
      await loadUsers();
    } finally {
      b.disabled = false;
    }
  };

  showUserView('detail');
  $('ue-name').focus();
}

async function loadUsers() {
  showUserView('list');
  const r = await api('GET', '/api/users');
  if (!r.ok) return;
  $('u-rows').innerHTML = '';
  (Array.isArray(r.data) ? r.data : []).forEach((u) => {
    const el = document.createElement('div');
    el.className = `u-row${u.active ? '' : ' off'}`;
    const initial = (u.name || '?').trim().charAt(0).toUpperCase();
    el.innerHTML =
      `<div class="u-av">${esc(initial)}</div>` +
      `<div style="flex:1;min-width:0">` +
      `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${esc(u.name)}</b>` +
      `<span class="badge b-${u.role}">${ROLE_NAME[u.role] || u.role}</span>` +
      `${u.active ? '' : '<span class="badge b-off">Отключён</span>'}</div>` +
      `<div class="small muted" style="margin-top:3px">вход: ${esc(u.last_login || '—')} · Face ID: ${Number(u.passkeys || 0) > 0 ? `ключей ${Number(u.passkeys)}` : 'нет'}</div>` +
      `</div>` +
      editBtnHtml('', 'Открыть карточку сотрудника');
    el.onclick = () => openUserDetail(u);
    $('u-rows').appendChild(el);
  });
}

async function loadLog() {
  const r = await api('GET', '/api/users?log=1');
  if (!r.ok) return;
  $('a-rows').innerHTML = r.data.length
    ? `<ul class="list">${r.data.map((a) => {
        const sub = [a.detail, a.ip].filter(Boolean).map(esc).join(' · ');
        return row(`${esc(a.user_name || '—')} · ${esc(a.action)}`, sub, `<span class="small muted">${esc(a.ts.slice(5, 16))}</span>`);
      }).join('')}</ul>`
    : '<div class="empty">Записей нет</div>';
}

/* ───── команды и очередь ───── */
const KIND_DONE = { intake: 'Приход записан', sale: 'Продажа оформлена', writeoff: 'Списание записано', edit: 'Запись исправлена', cancel_movement: 'Запись отменена', cancel_sale: 'Продажа отменена' };

async function sendCmd(kind, payload, requestId) {
  const reqId = requestId || rid();
  let r;
  // всегда сначала пробуем отправить на сервер; в очередь — только если связи действительно нет
  r = await api('POST', '/api/command', { kind, payload, request_id: reqId });
  if (!r.ok) {
    if (r.status === 0 && isQueueableKind(kind)) {
      const cnt = await enqueueOffline(kind, payload, reqId);
      toast(`Нет интернета — сохранено локально (в очереди: ${cnt}). Отправится само при появлении сети`, false, 5000);
      await loadStock();
      renderOpsTiles();
      return true;
    }
    toast(errMsg(r), true);
    return false;
  }
  const d = r.data || {};
  if (d.duplicate) toast('Эта операция уже принята ранее');
  else if (d.status === 'pending') {
    const where = state.me && state.me.role === 'admin' ? ' Статус — в разделе «Очередь».' : '';
    toast(`${KIND[kind] || 'Изменение'}: ждёт склад. Сайт принял, моноблок применит при выходе на связь.${where}`, false, 7000);
  } else toast(d.result ? `${KIND_DONE[kind] || 'Выполнено'}: ${d.result}` : (KIND_DONE[kind] || 'Выполнено'));
  if (state.tab === 'history') loadHistory();
  else if (state.tab === 'queue') loadOps();
  else {
    await loadStock();
    renderOpsTiles();
    if (state.me && state.me.role === 'admin') loadOps();
  }
  return true;
}

function guard(btn, fn) {
  let reqId = rid();
  btn.onclick = async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (await fn(reqId)) reqId = rid();
    } finally {
      btn.disabled = false;
    }
  };
}

async function loadOps() {
  const r = await api('GET', '/api/command');
  if (!r.ok) return;
  const list = Array.isArray(r.data) ? r.data : [];
  const pend = list.filter((c) => c.status === 'pending').length;
  const qb = $('q-badge');
  if (qb) { qb.textContent = pend; qb.hidden = !pend; }
  const qa = $('q-apply');
  if (qa) qa.hidden = !(state.me && state.me.role === 'admin' && pend > 0);

  const desc = (c) => {
    const p = c.payload || {};
    if (c.kind === 'intake') return `${p.grade} ${p.net_kg} кг`;
    if (c.kind === 'writeoff') return `${p.grade} ${p.net_kg} кг, ${p.reason}`;
    if (c.kind === 'sale') return `${p.customer}: ${(p.items || []).map((i) => i.grade + ' ' + i.net_kg).join(', ')}`;
    const src = p.device && p.device !== 'web' ? ' (запись моноблока)' : p.device === 'web' ? ' (запись сайта)' : '';
    if (c.kind === 'edit') return `запись #${p.id}${src}: ${p.reason}`;
    return `#${p.id}${src}: ${p.reason}`;
  };
  $('ops-list').innerHTML = list.length
    ? `<ul class="list">${list.map((c) => {
        const [t, cl] = ST[c.status] || [c.status, ''];
        const hint = c.status === 'pending' ? '<br><span class="small">Сайт принял изменение, моноблок ещё не применил его.</span>' : '';
        return row(`${esc(KIND[c.kind] || c.kind)} <span class="badge ${cl}">${t}</span>`, `${esc(desc(c))}${c.result ? '<br>' + esc(c.result) : ''}${hint}`, `<span class="small muted">${esc(String(c.ts || '').slice(5))}</span>`);
      }).join('')}</ul>`
    : '<div class="empty">Пока ничего</div>';
}

function openEdit(m) {
  state.edTarget = m;
  state.edReqId = rid(); // один request_id на открытие диалога: повтор после сбоя сети не задвоит правку
  renderOpsTiles();
  $('ed-err').textContent = isWebRow(m) ? '' : 'Запись моноблока: исправление применится, когда склад выйдет на связь.';
  $('ed-title').textContent = `Исправить запись #${m.id}`;
  $('ed-grade').value = m.grade;
  $('ed-kg').value = m.net_kg ?? '';
  $('ed-worker').value = m.worker || '';
  $('ed-note').value = m.note || '';
  $('ed-in').hidden = m.type !== 'in';
  $('ed-out').hidden = m.type !== 'out';
  $('ed-cust').value = m.customer || '';
  $('ed-price').value = m.price_per_kg ?? '';
  $('ed-amount').value = m.amount ?? '';
  $('ed-reason').value = '';
  $('ed-dlg').showModal();
}

/* ───── привязка обработчиков ───── */
$('lg-go').onclick = login;
$('lg-pw').onkeydown = (e) => { if (e.key === 'Enter') login(); };
$('logout-btn').onclick = logout;

$('menu').onclick = () => { $('md-name').textContent = state.me.name; $('md-role').textContent = ROLE_NAME[state.me.role] || state.me.role; $('md-tg').hidden = state.me.role !== 'admin'; $('menu-dlg').showModal(); loadPasskeys(); };
$('md-tg').onclick = async () => {
  const b = $('md-tg');
  b.disabled = true;
  try {
    const r = await api('POST', '/api/status?resource=tgtest', {});
    if (r.ok && r.data.ok) toast('Тест отправлен — проверьте тему в Telegram');
    else toast((r.data && r.data.error) || errMsg(r), true, 6000);
  } finally { b.disabled = false; }
};
$('md-close').onclick = () => $('menu-dlg').close();
$('md-out').onclick = () => { $('menu-dlg').close(); logout(); };

async function loadPasskeys() {
  const box = $('md-pk-list');
  const r = await api('GET', '/api/passkey');
  if (!r.ok || !r.data.length) { box.innerHTML = ''; return; }
  box.innerHTML = r.data.map((p) =>
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">` +
    `<span>${esc(p.device_name)} · ${esc(p.created_at.slice(5))}</span>` +
    `<button class="btn sec sm" data-del-pk="${esc(p.id)}">Удалить</button></div>`
  ).join('');
  box.querySelectorAll('[data-del-pk]').forEach((b) => (b.onclick = async () => {
    const r2 = await api('DELETE', '/api/passkey', { id: b.dataset.delPk });
    toast(r2.ok ? 'Face ID отключён' : errMsg(r2), !r2.ok);
    loadPasskeys();
  }));
}

$('md-pk').onclick = async () => {
  const b = $('md-pk');
  b.disabled = true;
  try {
    await registerPasskey();
    toast('Face ID подключён');
    loadPasskeys();
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast(e.message || 'Не удалось подключить Face ID', true);
  } finally {
    b.disabled = false;
  }
};

$('lg-pk').onclick = async () => {
  const b = $('lg-pk');
  b.disabled = true;
  $('lg-err').textContent = '';
  try {
    await loginWithPasskey();
    await start();
  } catch (e) {
    if (e.name !== 'NotAllowedError') $('lg-err').textContent = e.message || 'Не удалось войти по Face ID';
  } finally {
    b.disabled = false;
  }
};

isPasskeySupported().then((ok) => {
  $('lg-pk').hidden = !ok;
  $('md-pk').hidden = !ok;
});

$('burger').onclick = openDrawer;
$('drawer-close').onclick = closeDrawer;
$('overlay').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

$('refresh').onclick = async () => {
  await refreshAll();
  if (state.tab === 'report') loadReport();
  if (state.tab === 'history') loadHistory();
  if (state.tab === 'queue') loadOps();
  if (state.tab === 'expenses') loadExpenses();
  if (state.tab === 'payroll') loadPayroll();
  if (state.tab === 'payments') loadPayments();
  if (state.tab === 'investments') loadInvestments();
  if (state.tab === 'counterparties') loadCounterparties();
  if (state.tab === 'refs') loadRefs();
  if (state.tab === 'users') loadUsers();
  if (state.tab === 'log') loadLog();
  toast('Обновлено');
};

document.querySelectorAll('[data-range]').forEach((b) => (b.onclick = () => {
  const now = new Date();
  const today = iso(now);
  if (b.dataset.range === 'month') {
    $('r-from').value = today.slice(0, 8) + '01';
    $('r-to').value = today;
  } else if (b.dataset.range === 'prevmonth') {
    $('r-from').value = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    $('r-to').value = iso(new Date(now.getFullYear(), now.getMonth(), 0));
  } else {
    $('r-from').value = shift(+b.dataset.range);
    $('r-to').value = today;
  }
  loadReport();
}));
$('r-go').onclick = loadReport;

$('h-chips').onclick = (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  state.hType = b.dataset.type;
  document.querySelectorAll('#h-chips .chip').forEach((c) => c.classList.toggle('sel', c === b));
  loadHistory();
};
$('h-day').onchange = loadHistory;
$('h-all').onclick = () => { $('h-day').value = ''; loadHistory(); };
$('h-rows').onclick = (e) => {
  const b = e.target.closest('[data-hm]');
  if (!b) return;
  e.stopPropagation();
  const m = state.histMap[b.dataset.hm];
  if (!m) return;
  openRowMenu(b, buildHistMenuItems(m));
};

$('u-open-add').onclick = () => openUserDetail(null);
$('ue-back').onclick = () => showUserView('list');
$('ue-cancel').onclick = () => showUserView('list');

// ── Приход (вес берётся с большого табло весов) ──
guard($('in-go'), async (id) => {
  if (!state.selGrade.in) { toast('Выберите сорт', true); return false; }
  const w = getActiveWeightKg();
  if (!w.ok) { toast(w.error, true); return false; }
  const ok = await sendCmd('intake', { grade: state.selGrade.in, net_kg: w.net, worker: '', note: $('in-note').value }, id);
  if (ok) { camFlash('Приход записан', `${kg(w.net)} кг`, state.selGrade.in); $('in-note').value = ''; clearManualWeight(); }
  return ok;
});

// ── Продажа (выбор покупателя чипами + добавление позиций с весов) ──
let newCustReqId = rid();
$('sl-new-cust').onclick = async () => {
  const btn = $('sl-new-cust');
  if (btn.disabled) return;
  const name = await askText({ title: 'Новый покупатель', label: 'Название или имя', placeholder: 'Напр. Корзинка', okText: 'Добавить' });
  if (!name) return;
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/status?resource=refs', { target: 'customer', name, request_id: newCustReqId });
    if (!r.ok) { toast(errMsg(r), true); return; }
    newCustReqId = rid();
    const c = r.data && r.data.customer;
    if (c && !state.customers.some((x) => x.name === c.name)) state.customers.push(c);
    if (!c) { const st = await api('GET', '/api/status'); if (st.ok) paintStatus(st.data); }
    state.selCustomer = c ? c.name : name;
    renderCustomerChips();
    if ($('cust-dlg').open) $('cust-dlg').close();
    toast(r.data && r.data.duplicate ? 'Покупатель уже был добавлен' : 'Покупатель добавлен');
  } finally {
    btn.disabled = false;
  }
};

// ── Скидка весом в пользу покупателя: вес округляется вниз до шага (по умолчанию 100 г), разница — бесплатно.
// Включается переключателем на экране продажи (запоминается на этом устройстве); граммы можно вписать вручную.
// Со склада уходит весь взвешенный вес, покупатель платит за вес минус скидку, скидка идёт в отчёт как потеря.
const ROUND_KEY = 'saleRound';
function loadRound() {
  try { const r = JSON.parse(localStorage.getItem(ROUND_KEY)); if (r && typeof r.on === 'boolean') return { on: r.on, step: Number(r.step) > 0 ? Number(r.step) : 100 }; } catch {}
  return { on: false, step: 100 };
}
function saveRound() { try { localStorage.setItem(ROUND_KEY, JSON.stringify(state.round)); } catch {} }
state.round = loadRound();
state.freeManual = false;
function paintRound() {
  $('sl-round').classList.toggle('on', state.round.on);
  $('sl-round-on').checked = state.round.on;
  $('sl-round-step').disabled = !state.round.on;
  $('sl-free-g').disabled = !state.round.on;
  if (!state.round.on) $('sl-free-g').value = '';
}
$('sl-round-step').value = String(state.round.step);
paintRound();
$('sl-round-on').onchange = () => { state.round.on = $('sl-round-on').checked; state.freeManual = false; saveRound(); paintRound(); };
$('sl-round-step').oninput = () => {
  const v = parseInt($('sl-round-step').value, 10);
  if (v >= 1 && v <= 1000) { state.round.step = v; saveRound(); }
  state.freeManual = false;
};
$('sl-free-g').oninput = () => { state.freeManual = $('sl-free-g').value.trim() !== ''; };
// Сколько граммов отдаём бесплатно для веса netKg: вписано вручную или остаток от округления вниз до шага.
function freeGrams(netKg) {
  if (!state.round.on) return { ok: true, g: 0 };
  if (state.freeManual) {
    const v = parseDecimal($('sl-free-g').value);
    if (v === null) return { ok: true, g: 0 };
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: 'Неверная скидка весом (граммы). Пример: 85' };
    return { ok: true, g: Math.round(v) };
  }
  return { ok: true, g: Math.round(netKg * 1000) % state.round.step };
}

// Живой подсчёт суммы позиции: вес × цена видно сразу, ещё до «Взвесить и добавить позицию».
function updateSaleLive() {
  const live = $('sl-live'), ovEl = $('sl-amt-ov');
  if (!live || state.tab !== 'sale' || $('ops-shell').hidden) return; // экран продажи не открыт
  const price = parseDecimal($('sl-price').value), ov = parseDecimal(ovEl.value);
  const w = getActiveWeightKg();
  const cartTotal = state.saleCart.reduce((a, i) => a + Number(i.amount || 0), 0);
  let pos = null, text = '';
  if (ov !== null && Number.isFinite(ov) && ov >= 0) {
    pos = round2(ov);
    text = `Сумма позиции (вручную): <b>${money(pos)} ${esc(state.cur)}</b>`;
  } else if (w.ok && price !== null && Number.isFinite(price) && price > 0) {
    const fr = freeGrams(w.net);
    const freeG = fr.ok && fr.g < Math.round(w.net * 1000) ? fr.g : 0;
    const billed = round3(w.net - freeG / 1000);
    pos = round2(billed * price);
    text = freeG > 0
      ? `${kg(w.net)} кг − ${freeG} г = ${kg(billed)} кг × ${money(price)} = <b>${money(pos)} ${esc(state.cur)}</b>`
      : `${kg(w.net)} кг × ${money(price)} = <b>${money(pos)} ${esc(state.cur)}</b>`;
  } else if (price !== null && Number.isFinite(price) && price > 0) {
    text = `<span class="muted">${esc(w.error || 'Нет веса')}</span>`;
  }
  // автоподстановка бесплатных граммов, пока оператор не вписал своё
  if (state.round.on && !state.freeManual) {
    const auto = w.ok ? String(freeGrams(w.net).g) : '';
    if ($('sl-free-g').value !== auto && document.activeElement !== $('sl-free-g')) $('sl-free-g').value = auto;
  }
  ovEl.placeholder = pos !== null && !(ov !== null) ? `авто: ${money(pos)}` : 'авто';
  live.innerHTML = text ? `${text}${pos !== null ? ' <span class="muted">· нажмите «Добавить позицию»</span>' : ''}` : '';
  $('sl-total').textContent = pos !== null
    ? `${money(cartTotal)} ${state.cur} (+ ${money(pos)} не добавлено)`
    : `${money(cartTotal)} ${state.cur}`;
}
setInterval(updateSaleLive, 400);

// Подпись над весом на табло: что сейчас делается (видно на камере рядом с цифрами)
function updateScaleCtx() {
  const el = $('sc-ctx');
  if (!el || !el.offsetParent) return;
  const t = state.tab;
  const text = t === 'intake' ? `Приход · ${state.selGrade.in || 'выберите сорт'}`
    : t === 'sale' ? `Продажа · ${state.selGrade.sl || 'выберите сорт'}${state.selCustomer ? ` → ${state.selCustomer}` : ''}`
      : t === 'writeoff' ? `Списание · ${state.selGrade.wo || 'выберите сорт'} · ${state.woReason || ''}` : '';
  if (el.textContent !== text) el.textContent = text;
}
setInterval(updateScaleCtx, 300);

// Крупная плашка «записано» на весь экран: на видео с камеры видно, какой вес и что именно ушло в базу.
let camTimer = null;
function camFlash(kind, num, sub, ms = 4000) {
  const box = $('camflash');
  if (!box) return;
  $('cf-kind').textContent = kind;
  $('cf-num').textContent = num;
  $('cf-sub').textContent = sub || '';
  $('cf-time').textContent = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  box.hidden = false;
  clearTimeout(camTimer);
  camTimer = setTimeout(() => { box.hidden = true; }, ms);
}
$('camflash').onclick = () => { clearTimeout(camTimer); $('camflash').hidden = true; };

$('sl-add-pos').onclick = () => {
  if (!state.selGrade.sl) return toast('Выберите сорт', true);
  const pr = readDecimal('sl-price', { label: 'Цена за кг', max: 1e9 });
  if (!pr.ok) return toast(pr.error, true);
  const ov = readDecimal('sl-amt-ov', { label: 'Сумма', max: 1e12 });
  if (!ov.ok) return toast(ov.error, true);
  const price = pr.value;
  if (price === null && ov.value === null) {
    $('sl-price').classList.add('bad-input');
    $('sl-price').focus();
    return toast('Укажите цену за кг или сумму позиции', true);
  }
  const w = getActiveWeightKg();
  if (!w.ok) return toast(w.error, true);
  const fr = freeGrams(w.net);
  if (!fr.ok) { $('sl-free-g').classList.add('bad-input'); return toast(fr.error, true); }
  if (fr.g >= Math.round(w.net * 1000)) { $('sl-free-g').classList.add('bad-input'); return toast('Скидка весом должна быть меньше веса позиции', true); }
  const freeKg = round3(fr.g / 1000);
  const billed = round3(w.net - freeKg);
  const amount = ov.value !== null ? round2(ov.value) : round2(billed * price);
  if (!Number.isFinite(amount) || amount < 0) return toast('Неверная сумма', true);
  if (amount === 0 && !confirm(`Позиция «${state.selGrade.sl}» ${kg(billed)} кг на сумму 0 ${state.cur}. Добавить бесплатно?`)) return;
  state.saleCart.push({ grade: state.selGrade.sl, net_kg: w.net, free_kg: freeKg, price_per_kg: price, amount });
  camFlash('Позиция добавлена', `${kg(billed)} кг`,
    `${state.selGrade.sl}${freeKg > 0 ? ` · скидка ${fr.g} г` : ''} · ${money(amount)} ${state.cur}`, 2500);
  state.freeManual = false;
  $('sl-free-g').value = '';
  $('sl-free-g').classList.remove('bad-input');
  $('sl-amt-ov').value = '';
  clearManualWeight();
  renderSaleCart();
};

guard($('sl-go'), async (id) => {
  if (!state.selCustomer) { toast('Выберите покупателя', true); return false; }
  if (!state.saleCart.length) { toast('Добавьте хотя бы одну позицию', true); return false; }
  const total = round2(state.saleCart.reduce((a, i) => a + Number(i.amount || 0), 0));
  if (total <= 0 && !confirm(`Сумма продажи 0 ${state.cur}. Провести продажу без оплаты?`)) return false;
  const totalKg = round3(state.saleCart.reduce((a, i) => a + Number(i.net_kg || 0) - Number(i.free_kg || 0), 0));
  const ok = await sendCmd('sale', { customer: state.selCustomer, note: $('sl-note').value, items: state.saleCart }, id);
  if (ok) {
    camFlash('Продажа проведена', `${kg(totalKg)} кг`, `${state.selCustomer} · ${money(total)} ${state.cur}`);
    state.saleCart = [];
    $('sl-note').value = '';
    $('sl-price').value = '';
    $('sl-amt-ov').value = '';
    renderSaleCart();
  }
  return ok;
});

// ── Списание (плитки сортов + чипы причин + вес с табло) ──
$('wo-reasons').onclick = (e) => {
  const b = e.target.closest('[data-r]');
  if (!b) return;
  state.woReason = b.dataset.r;
  document.querySelectorAll('#wo-reasons .chip').forEach((c) => c.classList.toggle('sel', c === b));
};

guard($('wo-go'), async (id) => {
  if (!state.selGrade.wo) { toast('Выберите сорт', true); return false; }
  const w = getActiveWeightKg();
  if (!w.ok) { toast(w.error, true); return false; }
  const extra = $('wo-reason').value.trim();
  const reason = extra ? `${state.woReason}: ${extra}` : state.woReason;
  const ok = await sendCmd('writeoff', { grade: state.selGrade.wo, net_kg: w.net, reason }, id);
  if (ok) { camFlash('Списание записано', `${kg(w.net)} кг`, `${state.selGrade.wo} · ${reason}`); $('wo-reason').value = ''; clearManualWeight(); }
  return ok;
});

$('q-apply').onclick = async () => {
  const b = $('q-apply');
  b.disabled = true;
  try {
    const r = await api('PATCH', '/api/command', {});
    if (!r.ok) { toast(errMsg(r), true); return; }
    toast(`Применено в БД: ${r.data.applied}${r.data.rejected ? `, отклонено: ${r.data.rejected}` : ''}`);
    await loadOps();
  } finally {
    b.disabled = false;
  }
};

$('ed-cancel').onclick = () => $('ed-dlg').close();
$('ed-ok').onclick = async () => {
  const btn = $('ed-ok');
  if (btn.disabled) return;
  const m = state.edTarget;
  if (!m) return;
  const p = { id: m.id, device: m.device, reason: $('ed-reason').value.trim() };
  if (!p.reason) { $('ed-err').textContent = 'Укажите причину'; return; }
  const kgIn = readDecimal('ed-kg', { label: 'Вес нетто', positive: true, max: 1e6 });
  if (!kgIn.ok) { $('ed-err').textContent = kgIn.error; return; }
  const putStr = (k, v, old) => { if (String(v) !== String(old ?? '')) p[k] = v; };
  const putNum = (k, v, old) => { if (v !== null && (old == null || Math.abs(Number(old) - v) > 1e-9)) p[k] = v; };
  putStr('grade', $('ed-grade').value, m.grade);
  putNum('net_kg', round3(kgIn.value), m.net_kg);
  putStr('note', $('ed-note').value, m.note || '');
  if (m.type === 'in') putStr('worker', $('ed-worker').value, m.worker || '');
  if (m.type === 'out') {
    const pr = readDecimal('ed-price', { label: 'Цена за кг', max: 1e9 });
    if (!pr.ok) { $('ed-err').textContent = pr.error; return; }
    const am = readDecimal('ed-amount', { label: 'Сумма', max: 1e12 });
    if (!am.ok) { $('ed-err').textContent = am.error; return; }
    putStr('customer', $('ed-cust').value.trim(), m.customer || '');
    putNum('price_per_kg', pr.value, m.price_per_kg);
    putNum('amount', am.value === null ? null : round2(am.value), m.amount);
  }
  if (Object.keys(p).length <= 3) { $('ed-err').textContent = 'Ничего не изменено'; return; }
  btn.disabled = true;
  $('ed-cancel').disabled = true;
  try {
    if (await sendCmd('edit', p, state.edReqId)) {
      state.edReqId = rid();
      $('ed-dlg').close();
    }
  } finally {
    btn.disabled = false;
    $('ed-cancel').disabled = false;
  }
};

clearInvalidOnInput();
const CP_KIND_SHORT = { buyer: 'Покупатель', supplier: 'Поставщик', employee: 'Сотрудник', both: 'Покупатель / Поставщик' };
const cpSuggestions = () => (state.customers || []).map((c) => ({
  value: c.name,
  sub: [CP_KIND_SHORT[c.kind] || '', c.phone || ''].filter(Boolean).join(' · '),
}));
const empSuggestions = () => {
  const list = (state.customers || []).filter((c) => c.kind === 'employee');
  const rest = (state.customers || []).filter((c) => c.kind !== 'employee');
  return [...list, ...rest].map((c) => ({
    value: c.name,
    sub: [CP_KIND_SHORT[c.kind] || '', c.phone || ''].filter(Boolean).join(' · '),
  }));
};
attachAutocomplete($('exp-cp'), cpSuggestions);
attachAutocomplete($('exp-emp'), empSuggestions);
attachAutocomplete($('pm-f-cp'), cpSuggestions);
attachAutocomplete($('inv-f-investor'), cpSuggestions);
attachAutocomplete($('ed-cust'), cpSuggestions);
attachAutocomplete($('cp-search'), cpSuggestions);
initNumpad();
initOffline({
  onChange: paintConn,
  onSynced: async ({ sent, failedMsgs }) => {
    if (sent > 0) toast(`Оффлайн-очередь отправлена в облако (${sent})`, false, 5000);
    if (failedMsgs && failedMsgs.length) toast(`Отклонено сервером: ${failedMsgs[0]}`, true, 6000);
    await loadStock();
    renderOpsTiles();
    if (state.tab === 'history') loadHistory();
  },
});
initScale(toast);
initInvoice(toast);
initReport({
  cur: () => state.cur,
  crop: () => state.crop,
  gradeColor,
  openHistoryDay: (day) => { $('h-day').value = day; navigate('history'); },
  openExpenseAct: async (id) => {
    navigate('expenses');
    await openExpenseById(id);
  },
});
initExpenses({
  me: () => state.me,
  today,
  cur: () => state.cur,
  crop: () => state.crop,
  toast,
  askText,
});
initPayments({
  me: () => state.me,
  cur: () => state.cur,
  toast,
  askText,
});
initPayroll({
  me: () => state.me,
  cur: () => state.cur,
  toast,
  askText,
});
initInvestments({
  me: () => state.me,
  cur: () => state.cur,
  toast,
  askText,
});
initRefs({
  me: () => state.me,
  toast,
  gradeColor,
  onRefsChanged: async () => {
    const s = await api('GET', '/api/status');
    if (s.ok) paintStatus(s.data);
  },
});
initCounterparties({
  me: () => state.me,
  cur: () => state.cur,
  crop: () => state.crop,
  toast,
  askText,
  onRefsChanged: async () => {
    const s = await api('GET', '/api/status');
    if (s.ok) paintStatus(s.data);
  },
});
start();
