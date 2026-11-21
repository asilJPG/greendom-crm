const { query } = require('../lib/db');
const { handler, isValidDate, fail } = require('../lib/http');

// История движений. Фильтры: type, day, а для накладной — sale_id (+ device): все строки одной продажи.
module.exports = handler(async (req, res) => {
  const { type = '', day = '' } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const where = [];
  const params = [];
  if (['in', 'out', 'writeoff'].includes(type)) {
    params.push(type);
    where.push(`type=$${params.length}`);
  }
  if (day) {
    if (!isValidDate(day)) throw fail('Неверная дата');
    params.push(day);
    where.push(`ts::date=$${params.length}::date`);
  }
  const device = String(req.query.device || '').trim();
  if (device) {
    if (device.length > 100) throw fail('Неверное устройство');
    params.push(device);
    where.push(`device=$${params.length}`);
  }
  const saleRaw = req.query.sale_id;
  const bySale = saleRaw !== undefined && saleRaw !== '';
  if (bySale) {
    const saleId = Number(saleRaw);
    if (!Number.isInteger(saleId) || saleId < 1 || saleId > 2147483647) throw fail('Неверный номер продажи');
    params.push(saleId);
    // как в отчёте: у продажи без sale_id номером служит id первой строки
    where.push(`type='out' AND COALESCE(sale_id, id)=$${params.length}`);
  }
  params.push(bySale ? 500 : limit);
  const rows = await query(
    `SELECT device, id, sale_id, to_char(ts,'YYYY-MM-DD HH24:MI:SS') AS ts, type, grade, gross_kg, tare_kg, net_kg, manual, worker, note,
            customer, price_per_kg, amount, user_name, status, cancel_reason
     FROM movements ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${bySale ? 'device, id' : 'ts DESC, id DESC'} LIMIT $${params.length}`,
    params
  );
  res.status(200).json(rows);
});
