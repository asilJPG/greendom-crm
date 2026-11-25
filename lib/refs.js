// Справочники: сорта (grades) и покупатели (customers) — управляются из интерфейса без хардкода.
const { query } = require('./db');
const { audit } = require('./auth');
const { findDuplicate, dupReply, atomicCreate, atomicUpdate, uniqueAs409 } = require('./http');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

const KINDS = new Set(['buyer', 'supplier', 'employee', 'both']);

async function getRefs() {
  const [grades, customers] = await Promise.all([
    query(`SELECT id, name, sort_order, active FROM grades ORDER BY active DESC, sort_order, id`),
    query(`SELECT id, name, kind, inn, phone, contact_person, telegram, address, payment_terms, bank_details, note, active FROM customers ORDER BY active DESC, lower(name)`),
  ]);
  return { grades, customers };
}

// Переименование сорта: записи всех устройств + алиас «старое → новое» для моноблоков (они ещё могут прислать старое имя
// и по алиасу переименуют свои записи и config.json). Под той же блокировкой, что и операции с сайта: updated_at веб-строк
// растёт монотонно, зеркало для моноблока (курсор по updated_at) ничего не пропустит.
async function renameGrade(id, oldName, newName, active) {
  const { transaction } = require('./db');
  const { WEB_LOCK } = require('./warehouse');
  await transaction([
    [`SELECT pg_advisory_xact_lock(${WEB_LOCK})`, []],
    [`UPDATE grades SET name=$1, active=$2 WHERE id=$3`, [newName, active, id]],
    [`UPDATE movements SET grade=$1, updated_at=clock_timestamp() WHERE grade=$2`, [newName, oldName]],
    // цепочки: A→B и теперь B→C ⇒ A→C
    [`UPDATE grade_aliases SET new_name=$1, ts=now() WHERE new_name=$2`, [newName, oldName]],
    // новое имя снова стало настоящим сортом — его старый алиас больше не действует
    [`DELETE FROM grade_aliases WHERE old_name=$1`, [newName]],
    [`INSERT INTO grade_aliases(old_name, new_name) VALUES($1,$2)
      ON CONFLICT (old_name) DO UPDATE SET new_name=EXCLUDED.new_name, ts=now()`, [oldName, newName]],
  ]);
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
      if (name !== g.name) {
        await renameGrade(id, g.name, name, active);
      } else {
        await query(`UPDATE grades SET active=$1 WHERE id=$2`, [active, id]);
      }
      await audit(req, req.user.name, 'grade_edit', `#${id} ${g.name}→${name} active=${active}`);
      return res.status(200).json({ ok: true });
    }
    throw fail('неподдерживаемый метод', 405);
  }

  // ── Контрагенты (покупатели, поставщики, сотрудники) ──
  if (target === 'customer') {
    if (req.method === 'POST') {
      // Создаёт администратор, бухгалтер или складовщик (быстрое добавление покупателя из продажи). Директор — только просмотр.
      if (!['admin', 'keeper', 'accountant'].includes(req.user.role)) throw fail('нет прав на добавление контрагента', 403);
      const again = await findDuplicate(req, 'customer');
      if (again) return res.status(200).json(again);
      const name = String(b.name || '').trim().slice(0, 120);
      if (name.length < 2) throw fail('Название/имя: минимум 2 символа');
      const kind = KINDS.has(b.kind) ? b.kind : 'buyer';
      const inn = String(b.inn || '').trim().slice(0, 30);
      const phone = String(b.phone || '').trim().slice(0, 40);
      const contact_person = String(b.contact_person || '').trim().slice(0, 120);
      const telegram = String(b.telegram || '').trim().slice(0, 60);
      const address = String(b.address || '').trim().slice(0, 200);
      const payment_terms = String(b.payment_terms || '').trim().slice(0, 120);
      const bank_details = String(b.bank_details || '').trim().slice(0, 300);
      const note = String(b.note || '').trim().slice(0, 500);
      const [dup] = await query(
        `SELECT id FROM customers WHERE lower(name)=lower($1) AND active=true`,
        [name]
      );
      if (dup) throw fail('Контрагент с таким названием уже существует', 409);
      const r = await atomicCreate(req, {
        scope: 'customer',
        table: 'customers',
        values: [
          ['name', 'text', name], ['kind', 'text', kind], ['inn', 'text', inn], ['phone', 'text', phone],
          ['contact_person', 'text', contact_person], ['telegram', 'text', telegram], ['address', 'text', address],
          ['payment_terms', 'text', payment_terms], ['bank_details', 'text', bank_details], ['note', 'text', note],
        ],
        returning: 'id, name, kind, inn, phone, contact_person, telegram, address, payment_terms, bank_details, note, active',
        action: 'customer_add',
        detail: `${name} (${kind})`,
      }).catch(uniqueAs409('Контрагент с таким названием уже существует'));
      if (r.duplicate) return res.status(200).json(dupReply(r.id));
      return res.status(200).json({ ok: true, customer: r.doc });
    }

    if (req.method === 'PATCH') {
      if (req.user.role !== 'admin') throw fail('менять контрагентов может только администратор', 403);
      const id = Number(b.id);
      const [c] = Number.isInteger(id) ? await query(`SELECT * FROM customers WHERE id=$1`, [id]) : [];
      if (!c) throw fail('Контрагент не найден', 404);
      const name = b.name !== undefined ? String(b.name || '').trim().slice(0, 120) : c.name;
      if (name.length < 2) throw fail('Название/имя: минимум 2 символа');
      const active = b.active !== undefined ? Boolean(b.active) : c.active;
      if (active) {
        const [dup] = await query(`SELECT 1 FROM customers WHERE lower(name)=lower($1) AND active=true AND id<>$2`, [name, id]);
        if (dup) {
          throw fail(!c.active
            ? 'Контрагент с таким названием уже существует — переименуйте или удалите действующего'
            : 'Контрагент с таким названием уже существует', 409);
        }
      }
      const kind = b.kind !== undefined && KINDS.has(b.kind) ? b.kind : c.kind;
      const inn = b.inn !== undefined ? String(b.inn || '').trim().slice(0, 30) : c.inn;
      const phone = b.phone !== undefined ? String(b.phone || '').trim().slice(0, 40) : c.phone;
      const contact_person = b.contact_person !== undefined ? String(b.contact_person || '').trim().slice(0, 120) : (c.contact_person || '');
      const telegram = b.telegram !== undefined ? String(b.telegram || '').trim().slice(0, 60) : (c.telegram || '');
      const address = b.address !== undefined ? String(b.address || '').trim().slice(0, 200) : (c.address || '');
      const payment_terms = b.payment_terms !== undefined ? String(b.payment_terms || '').trim().slice(0, 120) : (c.payment_terms || '');
      const bank_details = b.bank_details !== undefined ? String(b.bank_details || '').trim().slice(0, 300) : (c.bank_details || '');
      const note = b.note !== undefined ? String(b.note || '').trim().slice(0, 500) : c.note;
      const act = !c.active && active ? 'customer_restore' : c.active && !active ? 'customer_delete' : 'customer_edit';
      await atomicUpdate(req, {
        table: 'customers',
        id,
        where: 'true',
        set: [
          ['name', 'text', name], ['kind', 'text', kind], ['inn', 'text', inn], ['phone', 'text', phone],
          ['contact_person', 'text', contact_person], ['telegram', 'text', telegram], ['address', 'text', address],
          ['payment_terms', 'text', payment_terms], ['bank_details', 'text', bank_details], ['note', 'text', note],
          ['active', 'boolean', active],
        ],
        action: act,
        detail: `#${id} ${name} (${kind}) active=${active}`,
      }).catch(uniqueAs409('Контрагент с таким названием уже существует'));
      return res.status(200).json({ ok: true });
    }
    throw fail('неподдерживаемый метод', 405);
  }

  throw fail('неизвестный справочник');
}

module.exports = { getRefs, handleRefs };
