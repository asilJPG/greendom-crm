const { query } = require('../lib/db');
const { handler } = require('../lib/http');

// Кто вошёл и состояние моноблока. Доступно и тем, кому ещё нужно сменить временный пароль (без данных склада).
module.exports = handler(
  async (req, res) => {
    const user = { name: req.user.name, role: req.user.role, must_change: req.user.must_change };
    if (req.user.must_change) return res.status(200).json({ user, devices: [] });
    const devices = await query(
      `SELECT device, crop, currency, grades, pending,
              floor(extract(epoch FROM (now() - last_seen)))::int AS seconds_ago
       FROM devices ORDER BY device`
    );
    res.status(200).json({ user, devices });
  },
  { allowMustChange: true }
);
