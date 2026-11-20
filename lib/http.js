const { ensureSchema } = require('./db');
const { getUser } = require('./auth');

const TZ = process.env.TZ_NAME || 'Asia/Tashkent';

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
}

function dateRange(from, to) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const d = todayStr();
  return [ok(from) ? from : d, ok(to) ? to : d];
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
      console.error(e);
      res.status(500).json({ error: 'внутренняя ошибка' });
    }
  };
}

module.exports = { handler, dateRange, todayStr, TZ };
