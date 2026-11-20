const crypto = require('crypto');
const { query } = require('./db');

const SESSION_MS = 12 * 3600 * 1000;
const MIN_PASSWORD = 6;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// ───── пароли: хранится только необратимый хэш scrypt ─────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  return safeEqual(h.toString('hex'), hash);
}

const DUMMY_HASH = hashPassword('dummy-password-for-timing');

// Вход по одному паролю: пароль определяет человека, поэтому он должен быть уникален среди ВСЕХ пользователей
// (и отключённых тоже, чтобы после включения не получилось двух владельцев одного пароля).
async function passwordTaken(pw, exceptId = null) {
  const rows = await query('SELECT id, pass_hash FROM app_users');
  let taken = false;
  for (const r of rows) if (r.id !== exceptId && verifyPassword(pw, r.pass_hash)) taken = true; // перебираем всех: время не зависит от результата
  return taken;
}

// ───── сессия: подписанная cookie с номером версии (смена пароля или отключение отменяют вход) ─────
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET не задан или короче 16 символов');
  return s;
}

const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');

function makeSessionValue(user) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, v: user.token_version, exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function sessionCookie(value, maxAgeSeconds) {
  return `cs=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

async function getUser(req) {
  const v = readCookie(req, 'cs');
  if (!v) return null;
  const [payload, sig] = v.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (!(data.exp > Date.now()) || !Number.isInteger(data.uid)) return null;
  const [u] = await query(
    'SELECT id, name, role, active, must_change, token_version FROM app_users WHERE id=$1',
    [data.uid]
  );
  if (!u || !u.active || u.token_version !== data.v) return null;
  return u;
}

// ───── ключ приёмника (моноблок) ─────
function requireIngestToken(req, res) {
  const token = process.env.INGEST_TOKEN || '';
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token.length < 16 || !safeEqual(given, token)) {
    res.status(401).json({ error: 'неверный ключ' });
    return false;
  }
  return true;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

async function audit(req, userName, action, detail = '') {
  try {
    await query('INSERT INTO audit_log(user_name, action, detail, ip) VALUES ($1,$2,$3,$4)', [userName || null, action, String(detail).slice(0, 500), clientIp(req)]);
  } catch (e) {
    console.error('audit', e);
  }
}

module.exports = {
  MIN_PASSWORD, safeEqual, hashPassword, verifyPassword, passwordTaken, DUMMY_HASH, makeSessionValue, sessionCookie,
  getUser, requireIngestToken, clientIp, audit,
};
