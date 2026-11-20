// Контроллер операций с сайта: тонкий слой поверх доменного сервиса lib/warehouse.js.
const { query } = require('../lib/db');
const { handler, TZ } = require('../lib/http');
const { audit } = require('../lib/auth');
const { cleanPayload, applyOperation } = require('../lib/warehouse');

module.exports = handler(
  async (req, res) => {
    if (req.method === 'GET') {
      const mine = req.user.role === 'admin' ? '' : 'WHERE user_name=$2';
      const rows = await query(
        `SELECT id, to_char(ts at time zone $1,'YYYY-MM-DD HH24:MI') AS ts, user_name, kind, payload, status, result
         FROM commands ${mine} ORDER BY id DESC LIMIT 30`,
        mine ? [TZ, req.user.name] : [TZ]
      );
      return res.status(200).json(rows);
    }

    if (req.method === 'PATCH') {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'только для администратора' });
      const b = req.body || {};
      const rows = b.id
        ? await query(`SELECT * FROM commands WHERE id=$1 AND status='pending'`, [Number(b.id)])
        : await query(`SELECT * FROM commands WHERE status='pending' ORDER BY id LIMIT 50`);
      let applied = 0;
      let rejected = 0;
      for (const c of rows) {
        try {
          const r = await applyOperation({ name: c.user_name, role: c.user_role }, c.kind, c.payload || {});
          await query(`UPDATE commands SET status='applied', result=$1, done_ts=now() WHERE id=$2`, [r.result, c.id]);
          applied++;
        } catch (e) {
          const msg = e.status ? e.message : 'ошибка применения';
          if (msg === 'ничего не изменилось') {
            await query(`UPDATE commands SET status='applied', result='уже применено', done_ts=now() WHERE id=$1`, [c.id]);
            applied++;
          } else {
            await query(`UPDATE commands SET status='rejected', result=$1, done_ts=now() WHERE id=$2`, [`отклонено: ${msg}`.slice(0, 300), c.id]);
            rejected++;
          }
        }
      }
      await audit(req, req.user.name, 'command_apply', `применено=${applied} отклонено=${rejected}`);
      return res.status(200).json({ ok: true, applied, rejected });
    }

    const b = req.body || {};
    const kind = String(b.kind || '');
    if (kind === 'edit' && req.user.role !== 'admin') return res.status(403).json({ error: 'править записи может только администратор' });

    const gradeRows = await query('SELECT name FROM grades WHERE active ORDER BY sort_order, id');
    const grades = gradeRows.map((g) => g.name);
    const payload = cleanPayload(kind, b.payload || {}, grades);
    const reqId = b.request_id ? String(b.request_id).slice(0, 64) : null;
    if (reqId) {
      const [dup] = await query('SELECT id FROM commands WHERE req_id=$1', [reqId]);
      if (dup) return res.status(200).json({ ok: true, duplicate: true });
    }
    const [pend] = await query(`SELECT count(*)::int AS n FROM commands WHERE user_name=$1 AND status='pending'`, [req.user.name]);
    if (pend.n >= 20) return res.status(429).json({ error: 'Слишком много операций ждут моноблок. Дождитесь выполнения' });

    const applied = await applyOperation(req.user, kind, payload);
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
  },
  { method: ['GET', 'POST', 'PATCH'], roles: ['keeper', 'admin'] }
);
