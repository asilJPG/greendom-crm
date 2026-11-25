const { query } = require('../lib/db');
const { handler, TZ } = require('../lib/http');
const { MIN_PASSWORD, hashPassword, encryptPassword, decryptPassword, passwordTaken, audit } = require('../lib/auth');

const ROLES = ['admin', 'director', 'keeper', 'accountant'];

function cleanName(v) {
  const n = String(v || '').trim();
  if (n.length < 2 || n.length > 40) {
    const e = new Error('Имя: от 2 до 40 символов');
    e.status = 400;
    throw e;
  }
  return n;
}

function cleanPassword(v) {
  if (String(v || '').length < MIN_PASSWORD) {
    const e = new Error(`Пароль: не короче ${MIN_PASSWORD} символов`);
    e.status = 400;
    throw e;
  }
  return String(v);
}

async function adminCount(excludeId) {
  const [{ n }] = await query(`SELECT count(*)::int AS n FROM app_users WHERE role='admin' AND active AND id <> $1`, [excludeId]);
  return n;
}

module.exports = handler(
  async (req, res) => {
    try {
      if (req.method === 'GET') {
        if (req.query.log) {
          const log = await query(
            `SELECT to_char(ts at time zone $1,'YYYY-MM-DD HH24:MI:SS') AS ts, user_name, action, detail, ip
             FROM audit_log ORDER BY id DESC LIMIT 100`,
            [TZ]
          );
          return res.status(200).json(log);
        }
        const users = await query(
          `SELECT u.id, u.name, u.role, u.active, u.must_change, u.pass_enc,
                  to_char(u.last_login at time zone $1,'YYYY-MM-DD HH24:MI') AS last_login,
                  (SELECT count(*)::int FROM passkeys p WHERE p.user_id=u.id) AS passkeys
           FROM app_users u ORDER BY u.id`,
          [TZ]
        );
        // Администратор может восстановить пароль сотрудника; пароли администраторов не показываем.
        return res.status(200).json(
          users.map(({ pass_enc, ...u }) => ({ ...u, password: u.role === 'admin' ? null : decryptPassword(pass_enc) }))
        );
      }

      const b = req.body || {};
      if (req.method === 'POST') {
        const name = cleanName(b.name);
        const password = cleanPassword(b.password);
        const role = ROLES.includes(b.role) ? b.role : 'director';
        const [dup] = await query('SELECT 1 FROM app_users WHERE lower(name)=lower($1)', [name]);
        if (dup) return res.status(409).json({ error: 'Такое имя уже есть' });
        if (await passwordTaken(password)) return res.status(409).json({ error: 'Выберите другой пароль' });
        const [u] = await query(
          'INSERT INTO app_users(name, role, pass_hash, pass_enc, must_change) VALUES ($1,$2,$3,$4,false) RETURNING id',
          [name, role, hashPassword(password), encryptPassword(password)]
        );
        await audit(req, req.user.name, 'user_add', `#${u.id} ${name} (${role})`);
        return res.status(200).json({ ok: true, id: u.id });
      }

      // PATCH: изменить имя, роль, отключить/включить, задать новый пароль или сбросить Face ID (reset_passkeys)
      const id = Number(b.id);
      const [target] = Number.isInteger(id) ? await query('SELECT * FROM app_users WHERE id=$1', [id]) : [];
      if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
      const name = b.name !== undefined ? cleanName(b.name) : target.name;
      const role = b.role !== undefined ? b.role : target.role;
      const active = b.active !== undefined ? Boolean(b.active) : target.active;
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Неизвестная роль' });
      if (name.toLowerCase() !== target.name.toLowerCase()) {
        const [dup] = await query('SELECT 1 FROM app_users WHERE lower(name)=lower($1) AND id<>$2', [name, id]);
        if (dup) return res.status(409).json({ error: 'Такое имя уже есть' });
      }
      const losingAdmin = target.role === 'admin' && target.active && (role !== 'admin' || !active);
      if (losingAdmin && (await adminCount(id)) === 0) {
        return res.status(409).json({ error: 'Нельзя убрать последнего администратора' });
      }
      let bump = !active && target.active; // отключили: все входы пользователя сбрасываются
      let passHash = target.pass_hash;
      let passEnc = target.pass_enc;
      const mustChange = false; // самостоятельной смены пароля нет: флаг больше никогда не ставится
      if (b.password !== undefined) {
        const pw = cleanPassword(b.password);
        if (await passwordTaken(pw, id)) return res.status(409).json({ error: 'Выберите другой пароль' });
        passHash = hashPassword(pw);
        passEnc = encryptPassword(pw);
        bump = true;
      }
      // Face ID отзывается при сбросе пароля, отключении, смене роли и по явной команде администратора.
      const revokePasskeys = b.password !== undefined || (!active && target.active) || role !== target.role || b.reset_passkeys === true;
      await query(
        `UPDATE app_users SET name=$1, role=$2, active=$3, pass_hash=$4, pass_enc=$5, must_change=$6,
                token_version = token_version + $7 WHERE id=$8`,
        [name, role, active, passHash, passEnc, mustChange, bump ? 1 : 0, id]
      );
      let revoked = 0;
      if (revokePasskeys) {
        revoked = (await query('DELETE FROM passkeys WHERE user_id=$1 RETURNING id', [id])).length;
      }
      await audit(req, req.user.name, 'user_edit', `#${id} ${name} роль=${role} активен=${active}${b.password !== undefined ? ' новый пароль' : ''}${revoked ? ` Face ID сброшен (${revoked})` : ''}`);
      return res.status(200).json({ ok: true, passkeys_revoked: revoked });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
  },
  { method: ['GET', 'POST', 'PATCH'], admin: true }
);
