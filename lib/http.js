const { ensureSchema } = require('./db');
const { requireLogin } = require('./auth');

const TZ = process.env.TZ_NAME || 'Asia/Tashkent';

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
}

function dateRange(from, to) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const d = todayStr();
  return [ok(from) ? from : d, ok(to) ? to : d];
}

// Обёртка: метод, вход, схема БД, единая обработка ошибок (без утечки подробностей наружу).
function handler(fn, { method = 'GET', auth = true } = {}) {
  return async (req, res) => {
    if (req.method !== method) return res.status(405).json({ error: `только ${method}` });
    if (auth && !requireLogin(req, res)) return;
    try {
      await ensureSchema();
      await fn(req, res);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'внутренняя ошибка' });
    }
  };
}

module.exports = { handler, dateRange, todayStr };
