const { sessionCookie } = require('../lib/auth');

module.exports = (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  res.status(200).json({ ok: true });
};
