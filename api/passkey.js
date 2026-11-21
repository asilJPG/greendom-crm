// Вход и привязка по Face ID / Touch ID (WebAuthn / Passkeys).
// Один endpoint на все действия (укладываемся в лимит 12 функций Vercel Hobby).
//
// Безопасность:
//  • публичный ключ берётся только из attestationObject (CBOR → authData → attestedCredentialData → COSE),
//    присланный клиентом publicKey/alg игнорируется;
//  • проверяются rpIdHash, флаги UP и UV (нужна биометрия/код устройства), тип, origin и challenge;
//  • challenge хранится на сервере, живёт CH_TTL_SEC и удаляется при первом использовании (повтор не проходит);
//  • неудачные входы считаются в login_fails по адресу; общий предел входа по паролю Face ID не блокирует.
const crypto = require('crypto');
const { query, ensureSchema } = require('../lib/db');
const { handler, TZ } = require('../lib/http');
const { getUser, makeSessionValue, sessionCookie, clientIp, audit } = require('../lib/auth');

const CH_TTL_SEC = 180;
const MAX_FAILS_IP = 5;
const WINDOW_MIN = 15;
const LEGACY_CH_COOKIE = 'pk_ch'; // прежняя cookie с challenge: просто стираем

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

function getRp(req) {
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const rpId = rawHost.replace(/:\d+$/, '');
  const proto = req.headers['x-forwarded-proto'] || (rpId === 'localhost' || rpId === '127.0.0.1' ? 'http' : 'https');
  return { rpId, origin: `${proto}://${rawHost}` };
}

// ───── минимальный CBOR-декодер (RFC 8949), достаточный для attestationObject и COSE-ключей ─────
function cborDecode(buf, pos = 0, depth = 0) {
  if (depth > 16) throw fail('слишком глубокая структура CBOR');
  const need = (n) => { if (pos + n > buf.length) throw fail('обрезанные данные CBOR'); };
  need(1);
  const ib = buf[pos++];
  const major = ib >> 5;
  const info = ib & 0x1f;
  let len;
  if (info < 24) len = info;
  else if (info === 24) { need(1); len = buf[pos]; pos += 1; }
  else if (info === 25) { need(2); len = buf.readUInt16BE(pos); pos += 2; }
  else if (info === 26) { need(4); len = buf.readUInt32BE(pos); pos += 4; }
  else if (info === 27) {
    need(8);
    const big = buf.readBigUInt64BE(pos); pos += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('слишком большое число CBOR');
    len = Number(big);
  } else throw fail('неподдерживаемый CBOR');

  switch (major) {
    case 0: return { value: len, pos };
    case 1: return { value: -1 - len, pos };
    case 2: need(len); return { value: buf.subarray(pos, pos + len), pos: pos + len };
    case 3: need(len); return { value: buf.subarray(pos, pos + len).toString('utf8'), pos: pos + len };
    case 4: {
      if (len > 1000) throw fail('слишком большой массив CBOR');
      const arr = [];
      for (let i = 0; i < len; i++) { const r = cborDecode(buf, pos, depth + 1); arr.push(r.value); pos = r.pos; }
      return { value: arr, pos };
    }
    case 5: {
      if (len > 1000) throw fail('слишком большой словарь CBOR');
      const map = new Map();
      for (let i = 0; i < len; i++) {
        const k = cborDecode(buf, pos, depth + 1); pos = k.pos;
        const v = cborDecode(buf, pos, depth + 1); pos = v.pos;
        map.set(k.value, v.value);
      }
      return { value: map, pos };
    }
    case 6: return cborDecode(buf, pos, depth + 1); // тег: берём вложенное значение
    case 7:
      if (info === 20) return { value: false, pos };
      if (info === 21) return { value: true, pos };
      if (info === 22 || info === 23) return { value: null, pos };
      throw fail('неподдерживаемый CBOR');
    default: throw fail('неподдерживаемый CBOR');
  }
}

// COSE_Key → SPKI DER (ES256: EC2/P-256, RS256: RSA)
function coseToSpki(cose) {
  if (!(cose instanceof Map)) throw fail('некорректный ключ COSE');
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (alg === -7) {
    const x = cose.get(-2), y = cose.get(-3);
    if (kty !== 2 || cose.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      throw fail('некорректный ключ ES256');
    }
    jwk = { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') };
  } else if (alg === -257) {
    const n = cose.get(-1), e = cose.get(-2);
    if (kty !== 3 || !Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) throw fail('некорректный ключ RS256');
    jwk = { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') };
  } else {
    throw fail('неподдерживаемый алгоритм ключа');
  }
  try {
    const spki = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'der', type: 'spki' });
    return { spki: spki.toString('base64url'), alg };
  } catch {
    throw fail('некорректный публичный ключ');
  }
}

// authData: rpIdHash(32) | flags(1) | signCount(4) | [attestedCredentialData] | [extensions]
function parseAuthData(buf, rpId, { attested = false } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw fail('некорректные данные аутентификатора');
  const expectedRpHash = crypto.createHash('sha256').update(rpId).digest();
  if (!crypto.timingSafeEqual(buf.subarray(0, 32), expectedRpHash)) throw fail('неверный rpId');
  const flags = buf[32];
  if (!(flags & 0x01)) throw fail('действие пользователя не подтверждено');
  if (!(flags & 0x04)) throw fail('биометрическая проверка не пройдена');
  const counter = buf.readUInt32BE(33);
  if (!attested) return { counter, flags };
  if (!(flags & 0x40)) throw fail('нет данных нового ключа');
  if (buf.length < 55) throw fail('некорректные данные ключа');
  let pos = 37 + 16; // aaguid
  const idLen = buf.readUInt16BE(pos); pos += 2;
  if (idLen < 1 || idLen > 1023 || pos + idLen > buf.length) throw fail('некорректный идентификатор ключа');
  const credId = buf.subarray(pos, pos + idLen); pos += idLen;
  const { value: cose, pos: end } = cborDecode(buf, pos);
  if (end > buf.length) throw fail('некорректный ключ COSE');
  const { spki, alg } = coseToSpki(cose);
  return { counter, flags, credId: credId.toString('base64url'), spki, alg };
}

function readClientData(b64) {
  let buf, cd;
  try {
    buf = Buffer.from(String(b64 || ''), 'base64url');
    cd = JSON.parse(buf.toString('utf8'));
  } catch {
    throw fail('некорректные данные клиента');
  }
  if (!cd || typeof cd.challenge !== 'string' || !cd.challenge || cd.challenge.length > 200) throw fail('нет challenge');
  return { buf, cd, challenge: cd.challenge };
}

function checkClientData({ cd }, expectedType, expectedOrigin) {
  if (cd.type !== expectedType) throw fail('неверный тип WebAuthn-операции');
  if (cd.origin !== expectedOrigin) throw fail('неверный домен запроса');
}

async function newChallenge(kind, userId = null) {
  const challenge = crypto.randomBytes(32).toString('base64url');
  await query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
  await query(
    `INSERT INTO webauthn_challenges(challenge, kind, user_id, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    [challenge, kind, userId, String(CH_TTL_SEC)]
  );
  return challenge;
}

// Одноразово: удаляем и сразу узнаём, был ли такой живой challenge нужного вида (и пользователя).
async function consumeChallenge(challenge, kind, userId = null) {
  const rows = await query(
    `DELETE FROM webauthn_challenges WHERE challenge=$1 RETURNING kind, user_id, expires_at > now() AS alive`,
    [challenge]
  );
  const r = rows[0];
  return Boolean(r && r.alive && r.kind === kind && (userId === null || r.user_id === userId));
}

const clearLegacy = (res) => res.setHeader('Set-Cookie', `${LEGACY_CH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);

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
      const challenge = await newChallenge('reg', u.id);
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
      clearLegacy(res);
      const clientData = readClientData(b.clientDataJSON);
      // challenge гасится сразу, даже если дальше проверка не пройдёт: каждый challenge — одна попытка
      if (!(await consumeChallenge(clientData.challenge, 'reg', u.id))) throw fail('сессия привязки истекла, попробуйте снова');
      checkClientData(clientData, 'webauthn.create', origin);

      // Ключ — только из attestationObject (формат 'none' и любые другие: подпись аттестации не нужна, attestation:'none').
      let authData;
      try {
        const att = cborDecode(Buffer.from(String(b.attestationObject || ''), 'base64url')).value;
        authData = att instanceof Map ? att.get('authData') : null;
      } catch {
        authData = null;
      }
      if (!Buffer.isBuffer(authData)) throw fail('нет attestationObject');
      const parsed = parseAuthData(authData, rpId, { attested: true });

      const credId = String(b.id || '').trim();
      if (!credId || credId.length > 1400 || credId !== parsed.credId) throw fail('неверный идентификатор ключа');

      const deviceName = String(b.device_name || 'Устройство').trim().slice(0, 60) || 'Устройство';
      const saved = await query(
        `INSERT INTO passkeys(id, user_id, public_key, alg, counter, device_name)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET public_key=EXCLUDED.public_key, alg=EXCLUDED.alg, counter=EXCLUDED.counter, device_name=EXCLUDED.device_name
         WHERE passkeys.user_id=$2
         RETURNING id`,
        [credId, u.id, parsed.spki, parsed.alg, parsed.counter, deviceName]
      );
      if (!saved.length) throw fail('этот ключ уже привязан к другому сотруднику', 409);
      await audit(req, u.name, 'passkey_add', deviceName);
      return res.status(200).json({ ok: true });
    }

    if (action === 'auth_options') {
      const challenge = await newChallenge('auth');
      return res.status(200).json({ challenge, rpId, timeout: 60000, userVerification: 'required' });
    }

    if (action === 'auth_verify') {
      clearLegacy(res);
      const ip = clientIp(req);
      // Только предел по адресу: общий предел входа по паролю на Face ID не распространяется.
      const [{ ipn }] = await query(
        `SELECT count(*)::int AS ipn FROM login_fails WHERE ip=$1 AND ts > now() - ($2 || ' minutes')::interval`,
        [ip, String(WINDOW_MIN)]
      );
      if (ipn >= MAX_FAILS_IP) {
        return res.status(423).json({ error: `Слишком много неверных попыток. Подождите ${WINDOW_MIN} минут` });
      }
      const reject = async (who, why, msg = 'Проверка Face ID не пройдена') => {
        await query('INSERT INTO login_fails(ip, name) VALUES ($1, $2)', [ip, 'passkey']);
        await audit(req, who, 'passkey_fail', why);
        return res.status(401).json({ error: msg });
      };

      let clientData, authInfo;
      try {
        clientData = readClientData(b.clientDataJSON);
      } catch (e) {
        return reject(null, e.message);
      }
      // challenge гасится сразу, даже если дальше проверка не пройдёт: каждый challenge — одна попытка
      if (!(await consumeChallenge(clientData.challenge, 'auth'))) {
        return reject(null, 'challenge не найден или использован', 'Сессия входа истекла, попробуйте снова');
      }
      try {
        checkClientData(clientData, 'webauthn.get', origin);
      } catch (e) {
        return reject(null, e.message);
      }

      const credId = String(b.id || '').trim();
      const [row] = await query(
        `SELECT p.id, p.public_key, p.alg, p.counter, u.id AS uid, u.name, u.role, u.active, u.token_version
         FROM passkeys p JOIN app_users u ON u.id=p.user_id
         WHERE p.id=$1`,
        [credId]
      );
      if (!row || !row.active) {
        return reject(row ? row.name : null, row ? 'отключён' : 'ключ не найден', 'Ключ Face ID не найден или сотрудник отключён');
      }

      const authDataBuf = Buffer.from(String(b.authenticatorData || ''), 'base64url');
      try {
        authInfo = parseAuthData(authDataBuf, rpId);
      } catch (e) {
        return reject(row.name, e.message);
      }
      const storedCounter = Number(row.counter || 0);
      if (storedCounter > 0 && authInfo.counter > 0 && authInfo.counter <= storedCounter) {
        return reject(row.name, 'повтор счётчика');
      }

      const signedData = Buffer.concat([authDataBuf, crypto.createHash('sha256').update(clientData.buf).digest()]);
      const sigBuf = Buffer.from(String(b.signature || ''), 'base64url');
      let verified = false;
      try {
        const keyObj = crypto.createPublicKey({ key: Buffer.from(row.public_key, 'base64url'), format: 'der', type: 'spki' });
        verified = crypto.verify('sha256', signedData, keyObj, sigBuf);
      } catch {
        verified = false;
      }
      if (!verified) return reject(row.name, 'неверная подпись');

      await query('UPDATE passkeys SET counter=$1 WHERE id=$2', [authInfo.counter, row.id]);
      await query('DELETE FROM login_fails WHERE ip=$1', [ip]);
      await query('UPDATE app_users SET last_login=now() WHERE id=$1', [row.uid]);
      await audit(req, row.name, 'login_passkey');

      const session = sessionCookie(makeSessionValue({ id: row.uid, token_version: row.token_version }), 12 * 3600);
      res.setHeader('Set-Cookie', [session, `${LEGACY_CH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`]);
      return res.status(200).json({ ok: true, name: row.name, role: row.role, must_change: false });
    }

    throw fail('неизвестное действие');
  },
  { method: ['GET', 'POST', 'DELETE'], auth: false }
);
