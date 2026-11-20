// Доменный слой «Инвестиции» (капитальные вложения в теплицу и расчёт окупаемости / ROI).
const { query } = require('./db');
const { todayStr } = require('./http');
const { audit } = require('./auth');

const PAY_METHODS = new Set(['cash', 'card', 'transfer']);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

async function handleInvestments(req, res) {
  const b = req.body || {};

  if (req.method === 'GET') {
    const [items, [revRow], [expRow]] = await Promise.all([
      query(
        `SELECT id, to_char(doc_date,'YYYY-MM-DD') AS doc_date, category, title, investor, amount,
                payment_method, doc_number, comment, user_name, status, cancel_reason
         FROM investments ORDER BY doc_date DESC, id DESC LIMIT 500`
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

  if (req.method === 'POST') {
    const docDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.doc_date || '')) ? String(b.doc_date) : todayStr();
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

    const [ins] = await query(
      `INSERT INTO investments(doc_date, category, title, investor, amount, payment_method, doc_number, comment, user_name)
       VALUES($1::date,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [docDate, category, title, investor, rounded, pm, docNumber, comment, req.user.name]
    );
    await audit(req, req.user.name, 'investment_add', `#${ins.id} ${title} ${rounded}`);
    return res.status(200).json({ ok: true, id: ins.id });
  }

  if (req.method === 'PATCH') {
    const id = Number(b.id);
    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!reason) throw fail('Укажите причину отмены');
    const [row] = Number.isInteger(id) ? await query(`SELECT * FROM investments WHERE id=$1`, [id]) : [];
    if (!row) throw fail('Запись об инвестиции не найдена', 404);
    if (row.status !== 'active') throw fail('Запись уже отменена', 409);
    await query(
      `UPDATE investments SET status='cancelled', cancel_reason=$1, cancelled_by=$2, cancelled_ts=now() WHERE id=$3`,
      [reason, req.user.name, id]
    );
    await audit(req, req.user.name, 'investment_cancel', `#${id} ${reason}`);
    return res.status(200).json({ ok: true });
  }

  throw fail('неподдерживаемый метод', 405);
}

module.exports = { handleInvestments };
