// Контроллер операций с сайта: тонкий слой поверх доменного сервиса lib/warehouse.js.
// Ответ POST: { ok, id, status: 'applied' | 'pending', result } или { ok, duplicate: true }.
const { query } = require('../lib/db');
const { handler, TZ, logError } = require('../lib/http');
const { audit } = require('../lib/auth');
const { cleanPayload, submitOperation, applyStalePending, pendingCount, getStock, PENDING_LIMIT } = require('../lib/warehouse');
const { notifyIntake, notifySale } = require('../lib/telegram');

module.exports = handler(
  async (req, res) => {
    if (req.method === 'GET') {
      const mine = req.user.role === 'admin' ? '' : 'WHERE user_name=$2';
      const rows = await query(
        `SELECT id, to_char(ts at time zone $1,'YYYY-MM-DD HH24:MI') AS ts, device, user_name, kind, payload, status, result
         FROM commands ${mine} ORDER BY id DESC LIMIT 30`,
        mine ? [TZ, req.user.name] : [TZ]
      );
      return res.status(200).json(rows);
    }

    if (req.method === 'PATCH') {
      // Применить в облаке зависшие команды — только для моноблоков, которые не выходили на связь больше суток.
      // Команды для активных моноблоков не трогаем: их применит (или отклонит) сам моноблок.
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'только для администратора' });
      const b = req.body || {};
      const id = b.id ? Number(b.id) : null;
      if (b.id && !Number.isInteger(id)) return res.status(400).json({ error: 'неверный номер команды' });
      const r = await applyStalePending(id);
      await audit(req, req.user.name, 'command_apply', `применено=${r.applied} отклонено=${r.rejected} пропущено=${r.skipped}`);
      return res.status(200).json({ ok: true, ...r });
    }

    const b = req.body || {};
    const kind = String(b.kind || '');
    if (kind === 'edit' && req.user.role !== 'admin') return res.status(403).json({ error: 'править записи может только администратор' });

    const gradeRows = await query('SELECT name FROM grades WHERE active ORDER BY sort_order, id');
    const payload = cleanPayload(kind, b.payload || {}, gradeRows.map((g) => g.name));
    const reqId = b.request_id ? String(b.request_id).slice(0, 64) : null;
    if ((await pendingCount(req.user.name)) >= PENDING_LIMIT) {
      return res.status(429).json({ error: 'Слишком много операций ждут моноблок. Дождитесь выполнения' });
    }

    const r = await submitOperation(req.user, kind, payload, reqId);
    if (r.duplicate) return res.status(200).json({ ok: true, duplicate: true, id: r.id, status: r.status, result: r.result });
    await audit(req, req.user.name, 'command', `#${r.id} ${kind} (${r.targetDevice}) ${r.status}`);

    // Уведомление в Telegram-группу о приходе и продаже (не ломает операцию при сбое сети)
    try {
      if (kind === 'intake') {
        const { byGrade } = await getStock().catch(() => ({ byGrade: {} }));
        await notifyIntake({ grade: payload.grade, net_kg: payload.net_kg, balance_kg: byGrade[payload.grade], user_name: req.user.name, note: payload.note });
      } else if (kind === 'sale') {
        const [dev] = await query(`SELECT currency FROM devices ORDER BY last_seen DESC LIMIT 1`).catch(() => []);
        await notifySale({
          sale_id: r.sale_id,
          customer: payload.customer,
          items: payload.items,
          total_kg: r.total_kg,
          total_amount: r.total_amount,
          currency: dev?.currency || 'сум',
          user_name: req.user.name,
          note: payload.note,
        });
      }
    } catch (e) {
      logError('telegram', e);
    }

    return res.status(200).json({ ok: true, id: r.id, status: r.status, result: r.result, applied_cloud: r.status === 'applied' });
  },
  { method: ['GET', 'POST', 'PATCH'], roles: ['keeper', 'admin'] }
);
