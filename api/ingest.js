// Приёмник: сюда моноблок отправляет новые операции. Повторная отправка безопасна (upsert по device+id).
const { query, ensureSchema } = require('../lib/db');
const { requireIngestToken } = require('../lib/auth');
const { getStock } = require('../lib/warehouse');
const { notifyIntake, notifySale } = require('../lib/telegram');

const TYPES = new Set(['in', 'out', 'writeoff']);
const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function cleanMovement(m, i) {
  const bad = (why) => {
    const e = new Error(`операция #${i}: ${why}`);
    e.status = 400;
    throw e;
  };
  if (!Number.isInteger(m.id)) bad('нет id');
  if (!TYPES.has(m.type)) bad('неизвестный тип');
  if (typeof m.grade !== 'string' || !m.grade.trim()) bad('нет сорта');
  if (!Number.isFinite(Number(m.net_kg))) bad('неверный вес');
  if (typeof m.ts !== 'string' || !TS.test(m.ts)) bad('неверное время');
  return {
    id: m.id,
    ts: m.ts.replace('T', ' ').slice(0, 19),
    type: m.type,
    grade: m.grade.trim().slice(0, 60),
    gross_kg: numOrNull(m.gross_kg),
    tare_kg: numOrNull(m.tare_kg),
    net_kg: Number(m.net_kg),
    manual: Boolean(m.manual),
    worker: String(m.worker || '').slice(0, 120),
    note: String(m.note || '').slice(0, 300),
    sale_id: Number.isInteger(m.sale_id) ? m.sale_id : null,
    customer: m.customer ? String(m.customer).slice(0, 120) : null,
    price_per_kg: numOrNull(m.price_per_kg),
    amount: numOrNull(m.amount),
    user_name: m.user_name ? String(m.user_name).slice(0, 120) : null,
    status: m.status === 'cancelled' ? 'cancelled' : 'active',
    cancel_reason: m.cancel_reason ? String(m.cancel_reason).slice(0, 300) : null,
    cancelled_ts: m.cancelled_ts && TS.test(m.cancelled_ts) ? m.cancelled_ts.slice(0, 19) : null,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });
  if (!requireIngestToken(req, res)) return;
  try {
    const b = req.body || {};
    // Диагностическая тестовая отправка в Telegram (без записи в БД)
    if (b.test_tg === true) {
      const rIn = await notifyIntake({
        grade: 'Высший',
        net_kg: 1.0,
        balance_kg: 10.0,
        user_name: 'ТЕСТ',
        note: 'Это тестовое сообщение (приход)',
        source: 'ТЕСТ',
      });
      const rOut = await notifySale({
        sale_id: 'ТЕСТ',
        customer: 'ТЕСТ (проверка бота)',
        items: [{ grade: 'Высший', net_kg: 1.0, price_per_kg: 150000, amount: 150000 }],
        total_kg: 1.0,
        total_amount: 150000,
        currency: 'сум',
        user_name: 'ТЕСТ',
        note: 'Это тестовое сообщение (продажа)',
        source: 'ТЕСТ',
      });
      return res.status(200).json({ ok: rIn.ok && rOut.ok, intake: rIn, sale: rOut });
    }
    const device = String(b.device || '').trim();
    if (!device || device.length > 64) return res.status(400).json({ error: 'не указано устройство' });
    const list = Array.isArray(b.movements) ? b.movements : [];
    if (list.length > 500) return res.status(400).json({ error: 'слишком много операций за раз (максимум 500)' });
    const rows = list.map(cleanMovement);

    await ensureSchema();
    // Сначала фиксируем ответы моноблока на операции с сайта (повтор безопасен: меняем только незавершённые).
    // Это важно сделать ДО записи movements: подтверждённая команда снимает защиту с этой строки.
    const acks = Array.isArray(b.acks) ? b.acks.slice(0, 100) : [];
    for (const a of acks) {
      if (!Number.isInteger(a.id) || !['applied', 'rejected'].includes(a.status)) continue;
      await query(
        `UPDATE commands SET status=$1, result=$2, done_ts=now() WHERE id=$3 AND device=$4 AND status IN ('pending','expired')`,
        [a.status, String(a.result || '').slice(0, 300), a.id, device]
      );
    }

    let newRows = [];
    if (rows.length) {
      const existing = await query(
        `SELECT id FROM movements WHERE device=$1 AND id = ANY($2::int[])`,
        [device, rows.map((r) => r.id)]
      );
      const existingIds = new Set(existing.map((e) => e.id));
      newRows = rows.filter((r) => !existingIds.has(r.id) && r.status === 'active' && (r.type === 'in' || r.type === 'out'));

      await query(
        `INSERT INTO movements (device,id,ts,type,grade,gross_kg,tare_kg,net_kg,manual,worker,note,sale_id,customer,
                                price_per_kg,amount,user_name,status,cancel_reason,cancelled_ts,updated_at)
         SELECT $1, x.id, x.ts, x.type, x.grade, x.gross_kg, x.tare_kg, x.net_kg, x.manual, x.worker, x.note, x.sale_id,
                x.customer, x.price_per_kg, x.amount, x.user_name, x.status, x.cancel_reason, x.cancelled_ts, now()
         FROM jsonb_to_recordset($2::jsonb) AS x(id integer, ts timestamp, type text, grade text, gross_kg double precision,
              tare_kg double precision, net_kg double precision, manual boolean, worker text, note text, sale_id integer,
              customer text, price_per_kg double precision, amount double precision, user_name text, status text,
              cancel_reason text, cancelled_ts timestamp)
         ON CONFLICT (device,id) DO UPDATE SET
              ts=EXCLUDED.ts, type=EXCLUDED.type, grade=EXCLUDED.grade, gross_kg=EXCLUDED.gross_kg, tare_kg=EXCLUDED.tare_kg,
              net_kg=EXCLUDED.net_kg, manual=EXCLUDED.manual, worker=EXCLUDED.worker, note=EXCLUDED.note,
              sale_id=EXCLUDED.sale_id, customer=EXCLUDED.customer, price_per_kg=EXCLUDED.price_per_kg,
              amount=EXCLUDED.amount, user_name=EXCLUDED.user_name, status=EXCLUDED.status,
              cancel_reason=EXCLUDED.cancel_reason, cancelled_ts=EXCLUDED.cancelled_ts, updated_at=now()
         WHERE NOT EXISTS (
              SELECT 1 FROM commands c
              WHERE c.device = movements.device AND c.status = 'pending'
                AND ((c.kind IN ('edit','cancel_movement') AND (c.payload->>'id')::int = movements.id)
                  OR (c.kind = 'cancel_sale' AND movements.sale_id IS NOT NULL AND (c.payload->>'id')::int = movements.sale_id))
         )`,
        [device, JSON.stringify(rows)]
      );
      // Автоматически пополняем справочник покупателей из поступивших продаж
      await query(
        `INSERT INTO customers(name)
         SELECT DISTINCT trim(customer) FROM movements
         WHERE device=$1 AND customer IS NOT NULL AND trim(customer) <> ''
         ON CONFLICT DO NOTHING`,
        [device]
      );
    }
    await query(
      `INSERT INTO devices (device,last_seen,crop,currency,grades,pending) VALUES ($1, now(), $2, $3, $4::jsonb, $5)
       ON CONFLICT (device) DO UPDATE SET last_seen=now(), crop=EXCLUDED.crop, currency=EXCLUDED.currency,
            grades=EXCLUDED.grades, pending=EXCLUDED.pending`,
      [
        device,
        b.crop ? String(b.crop).slice(0, 60) : null,
        b.currency ? String(b.currency).slice(0, 20) : null,
        JSON.stringify(Array.isArray(b.grades) ? b.grades.map(String).slice(0, 30) : []),
        Number.isInteger(b.pending) ? b.pending : 0,
      ]
    );

    // операции, которые ждут синхронизации с моноблоком; просрочка только через 30 дней
    await query(`UPDATE commands SET status='expired', result='не синхронизирована за 30 дней: моноблок не выходил на связь', done_ts=now()
                 WHERE device=$1 AND status='pending' AND ts < now() - interval '30 days'`, [device]);
    const commands = await query(
      `SELECT id, kind, payload, user_name, user_role FROM commands WHERE device=$1 AND status='pending' ORDER BY id LIMIT 20`,
      [device]
    );

    // Отправляем в Telegram только новые операции прихода и продажи с моноблока
    if (newRows.length) {
      const cur = b.currency ? String(b.currency).slice(0, 20) : 'сум';
      const { byGrade } = await getStock().catch(() => ({ byGrade: {} }));
      const intakes = newRows.filter((r) => r.type === 'in').slice(0, 10);
      for (const r of intakes) {
        await notifyIntake({
          grade: r.grade,
          net_kg: r.net_kg,
          balance_kg: byGrade[r.grade],
          user_name: r.user_name || '',
          note: r.note || '',
          source: device,
        });
      }
      const salesMap = new Map();
      for (const r of newRows.filter((x) => x.type === 'out')) {
        const key = r.sale_id ? `s:${r.sale_id}` : `m:${r.id}`;
        if (!salesMap.has(key)) {
          salesMap.set(key, {
            sale_id: r.sale_id || r.id,
            customer: r.customer || '—',
            user_name: r.user_name || '',
            note: r.note || '',
            items: [],
            total_kg: 0,
            total_amount: 0,
          });
        }
        const s = salesMap.get(key);
        s.items.push({ grade: r.grade, net_kg: r.net_kg, price_per_kg: r.price_per_kg, amount: r.amount });
        s.total_kg = Math.round((s.total_kg + Number(r.net_kg || 0)) * 1000) / 1000;
        s.total_amount = Math.round((s.total_amount + Number(r.amount || 0)) * 100) / 100;
      }
      for (const s of [...salesMap.values()].slice(0, 10)) {
        await notifySale({ ...s, currency: cur, source: device });
      }
    }

    res.status(200).json({ ok: true, accepted: rows.length, commands });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'внутренняя ошибка' });
  }
};
