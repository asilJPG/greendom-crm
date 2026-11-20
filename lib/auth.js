const crypto = require('crypto');

const SESSION_MS = 12 * 3600 * 1000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET не задан или короче 16 символов');
  return s;
}

const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');

function makeSessionValue() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function isLoggedIn(req) {
  const v = readCookie(req, 'cs');
  if (!v) return false;
  const [payload, sig] = v.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
  }
}

function sessionCookie(value, maxAgeSeconds) {
  return `cs=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function passwords() {
  return String(process.env.DASHBOARD_PASSWORDS || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function requireLogin(req, res) {
  if (isLoggedIn(req)) return true;
  res.status(401).json({ error: 'нужно войти' });
  return false;
}

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

module.exports = {
  safeEqual, makeSessionValue, sessionCookie, isLoggedIn, passwords, requireLogin, requireIngestToken, clientIp,
};
