const { query } = require('../lib/db');
const { handler, dateRange } = require('../lib/http');
const { handleExpenses } = require('../lib/expenses');

const R3 = (e) => `ROUND(${e}::numeric,3)::float8`;
const R2 = (e) => `ROUND(${e}::numeric,2)::float8`;
const r3 = (v) => Math.round(Number(v || 0) * 1000) / 1000;
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

function prevPeriod(from, to) {
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  const days = Math.max(1, Math.round((t - f) / 86400000) + 1);
  const pf = new Date(f.getTime() - days * 86400000);
  const pt = new Date(f.getTime() - 86400000);
  return [pf.toISOString().slice(0, 10), pt.toISOString().slice(0, 10)];
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = handler(async (req, res) => {
  if (req.query.resource === 'expenses') return handleExpenses(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'только GET' });

  const [from, to] = dateRange(req.query.from, req.query.to);
  const [pFrom, pTo] = prevPeriod(from, to);
  const grade = String(req.query.grade || '').trim();
  const customer = String(req.query.customer || '').trim();

  // Экспорт в Excel (CSV с UTF-8 BOM и разделителем «;»)
  if (req.query.format === 'csv') {
    const conds = [`ts::date BETWEEN $1::date AND $2::date`];
    const args = [from, to];
    if (grade) { args.push(grade); conds.push(`grade=$${args.length}`); }
    if (customer) { args.push(customer); conds.push(`customer=$${args.length}`); }
    const rows = await query(
      `SELECT device, id, to_char(ts,'YYYY-MM-DD HH24:MI:SS') AS ts, type, grade, gross_kg, tare_kg, net_kg,
              manual, worker, customer, price_per_kg, amount, user_name, note, status, cancel_reason
       FROM movements WHERE ${conds.join(' AND ')} ORDER BY ts, id`,
      args
    );
    const names = { in: 'приход', out: 'продажа', writeoff: 'списание' };
    const num = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));
    const head = ['устройство', 'id', 'время', 'операция', 'сорт', 'брутто, кг', 'тара, кг', 'нетто, кг', 'вручную', 'работник', 'покупатель', 'цена за кг', 'сумма', 'сотрудник', 'примечание', 'статус', 'причина отмены'];
    const lines = [head.map(csvCell).join(';')];
    for (const x of rows) {
      lines.push([
        x.device, x.id, x.ts, names[x.type] || x.type, x.grade, num(x.gross_kg), num(x.tare_kg), num(x.net_kg),
        x.manual ? 'да' : '', x.worker || '', x.customer || '', num(x.price_per_kg), num(x.amount),
        x.user_name || '', x.note || '', x.status === 'active' ? 'активна' : 'отменена', x.cancel_reason || '',
      ].map(csvCell).join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="otchet_${from}_${to}.csv"`);
    return res.status(200).end('\uFEFF' + lines.join('\r\n'));
  }

  // Общие фильтры для основного и предыдущего периодов
  const makeWhere = (startIdx) => {
    const conds = [`status='active'`, `ts::date BETWEEN $${startIdx}::date AND $${startIdx + 1}::date`];
    const params = [];
    let idx = startIdx + 2;
    if (grade) { conds.push(`grade=$${idx++}`); params.push(grade); }
    if (customer) { conds.push(`customer=$${idx++}`); params.push(customer); }
    return { sql: conds.join(' AND '), extra: params };
  };

  const curW = makeWhere(1);
  const p = [from, to, ...curW.extra];
  const prevW = makeWhere(1);
  const pp = [pFrom, pTo, ...prevW.extra];

  const [by_grade, by_day, by_worker, by_customer, [manual], [cancelled], [prevRow], saleRows, filterGrades, filterCustomers, expByCat, [prevExpRow]] = await Promise.all([
    query(
      `SELECT grade,
         ${R3(`SUM(CASE WHEN type='in' THEN net_kg ELSE 0 END)`)} AS in_kg,
         ${R3(`SUM(CASE WHEN type='out' THEN net_kg ELSE 0 END)`)} AS out_kg,
         ${R3(`SUM(CASE WHEN type='writeoff' THEN net_kg ELSE 0 END)`)} AS writeoff_kg,
         ${R2(`COALESCE(SUM(CASE WHEN type='out' THEN amount END),0)`)} AS amount
       FROM movements WHERE ${curW.sql} GROUP BY grade ORDER BY amount DESC, in_kg DESC`, p),
    query(
      `SELECT to_char(ts::date,'YYYY-MM-DD') AS day,
         ${R3(`SUM(CASE WHEN type='in' THEN net_kg ELSE 0 END)`)} AS in_kg,
         ${R3(`SUM(CASE WHEN type='out' THEN net_kg ELSE 0 END)`)} AS out_kg,
         ${R3(`SUM(CASE WHEN type='writeoff' THEN net_kg ELSE 0 END)`)} AS writeoff_kg,
         ${R2(`COALESCE(SUM(CASE WHEN type='out' THEN amount END),0)`)} AS amount
       FROM movements WHERE ${curW.sql} GROUP BY ts::date ORDER BY ts::date`, p),
    query(
      `SELECT COALESCE(NULLIF(worker,''),'(не указан)') AS worker, count(*)::int AS crates, ${R3('SUM(net_kg)')} AS kg
       FROM movements WHERE type='in' AND ${curW.sql} GROUP BY 1 ORDER BY kg DESC`, p),
    query(
      `SELECT customer, count(DISTINCT (device, COALESCE(sale_id, id)))::int AS sales_count,
         ${R3('SUM(net_kg)')} AS kg, ${R2('COALESCE(SUM(amount),0)')} AS amount
       FROM movements WHERE type='out' AND customer IS NOT NULL AND ${curW.sql} GROUP BY customer ORDER BY amount DESC`, p),
    query(`SELECT count(*)::int AS n FROM movements WHERE manual AND ${curW.sql}`, p),
    query(`SELECT count(*)::int AS n FROM movements WHERE status='cancelled' AND ts::date BETWEEN $1::date AND $2::date`, [from, to]),
    query(
      `SELECT
         ${R3(`COALESCE(SUM(CASE WHEN type='in' THEN net_kg END),0)`)} AS in_kg,
         ${R3(`COALESCE(SUM(CASE WHEN type='out' THEN net_kg END),0)`)} AS out_kg,
         ${R3(`COALESCE(SUM(CASE WHEN type='writeoff' THEN net_kg END),0)`)} AS writeoff_kg,
         ${R3(`COALESCE(SUM(CASE WHEN type='in' AND lower(grade) LIKE '%брак%' THEN net_kg END),0)`)} AS brak_kg,
         ${R2(`COALESCE(SUM(CASE WHEN type='out' THEN amount END),0)`)} AS amount
       FROM movements WHERE ${prevW.sql}`, pp),
    query(
      `SELECT device, id, sale_id, to_char(ts,'YYYY-MM-DD HH24:MI') AS ts, grade, gross_kg, tare_kg, net_kg,
              customer, price_per_kg, amount, user_name, note
       FROM movements WHERE type='out' AND ${curW.sql} ORDER BY ts DESC, id DESC LIMIT 300`, p),
    query(`SELECT DISTINCT grade FROM movements ORDER BY grade`),
    query(`SELECT DISTINCT customer FROM movements WHERE customer IS NOT NULL AND customer <> '' ORDER BY customer`),
    query(
      `SELECT c.name AS category, count(*)::int AS acts, ${R2('COALESCE(SUM(e.amount),0)')} AS amount
       FROM expenses e JOIN expense_categories c ON c.id=e.category_id
       WHERE e.status='active' AND e.doc_date BETWEEN $1::date AND $2::date
       GROUP BY c.name ORDER BY amount DESC`,
      [from, to]
    ),
    query(
      `SELECT ${R2('COALESCE(SUM(amount),0)')} AS amount FROM expenses
       WHERE status='active' AND doc_date BETWEEN $1::date AND $2::date`,
      [pFrom, pTo]
    ),
  ]);

  const totalIn = r3(by_grade.reduce((a, x) => a + x.in_kg, 0));
  const totalOut = r3(by_grade.reduce((a, x) => a + x.out_kg, 0));
  const totalWo = r3(by_grade.reduce((a, x) => a + x.writeoff_kg, 0));
  const totalAmt = r2(by_grade.reduce((a, x) => a + x.amount, 0));
  const brakIn = r3(by_grade.filter((x) => /брак/i.test(x.grade)).reduce((a, x) => a + x.in_kg, 0));
  const lossKg = r3(totalWo + brakIn);
  const lossPct = totalIn > 0 ? Math.round((lossKg / totalIn) * 1000) / 10 : 0;

  const enrichedGrades = by_grade.map((g) => ({
    ...g,
    avg_price: g.out_kg > 0 ? r2(g.amount / g.out_kg) : null,
    share_pct: totalAmt > 0 ? Math.round((g.amount / totalAmt) * 1000) / 10 : 0,
  }));

  const enrichedCustomers = by_customer.map((c) => ({
    ...c,
    avg_price: c.kg > 0 ? r2(c.amount / c.kg) : null,
    share_pct: totalAmt > 0 ? Math.round((c.amount / totalAmt) * 1000) / 10 : 0,
  }));

  const enrichedWorkers = by_worker.map((w) => ({
    ...w,
    avg_crate_kg: w.crates > 0 ? r3(w.kg / w.crates) : 0,
    share_pct: totalIn > 0 ? Math.round((w.kg / totalIn) * 1000) / 10 : 0,
  }));

  // Группировка продаж в документы (для накладных)
  const salesMap = new Map();
  for (const m of saleRows) {
    const key = `${m.device}:${m.sale_id || 'm' + m.id}`;
    if (!salesMap.has(key)) {
      salesMap.set(key, {
        device: m.device,
        sale_id: m.sale_id || m.id,
        ts: m.ts,
        customer: m.customer || '—',
        user_name: m.user_name || '',
        note: m.note || '',
        total_kg: 0,
        total_amount: 0,
        items: [],
      });
    }
    const s = salesMap.get(key);
    s.items.push({ id: m.id, grade: m.grade, gross_kg: m.gross_kg, tare_kg: m.tare_kg, net_kg: m.net_kg, price_per_kg: m.price_per_kg, amount: m.amount });
    s.total_kg = r3(s.total_kg + Number(m.net_kg || 0));
    s.total_amount = r2(s.total_amount + Number(m.amount || 0));
  }
  const sales = [...salesMap.values()];

  const pIn = Number(prevRow?.in_kg || 0);
  const pOut = Number(prevRow?.out_kg || 0);
  const pWo = Number(prevRow?.writeoff_kg || 0);
  const pBrak = Number(prevRow?.brak_kg || 0);
  const pAmt = Number(prevRow?.amount || 0);
  const expensesTotal = r2(expByCat.reduce((a, x) => a + Number(x.amount || 0), 0));
  const pExp = Number(prevExpRow?.amount || 0);
  const netProfit = r2(totalAmt - expensesTotal);
  const pProfit = r2(pAmt - pExp);
  const avgPrice = totalOut > 0 ? r2(totalAmt / totalOut) : null;
  const lossValue = avgPrice ? r2(lossKg * avgPrice) : 0;
  const marginPct = totalAmt > 0 ? Math.round((netProfit / totalAmt) * 1000) / 10 : 0;
  const by_expense_category = expByCat.map((x) => ({
    ...x,
    share_pct: expensesTotal > 0 ? Math.round((Number(x.amount) / expensesTotal) * 1000) / 10 : 0,
    rev_pct: totalAmt > 0 ? Math.round((Number(x.amount) / totalAmt) * 1000) / 10 : 0,
  }));

  res.status(200).json({
    from,
    to,
    summary: {
      in_kg: totalIn,
      out_kg: totalOut,
      writeoff_kg: totalWo,
      brak_kg: brakIn,
      loss_kg: lossKg,
      loss_pct: lossPct,
      loss_value: lossValue,
      amount: totalAmt,
      expenses_total: expensesTotal,
      net_profit: netProfit,
      margin_pct: marginPct,
      avg_price: avgPrice,
      sales_count: sales.length,
    },
    prev: {
      from: pFrom,
      to: pTo,
      in_kg: pIn,
      out_kg: pOut,
      writeoff_kg: pWo,
      loss_kg: r3(pWo + pBrak),
      amount: pAmt,
      expenses_total: pExp,
      net_profit: pProfit,
      avg_price: pOut > 0 ? r2(pAmt / pOut) : null,
    },
    by_grade: enrichedGrades,
    by_day,
    by_worker: enrichedWorkers,
    by_customer: enrichedCustomers,
    by_expense_category,
    sales,
    filters: {
      grades: filterGrades.map((r) => r.grade),
      customers: filterCustomers.map((r) => r.customer),
    },
    manual_entries: manual.n,
    cancelled_entries: cancelled.n,
  });
}, { method: ['GET', 'POST', 'PATCH'], roles: ['director', 'admin'] });
