// Взаиморасчёты с контрагентами, оплаты и Акт сверки (как в 1С / iiko).
// Конвенция сальдо:
//   Дебет (+) = контрагент должен нам (наши отгрузки/продажи + наши выплаты ему)
//   Кредит (−) = мы должны контрагенту / погашение долга (его оплаты нам + оказанные нам услуги/расходы)
//   Сальдо > 0 -> задолженность контрагента перед нами
//   Сальдо < 0 -> наша задолженность перед контрагентом
const { query } = require('./db');
const { todayStr, dateRange } = require('./http');
const { audit } = require('./auth');

const PAY_METHODS = new Set(['cash', 'card', 'transfer']);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

async function handlePayments(req, res) {
  const b = req.body || {};
  if (req.method === 'POST') {
    const docDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.doc_date || '')) ? String(b.doc_date) : todayStr();
    const counterparty = String(b.counterparty || '').trim().slice(0, 120);
    if (counterparty.length < 2) throw fail('Укажите контрагента');
    const direction = b.direction === 'out' ? 'out' : 'in';
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail('Укажите корректную сумму');
    const rounded = r2(amount);
    const pm = PAY_METHODS.has(b.payment_method) ? b.payment_method : 'cash';
    const comment = String(b.comment || '').trim().slice(0, 300);

    const [ins] = await query(
      `INSERT INTO payments(doc_date, counterparty, direction, amount, payment_method, comment, user_name)
       VALUES($1::date,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [docDate, counterparty, direction, rounded, pm, comment, req.user.name]
    );
    await audit(req, req.user.name, 'payment_add', `#${ins.id} ${counterparty} ${direction} ${rounded}`);
    return res.status(200).json({ ok: true, id: ins.id });
  }

  if (req.method === 'PATCH') {
    const id = Number(b.id);
    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!reason) throw fail('Укажите причину отмены');
    const [row] = Number.isInteger(id) ? await query(`SELECT * FROM payments WHERE id=$1`, [id]) : [];
    if (!row) throw fail('Оплата не найдена', 404);
    if (row.status !== 'active') throw fail('Оплата уже отменена', 409);
    await query(
      `UPDATE payments SET status='cancelled', cancel_reason=$1, cancelled_by=$2, cancelled_ts=now() WHERE id=$3`,
      [reason, req.user.name, id]
    );
    await audit(req, req.user.name, 'payment_cancel', `#${id} ${reason}`);
    return res.status(200).json({ ok: true });
  }
  throw fail('неподдерживаемый метод', 405);
}

async function handleReconcile(req, res) {
  if (req.method !== 'GET') throw fail('только GET', 405);
  const cp = String(req.query.counterparty || '').trim();

  // 1. Сводка по всем контрагентам (если counterparty не передан)
  if (!cp) {
    // Подтягиваем новых контрагентов из расходов и продаж
    await query(
      `INSERT INTO customers(name, kind)
       SELECT DISTINCT trim(counterparty), 'supplier' FROM expenses
       WHERE counterparty IS NOT NULL AND trim(counterparty) <> ''
       ON CONFLICT DO NOTHING`
    );
    const [list, salesAgg, expAgg, payAgg] = await Promise.all([
      query(`SELECT id, name, kind, inn, phone, note, active FROM customers ORDER BY active DESC, lower(name)`),
      query(`SELECT lower(trim(customer)) AS k, ROUND(COALESCE(SUM(amount),0)::numeric,2)::float8 AS amt, count(DISTINCT (device, COALESCE(sale_id, id)))::int AS cnt
             FROM movements WHERE type='out' AND status='active' AND customer IS NOT NULL AND trim(customer)<>'' GROUP BY 1`),
      query(`SELECT lower(trim(counterparty)) AS k, ROUND(COALESCE(SUM(amount),0)::numeric,2)::float8 AS amt, count(*)::int AS cnt
             FROM expenses WHERE status='active' AND counterparty IS NOT NULL AND trim(counterparty)<>'' GROUP BY 1`),
      query(`SELECT lower(trim(counterparty)) AS k,
               ROUND(COALESCE(SUM(CASE WHEN direction='in' THEN amount END),0)::numeric,2)::float8 AS pay_in,
               ROUND(COALESCE(SUM(CASE WHEN direction='out' THEN amount END),0)::numeric,2)::float8 AS pay_out
             FROM payments WHERE status='active' GROUP BY 1`),
    ]);
    const sMap = Object.fromEntries(salesAgg.map((r) => [r.k, r]));
    const eMap = Object.fromEntries(expAgg.map((r) => [r.k, r]));
    const pMap = Object.fromEntries(payAgg.map((r) => [r.k, r]));

    const rows = list.map((c) => {
      const k = c.name.trim().toLowerCase();
      const salesAmt = Number(sMap[k]?.amt || 0);
      const expAmt = Number(eMap[k]?.amt || 0);
      const payIn = Number(pMap[k]?.pay_in || 0);
      const payOut = Number(pMap[k]?.pay_out || 0);
      const debit = r2(salesAmt + payOut);
      const credit = r2(payIn + expAmt);
      return {
        ...c,
        sales_total: salesAmt,
        sales_count: Number(sMap[k]?.cnt || 0),
        expenses_total: expAmt,
        expenses_count: Number(eMap[k]?.cnt || 0),
        paid_in: payIn,
        paid_out: payOut,
        balance: r2(debit - credit),
      };
    });
    return res.status(200).json({ counterparties: rows });
  }

  // 2. Акт сверки по конкретному контрагенту за период [from, to]
  const [from, to] = dateRange(req.query.from, req.query.to);
  const k = cp.toLowerCase();

  const [[cpRow], [openSales], [openExp], [openPay], salesDocs, expDocs, payDocs] = await Promise.all([
    query(`SELECT id, name, kind, inn, phone, note FROM customers WHERE lower(name)=$1 LIMIT 1`, [k]),
    query(`SELECT ROUND(COALESCE(SUM(amount),0)::numeric,2)::float8 AS amt FROM movements
           WHERE type='out' AND status='active' AND lower(trim(customer))=$1 AND ts::date < $2::date`, [k, from]),
    query(`SELECT ROUND(COALESCE(SUM(amount),0)::numeric,2)::float8 AS amt FROM expenses
           WHERE status='active' AND lower(trim(counterparty))=$1 AND doc_date < $2::date`, [k, from]),
    query(`SELECT
             ROUND(COALESCE(SUM(CASE WHEN direction='in' THEN amount END),0)::numeric,2)::float8 AS pay_in,
             ROUND(COALESCE(SUM(CASE WHEN direction='out' THEN amount END),0)::numeric,2)::float8 AS pay_out
           FROM payments WHERE status='active' AND lower(trim(counterparty))=$1 AND doc_date < $2::date`, [k, from]),
    query(
      `SELECT device, COALESCE(sale_id, id) AS doc_no, to_char(MIN(ts),'YYYY-MM-DD') AS doc_date,
              ROUND(SUM(net_kg)::numeric,3)::float8 AS kg, ROUND(COALESCE(SUM(amount),0)::numeric,2)::float8 AS amount,
              string_agg(DISTINCT grade, ', ') AS grades
       FROM movements
       WHERE type='out' AND status='active' AND lower(trim(customer))=$1 AND ts::date BETWEEN $2::date AND $3::date
       GROUP BY device, COALESCE(sale_id, id) ORDER BY doc_date, doc_no`,
      [k, from, to]
    ),
    query(
      `SELECT e.id AS doc_no, to_char(e.doc_date,'YYYY-MM-DD') AS doc_date, c.name AS category,
              e.amount, e.payment_method, e.comment
       FROM expenses e JOIN expense_categories c ON c.id=e.category_id
       WHERE e.status='active' AND lower(trim(e.counterparty))=$1 AND e.doc_date BETWEEN $2::date AND $3::date
       ORDER BY e.doc_date, e.id`,
      [k, from, to]
    ),
    query(
      `SELECT id AS doc_no, to_char(doc_date,'YYYY-MM-DD') AS doc_date, direction, amount, payment_method, comment
       FROM payments
       WHERE status='active' AND lower(trim(counterparty))=$1 AND doc_date BETWEEN $2::date AND $3::date
       ORDER BY doc_date, id`,
      [k, from, to]
    ),
  ]);

  const openingBalance = r2(
    (Number(openSales?.amt || 0) + Number(openPay?.pay_out || 0)) -
    (Number(openPay?.pay_in || 0) + Number(openExp?.amt || 0))
  );

  const docs = [
    ...salesDocs.map((s) => ({
      date: s.doc_date,
      type: 'sale',
      doc_no: s.doc_no,
      title: `Продажа №${s.doc_no} (${s.grades}, ${s.kg} кг)`,
      debit: Number(s.amount || 0),
      credit: 0,
    })),
    ...expDocs.map((e) => ({
      date: e.doc_date,
      type: 'expense',
      doc_no: e.doc_no,
      title: `Акт расхода №${e.doc_no} · ${e.category}${e.comment ? ' (' + e.comment + ')' : ''}`,
      debit: 0,
      credit: Number(e.amount || 0),
    })),
    ...payDocs.map((p) => ({
      date: p.doc_date,
      type: p.direction === 'in' ? 'payment_in' : 'payment_out',
      doc_no: p.doc_no,
      title: `${p.direction === 'in' ? 'Оплата от контрагента' : 'Выплата контрагенту'} №${p.doc_no}${p.comment ? ' (' + p.comment + ')' : ''}`,
      debit: p.direction === 'out' ? Number(p.amount || 0) : 0,
      credit: p.direction === 'in' ? Number(p.amount || 0) : 0,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.doc_no - b.doc_no);

  const totalDebit = r2(docs.reduce((a, d) => a + d.debit, 0));
  const totalCredit = r2(docs.reduce((a, d) => a + d.credit, 0));
  const closingBalance = r2(openingBalance + totalDebit - totalCredit);

  return res.status(200).json({
    counterparty: cpRow || { name: cp, kind: 'buyer', inn: '', phone: '' },
    from,
    to,
    opening_balance: openingBalance,
    total_debit: totalDebit,
    total_credit: totalCredit,
    closing_balance: closingBalance,
    docs,
  });
}

module.exports = { handlePayments, handleReconcile };
