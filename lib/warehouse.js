// Доменный слой склада: расчёт остатков, валидация и применение операций (приход, продажа, списание, отмена, исправление).
//
// Правила синхронизации сайт ↔ моноблок:
//  • приход/продажа/списание с сайта сразу записываются в облаке как device='web' (моноблок получает их зеркалом через /api/ingest);
//  • исправление/отмена записи 'web' применяется сразу;
//  • исправление/отмена записи моноблока НЕ применяется в облаке, а ставится в очередь (pending) для этого моноблока —
//    решение принимает моноблок по своим остаткам, а облако получает результат вместе с его записями.
//    Исключение: моноблок неактивен (нет связи > 24 ч или неизвестен) — тогда изменение применяется прямо в облаке.
//  • все записи идут под одной advisory-блокировкой внутри транзакции: проверка остатка и вставка атомарны,
//    request_id занимается в той же транзакции (повтор = duplicate, без второго применения).
const { query, transaction } = require('./db');
const { todayStr, TZ, logError } = require('./http');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Общий ключ блокировки для всех записей с сайта (операций мало, сериализация дешевле гонок).
const WEB_LOCK = 774201;
const ACTIVE_HOURS = 24;
const PENDING_LIMIT = 20;

const str = (v, max, required = false, label = 'поле') => {
  const s = String(v ?? '').trim().slice(0, max);
  if (required && !s) throw fail(`${label}: обязательно`);
  return s;
};

const num = (v, label, { min = 0, max = 100000, strict = true } = {}) => {
  const x = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(x) || (strict ? x <= min : x < min) || x > max) {
    throw fail(`${label}: неверное значение`);
  }
  return x;
};

const posId = (v, label) => {
  const x = Number(v);
  if (!Number.isInteger(x) || x < 1) throw fail(`${label}: неверный номер`);
  return x;
};

const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const r2 = (v) => Math.round(Number(v) * 100) / 100;

// Именованные параметры (:name) → $n. Приведение типов (::jsonb) не трогаем.
function named(sql, params) {
  const keys = [];
  const text = sql.replace(/(?<!:):([a-z_]+)\b/g, (_, k) => {
    if (!(k in params)) throw new Error(`нет параметра ${k}`);
    let i = keys.indexOf(k);
    if (i < 0) i = keys.push(k) - 1;
    return `$${i + 1}`;
  });
  return [text, keys.map((k) => (params[k] === undefined ? null : params[k]))];
}

async function locked(sql, params) {
  const out = await transaction([[`SELECT pg_advisory_xact_lock(${WEB_LOCK})`, []], named(sql, params)]);
  return out[1][0];
}

async function getStock() {
  const gradeRows = await query(`SELECT name FROM grades WHERE active ORDER BY sort_order, id`);
  const order = gradeRows.map((r) => r.name);
  const rows = await query(
    `SELECT grade,
       ROUND(SUM(CASE WHEN type='in' THEN net_kg ELSE 0 END)::numeric,3)::float8 AS in_kg,
       ROUND(SUM(CASE WHEN type='out' THEN net_kg ELSE 0 END)::numeric,3)::float8 AS out_kg,
       ROUND(SUM(CASE WHEN type='writeoff' THEN net_kg ELSE 0 END)::numeric,3)::float8 AS writeoff_kg
     FROM movements WHERE status='active' GROUP BY grade`
  );
  const byGrade = Object.fromEntries(rows.map((r) => [r.grade, r]));
  const names = [...order, ...rows.map((r) => r.grade).filter((g) => !order.includes(g))];
  const out = names.map((g) => {
    const r = byGrade[g] || { grade: g, in_kg: 0, out_kg: 0, writeoff_kg: 0 };
    return { ...r, balance_kg: Math.round((r.in_kg - r.out_kg - r.writeoff_kg) * 1000) / 1000 };
  });
  return {
    rows: out,
    total_kg: Math.round(out.reduce((a, r) => a + r.balance_kg, 0) * 1000) / 1000,
    byGrade: Object.fromEntries(out.map((r) => [r.grade, r.balance_kg])),
  };
}

function cleanPayload(kind, p, grades) {
  const grade = (v) => {
    const g = str(v, 60, true, 'сорт');
    if (grades.length && !grades.includes(g)) throw fail('неизвестный сорт');
    return g;
  };
  if (kind === 'intake') {
    return { grade: grade(p.grade), net_kg: num(p.net_kg, 'вес'), worker: str(p.worker, 120), note: str(p.note, 300) };
  }
  if (kind === 'writeoff') {
    return { grade: grade(p.grade), net_kg: num(p.net_kg, 'вес'), reason: str(p.reason, 300, true, 'причина') };
  }
  if (kind === 'sale') {
    if (!Array.isArray(p.items) || !p.items.length || p.items.length > 50) throw fail('в продаже нет позиций');
    return {
      customer: str(p.customer, 120, true, 'покупатель'),
      note: str(p.note, 300),
      items: p.items.map((it) => ({
        grade: grade(it.grade),
        net_kg: num(it.net_kg, 'вес'),
        price_per_kg: it.price_per_kg === '' || it.price_per_kg == null ? null : num(it.price_per_kg, 'цена', { min: 0, max: 1e9, strict: false }),
        amount: num(it.amount, 'сумма', { min: 0, max: 1e12, strict: false }),
      })),
    };
  }
  if (kind === 'cancel_movement' || kind === 'cancel_sale') {
    return { id: posId(p.id, 'запись'), device: str(p.device, 64, true, 'устройство'), reason: str(p.reason, 300, true, 'причина') };
  }
  if (kind === 'edit') {
    const out = { id: posId(p.id, 'запись'), device: str(p.device, 64, true, 'устройство'), reason: str(p.reason, 300, true, 'причина') };
    if (p.grade !== undefined && p.grade !== null && p.grade !== '') out.grade = grade(p.grade);
    if (p.net_kg !== undefined && p.net_kg !== null && p.net_kg !== '') out.net_kg = num(p.net_kg, 'вес');
    if (p.worker !== undefined) out.worker = str(p.worker, 120);
    if (p.note !== undefined) out.note = str(p.note, 300);
    if (p.customer !== undefined && p.customer !== '') out.customer = str(p.customer, 120, true, 'покупатель');
    if (p.price_per_kg !== undefined && p.price_per_kg !== '' && p.price_per_kg !== null) {
      out.price_per_kg = num(p.price_per_kg, 'цена', { min: 0, max: 1e9, strict: false });
    }
    if (p.amount !== undefined && p.amount !== '' && p.amount !== null) {
      out.amount = num(p.amount, 'сумма', { min: 0, max: 1e12, strict: false });
    }
    return out;
  }
  throw fail('неизвестная операция');
}

const ROW_SQL = `SELECT *, to_char(ts,'YYYY-MM-DD') AS day, updated_at::text AS u_txt FROM movements`;

async function findMovement(device, id) {
  const [row] = await query(`${ROW_SQL} WHERE device=$1 AND id=$2`, [device, id]);
  return row || null;
}

async function findSale(device, saleId) {
  return query(`${ROW_SQL} WHERE device=$1 AND sale_id=$2 ORDER BY id`, [device, saleId]);
}

// Моноблок активен, если выходил на связь за последние 24 ч. Устройство 'web' — это сам сайт.
async function isDeviceActive(device) {
  if (device === 'web') return true;
  const [d] = await query(
    `SELECT last_seen > now() - interval '${ACTIVE_HOURS} hours' AS active FROM devices WHERE device=$1`,
    [device]
  );
  return Boolean(d && d.active);
}

// Лимит: только ожидающие команды этого человека, адресованные активным моноблокам (мёртвые устройства не блокируют).
async function pendingCount(userName) {
  const [r] = await query(
    `SELECT count(*)::int AS n FROM commands c
     WHERE c.user_name=$1 AND c.status='pending'
       AND EXISTS (SELECT 1 FROM devices d WHERE d.device=c.device AND d.last_seen > now() - interval '${ACTIVE_HOURS} hours')`,
    [userName]
  );
  return r.n;
}

function canCancel(user) {
  return user.role === 'admin';
}

// Общие куски SQL: повтор по request_id, «занять» request_id (или закрыть команду из очереди) только если изменение прошло.
const DUP_CTE = `dup AS (SELECT id, status, result FROM commands WHERE :req_id::text IS NOT NULL AND req_id = :req_id::text)`;
const GUARD = `NOT EXISTS (SELECT 1 FROM dup) AND (:cmd_id::int IS NULL OR EXISTS (SELECT 1 FROM commands WHERE id = :cmd_id::int AND status = 'pending'))`;
const finishCtes = (src) => `
  claim AS (
    INSERT INTO commands (device, user_name, user_role, kind, payload, req_id, status, result, done_ts)
    SELECT :cmd_device::text, :user_name::text, :user_role::text, :kind::text, :payload::jsonb, :req_id::text, 'applied', :result::text, now()
    FROM (SELECT 1 FROM ${src} LIMIT 1) z WHERE :cmd_id::int IS NULL
    ON CONFLICT (req_id) WHERE req_id IS NOT NULL DO NOTHING RETURNING id),
  mark AS (
    UPDATE commands SET status = 'applied', result = :result::text, done_ts = now()
    WHERE id = :cmd_id::int AND status = 'pending' AND EXISTS (SELECT 1 FROM ${src}) RETURNING id)`;

function baseParams(user, kind, p, reqId, cmdId, cmdDevice, result) {
  return {
    req_id: reqId || null,
    cmd_id: cmdId || null,
    cmd_device: cmdDevice,
    user_name: user.name,
    user_role: user.role,
    kind,
    payload: JSON.stringify(p),
    result: result || '',
    tz: TZ,
  };
}

// ── Приход / продажа / списание с сайта: мгновенно в облаке (device='web'), атомарно и идемпотентно ──
async function applyWebOp(user, kind, p, { reqId = null, cmdId = null, cmdDevice = 'web' } = {}) {
  let type;
  let items;
  if (kind === 'intake') {
    type = 'in';
    items = [{ grade: p.grade, net_kg: r3(p.net_kg), price_per_kg: null, amount: null }];
  } else if (kind === 'writeoff') {
    type = 'writeoff';
    items = [{ grade: p.grade, net_kg: r3(p.net_kg), price_per_kg: null, amount: null }];
  } else if (kind === 'sale') {
    type = 'out';
    items = p.items.map((it) => ({ grade: it.grade, net_kg: r3(it.net_kg), price_per_kg: it.price_per_kg, amount: r2(it.amount) }));
  } else {
    throw fail('неизвестная операция');
  }
  items = items.map((it, i) => ({ ...it, ord: i }));
  const params = {
    ...baseParams(user, kind, p, reqId, cmdId, cmdDevice, ''),
    items: JSON.stringify(items),
    type,
    check: type !== 'in',
    worker: kind === 'intake' ? p.worker || '' : '',
    note: kind === 'writeoff' ? p.reason : p.note || '',
    customer: kind === 'sale' ? p.customer : null,
  };
  const row = await locked(
    `WITH ${DUP_CTE},
     it AS (SELECT x.ord, x.grade, x.net_kg, x.price_per_kg, x.amount
            FROM jsonb_to_recordset(:items::jsonb) AS x(ord int, grade text, net_kg float8, price_per_kg float8, amount float8)),
     need AS (SELECT grade, ROUND(SUM(net_kg)::numeric, 3)::float8 AS kg FROM it GROUP BY grade),
     bal AS (SELECT grade, ROUND(SUM(CASE WHEN type='in' THEN net_kg ELSE -net_kg END)::numeric, 3)::float8 AS b
             FROM movements WHERE status='active' AND grade IN (SELECT grade FROM need) GROUP BY grade),
     short AS (SELECT n.grade, n.kg, COALESCE(b.b, 0) AS bal FROM need n LEFT JOIN bal b USING (grade)
               WHERE :check::boolean AND n.kg > COALESCE(b.b, 0) + 1e-9),
     go AS (SELECT 1 AS g WHERE ${GUARD} AND NOT EXISTS (SELECT 1 FROM short)),
     ${finishCtes('go')},
     ok AS (SELECT id FROM claim UNION ALL SELECT id FROM mark),
     sid AS (SELECT CASE WHEN :type::text = 'out' THEN nextval('web_sale_seq')::int END AS sid FROM ok),
     ins AS (
       INSERT INTO movements (device, id, ts, type, grade, gross_kg, tare_kg, net_kg, manual, worker, note, sale_id, customer,
                              price_per_kg, amount, user_name, status, updated_at)
       SELECT 'web', nextval('web_mov_seq')::int, (now() AT TIME ZONE :tz::text)::timestamp, :type::text, it.grade, it.net_kg, 0,
              it.net_kg, true, :worker::text, :note::text, sid.sid, :customer::text, it.price_per_kg, it.amount, :user_name::text,
              'active', clock_timestamp()
       FROM it CROSS JOIN sid
       RETURNING id, grade, net_kg, sale_id, amount)
     SELECT (SELECT row_to_json(dup) FROM dup) AS dup,
            (SELECT json_agg(short) FROM short) AS short,
            (SELECT id FROM ok LIMIT 1) AS cmd_id,
            (SELECT json_agg(ins ORDER BY id) FROM ins) AS rows`,
    params
  );
  if (row.dup) return { duplicate: true, id: row.dup.id, status: row.dup.status, result: row.dup.result };
  if (row.short && row.short.length) {
    const s = row.short[0];
    const verb = type === 'out' ? 'а продаётся' : 'списывается';
    throw fail(`Сорт «${s.grade}»: на складе ${r3(s.bal)} кг, ${verb} ${s.kg} кг`, 409);
  }
  if (!row.cmd_id) {
    if (cmdId) throw fail('команда уже обработана', 409);
    return { duplicate: true };
  }
  const rows = row.rows || [];
  const totalKg = r3(rows.reduce((a, r) => a + Number(r.net_kg), 0));
  const totalAmt = r2(rows.reduce((a, r) => a + Number(r.amount || 0), 0));
  let result;
  if (type === 'in') result = `приход #${rows[0].id}: ${p.grade} ${totalKg} кг`;
  else if (type === 'writeoff') result = `списание #${rows[0].id}: ${p.grade} ${totalKg} кг`;
  else result = `продажа #${rows[0].sale_id}: ${totalKg} кг на ${totalAmt}`;
  await query(`UPDATE commands SET result=$1 WHERE id=$2`, [result, row.cmd_id]);
  return {
    id: row.cmd_id,
    targetDevice: 'web',
    status: 'applied',
    result,
    rows,
    sale_id: type === 'out' ? rows[0].sale_id : null,
    total_kg: totalKg,
    total_amount: totalAmt,
  };
}

// ── Отмена / исправление прямо в облаке (записи 'web' или записи неактивного моноблока) ──
// Изменение условное: запись не поменялась с момента чтения (updated_at), остаток не уходит в минус,
// request_id свободен (или команда из очереди ещё pending). Всё это проверяется одним запросом под блокировкой.
async function applyChange(user, kind, p, { reqId = null, cmdId = null, cmdDevice = null, skipPerm = false } = {}) {
  const device = p.device;
  const deny = (row) => {
    if (skipPerm) return;
    if (!canCancel(user, row)) throw fail('отменять и изменять записи может только администратор', 403);
  };

  if (kind === 'cancel_sale') {
    const rows = await findSale(device, p.id);
    if (!rows.length) throw fail('продажа не найдена', 404);
    if (!rows.some((r) => r.status === 'active')) throw fail('продажа уже отменена', 409);
    deny(rows[0]);
    const result = `продажа #${p.id} отменена`;
    const row = await locked(
      `WITH ${DUP_CTE},
       upd AS (UPDATE movements SET status='cancelled', cancel_reason=:reason::text,
                 cancelled_ts=(now() AT TIME ZONE :tz::text)::timestamp, updated_at=clock_timestamp()
               WHERE device=:device::text AND sale_id=:sale_id::int AND status='active' AND ${GUARD}
               RETURNING id),
       ${finishCtes('upd')}
       SELECT (SELECT row_to_json(dup) FROM dup) AS dup, (SELECT count(*) FROM upd)::int AS n,
              COALESCE((SELECT id FROM claim), (SELECT id FROM mark)) AS cmd_id`,
      { ...baseParams(user, kind, p, reqId, cmdId, cmdDevice || device, result), reason: p.reason, device, sale_id: p.id }
    );
    return finishChange(row, result, device, cmdId, async () => {
      const now = await findSale(device, p.id);
      if (!now.some((r) => r.status === 'active')) throw fail('продажа уже отменена', 409);
    });
  }

  const m = await findMovement(device, p.id);
  if (!m) throw fail('запись не найдена', 404);

  if (kind === 'cancel_movement') {
    if (m.sale_id) throw fail('это позиция продажи, отмените всю продажу', 400);
    if (m.status !== 'active') throw fail('запись уже отменена', 409);
    deny(m);
    const delta = m.type === 'in' ? -Number(m.net_kg) : Number(m.net_kg);
    const result = `запись #${m.id} отменена`;
    const row = await locked(
      `WITH ${DUP_CTE},
       bal AS (SELECT ROUND(COALESCE(SUM(CASE WHEN type='in' THEN net_kg ELSE -net_kg END), 0)::numeric, 3)::float8 AS b
               FROM movements WHERE status='active' AND grade=:grade::text),
       upd AS (UPDATE movements SET status='cancelled', cancel_reason=:reason::text,
                 cancelled_ts=(now() AT TIME ZONE :tz::text)::timestamp, updated_at=clock_timestamp()
               WHERE device=:device::text AND id=:id::int AND status='active' AND updated_at=:u_txt::timestamptz AND ${GUARD}
                 AND (:delta::float8 >= 0 OR (SELECT b FROM bal) + :delta::float8 >= -1e-9)
               RETURNING id),
       ${finishCtes('upd')}
       SELECT (SELECT row_to_json(dup) FROM dup) AS dup, (SELECT count(*) FROM upd)::int AS n,
              COALESCE((SELECT id FROM claim), (SELECT id FROM mark)) AS cmd_id, (SELECT b FROM bal) AS bal`,
      { ...baseParams(user, kind, p, reqId, cmdId, cmdDevice || device, result), reason: p.reason, device, id: m.id,
        grade: m.grade, u_txt: m.u_txt, delta }
    );
    return finishChange(row, result, device, cmdId, async () => {
      const now = await findMovement(device, m.id);
      if (!now || now.status !== 'active') throw fail('запись уже отменена', 409);
      if (now.u_txt !== m.u_txt) throw fail('запись только что изменилась, обновите и повторите', 409);
      throw fail(`Нельзя отменить: этот товар уже продан или списан (на складе ${r3(row.bal)} кг)`, 409);
    });
  }

  if (kind === 'edit') {
    if (!skipPerm && user.role !== 'admin') throw fail('править записи может только администратор', 403);
    if (m.status !== 'active') throw fail('отменённую запись править нельзя', 409);
    const nextGrade = p.grade !== undefined ? p.grade : m.grade;
    const nextNet = p.net_kg !== undefined ? r3(p.net_kg) : Number(m.net_kg);
    const netChanged = nextNet !== Number(m.net_kg);
    const nextGross = netChanged ? r3(nextNet + Number(m.tare_kg || 0)) : m.gross_kg;
    const nextManual = netChanged ? true : m.manual;
    const nextWorker = m.type === 'in' && p.worker !== undefined ? p.worker : m.worker;
    const nextNote = p.note !== undefined ? p.note : m.note;
    const nextPrice = m.type === 'out' && p.price_per_kg !== undefined ? p.price_per_kg : m.price_per_kg;
    const nextAmount = m.type === 'out' && p.amount !== undefined ? r2(p.amount) : m.amount;
    const nextCustomer = m.type === 'out' && p.customer !== undefined ? p.customer : m.customer;
    const changed =
      nextGrade !== m.grade || netChanged || nextWorker !== m.worker || nextNote !== m.note ||
      nextPrice !== m.price_per_kg || nextAmount !== m.amount || nextCustomer !== m.customer;
    if (!changed) throw fail('ничего не изменилось', 400);

    const sign = m.type === 'in' ? 1 : -1;
    const same = nextGrade === m.grade;
    const dOld = same ? sign * (nextNet - Number(m.net_kg)) : -sign * Number(m.net_kg);
    const dNew = same ? dOld : sign * nextNet;
    const result = `запись #${m.id} исправлена`;
    const row = await locked(
      `WITH ${DUP_CTE},
       bal AS (SELECT grade, ROUND(SUM(CASE WHEN type='in' THEN net_kg ELSE -net_kg END)::numeric, 3)::float8 AS b
               FROM movements WHERE status='active' AND grade IN (:g_old::text, :g_new::text) GROUP BY grade),
       upd AS (UPDATE movements SET grade=:g_new::text, gross_kg=:gross::float8, net_kg=:net::float8, manual=:manual::boolean,
                 worker=:worker::text, note=:note::text, price_per_kg=:price::float8, amount=:amount::float8, customer=:customer::text,
                 updated_at=clock_timestamp()
               WHERE device=:device::text AND id=:id::int AND status='active' AND updated_at=:u_txt::timestamptz AND ${GUARD}
                 AND (:d_old::float8 >= 0 OR COALESCE((SELECT b FROM bal WHERE grade=:g_old::text), 0) + :d_old::float8 >= -1e-9)
                 AND (:d_new::float8 >= 0 OR COALESCE((SELECT b FROM bal WHERE grade=:g_new::text), 0) + :d_new::float8 >= -1e-9)
               RETURNING id),
       cust AS (UPDATE movements SET customer=:customer::text, updated_at=clock_timestamp()
                WHERE device=:device::text AND sale_id=:sale_id::int AND id<>:id::int AND :cust_changed::boolean
                  AND EXISTS (SELECT 1 FROM upd) RETURNING id),
       ${finishCtes('upd')}
       SELECT (SELECT row_to_json(dup) FROM dup) AS dup, (SELECT count(*) FROM upd)::int AS n,
              COALESCE((SELECT id FROM claim), (SELECT id FROM mark)) AS cmd_id, (SELECT count(*) FROM cust)::int AS c`,
      {
        ...baseParams(user, kind, p, reqId, cmdId, cmdDevice || device, result),
        device, id: m.id, u_txt: m.u_txt, g_old: m.grade, g_new: nextGrade, gross: nextGross, net: nextNet,
        manual: Boolean(nextManual), worker: nextWorker, note: nextNote, price: nextPrice, amount: nextAmount,
        customer: nextCustomer, sale_id: m.sale_id, cust_changed: m.type === 'out' && Boolean(m.sale_id) && nextCustomer !== m.customer,
        d_old: dOld, d_new: dNew,
      }
    );
    return finishChange(row, result, device, cmdId, async () => {
      const now = await findMovement(device, m.id);
      if (!now || now.status !== 'active') throw fail('отменённую запись править нельзя', 409);
      if (now.u_txt !== m.u_txt) throw fail('запись только что изменилась, обновите и повторите', 409);
      throw fail('После исправления остаток какого-то сорта стал бы отрицательным', 409);
    });
  }

  throw fail('неизвестная операция');
}

async function finishChange(row, result, device, cmdId, explain) {
  if (row.dup) return { duplicate: true, id: row.dup.id, status: row.dup.status, result: row.dup.result };
  if (row.n > 0 && row.cmd_id) return { id: row.cmd_id, targetDevice: device, status: 'applied', result };
  if (row.n > 0) return { duplicate: true }; // request_id занял параллельный запрос (практически невозможно под блокировкой)
  if (cmdId) {
    const [c] = await query(`SELECT status FROM commands WHERE id=$1`, [cmdId]);
    if (!c || c.status !== 'pending') throw fail('команда уже обработана', 409);
  }
  await explain();
  throw fail('изменение не применено', 409);
}

// ── Команда для активного моноблока: в облаке ничего не меняем, ждём его ответа ──
async function queueCommand(user, kind, p, reqId) {
  const result = 'ждёт синхронизации со складом';
  const row = await locked(
    `WITH ${DUP_CTE},
     ins AS (INSERT INTO commands (device, user_name, user_role, kind, payload, req_id, status, result)
             SELECT :device::text, :user_name::text, :user_role::text, :kind::text, :payload::jsonb, :req_id::text, 'pending', :result::text
             WHERE NOT EXISTS (SELECT 1 FROM dup)
             ON CONFLICT (req_id) WHERE req_id IS NOT NULL DO NOTHING RETURNING id)
     SELECT (SELECT row_to_json(dup) FROM dup) AS dup, (SELECT id FROM ins) AS cmd_id`,
    { req_id: reqId || null, device: p.device, user_name: user.name, user_role: user.role, kind, payload: JSON.stringify(p), result }
  );
  if (row.dup) return { duplicate: true, id: row.dup.id, status: row.dup.status, result: row.dup.result };
  if (!row.cmd_id) return { duplicate: true };
  return { id: row.cmd_id, targetDevice: p.device, status: 'pending', result };
}

// ── Точка входа для POST /api/command ──
async function submitOperation(user, kind, p, reqId) {
  if (kind === 'intake' || kind === 'writeoff' || kind === 'sale') return applyWebOp(user, kind, p, { reqId });
  if (!['edit', 'cancel_movement', 'cancel_sale'].includes(kind)) throw fail('неизвестная операция');
  if (kind === 'edit' && user.role !== 'admin') throw fail('править записи может только администратор', 403);

  if (p.device === 'web') return applyChange(user, kind, p, { reqId });

  // запись моноблока: только администратор
  if (user.role !== 'admin') throw fail('изменять записи моноблока может только администратор', 403);
  const exists =
    kind === 'cancel_sale' ? (await findSale(p.device, p.id)).length > 0 : Boolean(await findMovement(p.device, p.id));
  if (!exists) throw fail(kind === 'cancel_sale' ? 'продажа не найдена' : 'запись не найдена', 404);
  if (await isDeviceActive(p.device)) {
    if (kind !== 'cancel_sale') {
      const m = await findMovement(p.device, p.id);
      if (m.status !== 'active') throw fail(kind === 'edit' ? 'отменённую запись править нельзя' : 'запись уже отменена', 409);
      if (kind === 'cancel_movement' && m.sale_id) throw fail('это позиция продажи, отмените всю продажу', 400);
    } else if (!(await findSale(p.device, p.id)).some((r) => r.status === 'active')) {
      throw fail('продажа уже отменена', 409);
    }
    return queueCommand(user, kind, p, reqId);
  }
  // моноблок не выходил на связь больше суток (или неизвестен): применяем прямо в облаке
  const r = await applyChange(user, kind, p, { reqId });
  if (r.status === 'applied') r.result = `${r.result} в облаке (склад «${p.device}» не на связи)`;
  return r;
}

// ── PATCH /api/command: применить зависшие команды только для неактивных моноблоков ──
async function applyStalePending(id) {
  const rows = await query(
    `SELECT c.* FROM commands c
     WHERE c.status='pending' ${id ? 'AND c.id=$1' : ''}
       AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.device=c.device AND d.last_seen > now() - interval '${ACTIVE_HOURS} hours')
     ORDER BY c.id LIMIT 50`,
    id ? [id] : []
  );
  const [{ n: skipped }] = await query(
    `SELECT count(*)::int AS n FROM commands c WHERE c.status='pending'
       AND EXISTS (SELECT 1 FROM devices d WHERE d.device=c.device AND d.last_seen > now() - interval '${ACTIVE_HOURS} hours')`
  );
  let applied = 0;
  let rejected = 0;
  for (const c of rows) {
    const user = { name: c.user_name, role: c.user_role };
    const p = { ...(c.payload || {}) };
    try {
      if (['intake', 'writeoff', 'sale'].includes(c.kind)) {
        await applyWebOp(user, c.kind, p, { cmdId: c.id, cmdDevice: c.device });
      } else {
        p.device = c.device;
        await applyChange(user, c.kind, p, { cmdId: c.id, cmdDevice: c.device, skipPerm: true });
      }
      applied++;
    } catch (e) {
      const msg = e.status ? e.message : 'ошибка применения';
      if (msg === 'команда уже обработана') continue;
      if (msg === 'ничего не изменилось') {
        await query(`UPDATE commands SET status='applied', result='уже применено', done_ts=now() WHERE id=$1 AND status='pending'`, [c.id]);
        applied++;
      } else {
        if (!e.status) logError('command_apply', e);
        await query(`UPDATE commands SET status='rejected', result=$1, done_ts=now() WHERE id=$2 AND status='pending'`, [`отклонено: ${msg}`.slice(0, 300), c.id]);
        rejected++;
      }
    }
  }
  return { applied, rejected, skipped };
}

// ── Зеркало веб-операций для моноблока: строки device='web', изменённые после курсора ──
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?)\|(\d{1,10})$/;
async function webMovementsSince(cursor, limit = 500) {
  const m = typeof cursor === 'string' ? CURSOR_RE.exec(cursor) : null;
  const ts = m ? m[1] : '-infinity';
  const id = m ? Number(m[2]) : 0;
  const rows = await query(
    `SELECT id, to_char(ts,'YYYY-MM-DD HH24:MI:SS') AS ts, type, grade, gross_kg, tare_kg, net_kg, manual, worker, note,
            sale_id, customer, price_per_kg, amount, user_name, status, cancel_reason,
            to_char(cancelled_ts,'YYYY-MM-DD HH24:MI:SS') AS cancelled_ts, updated_at::text AS u_txt
     FROM movements WHERE device='web' AND (updated_at, id) > ($1::timestamptz, $2::int)
     ORDER BY updated_at, id LIMIT $3`,
    [ts, id, limit]
  );
  const last = rows[rows.length - 1];
  const next = last ? `${last.u_txt}|${last.id}` : m ? cursor : '';
  return {
    rows: rows.map(({ u_txt, ...r }) => ({ device: 'web', ...r })),
    cursor: next,
    more: rows.length === limit,
  };
}

module.exports = {
  WEB_LOCK,
  PENDING_LIMIT,
  getStock,
  cleanPayload,
  submitOperation,
  applyWebOp,
  applyChange,
  applyStalePending,
  isDeviceActive,
  pendingCount,
  webMovementsSince,
};
