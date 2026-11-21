// Доменный слой «Инвестиции» (капитальные вложения в теплицу и расчёт окупаемости / ROI).
const { query } = require('./db');
const { docDate, findDuplicate, dupReply, atomicCreate, atomicUpdate } = require('./http');

const PAY_METHODS = new Set(['cash', 'card', 'transfer']);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

async function handleInvestments(req, res) {
  const b = req.body || {};

  if (req.method === 'GET') {
    const onlyActive = req.user.role !== 'admin' ? "WHERE status='active'" : '';
    const [items, [revRow], [expRow]] = await Promise.all([
      query(
        `SELECT id, to_char(doc_date,'YYYY-MM-DD') AS doc_date, category, title, investor, amount,
                payment_method, doc_number, comment, user_name, status, cancel_reason
         FROM investments ${onlyActive} ORDER BY doc_date DESC, id DESC LIMIT 500`
      ),
      query(`SELECT ROUND(COALESCE(SUM(amount),0)::numeric,2)::float8 AS amt FROM movements WHERE type='out' AND status='active'`),
      query(`SELECT ROUND(COALESCE(SUM(amount),0)::numeric,2)::float8 AS amt FROM expenses WHERE status='active'`),
    ]);

    const active = items.filter((x) => x.status === 'active');
    const totalInvested = r2(active.reduce((a, x) => a + Number(x.amount || 0), 0));
    const totalRevenue = Number(revRow?.amt || 0);
    const totalExpenses = Number(expRow?.amt || 0);
    const cumulativeProfit = r2(totalRevenue - totalExpenses);
    const recovered = Math.max(0, Math.min(totalInvested, cumulativeProfit));
    const remaining = r2(Math.max(0, totalInvested - Math.max(0, cumulativeProfit)));
    const paybackPct = totalInvested > 0 ? Math.max(0, Math.round((cumulativeProfit / totalInvested) * 1000) / 10) : 0;

    // Разбивка по инвесторам и категориям
    const invMap = new Map();
    const catMap = new Map();
    for (const x of active) {
      const kInv = (x.investor || '').trim() || 'Общий бюджет';
      invMap.set(kInv, r2((invMap.get(kInv) || 0) + Number(x.amount || 0)));
      const kCat = (x.category || '').trim() || 'Прочие вложения';
      catMap.set(kCat, r2((catMap.get(kCat) || 0) + Number(x.amount || 0)));
    }
    const by_investor = [...invMap.entries()]
      .map(([investor, amount]) => ({ investor, amount, share_pct: totalInvested > 0 ? Math.round((amount / totalInvested) * 1000) / 10 : 0 }))
      .sort((a, b) => b.amount - a.amount);
    const by_category = [...catMap.entries()]
      .map(([category, amount]) => ({ category, amount, share_pct: totalInvested > 0 ? Math.round((amount / totalInvested) * 1000) / 10 : 0 }))
      .sort((a, b) => b.amount - a.amount);

    return res.status(200).json({
      summary: {
        total_invested: totalInvested,
        cumulative_profit: cumulativeProfit,
        recovered,
        remaining,
        payback_pct: paybackPct,
        count: active.length,
      },
      by_investor,
      by_category,
      items,
    });
  }

  // Запись (создание, правка, отмена) — только администратор; директор видит раздел только на чтение.
  if (req.user.role !== 'admin') throw fail('вносить и менять инвестиции может только администратор', 403);

  if (req.method === 'POST') {
    const dup = await findDuplicate(req, 'investment');
    if (dup) return res.status(200).json(dup);
    const day = docDate(b.doc_date);
    const title = String(b.title || '').trim().slice(0, 160);
    if (title.length < 2) throw fail('Укажите наименование вложения');
    const category = String(b.category || 'Постройка и оборудование').trim().slice(0, 80) || 'Постройка и оборудование';
    const investor = String(b.investor || '').trim().slice(0, 120);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail('Укажите корректную сумму');
    const rounded = r2(amount);
    const pm = PAY_METHODS.has(b.payment_method) ? b.payment_method : 'transfer';
    const docNumber = String(b.doc_number || '').trim().slice(0, 60);
    const comment = String(b.comment || '').trim().slice(0, 500);

    // Вложение, ключ request_id и журнал — одной транзакцией
    const r = await atomicCreate(req, {
      scope: 'investment',
      table: 'investments',
      values: [
        ['doc_date', 'date', day], ['category', 'text', category], ['title', 'text', title], ['investor', 'text', investor],
        ['amount', 'float8', rounded], ['payment_method', 'text', pm], ['doc_number', 'text', docNumber],
        ['comment', 'text', comment], ['user_name', 'text', req.user.name],
      ],
      action: 'investment_add',
      detail: `${title} ${rounded}`,
    });
    if (r.duplicate) return res.status(200).json(dupReply(r.id));
    return res.status(200).json({ ok: true, id: r.doc.id });
  }

  if (req.method === 'PATCH') {
    const id = Number(b.id);
    const [row] = Number.isInteger(id)
      ? await query(`SELECT *, to_char(doc_date,'YYYY-MM-DD') AS day FROM investments WHERE id=$1`, [id])
      : [];
    if (!row) throw fail('Запись об инвестиции не найдена', 404);

    if (b.action === 'restore') {
      if (row.status === 'active') throw fail('Запись уже активна', 409);
      const { n } = await atomicUpdate(req, {
        table: 'investments',
        id,
        where: "status='cancelled'",
        set: [['status', 'text', 'active']],
        setRaw: ['cancel_reason=NULL', 'cancelled_by=NULL', 'cancelled_ts=NULL'],
        action: 'investment_restore',
        detail: `#${id}`,
      });
      if (!n) throw fail('Запись уже активна', 409);
      return res.status(200).json({ ok: true, id });
    }

    if (row.status !== 'active') throw fail('Отменённую запись нельзя изменить', 409);

    if (b.action === 'edit') {
      const day = docDate(b.doc_date, row.day);
      const title = b.title !== undefined ? String(b.title || '').trim().slice(0, 160) : row.title;
      if (title.length < 2) throw fail('Укажите наименование вложения');
      const category = b.category !== undefined ? (String(b.category || '').trim().slice(0, 80) || row.category) : row.category;
      const investor = b.investor !== undefined ? String(b.investor || '').trim().slice(0, 120) : row.investor;
      const amount = b.amount !== undefined ? Number(b.amount) : Number(row.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail('Укажите корректную сумму');
      const rounded = r2(amount);
      const pm = b.payment_method !== undefined && PAY_METHODS.has(b.payment_method) ? b.payment_method : row.payment_method;
      const docNumber = b.doc_number !== undefined ? String(b.doc_number || '').trim().slice(0, 60) : (row.doc_number || '');
      const comment = b.comment !== undefined ? String(b.comment || '').trim().slice(0, 500) : (row.comment || '');

      const { n } = await atomicUpdate(req, {
        table: 'investments',
        id,
        set: [
          ['doc_date', 'date', day], ['category', 'text', category], ['title', 'text', title], ['investor', 'text', investor],
          ['amount', 'float8', rounded], ['payment_method', 'text', pm], ['doc_number', 'text', docNumber], ['comment', 'text', comment],
        ],
        action: 'investment_edit',
        detail: `#${id} ${title} ${row.amount}→${rounded}`,
      });
      if (!n) throw fail('Отменённую запись нельзя изменить', 409);
      return res.status(200).json({ ok: true, id });
    }

    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!reason) throw fail('Укажите причину отмены');
    const { n } = await atomicUpdate(req, {
      table: 'investments',
      id,
      set: [['status', 'text', 'cancelled'], ['cancel_reason', 'text', reason], ['cancelled_by', 'text', req.user.name]],
      setRaw: ['cancelled_ts=now()'],
      action: 'investment_cancel',
      detail: `#${id} ${reason}`,
    });
    if (!n) throw fail('Запись уже отменена', 409);
    return res.status(200).json({ ok: true });
  }

  throw fail('неподдерживаемый метод', 405);
}

module.exports = { handleInvestments };
