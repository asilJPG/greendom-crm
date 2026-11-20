// Справочники: сорта (grades) и покупатели (customers) — управляются из интерфейса без хардкода.
const { query } = require('./db');
const { audit } = require('./auth');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function getRefs() {
  const [grades, customers] = await Promise.all([
    query(`SELECT id, name, sort_order, active FROM grades ORDER BY active DESC, sort_order, id`),
    query(`SELECT id, name, phone, note, active FROM customers ORDER BY active DESC, lower(name)`),
  ]);
  return { grades, customers };
}

async function handleRefs(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json(await getRefs());
  }

  const b = req.body || {};
  const target = String(b.target || '');

  // ── Сорта (только администратор) ──
  if (target === 'grade') {
    if (req.user.role !== 'admin') throw fail('управлять сортами может только администратор', 403);

    if (req.method === 'POST') {
      const name = String(b.name || '').trim().slice(0, 40);
      if (name.length < 1) throw fail('Укажите название сорта');
      const [dup] = await query(`SELECT 1 FROM grades WHERE lower(name)=lower($1)`, [name]);
      if (dup) throw fail('Такой сорт уже есть', 409);
      const [{ ord }] = await query(`SELECT COALESCE(MAX(sort_order),0)::int + 1 AS ord FROM grades`);
      const [row] = await query(`INSERT INTO grades(name, sort_order) VALUES($1,$2) RETURNING id, name, sort_order, active`, [name, ord]);
      await audit(req, req.user.name, 'grade_add', `#${row.id} ${name}`);
      return res.status(200).json({ ok: true, grade: row });
    }

    if (req.method === 'PATCH') {
      const id = Number(b.id);
      const [g] = Number.isInteger(id) ? await query(`SELECT * FROM grades WHERE id=$1`, [id]) : [];
      if (!g) throw fail('Сорт не найден', 404);
      const name = b.name !== undefined ? String(b.name || '').trim().slice(0, 40) : g.name;
      if (name.length < 1) throw fail('Укажите название сорта');
      if (name.toLowerCase() !== g.name.toLowerCase()) {
        const [dup] = await query(`SELECT 1 FROM grades WHERE lower(name)=lower($1) AND id<>$2`, [name, id]);
        if (dup) throw fail('Такой сорт уже есть', 409);
      }
      const active = b.active !== undefined ? Boolean(b.active) : g.active;
      await query(`UPDATE grades SET name=$1, active=$2 WHERE id=$3`, [name, active, id]);
      if (name !== g.name) {
        await query(`UPDATE movements SET grade=$1, updated_at=now() WHERE grade=$2`, [name, g.name]);
      }
      await audit(req, req.user.name, 'grade_edit', `#${id} ${g.name}→${name} active=${active}`);
      return res.status(200).json({ ok: true });
    }
    throw fail('неподдерживаемый метод', 405);
  }

  // ── Покупатели (добавлять могут admin и keeper прямо из Продажи; редактировать/скрывать — admin) ──
  if (target === 'customer') {
    if (req.method === 'POST') {
      if (!['admin', 'keeper'].includes(req.user.role)) throw fail('нет прав на добавление покупателя', 403);
      const name = String(b.name || '').trim().slice(0, 120);
      if (name.length < 2) throw fail('Имя покупателя: минимум 2 символа');
      const phone = String(b.phone || '').trim().slice(0, 40);
      const note = String(b.note || '').trim().slice(0, 200);
      const [dup] = await query(`SELECT id, name, active FROM customers WHERE lower(name)=lower($1)`, [name]);
      if (dup) {
        if (!dup.active) {
          await query(`UPDATE customers SET active=true WHERE id=$1`, [dup.id]);
          return res.status(200).json({ ok: true, customer: { ...dup, active: true } });
        }
        throw fail('Такой покупатель уже есть', 409);
      }
      const [row] = await query(
        `INSERT INTO customers(name, phone, note) VALUES($1,$2,$3) RETURNING id, name, phone, note, active`,
        [name, phone, note]
      );
      await audit(req, req.user.name, 'customer_add', `#${row.id} ${name}`);
      return res.status(200).json({ ok: true, customer: row });
    }

    if (req.method === 'PATCH') {
      if (req.user.role !== 'admin') throw fail('менять покупателей может только администратор', 403);
      const id = Number(b.id);
      const [c] = Number.isInteger(id) ? await query(`SELECT * FROM customers WHERE id=$1`, [id]) : [];
      if (!c) throw fail('Покупатель не найден', 404);
      const name = b.name !== undefined ? String(b.name || '').trim().slice(0, 120) : c.name;
      if (name.length < 2) throw fail('Имя покупателя: минимум 2 символа');
      if (name.toLowerCase() !== c.name.toLowerCase()) {
        const [dup] = await query(`SELECT 1 FROM customers WHERE lower(name)=lower($1) AND id<>$2`, [name, id]);
        if (dup) throw fail('Такой покупатель уже есть', 409);
      }
      const phone = b.phone !== undefined ? String(b.phone || '').trim().slice(0, 40) : c.phone;
      const note = b.note !== undefined ? String(b.note || '').trim().slice(0, 200) : c.note;
      const active = b.active !== undefined ? Boolean(b.active) : c.active;
      await query(`UPDATE customers SET name=$1, phone=$2, note=$3, active=$4 WHERE id=$5`, [name, phone, note, active, id]);
      await audit(req, req.user.name, 'customer_edit', `#${id} ${name} active=${active}`);
      return res.status(200).json({ ok: true });
    }
    throw fail('неподдерживаемый метод', 405);
  }

  throw fail('неизвестный справочник');
}

module.exports = { getRefs, handleRefs };
