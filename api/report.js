const { query } = require('../lib/db');
const { handler, dateRange } = require('../lib/http');

const R3 = (e) => `ROUND(${e}::numeric,3)::float8`;
const R2 = (e) => `ROUND(${e}::numeric,2)::float8`;

module.exports = handler(async (req, res) => {
  const [from, to] = dateRange(req.query.from, req.query.to);
  const p = [from, to];
  const W = `status='active' AND ts::date BETWEEN $1::date AND $2::date`;

  const [by_grade, by_day, by_worker, by_customer, [manual], [cancelled]] = await Promise.all([
    query(
      `SELECT grade,
         ${R3(`SUM(CASE WHEN type='in' THEN net_kg ELSE 0 END)`)} AS in_kg,
         ${R3(`SUM(CASE WHEN type='out' THEN net_kg ELSE 0 END)`)} AS out_kg,
         ${R3(`SUM(CASE WHEN type='writeoff' THEN net_kg ELSE 0 END)`)} AS writeoff_kg,
         ${R2(`COALESCE(SUM(CASE WHEN type='out' THEN amount END),0)`)} AS amount
       FROM movements WHERE ${W} GROUP BY grade ORDER BY grade`, p),
    query(
      `SELECT to_char(ts::date,'YYYY-MM-DD') AS day,
         ${R3(`SUM(CASE WHEN type='in' THEN net_kg ELSE 0 END)`)} AS in_kg,
         ${R3(`SUM(CASE WHEN type='out' THEN net_kg ELSE 0 END)`)} AS out_kg,
         ${R2(`COALESCE(SUM(CASE WHEN type='out' THEN amount END),0)`)} AS amount
       FROM movements WHERE ${W} GROUP BY ts::date ORDER BY ts::date`, p),
    query(
      `SELECT COALESCE(NULLIF(worker,''),'(не указан)') AS worker, count(*)::int AS crates, ${R3('SUM(net_kg)')} AS kg
       FROM movements WHERE type='in' AND ${W} GROUP BY 1 ORDER BY kg DESC`, p),
    query(
      `SELECT customer, ${R3('SUM(net_kg)')} AS kg, ${R2('COALESCE(SUM(amount),0)')} AS amount
       FROM movements WHERE type='out' AND customer IS NOT NULL AND ${W} GROUP BY customer ORDER BY amount DESC`, p),
    query(`SELECT count(*)::int AS n FROM movements WHERE manual AND ${W}`, p),
    query(`SELECT count(*)::int AS n FROM movements WHERE status='cancelled' AND ts::date BETWEEN $1::date AND $2::date`, p),
  ]);
  res.status(200).json({
    from, to, by_grade, by_day, by_worker, by_customer,
    manual_entries: manual.n, cancelled_entries: cancelled.n,
  });
});
