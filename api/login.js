const { query, ensureSchema } = require('../lib/db');
const { checkOrigin, logError } = require('../lib/http');
const { verifyPassword, encryptPassword, DUMMY_HASH, makeSessionValue, sessionCookie, clientIp, audit } = require('../lib/auth');

// Вход по одному паролю: имени нет, пароль определяет пользователя и его роль.
// Из-за этого подбор проще (достаточно угадать пароль любого пользователя), поэтому два предела:
// по адресу и общий по всему сайту (общий закрывает распределённый перебор, но позволяет на 15 минут закрыть вход всем).
const MAX_FAILS_IP = 5;
const MAX_FAILS_ALL = 25;
const WINDOW_MIN = 15;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });
  if (!checkOrigin(req)) return res.status(403).json({ error: 'недопустимый источник запроса' });
  try {
    await ensureSchema();
    const ip = clientIp(req);
    const password = String((req.body || {}).password || '');

    const [{ ipn, alln }] = await query(
      `SELECT count(*) FILTER (WHERE ip=$1)::int AS ipn, count(*)::int AS alln
       FROM login_fails WHERE ts > now() - ($2 || ' minutes')::interval AND name IS DISTINCT FROM 'passkey'`,
      [ip, String(WINDOW_MIN)]
    );
    if (ipn >= MAX_FAILS_IP || alln >= MAX_FAILS_ALL) {
      return res.status(423).json({ error: `Слишком много неверных попыток. Подождите ${WINDOW_MIN} минут` });
    }

    const users = await query('SELECT * FROM app_users WHERE active ORDER BY id');
    let match = null;
    // Проверяем пароль против каждого активного пользователя без раннего выхода: время не выдаёт, чей это пароль.
    for (const u of users) if (verifyPassword(password, u.pass_hash) && !match) match = u;
    if (!users.length) verifyPassword(password, DUMMY_HASH);

    if (!match) {
      await query('INSERT INTO login_fails(ip) VALUES ($1)', [ip]);
      await audit(req, null, 'login_fail');
      await new Promise((r) => setTimeout(r, 500)); // замедляем подбор
      return res.status(401).json({ error: 'Неверный пароль' });
    }
    await query('DELETE FROM login_fails WHERE ip=$1', [ip]);
    if (!match.pass_enc) {
      await query('UPDATE app_users SET last_login=now(), pass_enc=$1 WHERE id=$2', [encryptPassword(password), match.id]);
    } else {
      await query('UPDATE app_users SET last_login=now() WHERE id=$1', [match.id]);
    }
    await audit(req, match.name, 'login');
    res.setHeader('Set-Cookie', sessionCookie(makeSessionValue(match), 12 * 3600));
    res.status(200).json({ ok: true, name: match.name, role: match.role, must_change: false });
  } catch (e) {
    logError('login', e);
    res.status(500).json({ error: 'внутренняя ошибка' });
  }
};
