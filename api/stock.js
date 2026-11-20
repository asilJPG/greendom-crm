const { handler } = require('../lib/http');
const { getStock } = require('../lib/warehouse');

module.exports = handler(async (req, res) => {
  const { rows, total_kg } = await getStock();
  res.status(200).json({ rows, total_kg });
});
