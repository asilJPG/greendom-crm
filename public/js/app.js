import { api, rawCall, errMsg, configureAuthHandlers } from './api.js';
import { initScale, autoConnectScale } from './scale.js';

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
  ['report', '/report', 'Отчёт', 'i-report', null, 'Склад'],
  ['history', '/history', 'История', 'i-history', null, 'Склад'],
  ['intake', '/intake', 'Приход', 'i-in', ['keeper', 'admin'], 'Работа'],
  ['sale', '/sale', 'Продажа', 'i-out', ['keeper', 'admin'], 'Работа'],
  ['writeoff', '/writeoff', 'Списание', 'i-wo', ['keeper', 'admin'], 'Работа'],
  ['queue', '/queue', 'Очередь', 'i-queue', ['keeper', 'admin'], 'Работа'],
  ['users', '/users', 'Сотрудники', 'i-users', ['admin'], 'Администрирование'],
  ['log', '/log', 'Журнал', 'i-log', ['admin'], 'Администрирование'],
];

const state = {
  me: null,
  tab: 'stock',
  cur: 'сум',
  grades: [],
  gradeIdx: {},
  histMap: {},
  hType: '',
  lastSeenSec: 0,
  lastPw: '',
  timer: null,
  opsTimer: null,
  toastTimer: null,
  pwTarget: null,
  edTarget: null,
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

// Универсальное модальное окно ввода текста (вместо браузерного prompt())
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
  ROUTES.forEach(([key]) => ($('p-' + key).hidden = key !== ridTab));
  const isOp = ridTab === 'intake' || ridTab === 'sale' || ridTab === 'writeoff';
  $('ops-shared').hidden = !isOp;

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
    fillGrades();
    autoConnectScale();
    if (ridTab === 'sale' && !$('sl-items').children.length) addSaleRow();
  }
  if (ridTab === 'queue') {
    loadOps();
    state.opsTimer = setInterval(loadOps, 8000);
  }
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

/* ───── старт и статус ───── */
function paintStatus(d) {
  const dev = d.devices[0];
  if (!dev) {
    $('seen').textContent = 'нет данных';
    $('dot').className = 'dot bad';
    $('stale').hidden = true;
    return;
  }
  state.grades = Array.isArray(dev.grades) ? dev.grades : [];
  state.lastSeenSec = dev.seconds_ago;
  state.cur = dev.currency || 'сум';
  $('title').textContent = 'Склад' + (dev.crop ? ' · ' + dev.crop : '');
  const m = Math.floor(dev.seconds_ago / 60);
  $('seen').textContent = m < 1 ? 'сейчас' : m < 60 ? m + ' мин' : Math.floor(m / 60) + ' ч';
  const stale = dev.seconds_ago > 900;
  $('dot').className = 'dot ' + (stale ? 'bad' : 'ok');
  $('stale').hidden = !stale;
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
  if (state.me.role !== 'director') loadOps();

  clearInterval(state.timer);
  state.timer = setInterval(refreshAll, 30000);
}

/* ───── остатки ───── */
async function loadStock() {
  const r = await api('GET', '/api/stock');
  if (!r.ok) return;
  const d = r.data;
  $('total').textContent = kg(d.total_kg);
  $('stock-cards').innerHTML = d.rows.map((x) =>
    `<div class="gcard"><div class="nm"><span class="sw" style="--gc:${gradeColor(x.grade)}"></span>${esc(x.grade)}</div>` +
    `<div class="bal">${kg(x.balance_kg)} <small>кг</small></div>` +
    `<div class="mini"><div>приход<b>${kg(x.in_kg)}</b></div><div>продано<b>${kg(x.out_kg)}</b></div><div>списано<b>${kg(x.writeoff_kg)}</b></div></div></div>`
  ).join('') || '<div class="empty">Данных ещё нет</div>';
}

/* ───── отчёт ───── */
async function loadReport() {
  const r = await api('GET', `/api/report?from=${$('r-from').value}&to=${$('r-to').value}`);
  if (!r.ok) return;
  const d = r.data;
  const sum = (k) => d.by_grade.reduce((a, x) => a + x[k], 0);
  const tOut = sum('out_kg');
  const tAmt = sum('amount');
  const section = (title, rows) => `<div class="card"><h2>${title}</h2>${rows.length ? `<ul class="list">${rows.join('')}</ul>` : '<div class="muted">Нет данных за период</div>'}</div>`;

  $('r-body').innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="k">Выручка</div><div class="v">${money(tAmt)} <small>${esc(state.cur)}</small></div></div>
      <div class="kpi"><div class="k">Продано</div><div class="v">${kg(tOut)} <small>кг</small></div></div>
      <div class="kpi"><div class="k">Приход</div><div class="v">${kg(sum('in_kg'))} <small>кг</small></div></div>
      <div class="kpi"><div class="k">Средняя цена</div><div class="v">${tOut ? money(tAmt / tOut) : '—'} <small>${esc(state.cur)}/кг</small></div></div>
      <div class="kpi"><div class="k">Списано</div><div class="v">${kg(sum('writeoff_kg'))} <small>кг</small></div></div>
    </div>
    <div class="muted small" style="margin:-2px 2px 14px">Ручных записей веса: ${d.manual_entries} · отменённых операций: ${d.cancelled_entries}</div>
    ${section('По сортам', d.by_grade.map((x) => row(`<span class="sw" style="--gc:${gradeColor(x.grade)};margin-right:8px"></span>${esc(x.grade)}`, `приход ${kg(x.in_kg)} · продано ${kg(x.out_kg)} · списано ${kg(x.writeoff_kg)}`, `${money(x.amount)}`)))}
    ${section('По дням', d.by_day.map((x) => row(dm(x.day), `приход ${kg(x.in_kg)} · продано ${kg(x.out_kg)} кг`, `${money(x.amount)}`)))}
    ${section('Кто сколько собрал', d.by_worker.map((x) => row(esc(x.worker), `${x.crates} ящ.`, `${kg(x.kg)} кг`)))}
    ${section('Покупатели', d.by_customer.map((x) => row(esc(x.customer), `${kg(x.kg)} кг`, `${money(x.amount)} ${esc(state.cur)}`)))}`;
}

/* ───── история ───── */
function rowActions(m) {
  if (m.status === 'cancelled' || !state.me) return '';
  const key = `${m.device}:${m.id}`;
  state.histMap[key] = m;
  const mine = state.me.role === 'keeper' && m.user_name === state.me.name && m.ts.slice(0, 10) === iso(new Date());
  if (state.me.role !== 'admin' && !mine) return '';
  return `<div class="acts"><button class="btn sec sm" data-a="cancel" data-k="${esc(key)}">Отменить${m.sale_id ? ' продажу' : ''}</button>` +
    `${state.me.role === 'admin' ? `<button class="btn sec sm" data-a="edit" data-k="${esc(key)}">Исправить</button>` : ''}</div>`;
}

async function loadHistory() {
  const r = await api('GET', `/api/movements?type=${state.hType}&day=${$('h-day').value}&limit=200`);
  if (!r.ok) return;
  state.histMap = {};
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
    el.innerHTML =
      `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${esc(u.name)}</b>` +
      `<span class="badge b-${u.role}">${ROLE_NAME[u.role] || u.role}</span>` +
      `${u.active ? '<span class="badge b-active">Активен</span>' : '<span class="badge b-off">Отключён</span>'}</div>` +
      `<div class="s small muted" style="margin-top:3px">${u.must_change ? 'ещё не сменил пароль · ' : ''}вход: ${esc(u.last_login || '—')}</div>` +
      `<div class="acts"><button class="btn sec sm" data-a="name">Имя</button>` +
      `<select class="rolesel" aria-label="Роль" style="width:auto;min-height:34px;padding:6px 10px;font-size:13.5px;border-radius:9px">` +
      `${Object.entries(ROLE_NAME).map(([k, v]) => `<option value="${k}"${k === u.role ? ' selected' : ''}>${v}</option>`).join('')}</select>` +
      `<button class="btn sec sm" data-a="pw">Новый пароль</button>` +
      `<button class="btn sec sm" data-a="active">${u.active ? 'Отключить' : 'Включить'}</button></div>`;
    el.querySelector('.rolesel').onchange = async (e) => {
      const r2 = await api('PATCH', '/api/users', { id: u.id, role: e.target.value });
      toast(r2.ok ? 'Роль изменена' : errMsg(r2), !r2.ok);
      loadUsers();
    };
    el.querySelectorAll('button').forEach((b) => (b.onclick = async () => {
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

/* ───── операции и очередь ───── */
function fillGrades() {
  for (const id of ['in-grade', 'wo-grade', 'ed-grade']) {
    const el = $(id), v = el.value;
    el.innerHTML = state.grades.map((g) => `<option>${esc(g)}</option>`).join('');
    if (state.grades.includes(v)) el.value = v;
  }
  document.querySelectorAll('#sl-items select').forEach((el) => {
    const v = el.value;
    el.innerHTML = state.grades.map((g) => `<option>${esc(g)}</option>`).join('');
    if (state.grades.includes(v)) el.value = v;
  });
  const stale = state.lastSeenSec > 900;
  $('ops-stale').hidden = !stale;
  if (stale) $('ops-stale').textContent = 'Моноблок сейчас не на связи: изменения сохранятся на сайте сразу, а моноблок подтянет их при подключении.';
}

async function sendCmd(kind, payload, requestId) {
  const r = await api('POST', '/api/command', { kind, payload, request_id: requestId || rid() });
  if (!r.ok) { toast(errMsg(r), true); return false; }
  toast(r.data.duplicate ? 'Эта операция уже принята' : r.data.status === 'pending' ? 'Сохранено на сайте (синхронизируется со складом)' : 'Сохранено');
  if (state.tab === 'history') loadHistory();
  else loadOps();
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

function addSaleRow() {
  const el = document.createElement('div');
  el.className = 'sitem';
  const n = 'sl' + Math.random().toString(36).slice(2, 7);
  el.innerHTML =
    `<div class="wrow"><select>${state.grades.map((g) => `<option>${esc(g)}</option>`).join('')}</select>` +
    `<button class="btn sec sm" data-del style="min-width:44px" aria-label="Убрать позицию">×</button></div>` +
    `<div class="wrow" style="margin-top:8px"><input id="${n}" class="kg" type="number" inputmode="decimal" step="0.001" min="0" placeholder="Вес, кг">` +
    `<button class="btn sec sm sc-read" data-t="${n}">С весов</button></div>` +
    `<div class="two"><input class="price" type="number" inputmode="decimal" min="0" placeholder="Цена за кг">` +
    `<input class="amt" type="number" inputmode="decimal" min="0" placeholder="Сумма"></div>`;
  const kgI = el.querySelector('.kg'), pr = el.querySelector('.price'), am = el.querySelector('.amt');
  const calc = () => { if (!am.dataset.hand && kgI.value && pr.value) am.value = Math.round(kgI.value * pr.value * 100) / 100; updateSaleTotal(); };
  kgI.oninput = pr.oninput = calc;
  am.oninput = () => { am.dataset.hand = am.value ? '1' : ''; updateSaleTotal(); };
  el.querySelector('[data-del]').onclick = () => { el.remove(); updateSaleTotal(); };
  $('sl-items').appendChild(el);
}

function updateSaleTotal() {
  const sum = [...document.querySelectorAll('#sl-items .amt')].reduce((a, i) => a + (+i.value || 0), 0);
  $('sl-total').textContent = money(sum) + ' ' + state.cur;
}

async function loadOps() {
  const r = await api('GET', '/api/command');
  if (!r.ok) return;
  fillGrades();
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
  fillGrades();
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

$('menu').onclick = () => { $('md-name').textContent = state.me.name; $('md-role').textContent = ROLE_NAME[state.me.role] || state.me.role; $('menu-dlg').showModal(); };
$('md-close').onclick = () => $('menu-dlg').close();
$('md-out').onclick = () => { $('menu-dlg').close(); logout(); };
$('md-pw').onclick = () => { $('menu-dlg').close(); openPw(null); };
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
  if (state.tab === 'users') loadUsers();
  if (state.tab === 'log') loadLog();
  toast('Обновлено');
};

document.querySelectorAll('[data-range]').forEach((b) => (b.onclick = () => {
  const today = iso(new Date());
  $('r-from').value = b.dataset.range === 'month' ? today.slice(0, 8) + '01' : shift(+b.dataset.range);
  $('r-to').value = today;
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

guard($('in-go'), async (id) => {
  const ok = await sendCmd('intake', { grade: $('in-grade').value, net_kg: $('in-kg').value, worker: $('in-worker').value, note: $('in-note').value }, id);
  if (ok) { $('in-kg').value = ''; $('in-note').value = ''; }
  return ok;
});
guard($('wo-go'), async (id) => {
  const ok = await sendCmd('writeoff', { grade: $('wo-grade').value, net_kg: $('wo-kg').value, reason: $('wo-reason').value }, id);
  if (ok) { $('wo-kg').value = ''; $('wo-reason').value = ''; }
  return ok;
});
$('sl-add').onclick = addSaleRow;
guard($('sl-go'), async (id) => {
  const items = [...document.querySelectorAll('#sl-items .sitem')].map((el) => ({
    grade: el.querySelector('select').value,
    net_kg: el.querySelector('.kg').value,
    price_per_kg: el.querySelector('.price').value,
    amount: el.querySelector('.amt').value,
  }));
  const ok = await sendCmd('sale', { customer: $('sl-cust').value, note: $('sl-note').value, items }, id);
  if (ok) { $('sl-items').innerHTML = ''; $('sl-cust').value = ''; $('sl-note').value = ''; addSaleRow(); updateSaleTotal(); }
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
start();
