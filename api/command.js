// Операции с сайта (приход, продажа, списание, отмена, исправление).
// Изменения применяются в облачной БД сразу (видны на сайте 24/7), а для записей моноблока
// дополнительно ставятся в очередь commands — при выходе на связь моноблок подтянет правки к себе,
// не затрагивая свои новые офлайн-записи.
const { query } = require('../lib/db');
const { handler, todayStr } = require('../lib/http');
const { audit } = require('../lib/auth');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const str = (v, max, required = false, label = 'поле') => {
  const s = String(v ?? '').trim().slice(0, max);
  if (required && !s) throw fail(`${label}: обязательно`);
  return s;
};
const num = (v, label, { min = 0, max = 100000, strict = true } = {}) => {
  const x = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(x) || (strict ? x <= min : x < min) || x > max) throw fail(`${label}: неверное значение`);
  return x;
};
const id = (v, label) => {
  const x = Number(v);
  if (!Number.isInteger(x) || x < 1) throw fail(`${label}: неверный номер`);
  return x;
};

// Единственное место, где разбирается payload: наружу уходит только то, что мы сами собрали из разрешённых полей.
function clean(kind, p, grades) {
  const grade = (v) => {
    const g = str(v, 60, true, 'сорт');
    if (grades.length && !grades.includes(g)) throw fail('неизвестный сорт');
    return g;
  };
  if (kind === 'intake') return { grade: grade(p.grade), net_kg: num(p.net_kg, 'вес'), worker: str(p.worker, 120), note: str(p.note, 300) };
  if (kind === 'writeoff') return { grade: grade(p.grade), net_kg: num(p.net_kg, 'вес'), reason: str(p.reason, 300, true, 'причина') };
  if (kind === 'sale') {
    if (!Array.isArray(p.items) || !p.items.length || p.items.length > 50) throw fail('в продаже нет позиций');
    return {
      customer: str(p.customer, 120, true, 'покупатель'), note: str(p.note, 300),
      items: p.items.map((it) => ({
        grade: grade(it.grade), net_kg: num(it.net_kg, 'вес'),
        price_per_kg: it.price_per_kg === '' || it.price_per_kg == null ? null : num(it.price_per_kg, 'цена', { min: 0, max: 1e9, strict: false }),
        amount: num(it.amount, 'сумма', { min: 0, max: 1e12, strict: false }),
      })),
    };
  }
  if (kind === 'cancel_movement' || kind === 'cancel_sale') {
    const out = { id: id(p.id, 'запись'), reason: str(p.reason, 300, true, 'причина') };
    if (p.device) out.device = str(p.device, 64);
    return out;
  }
  if (kind === 'edit') {
    const out = { id: id(p.id, 'запись'), reason: str(p.reason, 300, true, 'причина') };
    if (p.device) out.device = str(p.device, 64);
    if (p.grade !== undefined && p.grade !== null && p.grade !== '') out.grade = grade(p.grade);
    if (p.net_kg !== undefined && p.net_kg !== null && p.net_kg !== '') out.net_kg = num(p.net_kg, 'вес');
    if (p.worker !== undefined) out.worker = str(p.worker, 120);
    if (p.note !== undefined) out.note = str(p.note, 300);
    if (p.customer !== undefined && p.customer !== '') out.customer = str(p.customer, 120, true, 'покупатель');
    if (p.price_per_kg !== undefined && p.price_per_kg !== '' && p.price_per_kg !== null) out.price_per_kg = num(p.price_per_kg, 'цена', { min: 0, max: 1e9, strict: false });
    if (p.amount !== undefined && p.amount !== '' && p.amount !== null) out.amount = num(p.amount, 'сумма', { min: 0, max: 1e12, strict: false });
    return out;
  }
  throw fail('неизвестная операция');
}

async function stockMap() {
  const rows = await query(
    `SELECT grade,
       ROUND(SUM(CASE WHEN type='in' THEN net_kg ELSE 0 END)::numeric,3)::float8
       - ROUND(SUM(CASE WHEN type='out' THEN net_kg ELSE 0 END)::numeric,3)::float8
       - ROUND(SUM(CASE WHEN type='writeoff' THEN net_kg ELSE 0 END)::numeric,3)::float8 AS bal
     FROM movements WHERE status='active' GROUP BY grade`
  );
  return Object.fromEntries(rows.map((r) => [r.grade, Math.round(Number(r.bal || 0) * 1000) / 1000]));
}

async function findMovement(mid, device) {
  const rows = device
    ? await query(`SELECT *, to_char(ts,'YYYY-MM-DD') AS day FROM movements WHERE device=$1 AND id=$2`, [device, mid])
    : await query(`SELECT *, to_char(ts,'YYYY-MM-DD') AS day FROM movements WHERE id=$1 ORDER BY updated_at DESC LIMIT 1`, [mid]);
  return rows[0] || null;
}

function canCancel(user, row) {
  if (user.role === 'admin') return true;
  return row.user_name === user.name && row.day === todayStr();
}

async function applyInCloud(user, kind, p) {
  if (kind === 'intake') {
    const [{ nid }] = await query(`SELECT COALESCE(MAX(id),0)::int + 1 AS nid FROM movements WHERE device='web'`);
    const net = Math.round(p.net_kg * 1000) / 1000;
    await query(
      `INSERT INTO movements(device,id,ts,type,grade,gross_kg,tare_kg,net_kg,manual,worker,note,user_name,status,updated_at)
       VALUES('web',$1,(now() at time zone 'Asia/Tashkent')::timestamp,'in',$2,$3,0,$3,true,$4,$5,$6,'active',now())`,
      [nid, p.grade, net, p.worker, p.note, user.name]
    );
    return { targetDevice: 'web', status: 'applied', result: `приход #${nid}: ${p.grade} ${net} кг` };
  }

  if (kind === 'writeoff') {
    const stock = await stockMap();
    const bal = stock[p.grade] || 0;
    const net = Math.round(p.net_kg * 1000) / 1000;
    if (net > bal + 1e-9) throw fail(`Сорт «${p.grade}»: на складе ${bal} кг, списывается ${net} кг`, 409);
    const [{ nid }] = await query(`SELECT COALESCE(MAX(id),0)::int + 1 AS nid FROM movements WHERE device='web'`);
    await query(
      `INSERT INTO movements(device,id,ts,type,grade,gross_kg,tare_kg,net_kg,manual,note,user_name,status,updated_at)
       VALUES('web',$1,(now() at time zone 'Asia/Tashkent')::timestamp,'writeoff',$2,$3,0,$3,true,$4,$5,'active',now())`,
      [nid, p.grade, net, p.reason, user.name]
    );
    return { targetDevice: 'web', status: 'applied', result: `списание #${nid}: ${p.grade} ${net} кг` };
  }

  if (kind === 'sale') {
    const need = {};
    for (const it of p.items) need[it.grade] = Math.round(((need[it.grade] || 0) + it.net_kg) * 1000) / 1000;
    const stock = await stockMap();
    for (const [g, kg] of Object.entries(need)) {
      if (kg > (stock[g] || 0) + 1e-9) throw fail(`Сорт «${g}»: на складе ${stock[g] || 0} кг, а продаётся ${kg} кг`, 409);
    }
    const [{ nid, sid }] = await query(
      `SELECT COALESCE(MAX(id),0)::int + 1 AS nid, COALESCE(MAX(sale_id),0)::int + 1 AS sid FROM movements WHERE device='web'`
    );
    let curId = nid;
    let total = 0;
    for (const it of p.items) {
      const net = Math.round(it.net_kg * 1000) / 1000;
      const amt = Math.round(it.amount * 100) / 100;
      total += amt;
      await query(
        `INSERT INTO movements(device,id,ts,type,grade,gross_kg,tare_kg,net_kg,manual,note,sale_id,customer,price_per_kg,amount,user_name,status,updated_at)
         VALUES('web',$1,(now() at time zone 'Asia/Tashkent')::timestamp,'out',$2,$3,0,$3,true,$4,$5,$6,$7,$8,$9,'active',now())`,
        [curId++, it.grade, net, p.note, sid, p.customer, it.price_per_kg, amt, user.name]
      );
    }
    return { targetDevice: 'web', status: 'applied', result: `продажа #${sid}: ${Math.round(Object.values(need).reduce((a, b) => a + b, 0) * 1000) / 1000} кг на ${Math.round(total * 100) / 100}` };
  }

  if (kind === 'cancel_movement') {
    const m = await findMovement(p.id, p.device);
    if (!m) throw fail('запись не найдена', 404);
    if (m.sale_id) throw fail('это позиция продажи, отмените всю продажу', 400);
    if (m.status !== 'active') throw fail('запись уже отменена', 409);
    if (!canCancel(user, m)) throw fail('отменить может администратор (или вы, в тот же день)', 403);
    if (m.type === 'in') {
      const bal = (await stockMap())[m.grade] || 0;
      if (Number(m.net_kg) > bal + 1e-9) throw fail(`Нельзя отменить: этот товар уже продан или списан (на складе ${bal} кг)`, 409);
    }
    await query(
      `UPDATE movements SET status='cancelled', cancel_reason=$1, cancelled_ts=(now() at time zone 'Asia/Tashkent')::timestamp, updated_at=now()
       WHERE device=$2 AND id=$3`,
      [p.reason, m.device, m.id]
    );
    const synced = m.device === 'web';
    return { targetDevice: m.device, status: synced ? 'applied' : 'pending', result: synced ? `запись #${m.id} отменена` : 'отменено на сайте, ждёт синхронизации со складом' };
  }

  if (kind === 'cancel_sale') {
    const rows = p.device
      ? await query(`SELECT *, to_char(ts,'YYYY-MM-DD') AS day FROM movements WHERE device=$1 AND sale_id=$2`, [p.device, p.id])
      : await query(`SELECT *, to_char(ts,'YYYY-MM-DD') AS day FROM movements WHERE sale_id=$1 ORDER BY updated_at DESC`, [p.id]);
    if (!rows.length) throw fail('продажа не найдена', 404);
    const dev = rows[0].device;
    const same = rows.filter((r) => r.device === dev);
    if (!same.some((r) => r.status === 'active')) throw fail('продажа уже отменена', 409);
    if (!canCancel(user, same[0])) throw fail('отменить может администратор (или вы, в тот же день)', 403);
    await query(
      `UPDATE movements SET status='cancelled', cancel_reason=$1, cancelled_ts=(now() at time zone 'Asia/Tashkent')::timestamp, updated_at=now()
       WHERE device=$2 AND sale_id=$3`,
      [p.reason, dev, p.id]
    );
    const synced = dev === 'web';
    return { targetDevice: dev, status: synced ? 'applied' : 'pending', result: synced ? `продажа #${p.id} отменена` : 'отменено на сайте, ждёт синхронизации со складом' };
  }

  if (kind === 'edit') {
    const m = await findMovement(p.id, p.device);
    if (!m) throw fail('запись не найдена', 404);
    if (m.status !== 'active') throw fail('отменённую запись править нельзя', 409);
    const nextGrade = p.grade !== undefined ? p.grade : m.grade;
    const nextNet = p.net_kg !== undefined ? Math.round(p.net_kg * 1000) / 1000 : Number(m.net_kg);
    const netChanged = nextNet !== Number(m.net_kg);
    const nextGross = netChanged ? Math.round((nextNet + Number(m.tare_kg || 0)) * 1000) / 1000 : m.gross_kg;
    const nextManual = netChanged ? true : m.manual;
    const nextWorker = m.type === 'in' && p.worker !== undefined ? p.worker : m.worker;
    const nextNote = p.note !== undefined ? p.note : m.note;
    const nextPrice = m.type === 'out' && p.price_per_kg !== undefined ? p.price_per_kg : m.price_per_kg;
    const nextAmount = m.type === 'out' && p.amount !== undefined ? Math.round(p.amount * 100) / 100 : m.amount;
    const nextCustomer = m.type === 'out' && p.customer !== undefined ? p.customer : m.customer;

    const changed =
      nextGrade !== m.grade ||
      netChanged ||
      nextWorker !== m.worker ||
      nextNote !== m.note ||
      nextPrice !== m.price_per_kg ||
      nextAmount !== m.amount ||
      nextCustomer !== m.customer;
    if (!changed) throw fail('ничего не изменилось', 400);

    // Проверяем, не уйдёт ли остаток какого-то сорта в минус после правки
    const stock = await stockMap();
    const sign = m.type === 'in' ? 1 : -1;
    stock[m.grade] = Math.round(((stock[m.grade] || 0) - sign * Number(m.net_kg)) * 1000) / 1000;
    stock[nextGrade] = Math.round(((stock[nextGrade] || 0) + sign * nextNet) * 1000) / 1000;
    if (Object.values(stock).some((b) => b < -1e-9)) {
      throw fail('После исправления остаток какого-то сорта стал бы отрицательным', 409);
    }

    await query(
      `UPDATE movements SET grade=$1, gross_kg=$2, net_kg=$3, manual=$4, worker=$5, note=$6, price_per_kg=$7, amount=$8, customer=$9, updated_at=now()
       WHERE device=$10 AND id=$11`,
      [nextGrade, nextGross, nextNet, nextManual, nextWorker, nextNote, nextPrice, nextAmount, nextCustomer, m.device, m.id]
    );
    if (m.type === 'out' && m.sale_id && nextCustomer !== m.customer) {
      await query(`UPDATE movements SET customer=$1, updated_at=now() WHERE device=$2 AND sale_id=$3`, [nextCustomer, m.device, m.sale_id]);
    }
    const synced = m.device === 'web';
    return { targetDevice: m.device, status: synced ? 'applied' : 'pending', result: synced ? `запись #${m.id} исправлена` : 'изменено на сайте, ждёт синхронизации со складом' };
  }

  throw fail('неизвестная операция');
}

module.exports = handler(
  async (req, res) => {
    if (req.method === 'GET') {
      // складовщик видит свои операции, админ все
      const mine = req.user.role === 'admin' ? '' : 'WHERE user_name=$1';
      const rows = await query(
        `SELECT id, to_char(ts at time zone 'Asia/Tashkent','YYYY-MM-DD HH24:MI') AS ts, user_name, kind, payload, status, result
         FROM commands ${mine} ORDER BY id DESC LIMIT 30`,
        mine ? [req.user.name] : []
      );
      return res.status(200).json(rows);
    }
    if (req.method === 'PATCH') {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'только для администратора' });
      const b = req.body || {};
      const rows = b.id
        ? await query(`SELECT * FROM commands WHERE id=$1 AND status='pending'`, [Number(b.id)])
        : await query(`SELECT * FROM commands WHERE status='pending' ORDER BY id LIMIT 50`);
      let appliedCount = 0;
      let rejectedCount = 0;
      for (const c of rows) {
        try {
          const r = await applyInCloud({ name: c.user_name, role: c.user_role }, c.kind, c.payload || {});
          await query(`UPDATE commands SET status='applied', result=$1, done_ts=now() WHERE id=$2`, [r.result, c.id]);
          appliedCount++;
        } catch (e) {
          const msg = e.status ? e.message : 'ошибка применения';
          if (msg === 'ничего не изменилось') {
            await query(`UPDATE commands SET status='applied', result='уже применено', done_ts=now() WHERE id=$1`, [c.id]);
            appliedCount++;
          } else {
            await query(`UPDATE commands SET status='rejected', result=$1, done_ts=now() WHERE id=$2`, [`отклонено: ${msg}`.slice(0, 300), c.id]);
            rejectedCount++;
          }
        }
      }
      await audit(req, req.user.name, 'command_apply', `применено=${appliedCount} отклонено=${rejectedCount}`);
      return res.status(200).json({ ok: true, applied: appliedCount, rejected: rejectedCount });
    }
    const b = req.body || {};
    const kind = String(b.kind || '');
    try {
      if (kind === 'edit' && req.user.role !== 'admin') return res.status(403).json({ error: 'править записи может только администратор' });
      const [dev] = await query('SELECT device, grades FROM devices ORDER BY last_seen DESC LIMIT 1');
      const grades = dev && Array.isArray(dev.grades) ? dev.grades.map(String) : [];
      const payload = clean(kind, b.payload || {}, grades);
      const reqId = b.request_id ? String(b.request_id).slice(0, 64) : null;
      if (reqId) {
        const [dup] = await query('SELECT id FROM commands WHERE req_id=$1', [reqId]);
        if (dup) return res.status(200).json({ ok: true, duplicate: true });
      }
      const [pend] = await query(`SELECT count(*)::int AS n FROM commands WHERE user_name=$1 AND status='pending'`, [req.user.name]);
      if (pend.n >= 20) return res.status(429).json({ error: 'Слишком много операций ждут моноблок. Дождитесь выполнения' });

      const applied = await applyInCloud(req.user, kind, payload);
      const doneSql = applied.status === 'applied' ? 'now()' : 'NULL';
      const ins = await query(
        `INSERT INTO commands (device, user_name, user_role, kind, payload, req_id, status, result, done_ts)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,${doneSql})
         ON CONFLICT (req_id) WHERE req_id IS NOT NULL DO NOTHING RETURNING id`,
        [applied.targetDevice, req.user.name, req.user.role, kind, JSON.stringify(payload), reqId, applied.status, applied.result]
      );
      if (!ins.length) return res.status(200).json({ ok: true, duplicate: true });
      await audit(req, req.user.name, 'command', `#${ins[0].id} ${kind} (${applied.targetDevice})`);
      return res.status(200).json({ ok: true, id: ins[0].id, applied_cloud: true, status: applied.status });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  },
  { method: ['GET', 'POST', 'PATCH'], roles: ['keeper', 'admin'] }
);
