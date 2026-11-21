// Синхронизация сайт ↔ моноблок: зеркало веб-операций, очередь правок, неактивные устройства, сорта, гонки, Telegram.
// Настоящий Postgres (PGlite), вход через подписанную cookie (не зависит от формы входа).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.INGEST_TOKEN = 'ingest-token-for-sync-tests-0123456789';
process.env.SESSION_SECRET = 'session-secret-for-sync-tests-0123456789';
process.env.TG_BUDGET_MS = '400';

const pg = new PGlite();
globalThis.__TEST_DB = {
  query: async (text, params) => (await pg.query(text, params)).rows,
  transaction: async (list) => pg.transaction(async (tx) => { const out = []; for (const [t, p] of list) out.push((await tx.query(t, p || [])).rows); return out; }),
};
const db = globalThis.__TEST_DB;

const ingest = require('../api/ingest');
const command = require('../api/command');
const status = require('../api/status');
const { ensureSchema } = require('../lib/db');
const { makeSessionValue } = require('../lib/auth');
const { todayStr } = require('../lib/http');

function call(fn, { method = 'GET', body, query = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      code: 200, headers: {}, body: null,
      status(c) { this.code = c; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      json(o) { this.body = o; resolve(this); return this; },
      end(o) { this.body = o; resolve(this); return this; },
    };
    Promise.resolve(fn({ method, body, query, headers: { 'x-forwarded-for': '10.1.0.1', ...headers } }, res)).catch(reject);
  });
}
const AUTH = { authorization: 'Bearer ' + process.env.INGEST_TOKEN };
const today = todayStr();
const M = (o) => ({ ts: `${today} 09:00:00`, type: 'in', grade: 'Высший', gross_kg: null, tare_kg: null, net_kg: 10, manual: 0,
  worker: '', note: '', sale_id: null, customer: null, price_per_kg: null, amount: null, user_name: 'Склад', status: 'active', ...o });
const push = (device, extra = {}) => call(ingest, { method: 'POST', headers: AUTH,
  body: { device, crop: 'Клубника', currency: 'сум', grades: ['Высший', 'Первый'], pending: 0, movements: [], ...extra } });

let ADMIN;
let KEEPER;
let KEEPER2;
async function mkUser(name, role) {
  const [u] = await db.query(`INSERT INTO app_users(name, role, pass_hash) VALUES ($1,$2,'x') RETURNING id, token_version`, [name, role]);
  return { headers: { cookie: `cs=${makeSessionValue(u)}` } };
}
const cmd = (who, kind, payload, request_id) => call(command, { method: 'POST', body: { kind, payload, request_id }, ...who });
const bal = async (grade) => {
  const [r] = await db.query(`SELECT COALESCE(SUM(CASE WHEN type='in' THEN net_kg ELSE -net_kg END),0)::float8 AS b FROM movements WHERE status='active' AND grade=$1`, [grade]);
  return Math.round(r.b * 1000) / 1000;
};

test.before(async () => {
  await ensureSchema();
  ADMIN = await mkUser('Админ', 'admin');
  KEEPER = await mkUser('Кладовщик', 'keeper');
  KEEPER2 = await mkUser('Кладовщик 2', 'keeper');
});

test('#6 приёмник не принимает device=web; старый моноблок без web_cursor работает (без зеркала)', async () => {
  for (const d of ['web', 'WEB', 'Web']) assert.equal((await push(d, { movements: [M({ id: 1 })] })).code, 400, d);
  const r = await push('mono-A', { movements: [M({ id: 1, net_kg: 50 }), M({ id: 2, grade: 'Первый', net_kg: 20 })] });
  assert.equal(r.code, 200);
  assert.equal(r.body.web_movements, undefined, 'без web_cursor зеркало не отдаётся');
  assert.deepEqual(r.body.grades, ['Высший', 'Первый', 'Второй']);
  assert.ok(Array.isArray(r.body.grade_aliases));
});

test('#1 веб-приход/продажа/списание уходят моноблоку зеркалом; отмена веб-записи приходит повторно (upsert)', async () => {
  const first = await push('mono-A', { web_cursor: '' });
  assert.deepEqual(first.body.web_movements, []);
  const c0 = first.body.web_cursor;

  const inn = await cmd(KEEPER, 'intake', { grade: 'Высший', net_kg: 5, worker: 'Мадина' }, 'm-in');
  assert.equal(inn.code, 200);
  assert.equal(inn.body.status, 'applied');
  assert.match(inn.body.result, /приход #\d+/);
  const sale = await cmd(KEEPER, 'sale', { customer: 'Хавас', items: [{ grade: 'Высший', net_kg: 2, price_per_kg: 100, amount: 200 }, { grade: 'Первый', net_kg: 1, amount: 50 }] }, 'm-sale');
  assert.equal(sale.body.status, 'applied');
  const wo = await cmd(KEEPER, 'writeoff', { grade: 'Первый', net_kg: 0.5, reason: 'Порча' }, 'm-wo');
  assert.equal(wo.body.status, 'applied');

  const r = await push('mono-A', { web_cursor: c0 });
  const rows = r.body.web_movements;
  assert.equal(rows.length, 4, 'приход + 2 позиции продажи + списание');
  assert.ok(rows.every((x) => x.device === 'web'));
  assert.deepEqual(rows.map((x) => x.type), ['in', 'out', 'out', 'writeoff']);
  const s = rows.filter((x) => x.type === 'out');
  assert.equal(s[0].sale_id, s[1].sale_id);
  assert.equal(s[0].customer, 'Хавас');
  assert.ok(r.body.web_cursor && r.body.web_cursor !== c0);

  // курсор: следующий опрос пустой
  const again = await push('mono-A', { web_cursor: r.body.web_cursor });
  assert.deepEqual(again.body.web_movements, []);
  assert.equal(again.body.web_cursor, r.body.web_cursor);

  // складовщик не может отменить даже свою сегодняшнюю веб-запись; отменяет только админ
  const inId = rows[0].id;
  assert.equal((await cmd(KEEPER, 'cancel_movement', { id: inId, device: 'web', reason: 'ошибка' }, 'm-cancel-k')).code, 403, 'складовщик не отменяет даже свою запись');
  const cancel = await cmd(ADMIN, 'cancel_movement', { id: inId, device: 'web', reason: 'ошибка' }, 'm-cancel');
  assert.equal(cancel.code, 200, JSON.stringify(cancel.body));
  assert.equal(cancel.body.status, 'applied');
  assert.equal((await cmd(KEEPER2, 'cancel_sale', { id: s[0].sale_id, device: 'web', reason: 'чужая' })).code, 403, 'чужую веб-запись складовщик не отменяет');
  const upd = await push('mono-A', { web_cursor: r.body.web_cursor });
  assert.equal(upd.body.web_movements.length, 1);
  assert.equal(upd.body.web_movements[0].id, inId);
  assert.equal(upd.body.web_movements[0].status, 'cancelled');

  // мусорный курсор = с начала (не 500)
  const junk = await push('mono-A', { web_cursor: "x'; DROP TABLE movements; --" });
  assert.equal(junk.code, 200);
  assert.equal(junk.body.web_movements.length, 4);
});

test('#8 гонка: три одновременные продажи по 10 кг при остатке 10 кг — проходит ровно одна', async () => {
  await cmd(ADMIN, 'intake', { grade: 'Второй', net_kg: 10 }, 'race-in');
  assert.equal(await bal('Второй'), 10);
  const sale = (i) => cmd(ADMIN, 'sale', { customer: `К${i}`, items: [{ grade: 'Второй', net_kg: 10, amount: 1 }] }, `race-${i}`);
  const res = await Promise.all([sale(1), sale(2), sale(3)]);
  assert.deepEqual(res.map((r) => r.code).sort(), [200, 409, 409], JSON.stringify(res.map((r) => r.body)));
  assert.equal(await bal('Второй'), 0, 'остаток не ушёл в минус');
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM commands WHERE req_id LIKE 'race-%' AND kind='sale'`);
  assert.equal(n, 1, 'отклонённые продажи не заняли request_id');

  // одновременные повторы одного request_id: одно применение, остальные duplicate
  const dupl = await Promise.all([1, 2, 3].map(() => cmd(ADMIN, 'intake', { grade: 'Второй', net_kg: 1 }, 'same-req')));
  assert.equal(dupl.filter((r) => r.body.duplicate).length, 2);
  assert.equal(await bal('Второй'), 1);
  // отклонённый запрос можно повторить с тем же request_id после пополнения
  assert.equal((await cmd(ADMIN, 'writeoff', { grade: 'Второй', net_kg: 3, reason: 'x' }, 'wo-retry')).code, 409);
  await cmd(ADMIN, 'intake', { grade: 'Второй', net_kg: 5 }, 'race-in-2');
  assert.equal((await cmd(ADMIN, 'writeoff', { grade: 'Второй', net_kg: 3, reason: 'x' }, 'wo-retry')).body.status, 'applied');
});

test('#2 #3 правка/отмена записи активного моноблока — только командой; облако не меняет запись; отказ моноблока ничего не ломает', async () => {
  await push('mono-A');
  const e = await cmd(ADMIN, 'edit', { id: 1, device: 'mono-A', net_kg: 40, reason: 'весы' }, 'e-1');
  assert.equal(e.body.status, 'pending');
  assert.equal((await db.query(`SELECT net_kg FROM movements WHERE device='mono-A' AND id=1`))[0].net_kg, 50);
  assert.equal((await cmd(KEEPER, 'cancel_movement', { id: 1, device: 'mono-A', reason: 'x' })).code, 403);
  assert.equal((await cmd(KEEPER, 'edit', { id: 1, device: 'web', net_kg: 1, reason: 'x' })).code, 403);

  // «применить зависшие» не трогает команды активного моноблока (раньше давало «уже применено» и команда терялась)
  const p = await call(command, { method: 'PATCH', body: {}, ...ADMIN });
  assert.equal(p.body.applied, 0);
  const [c] = await db.query(`SELECT status FROM commands WHERE id=$1`, [e.body.id]);
  assert.equal(c.status, 'pending');

  // моноблок получает команду, отклоняет её (свои правила) — в облаке запись осталась прежней, откатывать нечего
  const got = await push('mono-A');
  assert.ok(got.body.commands.some((x) => x.id === e.body.id && x.payload.device === 'mono-A'));
  await push('mono-A', { acks: [{ id: e.body.id, status: 'rejected', result: 'отклонено: остаток' }] });
  assert.equal((await db.query(`SELECT net_kg FROM movements WHERE device='mono-A' AND id=1`))[0].net_kg, 50);
  assert.equal((await db.query(`SELECT status FROM commands WHERE id=$1`, [e.body.id]))[0].status, 'rejected');
});

test('#4 #5 #B неактивный моноблок: правка применяется в облаке сразу; лимит не считает команды мёртвых устройств; просрочка следа не оставляет', async () => {
  // старое устройство: записи есть, на связь не выходит
  await push('point-1-mac', { movements: [M({ id: 7, net_kg: 30 }), M({ id: 8, type: 'out', net_kg: 5, sale_id: 3, customer: 'А', amount: 1 })] });
  await db.query(`UPDATE devices SET last_seen = now() - interval '3 days' WHERE device='point-1-mac'`);
  for (let i = 0; i < 25; i++) {
    await db.query(`INSERT INTO commands(device,user_name,user_role,kind,payload,status) VALUES('point-1-mac','Кладовщик','keeper','edit','{"id":7}'::jsonb,'pending')`);
  }
  assert.equal((await cmd(KEEPER, 'intake', { grade: 'Высший', net_kg: 1 })).code, 200, 'зависшие команды мёртвого устройства не блокируют');

  const e = await cmd(ADMIN, 'edit', { id: 7, device: 'point-1-mac', net_kg: 29, reason: 'x' }, 'dead-e');
  assert.equal(e.body.status, 'applied');
  assert.equal((await db.query(`SELECT net_kg FROM movements WHERE device='point-1-mac' AND id=7`))[0].net_kg, 29);
  const cs = await cmd(ADMIN, 'cancel_sale', { id: 3, device: 'point-1-mac', reason: 'x' });
  assert.equal(cs.body.status, 'applied');
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM commands WHERE device='point-1-mac' AND status='pending' AND kind<>'edit'`);
  assert.equal(n, 0, 'для неактивного устройства команды не создаются');
  // неизвестное устройство = неактивное
  await db.query(`INSERT INTO movements(device,id,ts,type,grade,net_kg) VALUES('ghost',1,now(),'in','Высший',3)`);
  assert.equal((await cmd(ADMIN, 'cancel_movement', { id: 1, device: 'ghost', reason: 'x' })).body.status, 'applied');

  // активное устройство: просроченная команда ничего не меняла в облаке
  const pend = await cmd(ADMIN, 'edit', { id: 2, device: 'mono-A', net_kg: 19, reason: 'x' });
  await db.query(`UPDATE commands SET ts = now() - interval '31 days' WHERE id=$1`, [pend.body.id]);
  await push('mono-A');
  assert.equal((await db.query(`SELECT status FROM commands WHERE id=$1`, [pend.body.id]))[0].status, 'expired');
  assert.equal((await db.query(`SELECT net_kg FROM movements WHERE device='mono-A' AND id=2`))[0].net_kg, 20);
});

test('#6 отмена продажи выбирает строки по устройству, а не только по номеру', async () => {
  for (const d of ['mono-B', 'mono-C']) {
    await push(d, { movements: [M({ id: 1, net_kg: 10 }), M({ id: 2, type: 'out', net_kg: 1, sale_id: 9, customer: 'Б', amount: 1 })] });
    await db.query(`UPDATE devices SET last_seen = now() - interval '2 days' WHERE device=$1`, [d]);
  }
  assert.equal((await cmd(ADMIN, 'cancel_sale', { id: 9, reason: 'без устройства' })).code, 400);
  const r = await cmd(ADMIN, 'cancel_sale', { id: 9, device: 'mono-C', reason: 'x' });
  assert.equal(r.body.status, 'applied');
  const rows = await db.query(`SELECT device, status FROM movements WHERE sale_id=9 ORDER BY device`);
  assert.deepEqual(rows.map((x) => [x.device, x.status]), [['mono-B', 'active'], ['mono-C', 'cancelled']]);
});

test('#7 переименование сорта на сайте: алиас, перевод старого имени от моноблока, цепочки', async () => {
  const refs = (body) => call(status, { method: 'PATCH', query: { resource: 'refs' }, body, ...ADMIN });
  const [g] = await db.query(`SELECT id FROM grades WHERE name='Первый'`);
  assert.equal((await refs({ target: 'grade', id: g.id, name: 'Первый сорт' })).code, 200);
  const r = await push('mono-A', { movements: [M({ id: 30, grade: 'Первый', net_kg: 4 })], web_cursor: '' });
  assert.equal((await db.query(`SELECT grade FROM movements WHERE device='mono-A' AND id=30`))[0].grade, 'Первый сорт', 'старое имя переведено');
  assert.ok(r.body.grades.includes('Первый сорт') && !r.body.grades.includes('Первый'));
  assert.deepEqual(r.body.grade_aliases, [{ old: 'Первый', new: 'Первый сорт' }]);
  assert.ok(r.body.web_movements.filter((x) => x.type !== 'in' || x.grade !== 'Высший').some((x) => x.grade === 'Первый сорт'), 'веб-строки переименованы и пришли зеркалом');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM movements WHERE grade='Первый'`))[0].n, 0, 'остаток не раздвоился');

  // цепочка: Первый → Первый сорт → 1-й
  await refs({ target: 'grade', id: g.id, name: '1-й' });
  const r2 = await push('mono-A', { movements: [M({ id: 31, grade: 'Первый', net_kg: 1 })] });
  assert.equal((await db.query(`SELECT grade FROM movements WHERE device='mono-A' AND id=31`))[0].grade, '1-й');
  assert.deepEqual(Object.fromEntries(r2.body.grade_aliases.map((a) => [a.old, a.new])), { 'Первый': '1-й', 'Первый сорт': '1-й' });
  // вернули старое имя — его алиас больше не действует
  await refs({ target: 'grade', id: g.id, name: 'Первый' });
  const r3 = await push('mono-A');
  assert.ok(!r3.body.grade_aliases.some((a) => a.old === 'Первый'));
  assert.ok(r3.body.grade_aliases.some((a) => a.old === '1-й' && a.new === 'Первый'));
});

test('#9 Telegram: продажа одним сообщением, без дублей при повторе и при досылке остатка продажи; много приходов — сводкой; бюджет времени', async () => {
  const sent = [];
  try {
    globalThis.__TEST_TG = (m) => { sent.push(m); };
    const ts = `${today} 12:00:00`;
    const intakes = Array.from({ length: 12 }, (_, i) => M({ id: 200 + i, ts, net_kg: 1 }));
    await push('tg-mono', { movements: intakes });
    assert.equal(sent.length, 1, '12 приходов — одно сводное сообщение');
    assert.match(sent[0], /12 записей/);
    assert.match(sent[0], /12\.000 кг/);

    sent.length = 0;
    const sale = [M({ id: 300, type: 'out', net_kg: 2, sale_id: 50, customer: 'Х', amount: 10, ts }), M({ id: 301, type: 'out', net_kg: 3, sale_id: 50, customer: 'Х', amount: 20, ts })];
    await push('tg-mono', { movements: [sale[0]] }); // старый моноблок разрезал продажу между пачками
    await push('tg-mono', { movements: [sale[1]] });
    await push('tg-mono', { movements: sale });
    assert.equal(sent.length, 1, 'одна продажа — не больше одного сообщения');

    // медленный Telegram: ответ моноблоку не ждёт дольше бюджета
    sent.length = 0;
    globalThis.__TEST_TG = () => new Promise((r) => setTimeout(r, 3000));
    const many = Array.from({ length: 10 }, (_, i) => M({ id: 400 + i, type: 'out', net_kg: 0.1, sale_id: 100 + i, customer: 'Y', amount: 1, ts }));
    const t0 = Date.now();
    const r = await push('tg-mono', { movements: many });
    assert.equal(r.code, 200);
    assert.ok(Date.now() - t0 < 2500, `ответ за ${Date.now() - t0} мс`);
  } finally {
    delete globalThis.__TEST_TG;
  }
});
