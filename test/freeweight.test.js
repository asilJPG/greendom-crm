// Скидка весом в пользу покупателя (округление до 100 г): со склада уходит весь вес,
// покупатель платит за вес минус скидку, скидка — строка-потеря с тем же номером продажи.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.SESSION_SECRET = 'session-secret-for-tests-0123456789';
const pg = new PGlite();
globalThis.__TEST_DB = {
  query: async (text, params) => (await pg.query(text, params)).rows,
  transaction: async (list) => pg.transaction(async (tx) => { const out = []; for (const [t, p] of list) out.push((await tx.query(t, p || [])).rows); return out; }),
};
const db = globalThis.__TEST_DB;
const { ensureSchema } = require('../lib/db');
const { cleanPayload, submitOperation, getStock } = require('../lib/warehouse');

const ADMIN = { name: 'Админ', role: 'admin' };
const GRADES = ['Высший', 'Первый', 'Второй'];
const op = (kind, p, rid) => submitOperation(ADMIN, kind, cleanPayload(kind, p, GRADES), rid);
const bal = async (g) => (await getStock()).byGrade[g];

test('продажа со скидкой весом: склад −985 г, оплачено 900 г, потеря 85 г с тем же номером продажи', async () => {
  await ensureSchema();
  await op('intake', { grade: 'Высший', net_kg: 10 }, 'fw-in');
  const r = await op('sale', { customer: 'Корзинка', items: [{ grade: 'Высший', net_kg: 0.985, free_kg: 0.085, price_per_kg: 30000, amount: 27000 }] }, 'fw-s1');
  assert.equal(r.status, 'applied');
  assert.equal(r.total_kg, 0.9, 'в итог продажи идёт оплаченный вес');
  assert.equal(r.total_amount, 27000);
  assert.match(r.result, /скидка весом 0\.085 кг/);
  assert.equal(await bal('Высший'), 9.015, 'со склада ушёл весь взвешенный вес');
  const rows = await db.query(`SELECT type, net_kg, sale_id, customer, amount, note FROM movements WHERE device='web' AND sale_id IS NOT NULL ORDER BY id`);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].type, rows[0].net_kg, rows[0].customer, rows[0].amount], ['out', 0.9, 'Корзинка', 27000]);
  assert.deepEqual([rows[1].type, rows[1].net_kg, rows[1].customer, rows[1].amount], ['writeoff', 0.085, null, null]);
  assert.equal(rows[0].sale_id, rows[1].sale_id, 'потеря привязана к продаже');
  assert.match(rows[1].note, /Скидка весом покупателю: Корзинка/);

  // отмена продажи отменяет и потерю → остаток возвращается полностью
  await op('cancel_sale', { id: rows[0].sale_id, device: 'web', reason: 'тест' }, 'fw-c1');
  assert.equal(await bal('Высший'), 10);
  const st = await db.query(`SELECT DISTINCT status FROM movements WHERE sale_id=$1`, [rows[0].sale_id]);
  assert.deepEqual(st.map((x) => x.status), ['cancelled']);
});

test('без скидки продажа как раньше; скидка не может быть больше или равна весу; остаток считается по полному весу', async () => {
  const r = await op('sale', { customer: 'Макро', items: [{ grade: 'Высший', net_kg: 2, price_per_kg: 1000, amount: 2000 }] }, 'fw-s2');
  assert.equal(r.total_kg, 2);
  const n = await db.query(`SELECT count(*)::int AS n FROM movements WHERE sale_id=(SELECT sale_id FROM movements WHERE customer='Макро' LIMIT 1)`);
  assert.equal(n[0].n, 1, 'без скидки строки-потери нет');
  assert.throws(() => cleanPayload('sale', { customer: 'X', items: [{ grade: 'Высший', net_kg: 1, free_kg: 1, amount: 0 }] }, GRADES), /меньше веса/);
  assert.throws(() => cleanPayload('sale', { customer: 'X', items: [{ grade: 'Высший', net_kg: 1, free_kg: -0.1, amount: 0 }] }, GRADES), /скидка весом/);
  // на складе 8 кг: продать 7.95 со скидкой 0.1 (итого 8.05 физически) нельзя
  await assert.rejects(op('sale', { customer: 'Y', items: [{ grade: 'Высший', net_kg: 8.05, free_kg: 0.05, amount: 1 }] }, 'fw-s3'), /на складе 8 кг/);
  assert.equal(await bal('Высший'), 8);
});
