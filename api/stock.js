const { query } = require('../lib/db');
const { handler } = require('../lib/http');

module.exports = handler(async (req, res) => {
  const [dev] = await query(`SELECT grades FROM devices WHERE grades IS NOT NULL ORDER BY last_seen DESC LIMIT 1`);
  const order = (dev && Array.isArray(dev.grades) ? dev.grades : []).map(String);
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
  res.status(200).json({ rows: out, total_kg: Math.round(out.reduce((a, r) => a + r.balance_kg, 0) * 1000) / 1000 });
});
