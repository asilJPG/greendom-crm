import { api, rawCall, errMsg, configureAuthHandlers } from './api.js';
import { initScale, autoConnectScale, getActiveWeightKg, clearManualWeight, renderDisplay } from './scale.js';
import { isPasskeySupported, registerPasskey, loginWithPasskey } from './passkey.js';
import { initReport, loadReport } from './report.js';
import { initInvoice, openInvoice } from './invoice.js';
import { initExpenses, loadExpenses } from './expenses.js';
import { initRefs, loadRefs } from './refs.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kg = (v) => (v == null ? '—' : Number(v).toFixed(3));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const shift = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const dm = (s) => s.slice(8, 10) + '.' + s.slice(5, 7);
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

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
  lastPw: '',
  timer: null,
  opsTimer: null,
  toastTimer: null,
  pwTarget: null,
  edTarget: null,
  selGrade: { in: '', sl: '', wo: '' },
  selCustomer: '',
  woReason: 'Брак',
  saleCart: [],
};

function toast(text, bad = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

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
  ['login', 'force', 'app'].forEach((k) => ($(k).hidden = k !== which));
}

function openDrawer() { $('drawer').classList.add('open'); $('overlay').classList.add('open'); }
function closeDrawer() { $('drawer').classList.remove('open'); $('overlay').classList.remove('open'); }

function showLogin() {
  clearInterval(state.timer);
  clearInterval(state.opsTimer);
  state.me = null;
  state.lastPw = '';
  closeDrawer();
  showScreen('login');
  $('lg-pw').value = '';
  $('lg-pw').focus();
}

function showForce() {
  clearInterval(state.timer);
  clearInterval(state.opsTimer);
  showScreen('force');
  ['fc-old', 'fc-new', 'fc-new2'].forEach((id) => ($(id).value = ''));
  $('fc-err').textContent = '';
  $('fc-old').parentElement.hidden = !!state.lastPw;
}

configureAuthHandlers({ unauthorized: showLogin, mustChange: showForce });

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

  document.querySelectorAll('#nav .nav-item').forEach((a) => a.classList.toggle('sel', a.dataset.tab === ridTab));
  ROUTES.forEach(([key]) => { const el = $('p-' + key); if (el) el.hidden = key !== ridTab; });
  const isOp = ridTab === 'intake' || ridTab === 'sale' || ridTab === 'writeoff';
  $('ops-shell').hidden = !isOp;

  clearInterval(state.opsTimer);
  closeDrawer();
  window.scrollTo(0, 0);

  if (ridTab === 'stock') loadStock();
  if (ridTab === 'report') {
    if (!$('r-from').value) {
      const today = iso(new Date());
      $('r-from').value = today.slice(0, 8) + '01';
      $('r-to').value = today;
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
  if (ridTab === 'refs') loadRefs();
  if (ridTab === 'users') loadUsers();
  if (ridTab === 'log') loadLog();
}

window.addEventListener('popstate', () => {
  if (!state.me) return;
  navigate(resolveRouteFromPath(location.pathname), { push: false });
});

/* ───── вход, выход, пароль ───── */
async function login() {
  const pw = $('lg-pw').value;
  const r = await rawCall('POST', '/api/login', { password: pw });
  if (!r.ok) { $('lg-err').textContent = errMsg(r); return; }
  state.lastPw = pw;
  $('lg-err').textContent = '';
  await start();
}

async function logout() {
  await rawCall('POST', '/api/logout');
  showLogin();
}

function openPw(target) {
  state.pwTarget = target;
  $('pd-err').textContent = '';
  $('pd-old').value = '';
  $('pd-new').value = '';
  $('pd-title').textContent = target ? `Новый пароль для «${target.name}»` : 'Сменить пароль';
  $('pd-old-f').hidden = !!target;
  $('pd-new-l').textContent = 'Новый пароль (от 6 символов)';
  $('pw-dlg').showModal();
}

/* ───── старт, статус и справочники ───── */
function paintStatus(d) {
  if (Array.isArray(d.grades) && d.grades.length) state.grades = d.grades;
  if (Array.isArray(d.customers)) state.customers = d.customers;
  const dev = d.devices[0];
  if (!dev) {
    $('seen').textContent = 'нет данных';
    $('dot').className = 'dot bad';
    $('stale').hidden = true;
    return;
  }
  if (!state.grades.length && Array.isArray(dev.grades)) state.grades = dev.grades;
  state.lastSeenSec = dev.seconds_ago;
  state.cur = dev.currency || 'сум';
  state.crop = dev.crop || 'Клубника';
  $('title').textContent = 'Склад' + (dev.crop ? ' · ' + dev.crop : '');
  const m = Math.floor(dev.seconds_ago / 60);
  $('seen').textContent = m < 1 ? 'сейчас' : m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч';
  const stale = dev.seconds_ago > 900;
  $('dot').className = 'dot ' + (stale ? 'bad' : 'ok');
  $('stale').hidden = !stale;
  $('ops-stale').hidden = !stale;
  if (stale) $('ops-stale').textContent = 'Моноблок сейчас не на связи: изменения сохранятся на сайте сразу, а моноблок подтянет их при подключении.';
}

async function refreshAll() {
  const s = await api('GET', '/api/status');
  if (s.ok) paintStatus(s.data);
  if (state.tab === 'stock') loadStock();
}

async function start() {
  const r = await rawCall('GET', '/api/status');
  if (r.status === 401) return showLogin();
  if (!r.ok) return toast(errMsg(r), true);
  state.me = r.data.user;
  if (state.me.must_change) return showForce();

  showScreen('app');
  $('menu').textContent = state.me.name.trim().charAt(0).toUpperCase();
  $('me-name').textContent = state.me.name;
  $('me-role').textContent = ROLE_NAME[state.me.role] || state.me.role;

  buildNav();
  paintStatus(r.data);
  navigate(resolveRouteFromPath(location.pathname), { push: false, replace: true });
  if (state.me.role === 'admin') loadOps();

  clearInterval(state.timer);
  state.timer = setInterval(refreshAll, 30000);
}

/* ───── остатки ───── */
async function loadStock() {
  const r = await api('GET', '/api/stock');
  if (!r.ok) return;
  const d = r.data;
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

function renderCustomerChips() {
  const box = $('sl-cust-chips');
  if (!box) return;
  const list = state.customers;
  if (state.selCustomer && !list.some((c) => c.name === state.selCustomer)) {
    state.selCustomer = list[0] ? list[0].name : '';
  }
  box.innerHTML = list.map((c) =>
    `<button type="button" class="chip${state.selCustomer === c.name ? ' sel' : ''}" data-c="${esc(c.name)}">${esc(c.name)}</button>`
  ).join('') || '<div class="small muted">Нажмите «+ Новый», чтобы добавить первого покупателя</div>';
  box.onclick = (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    state.selCustomer = b.dataset.c;
    box.querySelectorAll('.chip').forEach((ch) => ch.classList.toggle('sel', ch === b));
  };
}

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
        <b>${esc(it.grade)}</b> · ${kg(it.net_kg)} кг
        <div class="small muted">${it.price_per_kg != null ? `${money(it.price_per_kg)} ${esc(state.cur)}/кг` : 'цена не указана'}</div>
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
function rowActions(m) {
  if (m.status === 'cancelled' || !state.me) return '';
  const key = `${m.device}:${m.id}`;
  state.histMap[key] = m;
  const mine = state.me.role === 'keeper' && m.user_name === state.me.name && m.ts.slice(0, 10) === iso(new Date());
  const btns = [];
  if (m.type === 'out') btns.push(`<button class="btn sec sm" data-a="inv" data-k="${esc(key)}">Накладная</button>`);
  if (state.me.role === 'admin' || mine) btns.push(`<button class="btn sec sm" data-a="cancel" data-k="${esc(key)}">Отменить${m.sale_id ? ' продажу' : ''}</button>`);
  if (state.me.role === 'admin') btns.push(`<button class="btn sec sm" data-a="edit" data-k="${esc(key)}">Исправить</button>`);
  return btns.length ? `<div class="acts">${btns.join('')}</div>` : '';
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
    return `<div class="hi ${cancelled ? 'cancelled' : ''}" style="--tc:${col}"><div class="bar"></div><div class="l" style="flex:1;min-width:0">` +
      `<div class="t" style="font-weight:600">${esc(m.grade)} · ${kg(m.net_kg)} кг${m.manual ? ' *' : ''}</div>` +
      `<div class="s small muted"><span class="badge ${tc}">${tn}</span> ${dm(m.ts.slice(0, 10))} ${esc(m.ts.slice(11, 16))}${who ? ' · ' + esc(who) : ''}</div>` +
      `${cancelled ? `<div class="small muted">отмена: ${esc(m.cancel_reason || '')}</div>` : ''}${rowActions(m)}</div>` +
      `<div class="r" style="font-weight:700;white-space:nowrap">${m.type === 'out' ? money(m.amount) : ''}</div></div>`;
  }).join('') || '<div class="empty">Записей нет</div>';
}

/* ───── сотрудники и журнал (админ) ───── */
async function loadUsers() {
  const r = await api('GET', '/api/users');
  if (!r.ok) return;
  $('u-rows').innerHTML = '';
  r.data.forEach((u) => {
    const el = document.createElement('div');
    el.className = 'li';
    el.style.cssText = 'display:block';
    const pwHtml = u.password
      ? `<span class="small muted" style="margin-left:4px">· пароль: <code class="pw-val" style="font-family:ui-monospace,monospace;background:var(--soft);padding:2px 6px;border-radius:6px;cursor:pointer" title="Нажмите, чтобы скопировать">••••••</code></span>`
      : `<span class="small muted" style="margin-left:4px">· пароль не сохранён (задайте новый или войдите)</span>`;
    el.innerHTML =
      `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${esc(u.name)}</b>` +
      `<span class="badge b-${u.role}">${ROLE_NAME[u.role] || u.role}</span>` +
      `${u.active ? '<span class="badge b-active">Активен</span>' : '<span class="badge b-off">Отключён</span>'}</div>` +
      `<div class="s small muted" style="margin-top:4px">вход: ${esc(u.last_login || '—')}${pwHtml}</div>` +
      `<div class="acts">${u.password ? '<button class="btn sec sm" data-a="showpw">Показать пароль</button>' : ''}<button class="btn sec sm" data-a="name">Имя</button>` +
      `<select class="rolesel" aria-label="Роль" style="width:auto;min-height:34px;padding:6px 10px;font-size:13.5px;border-radius:9px">` +
      `${Object.entries(ROLE_NAME).map(([k, v]) => `<option value="${k}"${k === u.role ? ' selected' : ''}>${v}</option>`).join('')}</select>` +
      `<button class="btn sec sm" data-a="pw">Новый пароль</button>` +
      `<button class="btn sec sm" data-a="active">${u.active ? 'Отключить' : 'Включить'}</button></div>`;
    let pwShown = false;
    const pwCode = el.querySelector('.pw-val');
    if (pwCode) {
      pwCode.onclick = () => {
        if (!pwShown) return;
        navigator.clipboard?.writeText(u.password).then(() => toast('Пароль скопирован')).catch(() => {});
      };
    }
    el.querySelector('.rolesel').onchange = async (e) => {
      const r2 = await api('PATCH', '/api/users', { id: u.id, role: e.target.value });
      toast(r2.ok ? 'Роль изменена' : errMsg(r2), !r2.ok);
      loadUsers();
    };
    el.querySelectorAll('button').forEach((b) => (b.onclick = async () => {
      if (b.dataset.a === 'showpw') {
        pwShown = !pwShown;
        pwCode.textContent = pwShown ? u.password : '••••••';
        b.textContent = pwShown ? 'Скрыть пароль' : 'Показать пароль';
        return;
      }
      if (b.dataset.a === 'pw') return openPw(u);
      const patch = { id: u.id };
      if (b.dataset.a === 'name') {
        const n = await askText({ title: 'Переименовать сотрудника', label: 'Новое имя', value: u.name });
        if (!n) return;
        patch.name = n;
      }
      if (b.dataset.a === 'active') patch.active = !u.active;
      const r2 = await api('PATCH', '/api/users', patch);
      toast(r2.ok ? 'Сохранено' : errMsg(r2), !r2.ok);
      loadUsers();
    }));
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
async function sendCmd(kind, payload, requestId) {
  const r = await api('POST', '/api/command', { kind, payload, request_id: requestId || rid() });
  if (!r.ok) { toast(errMsg(r), true); return false; }
  toast(r.data.duplicate ? 'Эта операция уже принята' : r.data.status === 'pending' ? 'Сохранено на сайте (синхронизируется со складом)' : 'Сохранено');
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
  const pend = r.data.filter((c) => c.status === 'pending').length;
  const qb = $('q-badge');
  if (qb) { qb.textContent = pend; qb.hidden = !pend; }
  const qa = $('q-apply');
  if (qa) qa.hidden = !(state.me && state.me.role === 'admin' && pend > 0);

  const desc = (c) => {
    const p = c.payload || {};
    if (c.kind === 'intake') return `${p.grade} ${p.net_kg} кг`;
    if (c.kind === 'writeoff') return `${p.grade} ${p.net_kg} кг, ${p.reason}`;
    if (c.kind === 'sale') return `${p.customer}: ${(p.items || []).map((i) => i.grade + ' ' + i.net_kg).join(', ')}`;
    if (c.kind === 'edit') return `запись #${p.id}: ${p.reason}`;
    return `#${p.id}: ${p.reason}`;
  };
  $('ops-list').innerHTML = r.data.length
    ? `<ul class="list">${r.data.map((c) => {
        const [t, cl] = ST[c.status] || [c.status, ''];
        return row(`${esc(KIND[c.kind] || c.kind)} <span class="badge ${cl}">${t}</span>`, `${esc(desc(c))}${c.result ? '<br>' + esc(c.result) : ''}`, `<span class="small muted">${esc(c.ts.slice(5))}</span>`);
      }).join('')}</ul>`
    : '<div class="empty">Пока ничего</div>';
}

function openEdit(m) {
  state.edTarget = m;
  renderOpsTiles();
  $('ed-err').textContent = '';
  $('ed-title').textContent = `Исправить запись #${m.id}`;
  $('ed-grade').value = m.grade;
  $('ed-kg').value = m.net_kg;
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
$('fc-go').onclick = async () => {
  if ($('fc-new').value !== $('fc-new2').value) { $('fc-err').textContent = 'Пароли не совпадают'; return; }
  const r = await rawCall('POST', '/api/password', { old_password: state.lastPw || $('fc-old').value, new_password: $('fc-new').value });
  if (!r.ok) { $('fc-err').textContent = errMsg(r); return; }
  state.lastPw = '';
  await start();
};

$('menu').onclick = () => { $('md-name').textContent = state.me.name; $('md-role').textContent = ROLE_NAME[state.me.role] || state.me.role; $('menu-dlg').showModal(); loadPasskeys(); };
$('md-close').onclick = () => $('menu-dlg').close();
$('md-out').onclick = () => { $('menu-dlg').close(); logout(); };
$('md-pw').onclick = () => { $('menu-dlg').close(); openPw(null); };

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

$('pd-cancel').onclick = () => $('pw-dlg').close();
$('pd-ok').onclick = async () => {
  const r = state.pwTarget
    ? await api('PATCH', '/api/users', { id: state.pwTarget.id, password: $('pd-new').value })
    : await api('POST', '/api/password', { old_password: $('pd-old').value, new_password: $('pd-new').value });
  if (!r.ok) { $('pd-err').textContent = errMsg(r); return; }
  $('pw-dlg').close();
  toast(state.pwTarget ? 'Пароль обновлён' : 'Пароль изменён');
  if (state.pwTarget) loadUsers();
};

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
$('h-rows').onclick = async (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const m = state.histMap[b.dataset.k];
  if (!m) return;
  if (b.dataset.a === 'inv') {
    const items = m.sale_id
      ? state.histRows.filter((x) => x.device === m.device && x.sale_id === m.sale_id && x.status === 'active')
      : [m];
    const sale = {
      device: m.device,
      sale_id: m.sale_id || m.id,
      ts: m.ts,
      customer: m.customer || '—',
      user_name: m.user_name || '',
      note: m.note || '',
      total_kg: Math.round(items.reduce((a, i) => a + Number(i.net_kg || 0), 0) * 1000) / 1000,
      total_amount: Math.round(items.reduce((a, i) => a + Number(i.amount || 0), 0) * 100) / 100,
      items,
    };
    openInvoice(sale, { crop: state.crop, cur: state.cur });
    return;
  }
  if (b.dataset.a === 'cancel') {
    const reason = await askText({
      title: m.sale_id ? 'Отменить продажу' : 'Отменить запись',
      label: 'Причина отмены',
      placeholder: 'Укажите причину',
      okText: 'Отменить',
    });
    if (!reason) return;
    await sendCmd(m.sale_id ? 'cancel_sale' : 'cancel_movement', { id: m.sale_id || m.id, device: m.device, reason });
  } else {
    openEdit(m);
  }
};

$('u-open-add').onclick = () => { $('u-err').textContent = ''; $('u-name').value = ''; $('u-pw').value = ''; $('u-add-dlg').showModal(); $('u-name').focus(); };
$('u-cancel').onclick = () => $('u-add-dlg').close();
$('u-add').onclick = async () => {
  const r = await api('POST', '/api/users', { name: $('u-name').value, password: $('u-pw').value, role: $('u-role').value });
  if (!r.ok) { $('u-err').textContent = errMsg(r); return; }
  $('u-err').textContent = '';
  $('u-name').value = '';
  $('u-pw').value = '';
  $('u-add-dlg').close();
  toast('Сотрудник добавлен');
  loadUsers();
};

// ── Приход (вес берётся с большого табло весов) ──
guard($('in-go'), async (id) => {
  if (!state.selGrade.in) { toast('Выберите сорт', true); return false; }
  const w = getActiveWeightKg();
  if (!w.ok) { toast(w.error, true); return false; }
  const ok = await sendCmd('intake', { grade: state.selGrade.in, net_kg: w.net, worker: '', note: $('in-note').value }, id);
  if (ok) { $('in-note').value = ''; clearManualWeight(); }
  return ok;
});

// ── Продажа (выбор покупателя чипами + добавление позиций с весов) ──
$('sl-new-cust').onclick = async () => {
  const name = await askText({ title: 'Новый покупатель', label: 'Название или имя', placeholder: 'Напр. Корзинка', okText: 'Добавить' });
  if (!name) return;
  const r = await api('POST', '/api/status?resource=refs', { target: 'customer', name });
  if (!r.ok) { toast(errMsg(r), true); return; }
  state.customers.push(r.data.customer);
  state.selCustomer = r.data.customer.name;
  renderCustomerChips();
  toast('Покупатель добавлен');
};

$('sl-add-pos').onclick = () => {
  if (!state.selGrade.sl) return toast('Выберите сорт', true);
  const w = getActiveWeightKg();
  if (!w.ok) return toast(w.error, true);
  const priceRaw = $('sl-price').value;
  const price = priceRaw === '' ? null : Number(priceRaw);
  const ovRaw = $('sl-amt-ov').value;
  const amount = ovRaw !== '' ? Number(ovRaw) : (price != null ? Math.round(w.net * price * 100) / 100 : 0);
  if (!Number.isFinite(amount) || amount < 0) return toast('Неверная сумма', true);
  state.saleCart.push({ grade: state.selGrade.sl, net_kg: w.net, price_per_kg: price, amount });
  $('sl-amt-ov').value = '';
  clearManualWeight();
  renderSaleCart();
};

guard($('sl-go'), async (id) => {
  if (!state.selCustomer) { toast('Выберите покупателя', true); return false; }
  if (!state.saleCart.length) { toast('Добавьте хотя бы одну позицию', true); return false; }
  const ok = await sendCmd('sale', { customer: state.selCustomer, note: $('sl-note').value, items: state.saleCart }, id);
  if (ok) {
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
  if (ok) { $('wo-reason').value = ''; clearManualWeight(); }
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
  const m = state.edTarget;
  const p = { id: m.id, device: m.device, reason: $('ed-reason').value };
  if (!p.reason.trim()) { $('ed-err').textContent = 'Укажите причину'; return; }
  const put = (k, v, old) => { if (String(v) !== String(old ?? '')) p[k] = v; };
  put('grade', $('ed-grade').value, m.grade);
  put('net_kg', $('ed-kg').value, m.net_kg);
  put('note', $('ed-note').value, m.note || '');
  if (m.type === 'in') put('worker', $('ed-worker').value, m.worker || '');
  if (m.type === 'out') {
    put('customer', $('ed-cust').value, m.customer || '');
    put('price_per_kg', $('ed-price').value, m.price_per_kg);
    put('amount', $('ed-amount').value, m.amount);
  }
  if (Object.keys(p).length <= 3) { $('ed-err').textContent = 'Ничего не изменено'; return; }
  if (await sendCmd('edit', p)) $('ed-dlg').close();
};

initScale(toast);
initInvoice(toast);
initReport({
  cur: () => state.cur,
  crop: () => state.crop,
  gradeColor,
  openHistoryDay: (day) => { $('h-day').value = day; navigate('history'); },
});
initExpenses({
  me: () => state.me,
  cur: () => state.cur,
  toast,
  askText,
});
initRefs({
  toast,
  askText,
  onRefsChanged: async () => {
    const s = await api('GET', '/api/status');
    if (s.ok) paintStatus(s.data);
  },
});
start();
