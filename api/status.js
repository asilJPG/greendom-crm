const { query } = require('../lib/db');
const { handler, todayStr } = require('../lib/http');
const { getRefs, handleRefs } = require('../lib/refs');

// Кто вошёл, состояние моноблока и справочники (сорта, покупатели).
module.exports = handler(
  async (req, res) => {
    if (req.query.resource === 'refs') return handleRefs(req, res);
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
