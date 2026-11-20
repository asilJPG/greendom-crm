// Вход и привязка по Face ID / Touch ID (WebAuthn / Passkeys).
// Один endpoint на все действия (укладываемся в лимит 12 функций Vercel Hobby).
const crypto = require('crypto');
const { query, ensureSchema } = require('../lib/db');
const { handler, TZ } = require('../lib/http');
const {
  getUser, makeSessionValue, sessionCookie, makeSignedCookie, readSignedCookie, clientIp, audit,
} = require('../lib/auth');

const CH_COOKIE = 'pk_ch';
const CH_TTL_SEC = 300;
const MAX_FAILS_IP = 5;
const MAX_FAILS_ALL = 25;
const WINDOW_MIN = 15;

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function getRp(req) {
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const rpId = rawHost.replace(/:\d+$/, '');
  const proto = req.headers['x-forwarded-proto'] || (rpId === 'localhost' || rpId === '127.0.0.1' ? 'http' : 'https');
  return { rpId, origin: `${proto}://${rawHost}` };
}

function clearChallenge(res) {
  res.setHeader('Set-Cookie', `${CH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

function verifyClientData(b64, expectedType, expectedChallenge, expectedOrigin) {
  let buf, cd;
  try {
    buf = Buffer.from(String(b64 || ''), 'base64url');
    cd = JSON.parse(buf.toString('utf8'));
  } catch {
    throw fail('некорректные данные клиента');
  }
  if (cd.type !== expectedType) throw fail('неверный тип WebAuthn-операции');
  if (cd.challenge !== expectedChallenge) throw fail('сессия Face ID устарела, попробуйте ещё раз');
  if (cd.origin !== expectedOrigin) throw fail('неверный домен запроса');
  return buf;
}

function verifyAuthData(b64, rpId) {
  const buf = Buffer.from(String(b64 || ''), 'base64url');
  if (buf.length < 37) throw fail('некорректные данные аутентификатора');
  const expectedRpHash = crypto.createHash('sha256').update(rpId).digest();
  if (!crypto.timingSafeEqual(buf.subarray(0, 32), expectedRpHash)) throw fail('неверный rpId');
  const flags = buf[32];
  if (!(flags & 0x01)) throw fail('действие пользователя не подтверждено');
  if (!(flags & 0x04)) throw fail('биометрическая проверка не пройдена');
  const counter = buf.readUInt32BE(33);
  return { buf, counter };
}

module.exports = handler(
  async (req, res) => {
    await ensureSchema();
    const { rpId, origin } = getRp(req);

    // GET: список подключённых устройств текущего пользователя
    if (req.method === 'GET') {
      const u = await getUser(req);
      if (!u) return res.status(401).json({ error: 'нужно войти' });
      const rows = await query(
        `SELECT id, device_name, to_char(created_at at time zone $1,'YYYY-MM-DD HH24:MI') AS created_at
         FROM passkeys WHERE user_id=$2 ORDER BY created_at DESC`,
        [TZ, u.id]
      );
      return res.status(200).json(rows);
    }

    // DELETE: удалить своё устройство Face ID
    if (req.method === 'DELETE') {
      const u = await getUser(req);
      if (!u) return res.status(401).json({ error: 'нужно войти' });
      const id = String((req.body || {}).id || '');
      if (!id) throw fail('не указан ключ');
      await query('DELETE FROM passkeys WHERE id=$1 AND user_id=$2', [id, u.id]);
      await audit(req, u.name, 'passkey_del', id.slice(0, 16));
      return res.status(200).json({ ok: true });
    }

    // POST: reg_options | reg_verify | auth_options | auth_verify
    const b = req.body || {};
    const action = String(b.action || '');

    if (action === 'reg_options') {
      const u = await getUser(req);
      if (!u) return res.status(401).json({ error: 'нужно войти' });
      const existing = await query('SELECT id FROM passkeys WHERE user_id=$1', [u.id]);
      const challenge = crypto.randomBytes(32).toString('base64url');
      res.setHeader('Set-Cookie', makeSignedCookie(CH_COOKIE, { c: challenge, uid: u.id, t: 'reg', exp: Date.now() + CH_TTL_SEC * 1000 }, CH_TTL_SEC));
      return res.status(200).json({
        challenge,
        rp: { name: 'Склад', id: rpId },
        user: { id: Buffer.from(`u:${u.id}`).toString('base64url'), name: u.name, displayName: u.name },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        timeout: 60000,
        attestation: 'none',
        excludeCredentials: existing.map((r) => ({ id: r.id, type: 'public-key' })),
      });
    }

    if (action === 'reg_verify') {
      const u = await getUser(req);
      if (!u) return res.status(401).json({ error: 'нужно войти' });
      const ch = readSignedCookie(req, CH_COOKIE);
      clearChallenge(res);
      if (!ch || ch.t !== 'reg' || ch.uid !== u.id) throw fail('сессия привязки истекла, попробуйте снова');

      const credId = String(b.id || '').trim();
      if (!credId || credId.length > 512) throw fail('неверный идентификатор ключа');
      verifyClientData(b.clientDataJSON, 'webauthn.create', ch.c, origin);
      const { counter } = verifyAuthData(b.authenticatorData, rpId);

      const pubB64 = String(b.publicKey || '');
      const alg = Number(b.alg) || -7;
      if (![-7, -257].includes(alg)) throw fail('неподдерживаемый алгоритм ключа');
      try {
        crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64url'), format: 'der', type: 'spki' });
      } catch {
        throw fail('некорректный публичный ключ');
      }

      const deviceName = String(b.device_name || 'Устройство').trim().slice(0, 60) || 'Устройство';
      await query(
        `INSERT INTO passkeys(id, user_id, public_key, alg, counter, device_name)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET public_key=EXCLUDED.public_key, alg=EXCLUDED.alg, counter=EXCLUDED.counter, device_name=EXCLUDED.device_name
         WHERE passkeys.user_id=$2`,
        [credId, u.id, pubB64, alg, counter, deviceName]
      );
      await audit(req, u.name, 'passkey_add', deviceName);
      return res.status(200).json({ ok: true });
    }

    if (action === 'auth_options') {
      const challenge = crypto.randomBytes(32).toString('base64url');
      res.setHeader('Set-Cookie', makeSignedCookie(CH_COOKIE, { c: challenge, t: 'auth', exp: Date.now() + CH_TTL_SEC * 1000 }, CH_TTL_SEC));
      return res.status(200).json({ challenge, rpId, timeout: 60000, userVerification: 'required' });
    }

    if (action === 'auth_verify') {
      const ip = clientIp(req);
      const [{ ipn, alln }] = await query(
        `SELECT count(*) FILTER (WHERE ip=$1)::int AS ipn, count(*)::int AS alln
         FROM login_fails WHERE ts > now() - ($2 || ' minutes')::interval`,
        [ip, String(WINDOW_MIN)]
      );
      if (ipn >= MAX_FAILS_IP || alln >= MAX_FAILS_ALL) {
        return res.status(423).json({ error: `Слишком много неверных попыток. Подождите ${WINDOW_MIN} минут` });
      }

      const ch = readSignedCookie(req, CH_COOKIE);
      if (!ch || ch.t !== 'auth') {
        clearChallenge(res);
        throw fail('сессия входа истекла, попробуйте снова', 401);
      }

      const credId = String(b.id || '').trim();
      const [row] = await query(
        `SELECT p.id, p.public_key, p.alg, p.counter, u.id AS uid, u.name, u.role, u.active, u.must_change, u.token_version
         FROM passkeys p JOIN app_users u ON u.id=p.user_id
         WHERE p.id=$1`,
        [credId]
      );
      if (!row || !row.active) {
        await query('INSERT INTO login_fails(ip, name) VALUES ($1, $2)', [ip, 'passkey']);
        await audit(req, row ? row.name : null, 'passkey_fail', row ? 'отключён' : 'ключ не найден');
        clearChallenge(res);
        return res.status(401).json({ error: 'Ключ Face ID не найден или сотрудник отключён' });
      }

      const clientDataBuf = verifyClientData(b.clientDataJSON, 'webauthn.get', ch.c, origin);
      const { buf: authDataBuf, counter } = verifyAuthData(b.authenticatorData, rpId);
      const storedCounter = Number(row.counter || 0);
      if (storedCounter > 0 && counter > 0 && counter <= storedCounter) {
        await audit(req, row.name, 'passkey_fail', 'повтор счётчика');
        clearChallenge(res);
        return res.status(401).json({ error: 'Проверка подписи не пройдена' });
      }

      const signedData = Buffer.concat([authDataBuf, crypto.createHash('sha256').update(clientDataBuf).digest()]);
      const sigBuf = Buffer.from(String(b.signature || ''), 'base64url');
      let verified = false;
      try {
        const keyObj = crypto.createPublicKey({ key: Buffer.from(row.public_key, 'base64url'), format: 'der', type: 'spki' });
        verified = crypto.verify('sha256', signedData, keyObj, sigBuf);
      } catch {
        verified = false;
      }
      if (!verified) {
        await query('INSERT INTO login_fails(ip, name) VALUES ($1, $2)', [ip, 'passkey']);
        await audit(req, row.name, 'passkey_fail', 'неверная подпись');
        clearChallenge(res);
        return res.status(401).json({ error: 'Проверка Face ID не пройдена' });
      }

      await query('UPDATE passkeys SET counter=$1 WHERE id=$2', [counter, row.id]);
      await query('DELETE FROM login_fails WHERE ip=$1', [ip]);
      await query('UPDATE app_users SET last_login=now() WHERE id=$1', [row.uid]);
      await audit(req, row.name, 'login_passkey');

      const session = sessionCookie(makeSessionValue({ id: row.uid, token_version: row.token_version }), 12 * 3600);
      res.setHeader('Set-Cookie', [session, `${CH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`]);
      return res.status(200).json({ ok: true, name: row.name, role: row.role, must_change: row.must_change });
    }

    throw fail('неизвестное действие');
  },
  { method: ['GET', 'POST', 'DELETE'], auth: false }
);
