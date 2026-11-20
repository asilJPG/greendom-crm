const { query } = require('../lib/db');
const { handler } = require('../lib/http');
const { MIN_PASSWORD, verifyPassword, hashPassword, makeSessionValue, sessionCookie, audit } = require('../lib/auth');

// Смена своего пароля. После смены прежние входы (на других устройствах) перестают действовать.
module.exports = handler(
  async (req, res) => {
    const { old_password = '', new_password = '' } = req.body || {};
    if (String(new_password).length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Новый пароль: не короче ${MIN_PASSWORD} символов` });
    }
    if (new_password === old_password) return res.status(400).json({ error: 'Новый пароль должен отличаться от прежнего' });
    const [u] = await query('SELECT * FROM app_users WHERE id=$1', [req.user.id]);
    if (!verifyPassword(old_password, u.pass_hash)) return res.status(400).json({ error: 'Текущий пароль неверный' });
    const [upd] = await query(
      'UPDATE app_users SET pass_hash=$1, must_change=false, token_version=token_version+1 WHERE id=$2 RETURNING id, token_version',
      [hashPassword(new_password), u.id]
    );
    await audit(req, u.name, 'password_change');
    res.setHeader('Set-Cookie', sessionCookie(makeSessionValue({ id: upd.id, token_version: upd.token_version }), 12 * 3600));
    res.status(200).json({ ok: true });
  },
  { method: 'POST', allowMustChange: true }
);
