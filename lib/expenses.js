// Доменный слой расходов: категории расходов и акты расхода (как в iiko / 1С).
const { query } = require('./db');
const { dateRange, docDate, findDuplicate, dupReply, atomicCreate, atomicUpdate } = require('./http');
const { audit } = require('./auth');

const PAY_METHODS = new Set(['cash', 'card', 'transfer']);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Табличная часть акта (как в iiko/1С). Отрицательные и нечисловые количество/цена/сумма -> 400.
function cleanItems(list) {
  return list.slice(0, 100).map((it, i) => {
    const name = String(it?.name || '').trim().slice(0, 140);
    const qty = it?.qty === undefined || it?.qty === '' || it?.qty === null ? 1 : Number(it.qty);
    const unit = String(it?.unit || 'шт').trim().slice(0, 20) || 'шт';
    const price = it?.price === undefined || it?.price === '' || it?.price === null ? 0 : Number(it.price);
    const sumRaw = it?.sum !== undefined && it?.sum !== '' && it?.sum !== null ? Number(it.sum) : qty * price;
    if (![qty, price, sumRaw].every(Number.isFinite)) throw fail(`Строка ${i + 1}: количество, цена и сумма должны быть числами`);
    if (qty < 0 || price < 0 || sumRaw < 0) throw fail(`Строка ${i + 1}: отрицательные значения недопустимы`);
    if (sumRaw > 1e12) throw fail(`Строка ${i + 1}: слишком большая сумма`);
    const sum = Math.round(sumRaw * 100) / 100;
    return { name, qty: qty > 0 ? qty : 1, unit, price, sum };
  }).filter((it) => it.name || it.sum > 0);
}

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
    if (req.user.role !== 'admin') {
      conds.push(`e.status='active'`);
    }
    const [categories, items] = await Promise.all([
      query(`SELECT id, name, active FROM expense_categories ORDER BY active DESC, id`),
      query(
        `SELECT e.id, to_char(e.doc_date,'YYYY-MM-DD') AS doc_date, e.category_id, c.name AS category_name,
                e.amount, e.counterparty, e.employee, e.payment_method, e.doc_number, e.items, e.comment, e.user_name, e.status, e.cancel_reason
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

  // ── Акты расхода: вносит, правит и отменяет только администратор (директор — только просмотр) ──
  if (req.user.role !== 'admin') throw fail('вносить и менять расходы может только администратор', 403);

  if (req.method === 'POST') {
    const dup = await findDuplicate(req, 'expense');
    if (dup) return res.status(200).json(dup);
    const day = docDate(b.doc_date);
    const catId = Number(b.category_id);
    const [cat] = Number.isInteger(catId) ? await query(`SELECT id, name, active FROM expense_categories WHERE id=$1`, [catId]) : [];
    if (!cat || !cat.active) throw fail('Выберите активную категорию расхода');

    // Табличная часть акта (как в iiko/1С): необязательна; если передана, сумма считается по строкам
    const items = Array.isArray(b.items) && b.items.length ? cleanItems(b.items) : [];

    const amount = items.length
      ? items.reduce((a, x) => a + x.sum, 0)
      : Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail('Укажите корректную сумму');
    const rounded = Math.round(amount * 100) / 100;
    const counterparty = String(b.counterparty || '').trim().slice(0, 120);
    const employee = String(b.employee || '').trim().slice(0, 120);
    const docNumber = String(b.doc_number || '').trim().slice(0, 60);
    const comment = String(b.comment || '').trim().slice(0, 500);
    const pm = PAY_METHODS.has(b.payment_method) ? b.payment_method : 'cash';

    // Акт со всеми строками (items), ключ request_id и журнал — одной транзакцией
    const r = await atomicCreate(req, {
      scope: 'expense',
      table: 'expenses',
      values: [
        ['doc_date', 'date', day], ['category_id', 'int', cat.id], ['amount', 'float8', rounded],
        ['counterparty', 'text', counterparty], ['employee', 'text', employee], ['payment_method', 'text', pm], ['doc_number', 'text', docNumber],
        ['items', 'jsonb', JSON.stringify(items)], ['comment', 'text', comment], ['user_name', 'text', req.user.name],
      ],
      action: 'expense_add',
      detail: `${cat.name} ${rounded}${employee ? ` (${employee})` : ''}`,
    });
    if (r.duplicate) return res.status(200).json(dupReply(r.id));
    return res.status(200).json({ ok: true, id: r.doc.id });
  }

  if (req.method === 'PATCH') {
    const id = Number(b.id);
    const [row] = Number.isInteger(id)
      ? await query(`SELECT *, to_char(doc_date,'YYYY-MM-DD') AS day FROM expenses WHERE id=$1`, [id])
      : [];
    if (!row) throw fail('Акт расхода не найден', 404);

    // Восстановление отменённого акта (только администратор)
    if (b.action === 'restore') {
      if (row.status === 'active') throw fail('Акт уже активен', 409);
      const { n } = await atomicUpdate(req, {
        table: 'expenses',
        id,
        where: "status='cancelled'",
        set: [['status', 'text', 'active']],
        setRaw: ['cancel_reason=NULL', 'cancelled_by=NULL', 'cancelled_ts=NULL'],
        action: 'expense_restore',
        detail: `#${id}`,
      });
      if (!n) throw fail('Акт уже активен', 409);
      return res.status(200).json({ ok: true, id });
    }

    if (row.status !== 'active') throw fail('Отменённый акт нельзя изменить', 409);

    // Редактирование акта расхода (только администратор, в т.ч. чужих актов)
    if (b.action === 'edit') {
      const day = docDate(b.doc_date, row.day);
      const catId = b.category_id !== undefined ? Number(b.category_id) : row.category_id;
      const [cat] = Number.isInteger(catId) ? await query(`SELECT id, name, active FROM expense_categories WHERE id=$1`, [catId]) : [];
      if (!cat) throw fail('Выберите категорию расхода');

      const items = Array.isArray(b.items) ? cleanItems(b.items) : (Array.isArray(row.items) ? row.items : []);

      const amount = items.length
        ? items.reduce((a, x) => a + x.sum, 0)
        : Number(b.amount !== undefined ? b.amount : row.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail('Укажите корректную сумму');
      const rounded = Math.round(amount * 100) / 100;
      const counterparty = b.counterparty !== undefined ? String(b.counterparty || '').trim().slice(0, 120) : row.counterparty;
      const employee = b.employee !== undefined ? String(b.employee || '').trim().slice(0, 120) : (row.employee || '');
      const docNumber = b.doc_number !== undefined ? String(b.doc_number || '').trim().slice(0, 60) : (row.doc_number || '');
      const comment = b.comment !== undefined ? String(b.comment || '').trim().slice(0, 500) : row.comment;
      const pm = b.payment_method !== undefined && PAY_METHODS.has(b.payment_method) ? b.payment_method : row.payment_method;

      const { n } = await atomicUpdate(req, {
        table: 'expenses',
        id,
        set: [
          ['doc_date', 'date', day], ['category_id', 'int', cat.id], ['amount', 'float8', rounded],
          ['counterparty', 'text', counterparty], ['employee', 'text', employee], ['payment_method', 'text', pm], ['doc_number', 'text', docNumber],
          ['items', 'jsonb', JSON.stringify(items)], ['comment', 'text', comment],
        ],
        action: 'expense_edit',
        detail: `#${id} ${cat.name} ${row.amount}→${rounded}`,
      });
      if (!n) throw fail('Отменённый акт нельзя изменить', 409);
      return res.status(200).json({ ok: true, id });
    }

    // Отмена акта расхода (не удаляем физически)
    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!reason) throw fail('Укажите причину отмены');
    const { n } = await atomicUpdate(req, {
      table: 'expenses',
      id,
      set: [['status', 'text', 'cancelled'], ['cancel_reason', 'text', reason], ['cancelled_by', 'text', req.user.name]],
      setRaw: ['cancelled_ts=now()'],
      action: 'expense_cancel',
      detail: `#${id} ${reason}`,
    });
    if (!n) throw fail('Акт уже отменён', 409);
    return res.status(200).json({ ok: true });
  }

  throw fail('неподдерживаемый метод', 405);
}

module.exports = { handleExpenses };
