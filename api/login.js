const { query, ensureSchema } = require('../lib/db');
const { passwords, safeEqual, makeSessionValue, sessionCookie, clientIp } = require('../lib/auth');

const MAX_FAILS = 5;
const WINDOW_MIN = 15;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });
  try {
    const list = passwords();
    if (!list.length) return res.status(500).json({ error: 'пароль для сайта не настроен (DASHBOARD_PASSWORDS)' });
    await ensureSchema();
    const ip = clientIp(req);
    const [{ n }] = await query(
      `SELECT count(*)::int AS n FROM login_fails WHERE ip=$1 AND ts > now() - ($2 || ' minutes')::interval`,
      [ip, String(WINDOW_MIN)]
    );
    if (n >= MAX_FAILS) {
      return res.status(423).json({ error: `Слишком много неверных попыток. Подождите ${WINDOW_MIN} минут` });
    }
    const given = String((req.body || {}).password || '');
    const ok = list.some((p) => safeEqual(given, p));
    if (!ok) {
      await query('INSERT INTO login_fails(ip) VALUES ($1)', [ip]);
      await new Promise((r) => setTimeout(r, 500)); // замедляем подбор
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    await query('DELETE FROM login_fails WHERE ip=$1', [ip]);
    res.setHeader('Set-Cookie', sessionCookie(makeSessionValue(), 12 * 3600));
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'внутренняя ошибка' });
  }
};
