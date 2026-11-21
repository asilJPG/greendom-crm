// Приёмник: сюда моноблок отправляет новые операции. Повторная отправка безопасна (upsert по device+id).
const { query, ensureSchema } = require('../lib/db');
const { requireIngestToken } = require('../lib/auth');
const { logError } = require('../lib/http');
const { getStock, webMovementsSince } = require('../lib/warehouse');
const { sendMany, notifyIntake, notifyIntakeSummary, notifySale, notifySalesSummary } = require('../lib/telegram');

const MAX_SALE_MESSAGES = 8; // больше — одной сводкой (лимиты Telegram и время ответа моноблоку)
const MAX_SINGLE_INTAKES = 3; // больше приходов в пачке — одним сводным сообщением
const TG_BUDGET_MS = Number(process.env.TG_BUDGET_MS) || 7000; // общий бюджет на уведомления: моноблок ждёт ответ не больше 20 с

const TYPES = new Set(['in', 'out', 'writeoff']);
const TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const MAX_KG = 100000;
const MAX_AMOUNT = 1e12;
const MAX_PRICE = 1e9;

// Настоящая календарная дата-время «YYYY-MM-DD HH:MM:SS» (2026-02-30, 25:00 не проходят), год 2020…(текущий+1).
function validTs(v) {
  if (typeof v !== 'string') return null;
  const m = TS.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 2020 || y > new Date().getUTCFullYear() + 1) return null;
  if (h > 23 || mi > 59 || se > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

const empty = (v) => v === null || v === undefined || v === '';
// Число из JSON (или числовая строка); всё остальное — NaN.
const toNum = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);

function cleanMovement(m, i) {
  const bad = (why) => {
    const e = new Error(`операция #${i}${m && Number.isInteger(m.id) ? ` (id ${m.id})` : ''}: ${why}`);
    e.status = 400;
    throw e;
  };
  if (!m || typeof m !== 'object') bad('неверная запись');
  // необязательное число: null/пусто -> null; иначе конечное, >= 0 и <= max
  const optNum = (field, max) => {
    if (empty(m[field])) return null;
    const x = toNum(m[field]);
    if (!Number.isFinite(x) || x < 0 || x > max) bad(`неверное значение ${field} (${String(m[field]).slice(0, 30)})`);
    return x;
  };
  if (!Number.isInteger(m.id)) bad('нет id');
  if (!TYPES.has(m.type)) bad('неизвестный тип (type должен быть in, out или writeoff)');
  if (typeof m.grade !== 'string' || !m.grade.trim()) bad('нет сорта');
  const net = toNum(m.net_kg);
  if (!Number.isFinite(net) || net <= 0 || net > MAX_KG) bad(`неверный вес net_kg (${String(m.net_kg).slice(0, 30)}): нужно больше 0 и не больше ${MAX_KG}`);
  const gross = optNum('gross_kg', MAX_KG);
  const tare = optNum('tare_kg', MAX_KG);
  const price = optNum('price_per_kg', MAX_PRICE);
  const amount = optNum('amount', MAX_AMOUNT);
  const ts = validTs(m.ts);
  if (!ts) bad(`неверное время ts (${String(m.ts).slice(0, 30)})`);
  let cancelledTs = null;
  if (!empty(m.cancelled_ts)) {
    cancelledTs = validTs(m.cancelled_ts);
    if (!cancelledTs) bad(`неверное время cancelled_ts (${String(m.cancelled_ts).slice(0, 30)})`);
  }
  return {
    id: m.id,
    ts,
    type: m.type,
    grade: m.grade.trim().slice(0, 60),
    gross_kg: gross,
    tare_kg: tare,
    net_kg: net,
    manual: Boolean(m.manual),
    worker: String(m.worker || '').slice(0, 120),
    note: String(m.note || '').slice(0, 300),
    sale_id: Number.isInteger(m.sale_id) ? m.sale_id : null,
    customer: m.customer ? String(m.customer).slice(0, 120) : null,
    price_per_kg: price,
    amount,
    user_name: m.user_name ? String(m.user_name).slice(0, 120) : null,
    status: m.status === 'cancelled' ? 'cancelled' : 'active',
    cancel_reason: m.cancel_reason ? String(m.cancel_reason).slice(0, 300) : null,
    cancelled_ts: cancelledTs,
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
    // 'web' — это записи самого сайта; моноблок не может под ним писать (иначе смешается с веб-операциями)
    if (device.toLowerCase() === 'web') return res.status(400).json({ error: 'имя устройства «web» зарезервировано за сайтом' });
    const list = Array.isArray(b.movements) ? b.movements : [];
    if (list.length > 500) return res.status(400).json({ error: 'слишком много операций за раз (максимум 500)' });
    const rows = list.map(cleanMovement);

    await ensureSchema();
    // Сорта, переименованные на сайте: старое имя от моноблока переводим в новое (пока моноблок не переименует у себя).
    const aliasRows = await query(
      `SELECT old_name, new_name FROM grade_aliases a WHERE NOT EXISTS (SELECT 1 FROM grades g WHERE g.name = a.old_name) ORDER BY ts`
    );
    const alias = new Map(aliasRows.map((a) => [a.old_name, a.new_name]));
    for (const r of rows) if (alias.has(r.grade)) r.grade = alias.get(r.grade);

    // Ответы моноблока на команды с сайта (повтор безопасен: меняем только незавершённые).
    const acks = Array.isArray(b.acks) ? b.acks.slice(0, 100) : [];
    for (const a of acks) {
      if (!Number.isInteger(a.id) || !['applied', 'rejected'].includes(a.status)) continue;
      await query(
        `UPDATE commands SET status=$1, result=$2, done_ts=now() WHERE id=$3 AND device=$4 AND status IN ('pending','expired')`,
        [a.status, String(a.result || '').slice(0, 300), a.id, device]
      );
    }

    let newRows = [];
    let knownSales = new Set();
    if (rows.length) {
      const existing = await query(
        `SELECT id, sale_id FROM movements WHERE device=$1 AND (id = ANY($2::int[]) OR sale_id = ANY($3::int[]))`,
        [device, rows.map((r) => r.id), rows.filter((r) => r.sale_id).map((r) => r.sale_id)]
      );
      const existingIds = new Set(existing.map((e) => e.id));
      knownSales = new Set(existing.filter((e) => e.sale_id).map((e) => e.sale_id));
      newRows = rows.filter((r) => !existingIds.has(r.id) && r.status === 'active' && (r.type === 'in' || r.type === 'out'));

      // Записи моноблока — его собственные: облако их не правит (правки с сайта идут командами), поэтому принимаем как есть.
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
              cancel_reason=EXCLUDED.cancel_reason, cancelled_ts=EXCLUDED.cancelled_ts, updated_at=now()`,
        [device, JSON.stringify(rows)]
      );
      // Автоматически пополняем справочник покупателей из поступивших продаж
      const names = [...new Set(rows.map((r) => (r.customer || '').trim()).filter(Boolean))];
      if (names.length) {
        await query(`INSERT INTO customers(name) SELECT DISTINCT unnest($1::text[]) ON CONFLICT DO NOTHING`, [names]);
      }
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

    // Команды ждут моноблок; через 30 дней без ответа — expired. Облако их не применяло, поэтому откатывать нечего.
    await query(`UPDATE commands SET status='expired', result='не синхронизирована за 30 дней: моноблок не выходил на связь', done_ts=now()
                 WHERE device=$1 AND status='pending' AND ts < now() - interval '30 days'`, [device]);
    const commands = await query(
      `SELECT id, kind, payload, user_name, user_role FROM commands WHERE device=$1 AND status='pending' ORDER BY id LIMIT 20`,
      [device]
    );

    const out = { ok: true, accepted: rows.length, commands };
    // Справочник сортов сайта и переименования — моноблок добавит недостающие и переименует свои записи.
    const gradeRows = await query(`SELECT name FROM grades WHERE active ORDER BY sort_order, id`);
    out.grades = gradeRows.map((g) => g.name);
    out.grade_aliases = aliasRows.map((a) => ({ old: a.old_name, new: a.new_name }));
    // Зеркало веб-операций: только если моноблок его поддерживает (присылает web_cursor; пустая строка = с начала).
    if (b.web_cursor !== undefined && b.web_cursor !== null) {
      const mirror = await webMovementsSince(String(b.web_cursor));
      out.web_movements = mirror.rows;
      out.web_cursor = mirror.cursor;
      out.web_more = mirror.more;
    }

    // Telegram: только новые приходы и продажи; продажа — одним сообщением, только если раньше её строк не было.
    if (newRows.length) {
      const cur = b.currency ? String(b.currency).slice(0, 20) : 'сум';
      const { byGrade } = await getStock().catch(() => ({ byGrade: {} }));
      const jobs = [];
      const intakes = newRows.filter((r) => r.type === 'in');
      if (intakes.length > MAX_SINGLE_INTAKES) {
        jobs.push((o) => notifyIntakeSummary({ rows: intakes, balances: byGrade, source: device }, o));
      } else {
        for (const r of intakes) {
          jobs.push((o) => notifyIntake({ grade: r.grade, net_kg: r.net_kg, balance_kg: byGrade[r.grade], user_name: r.user_name || '', note: r.note || '', source: device }, o));
        }
      }
      const salesMap = new Map();
      for (const r of newRows.filter((x) => x.type === 'out')) {
        if (r.sale_id && knownSales.has(r.sale_id)) continue; // продажа уже была (частично) принята раньше — сообщение уже ушло
        const key = r.sale_id ? `s:${r.sale_id}` : `m:${r.id}`;
        if (!salesMap.has(key)) {
          salesMap.set(key, { sale_id: r.sale_id || r.id, customer: r.customer || '—', user_name: r.user_name || '', note: r.note || '', items: [], total_kg: 0, total_amount: 0 });
        }
        const s = salesMap.get(key);
        s.items.push({ grade: r.grade, net_kg: r.net_kg, price_per_kg: r.price_per_kg, amount: r.amount });
        s.total_kg = Math.round((s.total_kg + Number(r.net_kg || 0)) * 1000) / 1000;
        s.total_amount = Math.round((s.total_amount + Number(r.amount || 0)) * 100) / 100;
      }
      const sales = [...salesMap.values()];
      for (const s of sales.slice(0, MAX_SALE_MESSAGES)) jobs.push((o) => notifySale({ ...s, currency: cur, source: device }, o));
      if (sales.length > MAX_SALE_MESSAGES) {
        const rest = sales.slice(MAX_SALE_MESSAGES);
        jobs.push((o) => notifySalesSummary({ sales: rest, currency: cur, source: device }, o));
      }
      await sendMany(jobs, TG_BUDGET_MS);
    }

    res.status(200).json(out);
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    logError('ingest', e);
    res.status(500).json({ error: 'внутренняя ошибка' });
  }
};
