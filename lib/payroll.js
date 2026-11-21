// Модуль «Зарплата» (/payroll): штатные работники теплицы (без доступа к сайту) и выдача ЗП / авансов / премий.
// Выплаты ЗП автоматически пишутся в таблицу expenses с категорией «Зарплата», поэтому сразу попадают в ОПиУ (P&L)
// и не засоряют справочник контрагентов.
const { query } = require('./db');
const { dateRange, docDate, findDuplicate, dupReply, atomicCreate, atomicUpdate } = require('./http');
const { audit } = require('./auth');

const PAY_METHODS = new Set(['cash', 'card', 'transfer']);
const PAY_KINDS = new Set(['Зарплата', 'Аванс', 'Премия', 'Отпускные', 'Прочее']);
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

async function ensureSalaryCategoryId() {
  const [cat] = await query(`SELECT id FROM expense_categories WHERE lower(name)='зарплата' LIMIT 1`);
  if (cat) return cat.id;
  const [ins] = await query(`INSERT INTO expense_categories(name) VALUES('Зарплата') RETURNING id`);
  return ins.id;
}

async function handlePayroll(req, res) {
  const b = req.body || {};

  if (req.method === 'GET') {
    const [from, to] = dateRange(req.query.from, req.query.to);
    const catId = await ensureSalaryCategoryId();
    const onlyActiveStaff = req.user.role !== 'admin' ? 'WHERE active = true' : '';
    const onlyActivePay = req.user.role !== 'admin' ? "AND e.status='active'" : '';
    const [staff, payments] = await Promise.all([
      query(`SELECT id, name, position, salary, phone, note, active FROM staff ${onlyActiveStaff} ORDER BY active DESC, lower(name)`),
      query(
        `SELECT e.id, to_char(e.doc_date,'YYYY-MM-DD') AS doc_date, e.employee, e.amount,
                e.payment_method, e.comment, e.user_name, e.status, e.cancel_reason
         FROM expenses e
         WHERE (e.category_id=$1 OR (e.employee IS NOT NULL AND e.employee <> ''))
           AND e.doc_date BETWEEN $2::date AND $3::date ${onlyActivePay}
         ORDER BY e.doc_date DESC, e.id DESC LIMIT 300`,
        [catId, from, to]
      ),
    ]);

    const activePay = payments.filter((p) => p.status === 'active');
    const total = r2(activePay.reduce((a, x) => a + Number(x.amount || 0), 0));

    // Сводка сколько выдано каждому работнику за выбранный период
    const byEmpMap = new Map();
    for (const p of activePay) {
      const name = (p.employee || '').trim() || '(не указан)';
      const cur = byEmpMap.get(name) || { employee: name, amount: 0, count: 0 };
      cur.amount = r2(cur.amount + Number(p.amount || 0));
      cur.count += 1;
      byEmpMap.set(name, cur);
    }
    const by_employee = [...byEmpMap.values()].sort((a, b) => b.amount - a.amount);

    return res.status(200).json({ from, to, total, count: activePay.length, staff, by_employee, payments });
  }

  // Изменять штат и выдавать/отменять ЗП может только администратор
  if (req.user.role !== 'admin') throw fail('управлять зарплатой и работниками может только администратор', 403);

  const target = String(b.target || 'payout');

  // ── 1. Работники теплицы (staff) ──
  if (target === 'staff') {
    if (req.method === 'POST') {
      const dup = await findDuplicate(req, 'staff');
      if (dup) return res.status(200).json(dup);
      const name = String(b.name || '').trim().slice(0, 120);
      if (name.length < 2) throw fail('ФИО работника: минимум 2 символа');
      const position = String(b.position || '').trim().slice(0, 80);
      const salary = b.salary === '' || b.salary == null ? 0 : Number(b.salary);
      if (!Number.isFinite(salary) || salary < 0 || salary > 1e12) throw fail('Неверный оклад');
      const phone = String(b.phone || '').trim().slice(0, 40);
      const note = String(b.note || '').trim().slice(0, 300);

      const [existing] = await query(`SELECT * FROM staff WHERE lower(name)=lower($1)`, [name]);
      if (existing) {
        if (!existing.active) {
          await query(`UPDATE staff SET active=true, position=$1, salary=$2, phone=$3, note=$4 WHERE id=$5`, [position || existing.position, r2(salary) || existing.salary, phone || existing.phone, note || existing.note, existing.id]);
          await audit(req, req.user.name, 'staff_restore', `#${existing.id} ${name}`);
          return res.status(200).json({ ok: true, id: existing.id });
        }
        throw fail('Такой работник уже есть в списке', 409);
      }

      const r = await atomicCreate(req, {
        scope: 'staff',
        table: 'staff',
        values: [
          ['name', 'text', name], ['position', 'text', position],
          ['salary', 'float8', r2(salary)], ['phone', 'text', phone], ['note', 'text', note],
        ],
        action: 'staff_add',
        detail: `${name}${position ? ` (${position})` : ''}`,
      });
      if (r.duplicate) return res.status(200).json(dupReply(r.id));
      return res.status(200).json({ ok: true, id: r.doc.id });
    }

    if (req.method === 'PATCH') {
      const id = Number(b.id);
      const [row] = Number.isInteger(id) ? await query(`SELECT * FROM staff WHERE id=$1`, [id]) : [];
      if (!row) throw fail('Работник не найден', 404);
      const name = b.name !== undefined ? String(b.name || '').trim().slice(0, 120) : row.name;
      if (name.length < 2) throw fail('ФИО работника: минимум 2 символа');
      if (name.toLowerCase() !== row.name.toLowerCase()) {
        const [dup] = await query(`SELECT 1 FROM staff WHERE lower(name)=lower($1) AND id<>$2`, [name, id]);
        if (dup) throw fail('Такой работник уже есть в списке', 409);
      }
      const position = b.position !== undefined ? String(b.position || '').trim().slice(0, 80) : row.position;
      const salary = b.salary !== undefined ? (b.salary === '' || b.salary == null ? 0 : Number(b.salary)) : Number(row.salary || 0);
      if (!Number.isFinite(salary) || salary < 0 || salary > 1e12) throw fail('Неверный оклад');
      const phone = b.phone !== undefined ? String(b.phone || '').trim().slice(0, 40) : row.phone;
      const note = b.note !== undefined ? String(b.note || '').trim().slice(0, 300) : row.note;
      const active = b.active !== undefined ? Boolean(b.active) : row.active;

      await query(
        `UPDATE staff SET name=$1, position=$2, salary=$3, phone=$4, note=$5, active=$6 WHERE id=$7`,
        [name, position, r2(salary), phone, note, active, id]
      );
      await audit(req, req.user.name, 'staff_edit', `#${id} ${name} active=${active}`);
      return res.status(200).json({ ok: true });
    }
    throw fail('неподдерживаемый метод', 405);
  }

  // ── 2. Выдача ЗП / Аванса / Премии (пишется в expenses с категорией «Зарплата») ──
  if (req.method === 'POST') {
    const dup = await findDuplicate(req, 'payroll');
    if (dup) return res.status(200).json(dup);
    const day = docDate(b.doc_date);
    const employee = String(b.employee || '').trim().slice(0, 120);
    if (employee.length < 2) throw fail('Выберите работника');
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail('Укажите корректную сумму');
    const rounded = r2(amount);
    const pm = PAY_METHODS.has(b.payment_method) ? b.payment_method : 'cash';
    const payKind = PAY_KINDS.has(b.pay_kind) ? b.pay_kind : 'Зарплата';
    const period = String(b.period || '').trim().slice(0, 30);
    const extra = String(b.comment || '').trim().slice(0, 350);
    const comment = [payKind, period ? `за ${period}` : '', extra].filter(Boolean).join(' · ');
    const catId = await ensureSalaryCategoryId();

    const r = await atomicCreate(req, {
      scope: 'payroll',
      table: 'expenses',
      values: [
        ['doc_date', 'date', day], ['category_id', 'int', catId], ['amount', 'float8', rounded],
        ['counterparty', 'text', ''], ['employee', 'text', employee], ['payment_method', 'text', pm],
        ['doc_number', 'text', ''], ['items', 'jsonb', '[]'], ['comment', 'text', comment], ['user_name', 'text', req.user.name],
      ],
      action: 'payroll_add',
      detail: `${employee} ${rounded} (${payKind})`,
    });
    if (r.duplicate) return res.status(200).json(dupReply(r.id));
    return res.status(200).json({ ok: true, id: r.doc.id });
  }

  if (req.method === 'PATCH') {
    const id = Number(b.id);
    const [row] = Number.isInteger(id) ? await query(`SELECT * FROM expenses WHERE id=$1`, [id]) : [];
    if (!row) throw fail('Выплата не найдена', 404);

    if (b.action === 'restore') {
      if (row.status === 'active') throw fail('Выплата уже активна', 409);
      const { n } = await atomicUpdate(req, {
        table: 'expenses',
        id,
        where: "status='cancelled'",
        set: [['status', 'text', 'active']],
        setRaw: ['cancel_reason=NULL', 'cancelled_by=NULL', 'cancelled_ts=NULL'],
        action: 'payroll_restore',
        detail: `#${id}`,
      });
      if (!n) throw fail('Выплата уже активна', 409);
      return res.status(200).json({ ok: true, id });
    }

    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!reason) throw fail('Укажите причину отмены');
    if (row.status !== 'active') throw fail('Выплата уже отменена', 409);
    const { n } = await atomicUpdate(req, {
      table: 'expenses',
      id,
      set: [['status', 'text', 'cancelled'], ['cancel_reason', 'text', reason], ['cancelled_by', 'text', req.user.name]],
      setRaw: ['cancelled_ts=now()'],
      action: 'payroll_cancel',
      detail: `#${id} ${reason}`,
    });
    if (!n) throw fail('Выплата уже отменена', 409);
    return res.status(200).json({ ok: true });
  }

  throw fail('неподдерживаемый метод', 405);
}

module.exports = { handlePayroll };
