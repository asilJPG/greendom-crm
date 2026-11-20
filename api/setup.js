// Первичная настройка: создаёт первого администратора. Работает только пока в базе нет ни одного пользователя
// и только с одноразовым ключом установки (SETUP_KEY из настроек проекта).
const { query, ensureSchema } = require('../lib/db');
const { safeEqual, hashPassword, clientIp, audit } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });
  try {
    await ensureSchema();
    const ip = clientIp(req);
    const [{ n }] = await query(
      `SELECT count(*)::int AS n FROM login_fails WHERE ip=$1 AND ts > now() - interval '15 minutes'`,
      [ip]
    );
    if (n >= 5) return res.status(423).json({ error: 'Слишком много попыток. Подождите 15 минут' });
    const key = process.env.SETUP_KEY || '';
    const b = req.body || {};
    if (key.length < 16 || !safeEqual(String(b.key || ''), key)) {
      await query('INSERT INTO login_fails(ip, name) VALUES ($1, $2)', [ip, 'setup']);
      return res.status(401).json({ error: 'неверный ключ установки' });
    }
    const [{ users }] = await query('SELECT count(*)::int AS users FROM app_users');
    if (users > 0) return res.status(409).json({ error: 'Первичная настройка уже выполнена' });
    const name = String(b.name || '').trim();
    const password = String(b.password || '');
    const temporary = Boolean(b.temporary); // true: при первом входе сайт потребует сменить пароль
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Имя: от 2 до 40 символов' });
    // Держатель SETUP_KEY (владелец) вправе задать и короткий пароль первому админу; все остальные пароли
    // (смена, создание пользователей) проходят через MIN_PASSWORD в password.js / users.js.
    if (password.length < 4) return res.status(400).json({ error: 'Пароль слишком короткий (минимум 4 символа)' });
    await query(
      `INSERT INTO app_users(name, role, pass_hash, must_change) VALUES ($1, 'admin', $2, $3)`,
      [name, hashPassword(password), temporary]
    );
    await audit(req, name, 'setup', 'создан первый администратор');
    res.status(200).json({ ok: true, name, must_change: temporary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'внутренняя ошибка' });
  }
};
