// Операции с сайта (приход, продажа, списание, отмена, исправление). Сайт ничего не меняет сам: операция ставится в очередь,
// моноблок (источник правды) забирает её при обмене, проверяет теми же правилами, что и локальный ввод, и отвечает.
const { query } = require('../lib/db');
const { handler } = require('../lib/http');
const { audit } = require('../lib/auth');

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, max, required = false, label = 'поле') => {
  const s = String(v ?? '').trim().slice(0, max);
  if (required && !s) throw fail(`${label}: обязательно`);
  return s;
};
const num = (v, label, { min = 0, max = 100000, strict = true } = {}) => {
  const x = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(x) || (strict ? x <= min : x < min) || x > max) throw fail(`${label}: неверное значение`);
  return x;
};
const id = (v, label) => {
  const x = Number(v);
  if (!Number.isInteger(x) || x < 1) throw fail(`${label}: неверный номер`);
  return x;
};

// Единственное место, где разбирается payload: наружу уходит только то, что мы сами собрали из разрешённых полей.
function clean(kind, p, grades) {
  const grade = (v) => {
    const g = str(v, 60, true, 'сорт');
    if (grades.length && !grades.includes(g)) throw fail('неизвестный сорт');
    return g;
  };
  if (kind === 'intake') return { grade: grade(p.grade), net_kg: num(p.net_kg, 'вес'), worker: str(p.worker, 120), note: str(p.note, 300) };
  if (kind === 'writeoff') return { grade: grade(p.grade), net_kg: num(p.net_kg, 'вес'), reason: str(p.reason, 300, true, 'причина') };
  if (kind === 'sale') {
    if (!Array.isArray(p.items) || !p.items.length || p.items.length > 50) throw fail('в продаже нет позиций');
    return {
      customer: str(p.customer, 120, true, 'покупатель'), note: str(p.note, 300),
      items: p.items.map((it) => ({
        grade: grade(it.grade), net_kg: num(it.net_kg, 'вес'),
        price_per_kg: it.price_per_kg === '' || it.price_per_kg == null ? null : num(it.price_per_kg, 'цена', { min: 0, max: 1e9, strict: false }),
        amount: num(it.amount, 'сумма', { min: 0, max: 1e12, strict: false }),
      })),
    };
  }
  if (kind === 'cancel_movement' || kind === 'cancel_sale') return { id: id(p.id, 'запись'), reason: str(p.reason, 300, true, 'причина') };
  if (kind === 'edit') {
    const out = { id: id(p.id, 'запись'), reason: str(p.reason, 300, true, 'причина') };
    if (p.grade !== undefined && p.grade !== null && p.grade !== '') out.grade = grade(p.grade);
    if (p.net_kg !== undefined && p.net_kg !== null && p.net_kg !== '') out.net_kg = num(p.net_kg, 'вес');
    if (p.worker !== undefined) out.worker = str(p.worker, 120);
    if (p.note !== undefined) out.note = str(p.note, 300);
    if (p.customer !== undefined && p.customer !== '') out.customer = str(p.customer, 120, true, 'покупатель');
    if (p.price_per_kg !== undefined && p.price_per_kg !== '' && p.price_per_kg !== null) out.price_per_kg = num(p.price_per_kg, 'цена', { min: 0, max: 1e9, strict: false });
    if (p.amount !== undefined && p.amount !== '' && p.amount !== null) out.amount = num(p.amount, 'сумма', { min: 0, max: 1e12, strict: false });
    return out;
  }
  throw fail('неизвестная операция');
}

module.exports = handler(
  async (req, res) => {
    if (req.method === 'GET') {
      // складовщик видит свои операции, админ все
      const mine = req.user.role === 'admin' ? '' : 'WHERE user_name=$1';
      const rows = await query(
        `SELECT id, to_char(ts at time zone 'Asia/Tashkent','YYYY-MM-DD HH24:MI') AS ts, user_name, kind, payload, status, result
         FROM commands ${mine} ORDER BY id DESC LIMIT 30`,
        mine ? [req.user.name] : []
      );
      return res.status(200).json(rows);
    }
    const b = req.body || {};
    const kind = String(b.kind || '');
    try {
      if (kind === 'edit' && req.user.role !== 'admin') return res.status(403).json({ error: 'править записи может только администратор' });
      const [dev] = await query('SELECT device, grades FROM devices ORDER BY last_seen DESC LIMIT 1');
      if (!dev) return res.status(409).json({ error: 'Моноблок ещё ни разу не выходил на связь' });
      const grades = Array.isArray(dev.grades) ? dev.grades.map(String) : [];
      const payload = clean(kind, b.payload || {}, grades);
      const reqId = b.request_id ? String(b.request_id).slice(0, 64) : null;
      const [pend] = await query(`SELECT count(*)::int AS n FROM commands WHERE user_name=$1 AND status='pending'`, [req.user.name]);
      if (pend.n >= 20) return res.status(429).json({ error: 'Слишком много операций ждут моноблок. Дождитесь выполнения' });
      const ins = await query(
        `INSERT INTO commands (device, user_name, user_role, kind, payload, req_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (req_id) WHERE req_id IS NOT NULL DO NOTHING RETURNING id`,
        [dev.device, req.user.name, req.user.role, kind, JSON.stringify(payload), reqId]
      );
      if (!ins.length) return res.status(200).json({ ok: true, duplicate: true }); // та же операция уже принята (двойное нажатие, повтор)
      await audit(req, req.user.name, 'command', `#${ins[0].id} ${kind}`);
      return res.status(200).json({ ok: true, id: ins[0].id });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
  },
  { method: ['GET', 'POST'], roles: ['keeper', 'admin'] }
);
