const { ensureSchema, query } = require('./db');
const { getUser } = require('./auth');

const TZ = process.env.TZ_NAME || 'Asia/Tashkent';

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
}

// Настоящая календарная дата YYYY-MM-DD (2026-02-30 и 2026-13-01 не проходят).
function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2999) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Дата документа: пусто -> fallback (обычно сегодня), иначе только настоящая дата, иначе 400.
function docDate(v, fallback = todayStr()) {
  if (v === undefined || v === null || v === '') return fallback;
  if (!isValidDate(v)) throw fail('Неверная дата');
  return String(v);
}

function dateRange(from, to) {
  const d = todayStr();
  return [docDate(from, d), docDate(to, d)];
}

// Защита от CSRF на мутирующих запросах: если браузер прислал Origin, он обязан совпадать с Host.
function checkOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers?.origin;
  const host = req.headers?.host;
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// В журнал сервера — только код и текст ошибки (без SQL-параметров, паролей и стеков с данными).
function logError(tag, e) {
  console.error(tag, (e && e.code) || '', (e && e.message) || String(e));
}

// ───── Атомарные денежные записи ─────
// Ключ идемпотентности, документ (со всеми строками) и запись журнала пишутся ОДНИМ SQL-запросом в транзакции:
// сбой на любом шаге откатывает всё (ключ остаётся свободным, повтор пройдёт), а занятый ключ значит, что документ записан.
// Повтор с тем же request_id -> { ok: true, duplicate: true, id } без второй записи.

// request_id запроса -> ключ `${scope}:${rid}` (или null, если request_id не передан).
function idemKey(req, scope) {
  const raw = (req.body || {}).request_id;
  if (raw === undefined || raw === null || raw === '') return null;
  const rid = String(raw);
  if (rid.length > 100) throw fail('request_id слишком длинный');
  return `${scope}:${rid}`;
}

// Быстрый ответ на повтор до проверок (чтобы повтор не получил, например, 409 «уже есть»). Только чтение.
async function findDuplicate(req, scope) {
  const key = idemKey(req, scope);
  if (!key) return null;
  const [row] = await query(`SELECT doc_id FROM idempotency_keys WHERE key=$1`, [key]);
  return row ? dupReply(row.doc_id) : null;
}

function dupReply(id) {
  return id === null || id === undefined ? { ok: true, duplicate: true } : { ok: true, duplicate: true, id };
}

// Сборщик параметров: p(value, 'type') -> '$n::type'.
function paramList() {
  const params = [];
  const p = (v, type) => {
    params.push(v === undefined ? null : v);
    return `$${params.length}::${type}`;
  };
  return { params, p };
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name) {
  if (!IDENT.test(name)) throw new Error(`недопустимое имя ${name}`);
  return name;
}

function auditParts(req, p, action, detailSql) {
  const { clientIp } = require('./auth');
  return `INSERT INTO audit_log(user_name, action, detail, ip)
          SELECT ${p(req.user ? req.user.name : null, 'text')}, ${p(action, 'text')}, left(${detailSql}, 500), ${p(clientIp(req), 'text')}`;
}

// Создание документа: { scope, table, values: [[col, type, value], ...], returning, action, detail }.
// В журнал пишется «#<id> <detail>». Ответ: { doc } (строка RETURNING) или { duplicate: true, id }.
async function atomicCreate(req, { scope, table, values, returning = 'id', action, detail = '' }) {
  const { transaction } = require('./db');
  const key = idemKey(req, scope);
  const { params, p } = paramList();
  const kP = p(key, 'text');
  const cols = values.map(([c]) => ident(c));
  const exprs = values.map(([, type, v]) => p(v, type));
  const sql = `WITH
    nid AS (SELECT nextval(pg_get_serial_sequence('${ident(table)}', 'id'))::int AS id),
    k AS (INSERT INTO idempotency_keys(key, user_name, doc_id)
          SELECT ${kP}, ${p(req.user ? req.user.name : null, 'text')}, nid.id FROM nid WHERE ${kP} IS NOT NULL
          ON CONFLICT (key) DO NOTHING RETURNING doc_id),
    go AS (SELECT id FROM nid WHERE ${kP} IS NULL OR EXISTS (SELECT 1 FROM k)),
    d AS (INSERT INTO ${table}(id, ${cols.join(', ')}) SELECT go.id, ${exprs.join(', ')} FROM go RETURNING ${returning}),
    a AS (${auditParts(req, p, action, `'#' || d.id || ' ' || ${p(String(detail), 'text')}`)} FROM d RETURNING id)
    SELECT (SELECT row_to_json(d) FROM d) AS doc`;
  const list = [[sql, params]];
  // Ключ был занят (в т.ч. параллельным запросом, уже закоммиченным): следующий запрос транзакции видит его запись.
  if (key) list.push([`SELECT doc_id FROM idempotency_keys WHERE key=$1`, [key]]);
  const out = await transaction(list);
  const doc = out[0][0] && out[0][0].doc;
  if (doc) return { doc };
  const prev = key ? out[1][0] : null;
  return { duplicate: true, id: prev ? prev.doc_id : null };
}

// Правка/отмена документа: строка блокируется (FOR UPDATE), меняется и журналируется одним запросом.
// { table, id, set: [[col, type, value], ...], setRaw: ['col=expr'], where, action, detail, scope? }.
// Если передан scope и request_id — ключ занимается только вместе с изменением.
// Ответ: { n } (сколько строк изменено, 0 или 1) или { duplicate: true, id }.
async function atomicUpdate(req, { table, id, set = [], setRaw = [], where = "status='active'", action, detail = '', scope = null }) {
  const { transaction } = require('./db');
  const key = scope ? idemKey(req, scope) : null;
  const { params, p } = paramList();
  const idP = p(id, 'int');
  const kP = p(key, 'text');
  const sets = [...set.map(([c, type, v]) => `${ident(c)}=${p(v, type)}`), ...setRaw];
  const sql = `WITH
    t AS (SELECT id FROM ${ident(table)} WHERE id=${idP} AND (${where}) FOR UPDATE),
    k AS (INSERT INTO idempotency_keys(key, user_name, doc_id)
          SELECT ${kP}, ${p(req.user ? req.user.name : null, 'text')}, t.id FROM t WHERE ${kP} IS NOT NULL
          ON CONFLICT (key) DO NOTHING RETURNING doc_id),
    u AS (UPDATE ${table} x SET ${sets.join(', ')}
          FROM t WHERE x.id=t.id AND (${kP} IS NULL OR EXISTS (SELECT 1 FROM k)) RETURNING x.id),
    a AS (${auditParts(req, p, action, p(String(detail), 'text'))} FROM u RETURNING id)
    SELECT (SELECT count(*) FROM u)::int AS n`;
  const list = [[sql, params]];
  if (key) list.push([`SELECT doc_id FROM idempotency_keys WHERE key=$1`, [key]]);
  const out = await transaction(list);
  const n = out[0][0].n;
  if (!n && key && out[1][0]) return { duplicate: true, id: out[1][0].doc_id };
  return { n };
}

// Ошибка уникальности (параллельная вставка того же имени) -> понятный 409 вместо 500.
function uniqueAs409(msg) {
  return (e) => {
    if (e && e.code === '23505' && !String(e.message || '').includes('idempotency_keys')) throw fail(msg, 409);
    throw e;
  };
}

// Единая обёртка маршрута: метод, CSRF-проверка, схема БД, вход, роль, must_change, обработка ошибок.
function handler(fn, { method = 'GET', auth = true, admin = false, roles = null, allowMustChange = false } = {}) {
  const methods = Array.isArray(method) ? method : [method];
  return async (req, res) => {
    if (res.setHeader) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (!methods.includes(req.method)) return res.status(405).json({ error: `только ${methods.join(', ')}` });
    if (!checkOrigin(req)) return res.status(403).json({ error: 'недопустимый источник запроса' });
    try {
      await ensureSchema();
      if (auth) {
        const u = await getUser(req);
        if (!u) return res.status(401).json({ error: 'нужно войти' });
        if (u.must_change && !allowMustChange) return res.status(403).json({ error: 'Сначала смените пароль', must_change: true });
        if (admin && u.role !== 'admin') return res.status(403).json({ error: 'только для администратора' });
        if (roles && !roles.includes(u.role)) return res.status(403).json({ error: 'нет прав на это действие' });
        req.user = u;
      }
      await fn(req, res);
    } catch (e) {
      if (e.status && e.status >= 400 && e.status < 500) {
        return res.status(e.status).json({ error: e.message });
      }
      logError('api', e);
      res.status(500).json({ error: 'внутренняя ошибка' });
    }
  };
}

module.exports = { handler, dateRange, docDate, isValidDate, todayStr, checkOrigin, logError, idemKey, findDuplicate, dupReply, atomicCreate, atomicUpdate, uniqueAs409, fail, TZ };
