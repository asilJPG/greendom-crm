// Атомарность денежных записей, проверка данных от моноблока и первичная настройка (PGlite, без сети).
// Сбой «посреди записи» имитируется триггером, который роняет вставку в audit_log для выбранного действия:
// после сбоя не должно остаться ни документа, ни ключа request_id, ни строки журнала.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.INGEST_TOKEN = 'ingest-token-for-tests-0123456789abcdef';
process.env.SESSION_SECRET = 'session-secret-for-tests-0123456789';
process.env.SETUP_KEY = 'setup-key-for-tests-0123456789abcdef';

const pg = new PGlite();
globalThis.__TEST_DB = {
  query: async (text, params) => (await pg.query(text, params)).rows,
  transaction: async (list) => pg.transaction(async (tx) => { const out = []; for (const [t, p] of list) out.push((await tx.query(t, p || [])).rows); return out; }),
};
const db = globalThis.__TEST_DB;

const setup = require('../api/setup');
const login = require('../api/login');
const report = require('../api/report');
const status = require('../api/status');
const ingest = require('../api/ingest');
const { todayStr } = require('../lib/http');

let ipCounter = 0;
function call(fn, { method = 'GET', body, query = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      code: 200, headers: {}, body: null,
      status(c) { this.code = c; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      json(o) { this.body = o; resolve(this); return this; },
      end(o) { this.body = o; resolve(this); return this; },
    };
    Promise.resolve(fn({ method, body, query, headers: { 'x-forwarded-for': `10.7.0.${++ipCounter}`, ...headers } }, res)).catch(reject);
  });
}
const ADMIN_PW = 'atomic-admin-pw-1';
const today = todayStr();
let cookie;
const fin = (resource, method, body) => call(report, { method, query: { resource }, body, headers: { cookie } });
const refs = (method, body) => call(status, { method, query: { resource: 'refs' }, body, headers: { cookie } });
const one = async (sql, params = []) => (await db.query(sql, params))[0];
const count = async (sql, params = []) => (await one(sql, params)).n;
const keyExists = async (key) => (await count(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1`, [key])) > 0;

// Имитация сбоя: вставка в audit_log для действий из crash_actions падает внутри транзакции.
async function crashOn(action) { await db.query(`INSERT INTO crash_actions(action) VALUES ($1)`, [action]); }
async function noCrash() { await db.query(`DELETE FROM crash_actions WHERE true`); }

// ───────── первичная настройка ─────────
test('setup: одновременные запросы создают ровно одного администратора, остальные получают 409', async () => {
  const names = ['Первый', 'Второй', 'Третий', 'Четвёртый', 'Пятый'];
  const rs = await Promise.all(names.map((name, i) =>
    call(setup, { method: 'POST', body: { key: process.env.SETUP_KEY, name, password: i === 0 ? ADMIN_PW : ADMIN_PW + i } })));
  assert.equal(rs.filter((r) => r.code === 200).length, 1, JSON.stringify(rs.map((r) => [r.code, r.body])));
  assert.equal(rs.filter((r) => r.code === 409).length, names.length - 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM app_users`), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM app_users WHERE role='admin'`), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action='setup'`), 1, 'одна запись журнала');
  const again = await call(setup, { method: 'POST', body: { key: process.env.SETUP_KEY, name: 'Шестой', password: 'pw-6666' } });
  assert.equal(again.code, 409);
  assert.equal(again.body.error, 'Первичная настройка уже выполнена');

  const winner = rs.find((r) => r.code === 200).body.name;
  const pw = winner === 'Первый' ? ADMIN_PW : ADMIN_PW + names.indexOf(winner);
  const r = await call(login, { method: 'POST', body: { password: pw } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const sc = r.headers['Set-Cookie'];
  cookie = (Array.isArray(sc) ? sc : [sc]).find((c) => c.startsWith('cs=')).split(';')[0];

  await db.query(`CREATE TABLE crash_actions(action text PRIMARY KEY)`);
  await db.query(`CREATE FUNCTION crash_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM crash_actions WHERE action = NEW.action) THEN RAISE EXCEPTION 'имитация сбоя'; END IF;
      RETURN NEW;
    END $$`);
  await db.query(`CREATE TRIGGER crash_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION crash_audit()`);
});

// ───────── создание денежных документов ─────────
test('сбой журнала при создании: ни документа, ни ключа, ни строки журнала; повтор с тем же request_id проходит', async () => {
  const catId = (await fin('expenses', 'GET')).body.categories[0].id;
  const cases = [
    ['payment', 'payment_add', 'payments', () => fin('payments', 'POST', { request_id: 'crash-1', counterparty: 'Атом-КА', direction: 'in', amount: 1500 })],
    ['expense', 'expense_add', 'expenses', () => fin('expenses', 'POST', {
      request_id: 'crash-1', target: 'expense', category_id: catId,
      items: [{ name: 'Плёнка', qty: 2, price: 300 }, { name: 'Шпагат', qty: 1, price: 50 }],
    })],
    ['investment', 'investment_add', 'investments', () => fin('investments', 'POST', { request_id: 'crash-1', title: 'Котёл', amount: 9000 })],
    ['customer', 'customer_add', 'customers', () => refs('POST', { request_id: 'crash-1', target: 'customer', name: 'Атом-покупатель' })],
  ];
  for (const [scope, action, table, send] of cases) {
    const before = await count(`SELECT count(*)::int AS n FROM ${table}`);
    const auditBefore = await count(`SELECT count(*)::int AS n FROM audit_log WHERE action=$1`, [action]);

    await crashOn(action);
    const crashed = await send();
    assert.equal(crashed.code, 500, `${scope}: сбой даёт 500`);
    assert.equal(await count(`SELECT count(*)::int AS n FROM ${table}`), before, `${scope}: документ не записан`);
    assert.equal(await keyExists(`${scope}:crash-1`), false, `${scope}: ключ свободен`);
    assert.equal(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action=$1`, [action]), auditBefore, `${scope}: журнала нет`);
    await noCrash();

    const ok = await send();
    assert.equal(ok.code, 200, `${scope}: ${JSON.stringify(ok.body)}`);
    assert.ok(!ok.body.duplicate, `${scope}: повтор после сбоя — не дубликат`);
    const id = ok.body.id ?? ok.body.customer.id;
    assert.ok(Number.isInteger(id));
    assert.equal(await count(`SELECT count(*)::int AS n FROM ${table}`), before + 1, `${scope}: одна запись`);
    assert.equal((await one(`SELECT doc_id FROM idempotency_keys WHERE key=$1`, [`${scope}:crash-1`])).doc_id, id, `${scope}: id сохранён с ключом`);
    const a = await one(`SELECT detail, user_name FROM audit_log WHERE action=$1 ORDER BY id DESC LIMIT 1`, [action]);
    assert.ok(a.detail.startsWith(`#${id} `), `${scope}: журнал ссылается на документ: ${a.detail}`);

    const dup = await send();
    assert.deepEqual(dup.body, { ok: true, duplicate: true, id }, `${scope}: повтор возвращает тот же id`);
    assert.equal(await count(`SELECT count(*)::int AS n FROM ${table}`), before + 1, `${scope}: повтор не создал второй документ`);
    assert.equal(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action=$1`, [action]), auditBefore + 1, `${scope}: одна запись журнала`);
  }
  // строки акта расхода записаны вместе с актом
  const exp = await one(`SELECT amount, items FROM expenses ORDER BY id DESC LIMIT 1`);
  assert.equal(exp.amount, 650);
  assert.equal(exp.items.length, 2);
});

test('параллельные повторы одного request_id: один документ, остальные duplicate с тем же id', async () => {
  const before = await count(`SELECT count(*)::int AS n FROM payments`);
  const rs = await Promise.all([1, 2, 3, 4].map(() =>
    fin('payments', 'POST', { request_id: 'race-1', counterparty: 'Атом-КА', direction: 'out', amount: 42 })));
  assert.ok(rs.every((r) => r.code === 200), JSON.stringify(rs.map((r) => r.body)));
  const created = rs.filter((r) => !r.body.duplicate);
  assert.equal(created.length, 1);
  assert.ok(rs.filter((r) => r.body.duplicate).every((r) => r.body.id === created[0].body.id));
  assert.equal(await count(`SELECT count(*)::int AS n FROM payments`), before + 1);
});

test('без request_id запись тоже атомарна (документ + журнал), ключ не создаётся', async () => {
  const keys = await count(`SELECT count(*)::int AS n FROM idempotency_keys`);
  await crashOn('payment_add');
  const before = await count(`SELECT count(*)::int AS n FROM payments`);
  assert.equal((await fin('payments', 'POST', { counterparty: 'Атом-КА', direction: 'in', amount: 7 })).code, 500);
  assert.equal(await count(`SELECT count(*)::int AS n FROM payments`), before);
  await noCrash();
  const ok = await fin('payments', 'POST', { counterparty: 'Атом-КА', direction: 'in', amount: 7 });
  assert.equal(ok.code, 200);
  assert.ok(Number.isInteger(ok.body.id));
  assert.equal(await count(`SELECT count(*)::int AS n FROM idempotency_keys`), keys);
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action='payment_add' AND detail LIKE $1`, [`#${ok.body.id} %`]), 1);
});

// ───────── правка и отмена ─────────
test('сбой журнала при правке/отмене: документ не меняется; повторная отмена — 409', async () => {
  const pay = await one(`SELECT id FROM payments WHERE status='active' ORDER BY id DESC LIMIT 1`);
  const exp = await one(`SELECT id, amount FROM expenses WHERE status='active' ORDER BY id DESC LIMIT 1`);
  const inv = await one(`SELECT id, amount FROM investments WHERE status='active' ORDER BY id DESC LIMIT 1`);
  const cust = await one(`SELECT id, phone FROM customers WHERE name='Атом-покупатель'`);

  const ops = [
    ['payment_cancel', () => fin('payments', 'PATCH', { id: pay.id, reason: 'ошибка' }),
      async () => assert.equal((await one(`SELECT status FROM payments WHERE id=$1`, [pay.id])).status, 'active')],
    ['expense_edit', () => fin('expenses', 'PATCH', { id: exp.id, action: 'edit', items: [], amount: 1 }),
      async () => assert.equal((await one(`SELECT amount FROM expenses WHERE id=$1`, [exp.id])).amount, exp.amount)],
    ['expense_cancel', () => fin('expenses', 'PATCH', { id: exp.id, reason: 'дубль' }),
      async () => assert.equal((await one(`SELECT status FROM expenses WHERE id=$1`, [exp.id])).status, 'active')],
    ['investment_edit', () => fin('investments', 'PATCH', { id: inv.id, action: 'edit', amount: 1 }),
      async () => assert.equal((await one(`SELECT amount FROM investments WHERE id=$1`, [inv.id])).amount, inv.amount)],
    ['investment_cancel', () => fin('investments', 'PATCH', { id: inv.id, reason: 'дубль' }),
      async () => assert.equal((await one(`SELECT status FROM investments WHERE id=$1`, [inv.id])).status, 'active')],
    ['customer_edit', () => refs('PATCH', { target: 'customer', id: cust.id, phone: '+998 90 000 00 00' }),
      async () => assert.equal((await one(`SELECT phone FROM customers WHERE id=$1`, [cust.id])).phone, cust.phone)],
  ];
  for (const [action, send, unchanged] of ops) {
    await crashOn(action);
    assert.equal((await send()).code, 500, action);
    await unchanged();
    assert.equal(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action=$1`, [action]), 0, `${action}: журнала нет`);
    await noCrash();
    const ok = await send();
    assert.equal(ok.code, 200, `${action}: ${JSON.stringify(ok.body)}`);
    assert.equal(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action=$1`, [action]), 1, `${action}: одна запись журнала`);
  }
  assert.equal((await one(`SELECT status FROM payments WHERE id=$1`, [pay.id])).status, 'cancelled');
  assert.equal((await one(`SELECT amount FROM expenses WHERE id=$1`, [exp.id])).amount, 1);
  assert.equal((await fin('payments', 'PATCH', { id: pay.id, reason: 'ещё раз' })).code, 409, 'повторная отмена');
  assert.equal(await count(`SELECT count(*)::int AS n FROM audit_log WHERE action='payment_cancel'`), 1);
});

test('архивный контрагент возвращается атомарно; повтор request_id — duplicate', async () => {
  const c = await one(`SELECT id FROM customers WHERE name='Атом-покупатель'`);
  await db.query(`UPDATE customers SET active=false WHERE id=$1`, [c.id]);
  await crashOn('customer_restore');
  assert.equal((await refs('POST', { request_id: 'restore-1', target: 'customer', name: 'Атом-покупатель' })).code, 500);
  assert.equal((await one(`SELECT active FROM customers WHERE id=$1`, [c.id])).active, false);
  assert.equal(await keyExists('customer:restore-1'), false);
  await noCrash();
  const ok = await refs('POST', { request_id: 'restore-1', target: 'customer', name: 'Атом-покупатель' });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.customer.active, true);
  assert.deepEqual((await refs('POST', { request_id: 'restore-1', target: 'customer', name: 'Атом-покупатель' })).body, { ok: true, duplicate: true, id: c.id });
  assert.equal((await refs('POST', { request_id: 'restore-2', target: 'customer', name: 'Атом-покупатель' })).code, 409, 'активный — уже есть');
  assert.equal(await keyExists('customer:restore-2'), false, 'отказ не занимает ключ');
});

// ───────── приёмник: проверка значений ─────────
const AUTH = { authorization: 'Bearer ' + process.env.INGEST_TOKEN };
const MV = (o) => ({ id: 1, ts: `${today} 10:00:00`, type: 'in', grade: 'Высший', gross_kg: 10.5, tare_kg: 0.5, net_kg: 10,
  manual: 0, worker: '', note: '', sale_id: null, customer: null, price_per_kg: null, amount: null, user_name: 'Склад', status: 'active', ...o });
const push = (movements) => call(ingest, { method: 'POST', headers: AUTH, body: { device: 'atom-mono', crop: 'Клубника', currency: 'сум', grades: ['Высший'], pending: 0, movements } });

test('ingest: неверные значения отклоняют всю пачку с 400 и называют номер операции и поле', async () => {
  const nextYear = new Date().getUTCFullYear() + 2;
  const bad = [
    [{ net_kg: 0 }, 'net_kg'], [{ net_kg: -1 }, 'net_kg'], [{ net_kg: 100001 }, 'net_kg'], [{ net_kg: 'abc' }, 'net_kg'],
    [{ net_kg: 'Infinity' }, 'net_kg'], [{ net_kg: null }, 'net_kg'], [{ net_kg: true }, 'net_kg'],
    [{ gross_kg: -0.1 }, 'gross_kg'], [{ gross_kg: 100001 }, 'gross_kg'], [{ tare_kg: -1 }, 'tare_kg'], [{ tare_kg: 'x' }, 'tare_kg'],
    [{ type: 'out', price_per_kg: -5, amount: 10 }, 'price_per_kg'], [{ type: 'out', price_per_kg: 2e9, amount: 10 }, 'price_per_kg'],
    [{ type: 'out', amount: -1 }, 'amount'], [{ type: 'out', amount: 2e12 }, 'amount'], [{ type: 'out', amount: 'NaN' }, 'amount'],
    [{ ts: '2026-02-30 10:00:00' }, 'ts'], [{ ts: '2026-13-01 10:00:00' }, 'ts'], [{ ts: '2026-01-01 25:00:00' }, 'ts'],
    [{ ts: '2019-12-31 23:59:59' }, 'ts'], [{ ts: `${nextYear}-01-01 10:00:00` }, 'ts'], [{ ts: 'вчера' }, 'ts'], [{ ts: 1700000000 }, 'ts'],
    [{ status: 'cancelled', cancelled_ts: '2026-02-29 10:00:00' }, 'cancelled_ts'], [{ status: 'cancelled', cancelled_ts: 'never' }, 'cancelled_ts'],
    [{ type: 'steal' }, 'type'],
  ];
  const before = await count(`SELECT count(*)::int AS n FROM movements WHERE device='atom-mono'`);
  for (const [patch, field] of bad) {
    const r = await push([MV({ id: 1 }), MV({ id: 2, ...patch })]);
    assert.equal(r.code, 400, `${JSON.stringify(patch)} -> ${r.code} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /операция #1 \(id 2\)/, `номер операции: ${r.body.error}`);
    assert.ok(r.body.error.includes(field === 'type' ? 'тип' : field), `поле ${field}: ${r.body.error}`);
  }
  assert.equal(await count(`SELECT count(*)::int AS n FROM movements WHERE device='atom-mono'`), before, 'из отклонённых пачек ничего не записано');
});

test('ingest: корректные пачки моноблока принимаются (брутто/тара/нетто, продажа с ценой, списание без цены, отмена)', async () => {
  const thisYear = new Date().getUTCFullYear();
  const r = await push([
    MV({ id: 11, gross_kg: 0, tare_kg: 0, net_kg: 0.001 }),
    MV({ id: 12, type: 'out', gross_kg: null, tare_kg: null, net_kg: 0.001, sale_id: 5, customer: 'Атом-КА', price_per_kg: 0, amount: 0 }),
    MV({ id: 13, type: 'writeoff', net_kg: 0.001, price_per_kg: null, amount: null, note: 'порча' }),
    MV({ id: 14, ts: '2024-02-29T08:30:00', net_kg: '2.5', gross_kg: '', tare_kg: undefined }),
    MV({ id: 15, ts: `${thisYear + 1}-12-31 23:59:59`, net_kg: 100000, gross_kg: 100000, tare_kg: 0 }),
    MV({ id: 16, status: 'cancelled', cancel_reason: 'ошибка', cancelled_ts: `${today} 11:00:00` }),
    MV({ id: 17, status: 'cancelled', cancelled_ts: '' }),
  ]);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.accepted, 7);
  const rows = await db.query(`SELECT id, net_kg, gross_kg, to_char(ts,'YYYY-MM-DD HH24:MI:SS') AS ts, cancelled_ts FROM movements WHERE device='atom-mono' ORDER BY id`);
  const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
  assert.equal(byId[14].net_kg, 2.5);
  assert.equal(byId[14].gross_kg, null);
  assert.equal(byId[14].ts, '2024-02-29 08:30:00');
  assert.ok(byId[16].cancelled_ts);
  assert.equal(byId[17].cancelled_ts, null);
});
