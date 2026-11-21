// Первичная настройка: создаёт первого администратора. Работает только пока в базе нет ни одного пользователя
// и только с одноразовым ключом установки (SETUP_KEY из настроек проекта).
const { query, transaction, ensureSchema } = require('../lib/db');
const { checkOrigin, logError } = require('../lib/http');
const { safeEqual, hashPassword, encryptPassword, clientIp } = require('../lib/auth');

// Ключ блокировки первичной настройки: параллельные запросы выполняются по очереди.
const SETUP_LOCK = 774202;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });
  if (!checkOrigin(req)) return res.status(403).json({ error: 'недопустимый источник запроса' });
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
    // Самостоятельной смены пароля больше нет: пароли задаёт только администратор и они постоянные,
    // поэтому флаг temporary игнорируется, must_change всегда false.
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Имя: от 2 до 40 символов' });
    // Держатель SETUP_KEY (владелец) вправе задать и короткий пароль первому админу; все остальные пароли
    // (создание пользователей и сброс админом) проходят через MIN_PASSWORD в users.js.
    if (password.length < 4) return res.status(400).json({ error: 'Пароль слишком короткий (минимум 4 символа)' });
    // Проверка «пользователей ещё нет», создание админа и запись в журнал — одной транзакцией под блокировкой:
    // из двух одновременных запросов админа создаст только один, второй получит 409.
    const out = await transaction([
      [`SELECT pg_advisory_xact_lock(${SETUP_LOCK})`, []],
      [
        `WITH ins AS (
           INSERT INTO app_users(name, role, pass_hash, pass_enc, must_change)
           SELECT $1::text, 'admin', $2::text, $3::text, false
           WHERE NOT EXISTS (SELECT 1 FROM app_users)
           RETURNING id),
         a AS (INSERT INTO audit_log(user_name, action, detail, ip)
               SELECT $1::text, 'setup', 'создан первый администратор', $4::text FROM ins RETURNING id)
         SELECT count(*)::int AS n FROM ins`,
        [name, hashPassword(password), encryptPassword(password), ip],
      ],
    ]);
    if (!out[1][0].n) return res.status(409).json({ error: 'Первичная настройка уже выполнена' });
    res.status(200).json({ ok: true, name, must_change: false });
  } catch (e) {
    logError('setup', e);
    res.status(500).json({ error: 'внутренняя ошибка' });
  }
};
