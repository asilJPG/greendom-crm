// Проверки облачной части на настоящем Postgres (PGlite работает локально, без сети).
// Вход идёт по одному паролю (имени нет): пароль определяет пользователя и роль.
// Цель: попытаться нарушить правила (чужой пароль, подделка сессии, обход смены пароля, чужие права, подбор).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.INGEST_TOKEN = 'ingest-token-for-tests-0123456789abcdef';
process.env.SESSION_SECRET = 'session-secret-for-tests-0123456789';
process.env.SETUP_KEY = 'setup-key-for-tests-0123456789abcdef';

const pg = new PGlite();
globalThis.__TEST_DB = { query: async (text, params) => (await pg.query(text, params)).rows };

const ingest = require('../api/ingest');
const login = require('../api/login');
const logout = require('../api/logout');
const setup = require('../api/setup');
const password = require('../api/password');
const users = require('../api/users');
const stock = require('../api/stock');
const report = require('../api/report');
const movements = require('../api/movements');
const status = require('../api/status');
const command = require('../api/command');
const passkey = require('../api/passkey');
const { todayStr } = require('../lib/http');

const OWNER_PW = '4711-test'; // вымышленные данные; настоящие пароли в тестах не используются

let ipCounter = 0;
function call(fn, { method = 'GET', body, query = {}, headers = {}, ip } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      code: 200, headers: {}, body: null,
      status(c) { this.code = c; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      json(o) { this.body = o; resolve(this); return this; },
      end(o) { this.body = o; resolve(this); return this; },
    };
    const xff = ip || `10.0.0.${++ipCounter}`; // у каждого запроса свой адрес, если не задан явно
    Promise.resolve(fn({ method, body, query, headers: { 'x-forwarded-for': xff, ...headers } }, res)).catch(reject);
  });
}
const AUTH = { authorization: 'Bearer ' + process.env.INGEST_TOKEN };
const SETUP = process.env.SETUP_KEY;
const today = todayStr();
const M = (o) => ({ ts: `${today} 10:00:00`, type: 'in', grade: 'Высший', gross_kg: 10.5, tare_kg: 0.5, net_kg: 10, manual: 0,
  worker: '', note: '', sale_id: null, customer: null, price_per_kg: null, amount: null, user_name: 'Склад 1', status: 'active', ...o });
const BATCH = {
  device: 'point-1', crop: 'Клубника', currency: 'сум', grades: ['Высший', 'Первый', 'Второй', 'Брак'], pending: 0,
  movements: [
    M({ id: 1, grade: 'Высший', net_kg: 100, worker: 'Алишер', manual: 1 }),
    M({ id: 2, grade: 'Первый', net_kg: 50, worker: 'Дильноза' }),
    M({ id: 3, type: 'out', grade: 'Высший', net_kg: 30, sale_id: 1, customer: 'ООО Базар', price_per_kg: 20000, amount: 600000 }),
    M({ id: 4, type: 'writeoff', grade: 'Первый', net_kg: 5, note: 'Порча' }),
  ],
};
const cookieOf = (r) => r.headers['Set-Cookie'].split(';')[0];
async function signIn(pw, ip) {
  const r = await call(login, { method: 'POST', body: { password: pw }, ip });
  assert.equal(r.code, 200, `вход: ${JSON.stringify(r.body)}`);
  return { cookie: cookieOf(r), body: r.body };
}
const as = (cookie) => ({ headers: { cookie } });
const DATA_ENDPOINTS = [['stock', stock], ['report', report], ['movements', movements]];

// ───────── первичная настройка ─────────
test('setup: без ключа и с чужим ключом закрыт', async () => {
  assert.equal((await call(setup, { method: 'POST', body: { name: 'owner', password: OWNER_PW } })).code, 401);
  assert.equal((await call(setup, { method: 'POST', body: { key: 'wrong', name: 'owner', password: OWNER_PW } })).code, 401);
  assert.equal((await call(setup, { method: 'GET' })).code, 405);
});

test('setup: создаёт первого админа один раз, повторно нельзя даже с верным ключом', async () => {
  assert.equal((await call(setup, { method: 'POST', body: { key: SETUP, name: 'owner', password: '12' } })).code, 400, 'слишком короткий');
  const ok = await call(setup, { method: 'POST', body: { key: SETUP, name: 'owner', password: OWNER_PW } });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.must_change, false);
  assert.equal((await call(setup, { method: 'POST', body: { key: SETUP, name: 'hacker', password: 'hackerpass1' } })).code, 409);
  const [{ n }] = await globalThis.__TEST_DB.query('SELECT count(*)::int AS n FROM app_users');
  assert.equal(n, 1);
});

test('пароль в базе хранится хэшем и шифром, а не открытым текстом; админ видит пароль в /api/users', async () => {
  const [u] = await globalThis.__TEST_DB.query('SELECT pass_hash, pass_enc FROM app_users');
  assert.match(u.pass_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.ok(!u.pass_hash.includes(OWNER_PW));
  assert.ok(u.pass_enc.startsWith('gcm$'));
  assert.ok(!u.pass_enc.includes(OWNER_PW));
  const { cookie: admin } = await signIn(OWNER_PW);
  const list = await call(users, as(admin));
  assert.equal(list.code, 200);
  assert.equal(list.body[0].password, OWNER_PW);
});

// ───────── приёмник (ключ моноблока) ─────────
test('приёмник: без ключа и с чужим ключом закрыт; плохие данные дают 400', async () => {
  assert.equal((await call(ingest, { method: 'POST', body: BATCH })).code, 401);
  assert.equal((await call(ingest, { method: 'POST', body: BATCH, headers: { authorization: 'Bearer wrong' } })).code, 401);
  const bad = await call(ingest, { method: 'POST', body: { ...BATCH, movements: [{ ...M({ id: 9 }), type: 'steal' }] }, headers: AUTH });
  assert.equal(bad.code, 400);
  assert.equal((await call(ingest, { method: 'POST', body: { movements: [] }, headers: AUTH })).code, 400);
});

test('приёмник: принимает пачку, повторная отправка не дублирует', async () => {
  assert.equal((await call(ingest, { method: 'POST', body: BATCH, headers: AUTH })).body.accepted, 4);
  assert.equal((await call(ingest, { method: 'POST', body: BATCH, headers: AUTH })).code, 200);
  const [{ n }] = await globalThis.__TEST_DB.query('SELECT count(*)::int AS n FROM movements');
  assert.equal(n, 4);
});

// ───────── вход по одному паролю ─────────
test('вход: неверный, пустой и не-строковый пароль не проходят; инъекция не проходит', async () => {
  for (const body of [{ password: 'wrong-pass' }, { password: '' }, {}, { password: { $ne: 1 } }, { password: ["' OR '1'='1"] }, { password: "' OR 1=1 --" }]) {
    assert.equal((await call(login, { method: 'POST', body })).code, 401, JSON.stringify(body));
  }
  assert.equal((await call(login, { method: 'POST', body: { name: 'owner', password: 'wrong-pass' } })).code, 401, 'имя больше ничего не даёт');
});

test('вход: пароль определяет пользователя и роль; имя в запросе игнорируется', async () => {
  const a = await signIn(OWNER_PW);
  assert.equal(a.body.role, 'admin');
  assert.equal(a.body.name, 'owner');
  const b = await call(login, { method: 'POST', body: { name: 'кто-угодно', password: OWNER_PW } });
  assert.equal(b.body.name, 'owner', 'подставленное имя на результат не влияет');
});

test('данные закрыты без входа, с мусорной и с подделанной cookie', async () => {
  const { cookie } = await signIn(OWNER_PW);
  for (const [name, fn] of [...DATA_ENDPOINTS, ['status', status], ['users', users]]) {
    assert.equal((await call(fn)).code, 401, `${name} без cookie`);
    assert.equal((await call(fn, as('cs=abc.def'))).code, 401, `${name} мусор`);
    const forged = cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    assert.equal((await call(fn, as(forged))).code, 401, `${name} подпись изменена`);
  }
  const [payload] = cookie.slice(3).split('.');
  assert.equal((await call(stock, as(`cs=${payload}.AAAA`))).code, 401);
});

// ───────── данные склада ─────────
test('остатки, отчёт, история считаются верно', async () => {
  const { cookie } = await signIn(OWNER_PW);
  const st = await call(stock, as(cookie));
  const by = Object.fromEntries(st.body.rows.map((x) => [x.grade, x]));
  assert.equal(by['Высший'].balance_kg, 70);
  assert.equal(by['Первый'].balance_kg, 45);
  assert.equal(st.body.total_kg, 115);
  assert.deepEqual(st.body.rows.map((x) => x.grade), ['Высший', 'Первый', 'Второй', 'Брак']);
  const rep = await call(report, { query: { from: today, to: today }, ...as(cookie) });
  const g = Object.fromEntries(rep.body.by_grade.map((x) => [x.grade, x]));
  assert.equal(g['Высший'].amount, 600000);
  assert.equal(rep.body.by_customer[0].customer, 'ООО Базар');
  assert.equal(rep.body.manual_entries, 1);
  assert.equal((await call(movements, { query: { type: 'in' }, ...as(cookie) })).body.length, 2);
});

test('отмена на моноблоке доходит до облака и меняет остаток и выручку', async () => {
  const cancelled = { ...BATCH, movements: [M({ id: 3, type: 'out', grade: 'Высший', net_kg: 30, sale_id: 1, customer: 'ООО Базар',
    price_per_kg: 20000, amount: 600000, status: 'cancelled', cancel_reason: 'покупатель отказался', cancelled_ts: `${today} 11:00:00` })] };
  assert.equal((await call(ingest, { method: 'POST', body: cancelled, headers: AUTH })).code, 200);
  const { cookie } = await signIn(OWNER_PW);
  assert.equal((await call(stock, as(cookie))).body.rows.find((x) => x.grade === 'Высший').balance_kg, 100);
  const rep = await call(report, { query: {}, ...as(cookie) });
  assert.equal(rep.body.by_grade.find((x) => x.grade === 'Высший').amount, 0);
  assert.equal(rep.body.cancelled_entries, 1);
});

// ───────── пользователи, роли, смена пароля ─────────
test('админ создаёт пользователя; одинаковые пароли не принимаются; пароль сразу постоянный', async () => {
  const { cookie: admin } = await signIn(OWNER_PW);
  const add = (body) => call(users, { method: 'POST', body, ...as(admin) });
  assert.equal((await add({ name: 'Бахтиёр', password: 'short', role: 'director' })).code, 400, 'короткий пароль');
  assert.equal((await add({ name: 'Б', password: 'longenough1', role: 'director' })).code, 400, 'короткое имя');
  assert.equal((await add({ name: 'Бахтиёр', password: OWNER_PW, role: 'director' })).code, 409, 'чужой пароль занят: двое с одним паролем невозможны');
  assert.equal((await add({ name: 'Бахтиёр', password: 'viewerpass1', role: 'director' })).code, 200);
  assert.equal((await add({ name: 'бахтиёр', password: 'viewerpass2', role: 'director' })).code, 409, 'имя занято без учёта регистра');
  assert.equal((await add({ name: 'Другой', password: 'viewerpass1', role: 'director' })).code, 409, 'пароль нового пользователя уже занят');

  const v = await signIn('viewerpass1');
  assert.equal(v.body.role, 'director', 'роль определена по паролю');
  assert.equal(v.body.must_change, false, 'пароль сразу постоянный');
  for (const [name, fn] of DATA_ENDPOINTS) {
    const r = await call(fn, as(v.cookie));
    assert.equal(r.code, 200, `${name}: данные доступны сразу после входа`);
  }
  const st = await call(status, as(v.cookie));
  assert.equal(st.code, 200);
  assert.ok(st.body.devices.length >= 1, 'данные склада отдаются сразу');
});

test('смена пароля: правила (в т.ч. чужой пароль), старая сессия отзывается', async () => {
  const v = await signIn('viewerpass1');
  const chg = (body) => call(password, { method: 'POST', body, ...as(v.cookie) });
  assert.equal((await chg({ old_password: 'viewerpass1', new_password: 'short' })).code, 400, 'короче 8');
  assert.equal((await chg({ old_password: 'viewerpass1', new_password: 'viewerpass1' })).code, 400, 'тот же пароль');
  assert.equal((await chg({ old_password: 'WRONG-old-pass', new_password: 'brand-new-pass-1' })).code, 400, 'неверный текущий');
  assert.equal((await chg({ old_password: 'viewerpass1', new_password: OWNER_PW })).code, 409, 'нельзя взять пароль администратора');
  const ok = await chg({ old_password: 'viewerpass1', new_password: 'brand-new-pass-1' });
  assert.equal(ok.code, 200);
  assert.equal((await call(stock, as(v.cookie))).code, 401, 'старая cookie отозвана');
  assert.equal((await call(stock, as(cookieOf(ok)))).code, 200, 'новая cookie работает');
  assert.equal((await call(login, { method: 'POST', body: { password: 'viewerpass1' } })).code, 401, 'старый пароль не подходит');
});

test('роль «просмотр» не может управлять пользователями и читать журнал', async () => {
  const { cookie: v, body } = await signIn('brand-new-pass-1');
  assert.equal(body.role, 'director');
  assert.equal((await call(stock, as(v))).code, 200);
  assert.equal((await call(users, as(v))).code, 403);
  assert.equal((await call(users, { query: { log: '1' }, ...as(v) })).code, 403);
  assert.equal((await call(users, { method: 'POST', body: { name: 'Хакер', password: 'hackerpass1', role: 'admin' }, ...as(v) })).code, 403);
  assert.equal((await call(users, { method: 'PATCH', body: { id: 1, role: 'director' }, ...as(v) })).code, 403);
  const [{ n }] = await globalThis.__TEST_DB.query(`SELECT count(*)::int AS n FROM app_users WHERE role='admin'`);
  assert.equal(n, 1, 'новый админ не появился');
});

test('последнего администратора нельзя убрать ни понижением, ни отключением', async () => {
  const { cookie: admin } = await signIn(OWNER_PW);
  const me = (await call(users, as(admin))).body.find((u) => u.name === 'owner');
  assert.equal((await call(users, { method: 'PATCH', body: { id: me.id, role: 'director' }, ...as(admin) })).code, 409);
  assert.equal((await call(users, { method: 'PATCH', body: { id: me.id, active: false }, ...as(admin) })).code, 409);
  assert.equal((await call(users, { method: 'PATCH', body: { id: me.id, role: 'root' }, ...as(admin) })).code, 400, 'неизвестная роль');
  assert.equal((await call(users, { method: 'PATCH', body: { id: 99999, active: false }, ...as(admin) })).code, 404);
  assert.equal((await call(users, { method: 'PATCH', body: { id: 'x', active: false }, ...as(admin) })).code, 404);
});

test('отключение и сброс пароля отзывают входы; пароль отключённого остаётся занятым', async () => {
  const { cookie: admin } = await signIn(OWNER_PW);
  const bakh = (await call(users, as(admin))).body.find((u) => u.name === 'Бахтиёр');
  const v1 = await signIn('brand-new-pass-1');
  const reset = (pw) => call(users, { method: 'PATCH', body: { id: bakh.id, password: pw }, ...as(admin) });
  assert.equal((await reset(OWNER_PW)).code, 409, 'нельзя назначить пароль другого пользователя');
  assert.equal((await reset('reset-by-admin-1')).code, 200);
  assert.equal((await call(stock, as(v1.cookie))).code, 401, 'сброс пароля отзывает вход');
  const v2 = await signIn('reset-by-admin-1');
  assert.equal(v2.body.must_change, false, 'после сброса админом пароль сразу постоянный');
  assert.equal((await call(users, { method: 'PATCH', body: { id: bakh.id, active: false }, ...as(admin) })).code, 200);
  assert.equal((await call(stock, as(v2.cookie))).code, 401, 'отключённый выброшен');
  assert.equal((await call(login, { method: 'POST', body: { password: 'reset-by-admin-1' } })).code, 401, 'и не может войти');
  const reuse = await call(users, { method: 'POST', body: { name: 'Новый', password: 'reset-by-admin-1', role: 'director' }, ...as(admin) });
  assert.equal(reuse.code, 409, 'пароль отключённого пользователя нельзя отдать другому');
});

test('второго админа можно создать, тогда первого можно отключить', async () => {
  const { cookie: admin } = await signIn(OWNER_PW);
  assert.equal((await call(users, { method: 'POST', body: { name: 'Второй', password: 'secondadmin1', role: 'admin' }, ...as(admin) })).code, 200);
  const first = (await call(users, as(admin))).body.find((u) => u.name === 'owner');
  assert.equal((await call(users, { method: 'PATCH', body: { id: first.id, active: false }, ...as(admin) })).code, 200);
  assert.equal((await call(stock, as(admin))).code, 401);
  assert.equal((await call(login, { method: 'POST', body: { password: OWNER_PW } })).code, 401, 'отключённый админ не входит');
  const second = await signIn('secondadmin1');
  assert.equal(second.body.role, 'admin');
  const ch = await call(password, { method: 'POST', body: { old_password: 'secondadmin1', new_password: 'second-admin-ok-1' }, ...as(second.cookie) });
  assert.equal((await call(users, { method: 'PATCH', body: { id: first.id, active: true }, ...as(cookieOf(ch)) })).code, 200);
});

test('журнал: пишет входы, неудачи и действия, доступен только админу, пароли не попадают', async () => {
  const { cookie } = await signIn(OWNER_PW);
  const log = await call(users, { query: { log: '1' }, ...as(cookie) });
  assert.equal(log.code, 200);
  const actions = new Set(log.body.map((a) => a.action));
  for (const a of ['setup', 'login', 'login_fail', 'user_add', 'user_edit', 'password_change']) assert.ok(actions.has(a), `нет записи ${a}`);
  const text = JSON.stringify(log.body);
  for (const secret of [OWNER_PW, 'viewerpass1', 'brand-new-pass', 'reset-by-admin', 'secondadmin1']) assert.ok(!text.includes(secret), `пароль ${secret} в журнале`);
});

// ───────── подбор (в конце: меняет глобальное состояние блокировок) ─────────
test('подбор: 5 ошибок с одного адреса блокируют вход, даже с верным паролем; другой адрес не затронут', async () => {
  const ip = '203.0.113.7';
  for (let i = 0; i < 5; i++) assert.equal((await call(login, { method: 'POST', body: { password: 'guess' + i }, ip })).code, 401);
  assert.equal((await call(login, { method: 'POST', body: { password: 'guess' }, ip })).code, 423);
  assert.equal((await call(login, { method: 'POST', body: { password: OWNER_PW }, ip })).code, 423, 'верный пароль с заблокированного адреса не принят');
  assert.equal((await call(login, { method: 'POST', body: { password: OWNER_PW }, ip: '203.0.113.8' })).code, 200);
});

test('подбор: распределённый перебор с разных адресов упирается в общий предел, верный пароль тоже закрыт', async () => {
  let blockedAt = 0;
  for (let i = 1; i <= 40; i++) {
    const r = await call(login, { method: 'POST', body: { password: 'spray' + i }, ip: `198.51.100.${i}` });
    if (r.code === 423) { blockedAt = i; break; }
    assert.equal(r.code, 401);
  }
  assert.ok(blockedAt > 0, 'общая блокировка так и не сработала за 40 попыток');
  const valid = await call(login, { method: 'POST', body: { password: OWNER_PW }, ip: '198.51.100.200' });
  assert.equal(valid.code, 423, 'во время общей блокировки не входит никто (цена защиты: 15 минут без входа для всех)');
});

test('выход: cookie сбрасывается', async () => {
  const r = await call(logout, { method: 'POST' });
  assert.match(r.headers['Set-Cookie'], /Max-Age=0/);
});

test('роли: складовщик создаётся и видит данные; прежний «viewer» превращается в директора; чужая роль отклоняется', async () => {
  await globalThis.__TEST_DB.query('DELETE FROM login_fails'); // предыдущие проверки подбора заполнили общий предел
  const { cookie: admin } = await signIn(OWNER_PW);
  const add = (body) => call(users, { method: 'POST', body, ...as(admin) });
  assert.equal((await add({ name: 'Складовщик Анвар', password: 'keeper-pass-1', role: 'keeper' })).code, 200);
  assert.equal((await add({ name: 'Хакер роли', password: 'hacker-pass-1', role: 'viewer' })).body && (await call(users, as(admin))).body.find((u) => u.name === 'Хакер роли').role, 'director', 'неизвестная роль при создании = директор, а не повышение');
  const k = await signIn('keeper-pass-1');
  assert.equal(k.body.role, 'keeper');
  const chg = await call(password, { method: 'POST', body: { old_password: 'keeper-pass-1', new_password: 'keeper-new-pass-1' }, ...as(k.cookie) });
  assert.equal(chg.code, 200);
  assert.equal((await call(stock, as(cookieOf(chg)))).code, 200);
  assert.equal((await call(users, as(cookieOf(chg)))).code, 403, 'складовщик не управляет пользователями');
  // миграция: старая база с ролью viewer
  const db = globalThis.__TEST_DB;
  await db.query(`ALTER TABLE app_users DROP CONSTRAINT app_users_role_check`);
  await db.query(`INSERT INTO app_users(name, role, pass_hash) VALUES ('Старый просмотр','viewer','x')`);
  require('../lib/db').resetSchemaCache();
  await require('../lib/db').ensureSchema();
  const [old] = await db.query(`SELECT role FROM app_users WHERE name='Старый просмотр'`);
  assert.equal(old.role, 'director');
  await assert.rejects(db.query(`INSERT INTO app_users(name, role, pass_hash) VALUES ('Левый','root','x')`), 'база не принимает неизвестную роль');
});

// ───────── операции с сайта: мгновенное применение в облаке + синхронизация с моноблоком ─────────
test('операции с сайта: мгновенное применение, защита от перезаписи моноблоком, новые офлайн-записи, права и лимит', async () => {
  const db = globalThis.__TEST_DB;
  await db.query('DELETE FROM login_fails');
  const { cookie: admin } = await signIn(OWNER_PW);
  const adm = as(admin);
  assert.equal((await call(users, { method: 'POST', body: { name: 'Директор Тест', password: 'director-pass-1', role: 'director' }, ...adm })).code, 200);
  const dir = await signIn('director-pass-1');
  await call(password, { method: 'POST', body: { old_password: 'director-pass-1', new_password: 'director-pass-2' }, ...as(dir.cookie) });
  const dirCookie = cookieOf((await call(login, { method: 'POST', body: { password: 'director-pass-2' } })));
  const keeper = cookieOf(await call(login, { method: 'POST', body: { password: 'keeper-new-pass-1' } }));
  const P = { grade: 'Высший', net_kg: 12.5, worker: 'Мадина' };
  const post = (cookie, kind, payload, extra = {}) => call(command, { method: 'POST', body: { kind, payload, ...extra }, ...as(cookie) });

  assert.equal((await post(dirCookie, 'intake', P)).code, 403, 'директор не создаёт операции');
  assert.equal((await call(command, as(dirCookie))).code, 403, 'директор не читает очередь');
  assert.equal((await call(command, { method: 'POST', body: { kind: 'intake', payload: P }, headers: {} })).code, 401, 'без входа нельзя');
  assert.equal((await post(keeper, 'edit', { id: 1, reason: 'x', net_kg: 5 })).code, 403, 'складовщик не правит записи');

  // проверка данных на входе
  for (const [why, kind, payload] of [
    ['неизвестный сорт', 'intake', { ...P, grade: 'Левый' }], ['отрицательный вес', 'intake', { ...P, net_kg: -1 }],
    ['вес не число', 'intake', { ...P, net_kg: 'abc' }], ['нулевой вес', 'intake', { ...P, net_kg: 0 }],
    ['огромный вес', 'intake', { ...P, net_kg: 1e9 }], ['списание без причины', 'writeoff', { grade: 'Высший', net_kg: 1 }],
    ['продажа без покупателя', 'sale', { customer: ' ', items: [{ grade: 'Высший', net_kg: 1, amount: 1 }] }],
    ['продажа без позиций', 'sale', { customer: 'К', items: [] }], ['отмена без причины', 'cancel_movement', { id: 1 }],
    ['неизвестная операция', 'drop_table', {}],
  ]) assert.equal((await post(keeper, kind, payload)).code, 400, why);

  // новые операции с сайта сразу применяются в облаке (device='web') и меняют остаток
  const before = (await call(stock, adm)).body.rows.find((r) => r.grade === 'Высший').balance_kg;
  const ok = await post(keeper, 'intake', { ...P, evil: 'DROP', note: 'n' }, { request_id: 'req-1' });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.applied_cloud, true);
  assert.equal(ok.body.status, 'applied');
  assert.equal((await post(keeper, 'intake', P, { request_id: 'req-1' })).body.duplicate, true, 'повтор того же запроса не создаёт вторую операцию');
  const sale = await post(keeper, 'sale', { customer: 'ООО', items: [{ grade: 'Высший', net_kg: 3, price_per_kg: 20000, amount: 60000 }] });
  assert.equal(sale.code, 200);
  assert.equal(sale.body.status, 'applied');
  const after = (await call(stock, adm)).body.rows.find((r) => r.grade === 'Высший').balance_kg;
  assert.equal(Math.round((after - before) * 1000) / 1000, 9.5, 'остаток на сайте обновился сразу (+12.5 - 3)');

  // исправление записи моноблока: сразу меняет movements в облаке И ставит pending-команду для point-1
  const adminEdit = await post(admin, 'edit', { id: 1, device: 'point-1', reason: 'ошибка весов', net_kg: 90 });
  assert.equal(adminEdit.code, 200);
  assert.equal(adminEdit.body.status, 'pending');
  const [m1] = await db.query(`SELECT net_kg, manual FROM movements WHERE device='point-1' AND id=1`);
  assert.equal(m1.net_kg, 90, 'правка сразу видна в облачной БД');
  assert.equal(m1.manual, true);

  // моноблок забирает очередь; чужое устройство не видит и не закрывает чужую команду
  const dev = (b) => call(ingest, { method: 'POST', body: { device: 'point-1', crop: 'Клубника', currency: 'сум', grades: BATCH.grades, pending: 0, movements: [], ...b }, headers: AUTH });
  const other = await call(ingest, { method: 'POST', body: { device: 'other-device', acks: [{ id: adminEdit.body.id, status: 'applied', result: 'взлом' }], movements: [] }, headers: AUTH });
  assert.deepEqual(other.body.commands, [], 'другое устройство очередь не получает');

  // защита от перезаписи: если моноблок прислал старую версию id=1 + новую офлайн-запись id=99 ДО ack,
  // облачная правка id=1 сохраняется, а новая запись id=99 принимается!
  const stalePush = await dev({
    movements: [
      { ...BATCH.movements[0], net_kg: 10 }, // старая версия id=1
      { id: 99, ts: '2026-11-17 14:00:00', type: 'in', grade: 'Первый', gross_kg: 5.2, tare_kg: 0.2, net_kg: 5.0, worker: 'Офлайн', status: 'active' },
    ],
  });
  assert.equal(stalePush.body.commands.length, 1);
  assert.equal(stalePush.body.commands[0].id, adminEdit.body.id);
  const [m1Still] = await db.query(`SELECT net_kg FROM movements WHERE device='point-1' AND id=1`);
  assert.equal(m1Still.net_kg, 90, 'старые данные моноблока не затёрли свежую правку сайта');
  const [m99] = await db.query(`SELECT net_kg FROM movements WHERE device='point-1' AND id=99`);
  assert.equal(m99.net_kg, 5, 'новая офлайн-запись моноблока сохранилась');

  // подтверждение от моноблока закрывает команду; повторный ответ не перезаписывает
  await dev({ acks: [{ id: adminEdit.body.id, status: 'hacked' }] });
  assert.equal((await dev({})).body.commands.length, 1, 'неверный статус ответа игнорируется');
  await dev({ acks: [{ id: adminEdit.body.id, status: 'applied', result: 'запись #1 исправлена' }] });
  await dev({ acks: [{ id: adminEdit.body.id, status: 'rejected', result: 'позже' }] });
  assert.equal((await dev({})).body.commands.length, 0);
  const admCmds = (await call(command, adm)).body;
  assert.equal(admCmds.find((r) => r.id === adminEdit.body.id).status, 'applied');
  assert.equal(admCmds.find((r) => r.id === adminEdit.body.id).result, 'запись #1 исправлена');
  assert.ok(!(await call(command, as(keeper))).body.some((r) => r.id === adminEdit.body.id), 'складовщик видит только свои операции');

  // срок давности: через 30 дней несинхронизированная команда помечается expired
  const edit2 = await post(admin, 'edit', { id: 1, device: 'point-1', reason: 'тест срока', net_kg: 91 });
  assert.equal(edit2.code, 200);
  await db.query(`UPDATE commands SET ts = now() - interval '31 days' WHERE id=$1`, [edit2.body.id]);
  assert.equal((await dev({})).body.commands.length, 0);
  assert.equal((await call(command, adm)).body.find((r) => r.id === edit2.body.id).status, 'expired');

  // PATCH /api/command: админ может применить старые зависшие pending-команды в БД
  await db.query(`INSERT INTO commands(device,user_name,user_role,kind,payload,status) VALUES('point-1','Администратор','admin','edit','{"id":1,"reason":"старая очередь","net_kg":95}'::jsonb,'pending')`);
  assert.equal((await call(command, { method: 'PATCH', body: {}, ...as(keeper) })).code, 403, 'складовщик не применяет очередь');
  const patchRes = await call(command, { method: 'PATCH', body: {}, ...adm });
  assert.equal(patchRes.code, 200);
  assert.equal(patchRes.body.applied, 1);
  const [m1Applied] = await db.query(`SELECT net_kg FROM movements WHERE device='point-1' AND id=1`);
  assert.equal(m1Applied.net_kg, 95, 'старая команда из очереди применилась в movements');

  // лимит 20 ожидающих команд на человека
  for (let i = 0; i < 20; i++) {
    await db.query(`INSERT INTO commands(device,user_name,user_role,kind,payload,status) VALUES('point-1','Складовщик Анвар','keeper','edit','{"id":1}'::jsonb,'pending')`);
  }
  const over = await post(keeper, 'intake', P);
  assert.equal(over.code, 429, 'больше 20 ожидающих команд не принимается');

  // CSRF: чужой Origin на мутирующем запросе отклоняется
  const csrf = await call(command, {
    method: 'POST',
    body: { kind: 'intake', payload: P },
    headers: { cookie: admin, host: 'sklad-urozhay.vercel.app', origin: 'https://evil.example' },
  });
  assert.equal(csrf.code, 403, 'чужой Origin отклонён');
});

test('Face ID / Passkey: регистрация, вход с проверкой ECDSA-подписи, отказ при подделке и отключении', async () => {
  const crypto = require('crypto');
  await globalThis.__TEST_DB.query('DELETE FROM login_fails');
  const { cookie: admin } = await signIn(OWNER_PW);
  const host = 'sklad-urozhay.vercel.app';
  const origin = `https://${host}`;
  const rpHash = crypto.createHash('sha256').update(host).digest();
  const makeAuthData = (counter, flags = 0x05) => {
    const b = Buffer.alloc(37);
    rpHash.copy(b, 0);
    b[32] = flags; // UP(0x01) + UV(0x04)
    b.writeUInt32BE(counter, 33);
    return b;
  };
  const cookieHeader = (res) => {
    const sc = res.headers['Set-Cookie'];
    return Array.isArray(sc) ? sc.map((s) => s.split(';')[0]).join('; ') : String(sc || '').split(';')[0];
  };

  // 1. Получение опций регистрации
  const regOpt = await call(passkey, { method: 'POST', body: { action: 'reg_options' }, headers: { cookie: admin, host } });
  assert.equal(regOpt.code, 200);
  const chCookie = cookieHeader(regOpt);

  // 2. Генерация настоящей пары ECDSA P-256 (как в Face ID / Secure Enclave)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const credId = crypto.randomBytes(16).toString('base64url');
  const regClientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: regOpt.body.challenge, origin })).toString('base64url');

  const regVer = await call(passkey, {
    method: 'POST',
    body: { action: 'reg_verify', id: credId, clientDataJSON: regClientData, authenticatorData: makeAuthData(1).toString('base64url'), publicKey: spki, alg: -7, device_name: 'iPhone Test' },
    headers: { cookie: `${admin}; ${chCookie}`, host },
  });
  assert.equal(regVer.code, 200, JSON.stringify(regVer.body));

  // Список ключей пользователя
  const list = await call(passkey, { method: 'GET', headers: { cookie: admin, host } });
  assert.equal(list.code, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].device_name, 'iPhone Test');

  // 3. Вход по Face ID с настоящей подписью
  const authOpt = await call(passkey, { method: 'POST', body: { action: 'auth_options' }, headers: { host } });
  assert.equal(authOpt.code, 200);
  const authChCookie = cookieHeader(authOpt);
  const authClientBuf = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: authOpt.body.challenge, origin }));
  const authDataBuf = makeAuthData(2);
  const signedData = Buffer.concat([authDataBuf, crypto.createHash('sha256').update(authClientBuf).digest()]);
  const sig = crypto.sign('sha256', signedData, privateKey).toString('base64url');

  const authOk = await call(passkey, {
    method: 'POST',
    body: { action: 'auth_verify', id: credId, clientDataJSON: authClientBuf.toString('base64url'), authenticatorData: authDataBuf.toString('base64url'), signature: sig },
    headers: { cookie: authChCookie, host },
  });
  assert.equal(authOk.code, 200, JSON.stringify(authOk.body));
  const newSession = Array.isArray(authOk.headers['Set-Cookie']) ? authOk.headers['Set-Cookie'][0].split(';')[0] : cookieOf(authOk);
  assert.equal((await call(stock, as(newSession))).code, 200, 'сессия после Face ID открывает данные');

  // 4. Поддельная подпись отклоняется
  const authOpt2 = await call(passkey, { method: 'POST', body: { action: 'auth_options' }, headers: { host } });
  const bad = await call(passkey, {
    method: 'POST',
    body: { action: 'auth_verify', id: credId, clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: authOpt2.body.challenge, origin })).toString('base64url'), authenticatorData: makeAuthData(3).toString('base64url'), signature: Buffer.from('fake').toString('base64url') },
    headers: { cookie: cookieHeader(authOpt2), host },
  });
  assert.equal(bad.code, 401, 'поддельная подпись не проходит');

  // 5. Удаление ключа
  const del = await call(passkey, { method: 'DELETE', body: { id: credId }, headers: { cookie: admin, host } });
  assert.equal(del.code, 200);
  assert.equal((await call(passkey, { method: 'GET', headers: { cookie: admin, host } })).body.length, 0);
});

test('отчётная система: сводка, прошлый период, потери %, фильтры, накладные и Excel CSV', async () => {
  await globalThis.__TEST_DB.query('DELETE FROM login_fails');
  const { cookie: admin } = await signIn(OWNER_PW);
  const r = await call(report, { query: { from: today, to: today }, ...as(admin) });
  assert.equal(r.code, 200);
  assert.ok(r.body.summary && r.body.prev, 'есть summary и prev');
  assert.equal(typeof r.body.summary.loss_pct, 'number');
  assert.ok(Array.isArray(r.body.sales) && r.body.sales.length >= 1, 'есть сгруппированные продажи для накладных');
  assert.ok(r.body.filters.grades.includes('Высший'));

  const filtered = await call(report, { query: { from: today, to: today, grade: 'Высший' }, ...as(admin) });
  assert.equal(filtered.code, 200);
  assert.ok(filtered.body.by_grade.every((g) => g.grade === 'Высший'), 'фильтр по сорту работает');

  const csv = await call(report, { query: { from: today, to: today, format: 'csv' }, ...as(admin) });
  assert.equal(csv.code, 200);
  assert.match(csv.headers['Content-Type'], /text\/csv/);
  assert.ok(String(csv.body).startsWith('\uFEFF'), 'есть UTF-8 BOM для Excel');
  assert.ok(String(csv.body).includes('Высший'), 'данные попали в CSV');
});

test('расходы: категории, акты расхода, права, отмена и чистая прибыль в отчёте', async () => {
  await globalThis.__TEST_DB.query('DELETE FROM login_fails');
  const { cookie: admin } = await signIn(OWNER_PW);
  const { cookie: dir } = await signIn('director-pass-2');
  const expReq = (method, body, cookie, extraQ = {}) =>
    call(report, { method, query: { resource: 'expenses', from: today, to: today, ...extraQ }, body, ...as(cookie) });

  // Базовые категории созданы автоматически
  const init = await expReq('GET', undefined, admin);
  assert.equal(init.code, 200);
  assert.ok(init.body.categories.some((c) => c.name === 'Зарплата'));

  // Создание и дубликат категории (только админ)
  assert.equal((await expReq('POST', { target: 'category', name: 'Аренда' }, dir)).code, 403, 'директор не создаёт категории');
  const cat = await expReq('POST', { target: 'category', name: 'Аренда теплицы' }, admin);
  assert.equal(cat.code, 200);
  assert.equal((await expReq('POST', { target: 'category', name: 'аренда теплицы' }, admin)).code, 409, 'дубликат категории');

  // Создание акта расхода: складовщик не имеет доступа (403), офисные роли (admin/director) могут
  const { cookie: keeper } = await signIn('keeper-new-pass-1');
  assert.equal((await expReq('GET', undefined, keeper)).code, 403, 'складовщик не видит расходы');
  assert.equal((await call(report, { query: { from: today, to: today }, ...as(keeper) })).code, 403, 'складовщик не видит отчёт ОПиУ');
  assert.equal((await expReq('POST', { target: 'expense', category_id: cat.body.category.id, amount: 100000 }, keeper)).code, 403);
  const act = await expReq('POST', {
    target: 'expense', doc_date: today, category_id: cat.body.category.id, amount: 150000,
    counterparty: 'АгроСнаб', payment_method: 'transfer', comment: 'Аванс',
  }, dir);
  assert.equal(act.code, 200);

  // Отчёт учитывает расходы и чистую прибыль (выручка - расходы)
  const rep1 = await call(report, { query: { from: today, to: today }, ...as(admin) });
  assert.equal(rep1.body.summary.expenses_total, 150000);
  assert.equal(rep1.body.summary.net_profit, Math.round((rep1.body.summary.amount - 150000) * 100) / 100);
  assert.equal(rep1.body.by_expense_category[0].category, 'Аренда теплицы');

  // Отмена акта обнуляет расход в отчёте
  const canc = await expReq('PATCH', { target: 'expense', id: act.body.id, reason: 'Ошибочный акт' }, admin);
  assert.equal(canc.code, 200);
  const rep2 = await call(report, { query: { from: today, to: today }, ...as(admin) });
  assert.equal(rep2.body.summary.expenses_total, 0);
});

test('справочники: динамические сорта и покупатели без хардкода', async () => {
  await globalThis.__TEST_DB.query('DELETE FROM login_fails');
  const { cookie: admin } = await signIn(OWNER_PW);
  const { cookie: keeper } = await signIn('keeper-new-pass-1');
  const refReq = (method, body, cookie) => call(status, { method, query: { resource: 'refs' }, body, ...as(cookie) });

  assert.equal((await refReq('POST', { target: 'grade', name: 'Экстра' }, keeper)).code, 403, 'сорта создаёт только админ');
  const g = await refReq('POST', { target: 'grade', name: 'Экстра' }, admin);
  assert.equal(g.code, 200);
  const c = await refReq('POST', { target: 'customer', name: 'Хавас', phone: '+998901112233' }, keeper);
  assert.equal(c.code, 200, 'складовщик может добавить нового покупателя прямо из продажи');

  const st = await call(status, as(admin));
  assert.ok(st.body.grades.includes('Экстра'));
  assert.ok(st.body.customers.some((x) => x.name === 'Хавас'));
});

test('контрагенты, оплаты, акт сверки и детализация ОПиУ', async () => {
  await globalThis.__TEST_DB.query('DELETE FROM login_fails');
  const { cookie: admin } = await signIn(OWNER_PW);
  const { cookie: dir } = await signIn('director-pass-2');
  const today = new Date().toISOString().slice(0, 10);

  // Директор может создавать контрагента с типом и ИНН
  const cpRes = await call(status, {
    method: 'POST',
    query: { resource: 'refs' },
    body: { target: 'customer', name: 'Корзинка', kind: 'buyer', inn: '301234567', phone: '+998901234567' },
    ...as(dir),
  });
  assert.equal(cpRes.code, 200);
  assert.equal(cpRes.body.customer.kind, 'buyer');
  assert.equal(cpRes.body.customer.inn, '301234567');

  // Проведём продажу Корзинке на 500 000 сум (сначала приход, чтобы хватило остатка)
  const inCmd = await call(command, {
    method: 'POST',
    body: { kind: 'intake', request_id: 'rec-in-1', payload: { grade: 'Высший', net_kg: 10 } },
    ...as(admin),
  });
  assert.equal(inCmd.code, 200);
  const saleCmd = await call(command, {
    method: 'POST',
    body: {
      kind: 'sale',
      request_id: 'rec-sale-1',
      payload: { customer: 'Корзинка', items: [{ grade: 'Высший', net_kg: 5, price_per_kg: 100000, amount: 500000 }] },
    },
    ...as(admin),
  });
  assert.equal(saleCmd.code, 200);

  // Оплата от Корзинки на 300 000 сум + ошибочная на 50 000 сум, которую отменим
  const pay1 = await call(report, {
    method: 'POST',
    query: { resource: 'payments' },
    body: { doc_date: today, counterparty: 'Корзинка', direction: 'in', amount: 300000, payment_method: 'transfer', comment: 'П/п 12' },
    ...as(dir),
  });
  assert.equal(pay1.code, 200);
  const pay2 = await call(report, {
    method: 'POST',
    query: { resource: 'payments' },
    body: { doc_date: today, counterparty: 'Корзинка', direction: 'in', amount: 50000, payment_method: 'cash' },
    ...as(dir),
  });
  assert.equal(pay2.code, 200);
  const cancPay = await call(report, {
    method: 'PATCH',
    query: { resource: 'payments' },
    body: { id: pay2.body.id, reason: 'Дубль' },
    ...as(admin),
  });
  assert.equal(cancPay.code, 200);

  // Сводка по контрагентам: Корзинка должна нам 500 000 - 300 000 = 200 000
  const listRes = await call(report, { query: { resource: 'reconcile' }, ...as(dir) });
  assert.equal(listRes.code, 200);
  const korz = listRes.body.counterparties.find((c) => c.name === 'Корзинка');
  assert.ok(korz);
  assert.equal(korz.sales_total, 500000);
  assert.equal(korz.paid_in, 300000);
  assert.equal(korz.balance, 200000);

  // Акт сверки по Корзинке за сегодня
  const actRes = await call(report, { query: { resource: 'reconcile', counterparty: 'Корзинка', from: today, to: today }, ...as(dir) });
  assert.equal(actRes.code, 200);
  assert.equal(actRes.body.opening_balance, 0);
  assert.equal(actRes.body.total_debit, 500000);
  assert.equal(actRes.body.total_credit, 300000);
  assert.equal(actRes.body.closing_balance, 200000);
  assert.equal(actRes.body.docs.length, 2);

  // Детализация ОПиУ возвращает expense_docs и loss_docs
  const rep = await call(report, { query: { from: today, to: today }, ...as(dir) });
  assert.equal(rep.code, 200);
  assert.ok(Array.isArray(rep.body.expense_docs));
  assert.ok(Array.isArray(rep.body.loss_docs));
  assert.ok(rep.body.sales.some((s) => s.customer === 'Корзинка'));
});

test('CRM-карточка контрагента, многострочный акт расхода и раздел Инвестиции', async () => {
  await globalThis.__TEST_DB.query('DELETE FROM login_fails');
  const { cookie: admin } = await signIn(OWNER_PW);
  const { cookie: dir } = await signIn('director-pass-2');
  const today = new Date().toISOString().slice(0, 10);

  // Расширенные CRM-поля контрагента
  const cp = await call(status, {
    method: 'POST',
    query: { resource: 'refs' },
    body: {
      target: 'customer',
      name: 'АгроПолив',
      kind: 'supplier',
      inn: '309998877',
      contact_person: 'Сардор',
      phone: '+998901119988',
      telegram: '@sardor_agro',
      address: 'Ташкент, Юнусабад',
      payment_terms: 'Отсрочка 7 дней',
      bank_details: 'Капиталбанк р/с 20208000',
    },
    ...as(dir),
  });
  assert.equal(cp.code, 200);
  assert.equal(cp.body.customer.contact_person, 'Сардор');
  assert.equal(cp.body.customer.telegram, '@sardor_agro');
  assert.equal(cp.body.customer.payment_terms, 'Отсрочка 7 дней');

  // Многострочный акт расхода (как в iiko / 1С) — сумма считается из items
  const expList = await call(report, { query: { resource: 'expenses', from: today, to: today }, ...as(dir) });
  const catId = expList.body.categories[0].id;
  const act = await call(report, {
    method: 'POST',
    query: { resource: 'expenses' },
    body: {
      target: 'expense',
      doc_date: today,
      doc_number: 'СЧ-77',
      category_id: catId,
      counterparty: 'АгроПолив',
      payment_method: 'transfer',
      items: [
        { name: 'Лента капельного полива', qty: 2, unit: 'шт', price: 120000 },
        { name: 'Фитинги', qty: 10, unit: 'шт', price: 5000 },
      ],
    },
    ...as(dir),
  });
  assert.equal(act.code, 200);
  const expAfter = await call(report, { query: { resource: 'expenses', from: today, to: today }, ...as(dir) });
  const savedAct = expAfter.body.items.find((x) => x.id === act.body.id);
  assert.equal(savedAct.amount, 290000);
  assert.equal(savedAct.doc_number, 'СЧ-77');
  assert.equal(savedAct.items.length, 2);

  // Редактирование проведённого акта расхода
  const editAct = await call(report, {
    method: 'PATCH',
    query: { resource: 'expenses' },
    body: {
      target: 'expense',
      action: 'edit',
      id: act.body.id,
      doc_number: 'СЧ-77-А',
      items: [{ name: 'Лента капельного полива', qty: 3, unit: 'шт', price: 120000 }],
    },
    ...as(dir),
  });
  assert.equal(editAct.code, 200);
  const expEdited = await call(report, { query: { resource: 'expenses', from: today, to: today }, ...as(dir) });
  const editedRow = expEdited.body.items.find((x) => x.id === act.body.id);
  assert.equal(editedRow.amount, 360000);
  assert.equal(editedRow.doc_number, 'СЧ-77-А');

  // Инвестиции: создание, расчёт окупаемости и отмена
  const inv1 = await call(report, {
    method: 'POST',
    query: { resource: 'investments' },
    body: {
      doc_date: today,
      category: 'Постройка теплицы',
      title: 'Каркас и плёнка',
      investor: 'Асил',
      amount: 10000000,
      payment_method: 'transfer',
      doc_number: 'ДОГ-1',
    },
    ...as(dir),
  });
  assert.equal(inv1.code, 200);
  const inv2 = await call(report, {
    method: 'POST',
    query: { resource: 'investments' },
    body: { doc_date: today, category: 'Оборудование и полив', title: 'Ошибочный дубль', investor: 'Асил', amount: 1000000 },
    ...as(dir),
  });
  assert.equal(inv2.code, 200);
  const invCanc = await call(report, {
    method: 'PATCH',
    query: { resource: 'investments' },
    body: { id: inv2.body.id, reason: 'Дубль' },
    ...as(admin),
  });
  assert.equal(invCanc.code, 200);

  const invGet = await call(report, { query: { resource: 'investments' }, ...as(dir) });
  assert.equal(invGet.code, 200);
  assert.equal(invGet.body.summary.total_invested, 10000000);
  assert.equal(invGet.body.by_investor[0].investor, 'Асил');
  assert.equal(invGet.body.by_investor[0].share_pct, 100);
});
