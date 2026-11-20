const { query } = require('../lib/db');
const { handler } = require('../lib/http');

module.exports = handler(async (req, res) => {
  const { type = '', day = '' } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const where = [];
  const params = [];
  if (['in', 'out', 'writeoff'].includes(type)) {
    params.push(type);
    where.push(`type=$${params.length}`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    params.push(day);
    where.push(`ts::date=$${params.length}::date`);
  }
  params.push(limit);
  const rows = await query(
    `SELECT device, id, to_char(ts,'YYYY-MM-DD HH24:MI:SS') AS ts, type, grade, net_kg, manual, worker, note,
            customer, price_per_kg, amount, user_name, status, cancel_reason
     FROM movements ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ts DESC, id DESC LIMIT $${params.length}`,
    params
  );
  res.status(200).json(rows);
});
