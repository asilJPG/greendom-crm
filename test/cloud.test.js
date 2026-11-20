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

test('пароль в базе хранится хэшем, а не открытым текстом', async () => {
  const [u] = await globalThis.__TEST_DB.query('SELECT pass_hash FROM app_users');
  assert.match(u.pass_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.ok(!u.pass_hash.includes(OWNER_PW));
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
test('админ создаёт пользователя; одинаковые пароли не принимаются; временный пароль не пускает к данным', async () => {
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
  assert.equal(v.body.must_change, true);
  for (const [name, fn] of DATA_ENDPOINTS) {
    const r = await call(fn, as(v.cookie));
    assert.equal(r.code, 403, `${name}: данные закрыты до смены пароля`);
    assert.equal(r.body.must_change, true);
  }
  const st = await call(status, as(v.cookie));
  assert.equal(st.code, 200);
  assert.deepEqual(st.body.devices, [], 'до смены пароля данные склада не отдаются даже через status');
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
  assert.equal(v2.body.must_change, true, 'после сброса снова нужен свой пароль');
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

// ───────── операции с сайта: очередь для моноблока ─────────
test('операции с сайта: права ролей, проверка данных, очередь, ответы моноблока, защита от повтора', async () => {
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

  // принятая операция: в очередь попадает только очищенный набор полей
  const ok = await post(keeper, 'intake', { ...P, evil: 'DROP', note: 'n' }, { request_id: 'req-1' });
  assert.equal(ok.code, 200);
  assert.equal((await post(keeper, 'intake', P, { request_id: 'req-1' })).body.duplicate, true, 'повтор того же запроса не создаёт вторую операцию');
  const sale = await post(keeper, 'sale', { customer: 'ООО', items: [{ grade: 'Высший', net_kg: 3, price_per_kg: 20000, amount: 60000 }] });
  assert.equal(sale.code, 200);
  const adminEdit = await post(admin, 'edit', { id: 1, reason: 'ошибка весов', net_kg: 90 });
  assert.equal(adminEdit.code, 200);

  // моноблок забирает очередь; чужое устройство не видит и не закрывает чужие операции
  const dev = (b) => call(ingest, { method: 'POST', body: { device: 'point-1', crop: 'Клубника', currency: 'сум', grades: BATCH.grades, pending: 0, movements: [], ...b }, headers: AUTH });
  const other = await call(ingest, { method: 'POST', body: { device: 'other-device', acks: [{ id: ok.body.id, status: 'applied', result: 'взлом' }], movements: [] }, headers: AUTH });
  assert.deepEqual(other.body.commands, [], 'другое устройство очередь не получает');
  const got = await dev({});
  assert.equal(got.body.commands.length, 3);
  const first = got.body.commands.find((c) => c.id === ok.body.id);
  assert.deepEqual(Object.keys(first.payload).sort(), ['grade', 'net_kg', 'note', 'worker'], 'лишние поля отброшены');
  assert.equal(first.user_name, 'Складовщик Анвар');
  assert.equal(first.user_role, 'keeper');
  assert.equal((await dev({})).body.commands.length, 3, 'без ответа операция приходит снова');

  // ответы: выполнено / отклонено; повтор ответа не перезаписывает
  await dev({ acks: [{ id: ok.body.id, status: 'applied', result: 'приход #5' }, { id: sale.body.id, status: 'rejected', result: 'отклонено: остаток' }, { id: 999, status: 'applied' }, { id: adminEdit.body.id, status: 'hacked' }] });
  await dev({ acks: [{ id: ok.body.id, status: 'rejected', result: 'позже' }] });
  const rows = (await call(command, as(keeper))).body;
  assert.equal(rows.find((r) => r.id === ok.body.id).status, 'applied');
  assert.equal(rows.find((r) => r.id === ok.body.id).result, 'приход #5', 'завершённую операцию ответом не переписать');
  assert.equal(rows.find((r) => r.id === sale.body.id).status, 'rejected');
  assert.ok(!rows.some((r) => r.id === adminEdit.body.id), 'складовщик видит только свои операции');
  assert.equal((await call(command, adm)).body.length >= 3, true, 'админ видит все');
  assert.equal((await dev({})).body.commands.length, 1, 'осталась только операция админа (ответ «hacked» не принят)');

  // срок давности: через сутки операция не выполняется
  await db.query(`UPDATE commands SET ts = now() - interval '25 hours' WHERE id=$1`, [adminEdit.body.id]);
  assert.equal((await dev({})).body.commands.length, 0);
  assert.equal((await call(command, adm)).body.find((r) => r.id === adminEdit.body.id).status, 'expired');

  // лимит ожидающих операций на человека
  await db.query(`UPDATE commands SET status='rejected' WHERE status='pending'`);
  let last;
  for (let i = 0; i < 21; i++) last = await post(keeper, 'intake', { ...P, net_kg: 1 + i });
  assert.equal(last.code, 429, 'больше 20 ожидающих операций не принимается');
});
