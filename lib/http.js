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

// Обёртка: метод, вход, роль, схема БД, единая обработка ошибок (без утечки подробностей наружу).
// allowMustChange: пускать пользователя, которому ещё нужно сменить временный пароль.
function handler(fn, { method = 'GET', auth = true, admin = false, allowMustChange = false } = {}) {
  const methods = Array.isArray(method) ? method : [method];
  return async (req, res) => {
    if (!methods.includes(req.method)) return res.status(405).json({ error: `только ${methods.join(', ')}` });
    try {
      await ensureSchema();
      if (auth) {
        const u = await getUser(req);
        if (!u) return res.status(401).json({ error: 'нужно войти' });
        if (u.must_change && !allowMustChange) return res.status(403).json({ error: 'Сначала смените пароль', must_change: true });
        if (admin && u.role !== 'admin') return res.status(403).json({ error: 'только для администратора' });
        req.user = u;
      }
      await fn(req, res);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'внутренняя ошибка' });
    }
  };
}

module.exports = { handler, dateRange, todayStr };
