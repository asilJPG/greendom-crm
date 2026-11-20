const { query, ensureSchema } = require('../lib/db');
const { verifyPassword, DUMMY_HASH, makeSessionValue, sessionCookie, clientIp, audit } = require('../lib/auth');

const MAX_FAILS_IP = 5;
const MAX_FAILS_NAME = 8;
const WINDOW_MIN = 15;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });
  try {
    await ensureSchema();
    const ip = clientIp(req);
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 60);
    const password = String(body.password || '');

    const [{ ipn }] = await query(
      `SELECT count(*)::int AS ipn FROM login_fails WHERE ip=$1 AND ts > now() - ($2 || ' minutes')::interval`,
      [ip, String(WINDOW_MIN)]
    );
    const [{ nn }] = await query(
      `SELECT count(*)::int AS nn FROM login_fails WHERE lower(name)=lower($1) AND ts > now() - ($2 || ' minutes')::interval`,
      [name, String(WINDOW_MIN)]
    );
    if (ipn >= MAX_FAILS_IP || nn >= MAX_FAILS_NAME) {
      return res.status(423).json({ error: `Слишком много неверных попыток. Подождите ${WINDOW_MIN} минут` });
    }

    const [user] = await query('SELECT * FROM app_users WHERE lower(name)=lower($1) AND active', [name]);
    const ok = verifyPassword(password, user ? user.pass_hash : DUMMY_HASH) && !!user; // всегда считаем хэш: время не выдаёт существование имени
    if (!ok) {
      await query('INSERT INTO login_fails(ip, name) VALUES ($1,$2)', [ip, name]);
      await audit(req, name, 'login_fail');
      await new Promise((r) => setTimeout(r, 500)); // замедляем подбор
      return res.status(401).json({ error: 'Неверное имя или пароль' });
    }
    await query('DELETE FROM login_fails WHERE ip=$1 OR lower(name)=lower($2)', [ip, name]);
    await query('UPDATE app_users SET last_login=now() WHERE id=$1', [user.id]);
    await audit(req, user.name, 'login');
    res.setHeader('Set-Cookie', sessionCookie(makeSessionValue(user), 12 * 3600));
    res.status(200).json({ ok: true, name: user.name, role: user.role, must_change: user.must_change });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'внутренняя ошибка' });
  }
};
