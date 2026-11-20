// Проверка облачной части на настоящем Postgres (PGlite работает локально, без сети).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.INGEST_TOKEN = 'ingest-token-for-tests-0123456789abcdef';
process.env.DASHBOARD_PASSWORDS = 'pass-one-1234, second-pass-5678';
process.env.SESSION_SECRET = 'session-secret-for-tests-0123456789';

const pg = new PGlite();
globalThis.__TEST_DB = { query: async (text, params) => (await pg.query(text, params)).rows };

const ingest = require('../api/ingest');
const login = require('../api/login');
const stock = require('../api/stock');
const report = require('../api/report');
const movements = require('../api/movements');
const status = require('../api/status');
const { todayStr } = require('../lib/http');

function call(fn, { method = 'GET', body, query = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      code: 200, headers: {}, body: null,
      status(c) { this.code = c; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      json(o) { this.body = o; resolve(this); return this; },
    };
    Promise.resolve(fn({ method, body, query, headers, socket: { remoteAddress: '1.2.3.4' } }, res)).catch(reject);
  });
}
const AUTH = { authorization: 'Bearer ' + process.env.INGEST_TOKEN };
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

async function cookieFor(password) {
  const r = await call(login, { method: 'POST', body: { password }, headers: {} });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  return r.headers['Set-Cookie'].split(';')[0];
}

test('приёмник: без ключа и с чужим ключом закрыт', async () => {
  assert.equal((await call(ingest, { method: 'POST', body: BATCH })).code, 401);
  assert.equal((await call(ingest, { method: 'POST', body: BATCH, headers: { authorization: 'Bearer wrong' } })).code, 401);
  assert.equal((await call(ingest, { method: 'GET', headers: AUTH })).code, 405);
});

test('приёмник: плохие данные отклоняются понятной ошибкой', async () => {
  const bad = { ...BATCH, movements: [{ ...M({ id: 9 }), type: 'steal' }] };
  const r = await call(ingest, { method: 'POST', body: bad, headers: AUTH });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /тип/);
  assert.equal((await call(ingest, { method: 'POST', body: { movements: [] }, headers: AUTH })).code, 400);
});

test('приёмник: принимает пачку и повторная отправка ничего не дублирует', async () => {
  let r = await call(ingest, { method: 'POST', body: BATCH, headers: AUTH });
  assert.equal(r.code, 200);
  assert.equal(r.body.accepted, 4);
  r = await call(ingest, { method: 'POST', body: BATCH, headers: AUTH });
  assert.equal(r.code, 200);
  const [{ n }] = await globalThis.__TEST_DB.query('SELECT count(*)::int AS n FROM movements');
  assert.equal(n, 4);
});

test('сайт закрыт без входа и с подделанной сессией', async () => {
  for (const fn of [stock, report, movements, status]) assert.equal((await call(fn)).code, 401);
  assert.equal((await call(stock, { headers: { cookie: 'cs=abc.def' } })).code, 401);
  const good = await cookieFor('pass-one-1234');
  const forged = good.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
  assert.equal((await call(stock, { headers: { cookie: forged } })).code, 401);
});

test('вход: оба пароля работают, остатки считаются верно', async () => {
  const c1 = await cookieFor('pass-one-1234');
  await cookieFor('second-pass-5678');
  const r = await call(stock, { headers: { cookie: c1 } });
  assert.equal(r.code, 200);
  const by = Object.fromEntries(r.body.rows.map((x) => [x.grade, x]));
  assert.equal(by['Высший'].balance_kg, 70);
  assert.equal(by['Первый'].balance_kg, 45);
  assert.equal(r.body.total_kg, 115);
  assert.deepEqual(r.body.rows.map((x) => x.grade), ['Высший', 'Первый', 'Второй', 'Брак'], 'порядок сортов как в настройках моноблока');
});

test('отчёт: суммы, выручка, работники, покупатели', async () => {
  const cookie = await cookieFor('pass-one-1234');
  const r = await call(report, { query: { from: today, to: today }, headers: { cookie } });
  assert.equal(r.code, 200);
  const g = Object.fromEntries(r.body.by_grade.map((x) => [x.grade, x]));
  assert.equal(g['Высший'].in_kg, 100);
  assert.equal(g['Высший'].out_kg, 30);
  assert.equal(g['Высший'].amount, 600000);
  assert.equal(g['Первый'].writeoff_kg, 5);
  assert.equal(r.body.by_customer[0].customer, 'ООО Базар');
  assert.equal(r.body.by_customer[0].amount, 600000);
  assert.deepEqual(r.body.by_worker.map((x) => [x.worker, x.kg]).sort(), [['Алишер', 100], ['Дильноза', 50]]);
  assert.equal(r.body.manual_entries, 1);
  assert.equal(r.body.by_day[0].day, today);
});

test('отмена на моноблоке доходит до облака и меняет остаток', async () => {
  const cancelled = { ...BATCH, movements: [M({ id: 3, type: 'out', grade: 'Высший', net_kg: 30, sale_id: 1, customer: 'ООО Базар',
    price_per_kg: 20000, amount: 600000, status: 'cancelled', cancel_reason: 'покупатель отказался', cancelled_ts: `${today} 11:00:00` })] };
  assert.equal((await call(ingest, { method: 'POST', body: cancelled, headers: AUTH })).code, 200);
  const cookie = await cookieFor('pass-one-1234');
  const r = await call(stock, { headers: { cookie } });
  assert.equal(r.body.rows.find((x) => x.grade === 'Высший').balance_kg, 100);
  const h = await call(movements, { query: { type: 'out' }, headers: { cookie } });
  assert.equal(h.body[0].status, 'cancelled');
  assert.equal(h.body[0].cancel_reason, 'покупатель отказался');
  const rep = await call(report, { query: {}, headers: { cookie } });
  assert.equal(rep.body.cancelled_entries, 1);
  assert.equal(rep.body.by_grade.find((x) => x.grade === 'Высший').amount, 0, 'отменённая продажа не попадает в выручку');
});

test('история: фильтры по типу и дню, статус моноблока', async () => {
  const cookie = await cookieFor('pass-one-1234');
  assert.equal((await call(movements, { query: { type: 'in' }, headers: { cookie } })).body.length, 2);
  assert.equal((await call(movements, { query: { day: '2001-01-01' }, headers: { cookie } })).body.length, 0);
  const s = await call(status, { headers: { cookie } });
  assert.equal(s.body.devices[0].device, 'point-1');
  assert.ok(s.body.devices[0].seconds_ago < 60);
});

test('подбор пароля: после 5 ошибок вход закрывается, даже верный пароль', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call(login, { method: 'POST', body: { password: 'nope' } })).code, 401);
  assert.equal((await call(login, { method: 'POST', body: { password: 'nope' } })).code, 423);
  assert.equal((await call(login, { method: 'POST', body: { password: 'pass-one-1234' } })).code, 423);
});
