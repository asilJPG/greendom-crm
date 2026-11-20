const { query } = require('../lib/db');
const { handler } = require('../lib/http');

module.exports = handler(async (req, res) => {
  const rows = await query(
    `SELECT device, crop, currency, grades, pending,
            floor(extract(epoch FROM (now() - last_seen)))::int AS seconds_ago
     FROM devices ORDER BY device`
  );
  res.status(200).json({ devices: rows });
});
