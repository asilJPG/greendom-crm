const { query } = require('../lib/db');
const { handler, TZ } = require('../lib/http');
const { MIN_PASSWORD, hashPassword, passwordTaken, audit } = require('../lib/auth');

const ROLES = ['admin', 'director', 'keeper'];

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
          `SELECT id, name, role, active, must_change,
                  to_char(last_login at time zone $1,'YYYY-MM-DD HH24:MI') AS last_login
           FROM app_users ORDER BY id`,
          [TZ]
        );
        return res.status(200).json(users);
      }

      const b = req.body || {};
      if (req.method === 'POST') {
        const name = cleanName(b.name);
        const password = cleanPassword(b.password);
        const role = ROLES.includes(b.role) ? b.role : 'director';
        const [dup] = await query('SELECT 1 FROM app_users WHERE lower(name)=lower($1)', [name]);
        if (dup) return res.status(409).json({ error: 'Такое имя уже есть' });
        if (await passwordTaken(password)) return res.status(409).json({ error: 'Такой пароль уже используется, выберите другой' });
        const [u] = await query(
          'INSERT INTO app_users(name, role, pass_hash, must_change) VALUES ($1,$2,$3,false) RETURNING id',
          [name, role, hashPassword(password)]
        );
        await audit(req, req.user.name, 'user_add', `#${u.id} ${name} (${role})`);
        return res.status(200).json({ ok: true, id: u.id });
      }

      // PATCH: изменить имя, роль, отключить/включить или задать новый временный пароль
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
      let mustChange = target.must_change;
      if (b.password !== undefined) {
        const pw = cleanPassword(b.password);
        if (await passwordTaken(pw, id)) return res.status(409).json({ error: 'Такой пароль уже используется, выберите другой' });
        passHash = hashPassword(pw);
        mustChange = false; // пароль, заданный администратором, сразу постоянный
        bump = true;
      }
      await query(
        `UPDATE app_users SET name=$1, role=$2, active=$3, pass_hash=$4, must_change=$5,
                token_version = token_version + $6 WHERE id=$7`,
        [name, role, active, passHash, mustChange, bump ? 1 : 0, id]
      );
      await audit(req, req.user.name, 'user_edit', `#${id} ${name} роль=${role} активен=${active}${b.password !== undefined ? ' новый пароль' : ''}`);
      return res.status(200).json({ ok: true });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
  },
  { method: ['GET', 'POST', 'PATCH'], admin: true }
);
