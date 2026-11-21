// Взаиморасчёты с контрагентами, оплаты и Акт сверки (как в 1С / iiko).
// Конвенция сальдо:
//   Дебет (+) = контрагент должен нам (наши отгрузки/продажи + наши выплаты ему)
//   Кредит (−) = мы должны контрагенту / погашение долга (его оплаты нам + оказанные нам услуги/расходы)
//   Сальдо > 0 -> задолженность контрагента перед нами
//   Сальдо < 0 -> наша задолженность перед контрагентом
const { query } = require('./db');
const { dateRange, docDate, findDuplicate, dupReply, atomicCreate, atomicUpdate } = require('./http');

const PAY_METHODS = new Set(['cash', 'card', 'transfer']);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

async function handlePayments(req, res) {
  const b = req.body || {};
  // GET: журнал актов оплаты за период (как банковская выписка / платежи в 1С)
  if (req.method === 'GET') {
    const [from, to] = dateRange(req.query.from, req.query.to);
    const dir = req.query.direction === 'in' || req.query.direction === 'out' ? req.query.direction : '';
    const conds = [`doc_date BETWEEN $1::date AND $2::date`];
    const params = [from, to];
    if (dir) {
      params.push(dir);
      conds.push(`direction=$${params.length}`);
    }
    if (req.user.role !== 'admin') {
      conds.push(`status='active'`);
    }
    const items = await query(
      `SELECT id, to_char(doc_date,'YYYY-MM-DD') AS doc_date, counterparty, direction, amount,
              payment_method, comment, user_name, status, cancel_reason
       FROM payments WHERE ${conds.join(' AND ')}
       ORDER BY doc_date DESC, id DESC LIMIT 300`,
      params
    );
    const active = items.filter((x) => x.status === 'active');
    const totalIn = r2(active.filter((x) => x.direction === 'in').reduce((a, x) => a + Number(x.amount || 0), 0));
    const totalOut = r2(active.filter((x) => x.direction === 'out').reduce((a, x) => a + Number(x.amount || 0), 0));
    return res.status(200).json({ from, to, total_in: totalIn, total_out: totalOut, net: r2(totalIn - totalOut), items });
  }

  // Оплаты вносит и отменяет только администратор; директор — только просмотр.
  if (req.method !== 'GET' && req.user.role !== 'admin') throw fail('вносить и отменять оплаты может только администратор', 403);
  if (req.method === 'POST') {
    const dup = await findDuplicate(req, 'payment');
    if (dup) return res.status(200).json(dup);
    const day = docDate(b.doc_date);
    const counterparty = String(b.counterparty || '').trim().slice(0, 120);
    if (counterparty.length < 2) throw fail('Укажите контрагента');
    const direction = b.direction === 'out' ? 'out' : 'in';
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail('Укажите корректную сумму');
    const rounded = r2(amount);
    const pm = PAY_METHODS.has(b.payment_method) ? b.payment_method : 'cash';
    const comment = String(b.comment || '').trim().slice(0, 300);

    // Оплата, ключ request_id и журнал — одной транзакцией
    const r = await atomicCreate(req, {
      scope: 'payment',
      table: 'payments',
      values: [
        ['doc_date', 'date', day], ['counterparty', 'text', counterparty], ['direction', 'text', direction],
        ['amount', 'float8', rounded], ['payment_method', 'text', pm], ['comment', 'text', comment], ['user_name', 'text', req.user.name],
      ],
      action: 'payment_add',
      detail: `${counterparty} ${direction} ${rounded}`,
    });
    if (r.duplicate) return res.status(200).json(dupReply(r.id));
    return res.status(200).json({ ok: true, id: r.doc.id });
  }

  if (req.method === 'PATCH') {
    const id = Number(b.id);
    const [row] = Number.isInteger(id) ? await query(`SELECT * FROM payments WHERE id=$1`, [id]) : [];
    if (!row) throw fail('Оплата не найдена', 404);

    if (b.action === 'restore') {
      if (row.status === 'active') throw fail('Оплата уже активна', 409);
      const { n } = await atomicUpdate(req, {
        table: 'payments',
        id,
        where: "status='cancelled'",
        set: [['status', 'text', 'active']],
        setRaw: ['cancel_reason=NULL', 'cancelled_by=NULL', 'cancelled_ts=NULL'],
        action: 'payment_restore',
        detail: `#${id}`,
      });
      if (!n) throw fail('Оплата уже активна', 409);
      return res.status(200).json({ ok: true, id });
    }

    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!reason) throw fail('Укажите причину отмены');
    if (row.status !== 'active') throw fail('Оплата уже отменена', 409);
    const { n } = await atomicUpdate(req, {
      table: 'payments',
      id,
      set: [['status', 'text', 'cancelled'], ['cancel_reason', 'text', reason], ['cancelled_by', 'text', req.user.name]],
      setRaw: ['cancelled_ts=now()'],
      action: 'payment_cancel',
      detail: `#${id} ${reason}`,
    });
    if (!n) throw fail('Оплата уже отменена', 409);
    return res.status(200).json({ ok: true });
  }
  throw fail('неподдерживаемый метод', 405);
}

async function handleReconcile(req, res) {
  if (req.method !== 'GET') throw fail('только GET', 405);
  const cp = String(req.query.counterparty || '').trim();

  // 1. Сводка по всем контрагентам (если counterparty не передан)
  if (!cp) {
    // Подтягиваем новых контрагентов из расходов (не создаём дубль, если уже есть в customers)
    await query(
      `INSERT INTO customers(name, kind)
       SELECT DISTINCT trim(counterparty), 'supplier' FROM expenses
       WHERE counterparty IS NOT NULL AND trim(counterparty) <> ''
         AND NOT EXISTS (SELECT 1 FROM customers c WHERE lower(c.name) = lower(trim(expenses.counterparty)))`
    );
    const onlyActiveCust = req.user.role !== 'admin' ? 'WHERE active = true' : '';
    const [list, salesAgg, expAgg, payAgg] = await Promise.all([
      query(`SELECT id, name, kind, inn, phone, contact_person, telegram, address, payment_terms, bank_details, note, active FROM customers ${onlyActiveCust} ORDER BY active DESC, lower(name)`),
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
    query(`SELECT id, name, kind, inn, phone, contact_person, telegram, address, payment_terms, bank_details, note FROM customers WHERE lower(name)=$1 LIMIT 1`, [k]),
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
