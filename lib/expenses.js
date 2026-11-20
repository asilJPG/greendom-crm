// Доменный слой расходов: категории расходов и акты расхода (как в iiko / 1С).
const { query } = require('./db');
const { todayStr, dateRange } = require('./http');
const { audit } = require('./auth');

const PAY_METHODS = new Set(['cash', 'card', 'transfer']);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function handleExpenses(req, res) {
  const b = req.body || {};

  // GET: список актов расхода + категории
  if (req.method === 'GET') {
    const [from, to] = req.query.all === '1' ? ['2000-01-01', '2099-12-31'] : dateRange(req.query.from, req.query.to);
    const catId = Number(req.query.category_id || 0);
    const conds = [`e.doc_date BETWEEN $1::date AND $2::date`];
    const params = [from, to];
    if (Number.isInteger(catId) && catId > 0) {
      params.push(catId);
      conds.push(`e.category_id=$${params.length}`);
    }
    const [categories, items] = await Promise.all([
      query(`SELECT id, name, active FROM expense_categories ORDER BY active DESC, id`),
      query(
        `SELECT e.id, to_char(e.doc_date,'YYYY-MM-DD') AS doc_date, e.category_id, c.name AS category_name,
                e.amount, e.counterparty, e.payment_method, e.doc_number, e.items, e.comment, e.user_name, e.status, e.cancel_reason
         FROM expenses e JOIN expense_categories c ON c.id=e.category_id
         WHERE ${conds.join(' AND ')}
         ORDER BY e.doc_date DESC, e.id DESC LIMIT 300`,
        params
      ),
    ]);
    const total = Math.round(items.filter((x) => x.status === 'active').reduce((a, x) => a + Number(x.amount || 0), 0) * 100) / 100;
    return res.status(200).json({ from, to, total, categories, items });
  }

  const target = String(b.target || 'expense');

  // ── Категории расходов (только администратор) ──
  if (target === 'category') {
    if (req.user.role !== 'admin') throw fail('управлять категориями может только администратор', 403);

    if (req.method === 'POST') {
      const name = String(b.name || '').trim().slice(0, 60);
      if (name.length < 2) throw fail('Название категории: минимум 2 символа');
      const [dup] = await query(`SELECT 1 FROM expense_categories WHERE lower(name)=lower($1)`, [name]);
      if (dup) throw fail('Такая категория уже есть', 409);
      const [row] = await query(`INSERT INTO expense_categories(name) VALUES($1) RETURNING id, name, active`, [name]);
      await audit(req, req.user.name, 'exp_cat_add', `#${row.id} ${name}`);
      return res.status(200).json({ ok: true, category: row });
    }

    if (req.method === 'PATCH') {
      const id = Number(b.id);
      const [cat] = Number.isInteger(id) ? await query(`SELECT * FROM expense_categories WHERE id=$1`, [id]) : [];
      if (!cat) throw fail('Категория не найдена', 404);
      const name = b.name !== undefined ? String(b.name || '').trim().slice(0, 60) : cat.name;
      if (name.length < 2) throw fail('Название категории: минимум 2 символа');
      if (name.toLowerCase() !== cat.name.toLowerCase()) {
        const [dup] = await query(`SELECT 1 FROM expense_categories WHERE lower(name)=lower($1) AND id<>$2`, [name, id]);
        if (dup) throw fail('Такая категория уже есть', 409);
      }
      const active = b.active !== undefined ? Boolean(b.active) : cat.active;
      await query(`UPDATE expense_categories SET name=$1, active=$2 WHERE id=$3`, [name, active, id]);
      await audit(req, req.user.name, 'exp_cat_edit', `#${id} ${name} active=${active}`);
      return res.status(200).json({ ok: true });
    }
    throw fail('неподдерживаемый метод', 405);
  }

  // ── Акты расхода (admin и director — офисные роли) ──
  if (!['admin', 'director'].includes(req.user.role)) throw fail('нет прав на внесение расходов', 403);

  if (req.method === 'POST') {
    const docDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.doc_date || '')) ? String(b.doc_date) : todayStr();
    const catId = Number(b.category_id);
    const [cat] = Number.isInteger(catId) ? await query(`SELECT id, name, active FROM expense_categories WHERE id=$1`, [catId]) : [];
    if (!cat || !cat.active) throw fail('Выберите активную категорию расхода');

    // Табличная часть акта (как в iiko/1С): необязательна; если передана, сумма считается по строкам
    let cleanItems = [];
    if (Array.isArray(b.items) && b.items.length) {
      cleanItems = b.items.slice(0, 100).map((it) => {
        const name = String(it?.name || '').trim().slice(0, 140);
        const qty = Number(it?.qty ?? 1);
        const unit = String(it?.unit || 'шт').trim().slice(0, 20) || 'шт';
        const price = Number(it?.price ?? 0);
        const sumRaw = it?.sum !== undefined && it?.sum !== '' ? Number(it.sum) : qty * price;
        const sum = Math.round((Number.isFinite(sumRaw) ? sumRaw : 0) * 100) / 100;
        return { name, qty: Number.isFinite(qty) && qty > 0 ? qty : 1, unit, price: Number.isFinite(price) && price >= 0 ? price : 0, sum };
      }).filter((it) => it.name || it.sum > 0);
    }

    const amount = cleanItems.length
      ? cleanItems.reduce((a, x) => a + x.sum, 0)
      : Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail('Укажите корректную сумму');
    const rounded = Math.round(amount * 100) / 100;
    const counterparty = String(b.counterparty || '').trim().slice(0, 120);
    const docNumber = String(b.doc_number || '').trim().slice(0, 60);
    const comment = String(b.comment || '').trim().slice(0, 500);
    const pm = PAY_METHODS.has(b.payment_method) ? b.payment_method : 'cash';

    const [ins] = await query(
      `INSERT INTO expenses(doc_date, category_id, amount, counterparty, payment_method, doc_number, items, comment, user_name)
       VALUES($1::date, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING id`,
      [docDate, cat.id, rounded, counterparty, pm, docNumber, JSON.stringify(cleanItems), comment, req.user.name]
    );
    await audit(req, req.user.name, 'expense_add', `#${ins.id} ${cat.name} ${rounded}`);
    return res.status(200).json({ ok: true, id: ins.id });
  }

  if (req.method === 'PATCH') {
    const id = Number(b.id);
    const [row] = Number.isInteger(id)
      ? await query(`SELECT *, to_char(doc_date,'YYYY-MM-DD') AS day FROM expenses WHERE id=$1`, [id])
      : [];
    if (!row) throw fail('Акт расхода не найден', 404);
    if (row.status !== 'active') throw fail('Отменённый акт нельзя изменить', 409);

    // Редактирование акта расхода (admin или director)
    if (b.action === 'edit') {
      const docDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.doc_date || '')) ? String(b.doc_date) : row.day;
      const catId = b.category_id !== undefined ? Number(b.category_id) : row.category_id;
      const [cat] = Number.isInteger(catId) ? await query(`SELECT id, name, active FROM expense_categories WHERE id=$1`, [catId]) : [];
      if (!cat) throw fail('Выберите категорию расхода');

      let cleanItems = Array.isArray(row.items) ? row.items : [];
      if (Array.isArray(b.items)) {
        cleanItems = b.items.slice(0, 100).map((it) => {
          const name = String(it?.name || '').trim().slice(0, 140);
          const qty = Number(it?.qty ?? 1);
          const unit = String(it?.unit || 'шт').trim().slice(0, 20) || 'шт';
          const price = Number(it?.price ?? 0);
          const sumRaw = it?.sum !== undefined && it?.sum !== '' ? Number(it.sum) : qty * price;
          const sum = Math.round((Number.isFinite(sumRaw) ? sumRaw : 0) * 100) / 100;
          return { name, qty: Number.isFinite(qty) && qty > 0 ? qty : 1, unit, price: Number.isFinite(price) && price >= 0 ? price : 0, sum };
        }).filter((it) => it.name || it.sum > 0);
      }

      const amount = cleanItems.length
        ? cleanItems.reduce((a, x) => a + x.sum, 0)
        : Number(b.amount !== undefined ? b.amount : row.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail('Укажите корректную сумму');
      const rounded = Math.round(amount * 100) / 100;
      const counterparty = b.counterparty !== undefined ? String(b.counterparty || '').trim().slice(0, 120) : row.counterparty;
      const docNumber = b.doc_number !== undefined ? String(b.doc_number || '').trim().slice(0, 60) : (row.doc_number || '');
      const comment = b.comment !== undefined ? String(b.comment || '').trim().slice(0, 500) : row.comment;
      const pm = b.payment_method !== undefined && PAY_METHODS.has(b.payment_method) ? b.payment_method : row.payment_method;

      await query(
        `UPDATE expenses
         SET doc_date=$1::date, category_id=$2, amount=$3, counterparty=$4, payment_method=$5, doc_number=$6, items=$7::jsonb, comment=$8
         WHERE id=$9`,
        [docDate, cat.id, rounded, counterparty, pm, docNumber, JSON.stringify(cleanItems), comment, id]
      );
      await audit(req, req.user.name, 'expense_edit', `#${id} ${cat.name} ${row.amount}→${rounded}`);
      return res.status(200).json({ ok: true, id });
    }

    // Отмена акта расхода (не удаляем физически)
    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!reason) throw fail('Укажите причину отмены');
    const mineToday = row.user_name === req.user.name && row.day === todayStr();
    if (req.user.role !== 'admin' && !mineToday) throw fail('Отменить может администратор (или вы, в тот же день)', 403);
    await query(
      `UPDATE expenses SET status='cancelled', cancel_reason=$1, cancelled_by=$2, cancelled_ts=now() WHERE id=$3`,
      [reason, req.user.name, id]
    );
    await audit(req, req.user.name, 'expense_cancel', `#${id} ${reason}`);
    return res.status(200).json({ ok: true });
  }

  throw fail('неподдерживаемый метод', 405);
}

module.exports = { handleExpenses };
