const { query } = require('../lib/db');
const { handler, todayStr } = require('../lib/http');
const { getRefs, handleRefs } = require('../lib/refs');
const { sendTelegram } = require('../lib/telegram');

// Кто вошёл, состояние моноблока и справочники (сорта, покупатели).
module.exports = handler(
  async (req, res) => {
    if (req.query.resource === 'refs') return handleRefs(req, res);
    if (req.query.resource === 'tgtest') return tgTest(req, res);
    if (req.method !== 'GET') return res.status(405).json({ error: 'только GET' });

    const user = { name: req.user.name, role: req.user.role, must_change: false };
    const today = todayStr(); // «сегодня» по Ташкенту: фронтенд не должен считать дату по часам устройства
    const [devices, refs] = await Promise.all([
      query(
        `SELECT device, crop, currency, grades, pending,
                floor(extract(epoch FROM (now() - last_seen)))::int AS seconds_ago
         FROM devices ORDER BY device`
      ),
      getRefs(),
    ]);
    res.status(200).json({
      user,
      today,
      devices,
      grades: refs.grades.filter((g) => g.active).map((g) => g.name),
      customers: refs.customers.filter((c) => c.active),
    });
  },
  { method: ['GET', 'POST', 'PATCH'], allowMustChange: true }
);

// Проверка Telegram: одно тестовое сообщение в группу (в тему TG_THREAD_ID). Только админ.
async function tgTest(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'только для администратора' });
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const time = new Date().toLocaleString('ru-RU', { timeZone: process.env.TZ_NAME || 'Asia/Tashkent' });
  const r = await sendTelegram(`🧪 <b>Тест уведомлений</b>\nПроверил: ${esc(req.user.name)}\n${esc(time)}`, { deadline: Date.now() + 6000 });
  if (!r.configured) return res.status(200).json({ ok: false, error: 'Telegram не настроен (нет токена или ID группы)' });
  const bad = r.results.find((x) => !x.ok);
  res.status(200).json({ ok: r.ok, error: bad ? `Telegram: ${bad.description || 'ошибка ' + bad.status}` : '' });
}
