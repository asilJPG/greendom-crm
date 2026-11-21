// Проверки входа, паролей, Face ID (passkeys), ролей и валидации на настоящем Postgres (PGlite).
// Каждая проверка ломает конкретное правило: повтор ответа Face ID, подмена ключа, запись директором и т.д.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

process.env.INGEST_TOKEN = 'ingest-token-for-tests-0123456789abcdef';
process.env.SESSION_SECRET = 'session-secret-for-tests-0123456789';
process.env.SETUP_KEY = 'setup-key-for-tests-0123456789abcdef';

const pg = new PGlite();
globalThis.__TEST_DB = {
  query: async (text, params) => (await pg.query(text, params)).rows,
  transaction: async (list) => pg.transaction(async (tx) => { const out = []; for (const [t, p] of list) out.push((await tx.query(t, p || [])).rows); return out; }),
};
const db = globalThis.__TEST_DB;

const login = require('../api/login');
const setup = require('../api/setup');
const users = require('../api/users');
const report = require('../api/report');
const movements = require('../api/movements');
const status = require('../api/status');
const passkey = require('../api/passkey');
const http = require('../lib/http');
const { todayStr } = http;

let ipCounter = 0;
function call(fn, { method = 'GET', body, query = {}, headers = {}, ip } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      code: 200, headers: {}, body: null,
      status(c) { this.code = c; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      json(o) { this.body = o; resolve(this); return this; },
      end(o) { this.body = o; resolve(this); return this; },
    };
    const xff = ip || `10.1.0.${++ipCounter}`;
    Promise.resolve(fn({ method, body, query, headers: { 'x-forwarded-for': xff, ...headers } }, res)).catch(reject);
  });
}
const sessionOf = (r) => {
  const sc = r.headers['Set-Cookie'];
  const list = Array.isArray(sc) ? sc : [sc];
  return list.find((c) => c.startsWith('cs=')).split(';')[0];
};
async function signIn(pw, ip) {
  const r = await call(login, { method: 'POST', body: { password: pw }, ip });
  assert.equal(r.code, 200, `вход: ${JSON.stringify(r.body)}`);
  return { cookie: sessionOf(r), body: r.body };
}
const as = (cookie, extra = {}) => ({ headers: { cookie, ...extra } });
const today = todayStr();

const ADMIN_PW = 'admin-test-pw-1';
const DIR_PW = 'director-test-pw-1';
const KEEP_PW = 'keeper-test-pw-1';
let admin, dir, keeper, ids = {};

// ───────── WebAuthn: минимальный CBOR-кодировщик и «аутентификатор» на node:crypto ─────────
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (Number.isInteger(v)) return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const HOST = 'sklad-urozhay.vercel.app';
const ORIGIN = `https://${HOST}`;
const PK = { host: HOST };

function makeAuthenticator(kind = 'es256') {
  let keys, cose, alg;
  if (kind === 'rs256') {
    keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const j = keys.publicKey.export({ format: 'jwk' });
    alg = -257;
    cose = new Map([[1, 3], [3, -257], [-1, Buffer.from(j.n, 'base64url')], [-2, Buffer.from(j.e, 'base64url')]]);
  } else {
    keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const j = keys.publicKey.export({ format: 'jwk' });
    alg = -7;
    cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x, 'base64url')], [-3, Buffer.from(j.y, 'base64url')]]);
  }
  const credId = crypto.randomBytes(16);
  let counter = 0;
  const rpHash = (rp) => crypto.createHash('sha256').update(rp).digest();
  return {
    id: credId.toString('base64url'),
    alg,
    spki: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    // ответ navigator.credentials.create()
    attestation(challenge, { flags = 0x45, rp = HOST, origin = ORIGIN, id = credId, coseKey = cose } = {}) {
      const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
      const head = Buffer.alloc(37); rpHash(rp).copy(head); head[32] = flags; head.writeUInt32BE(counter, 33);
      const authData = Buffer.concat([head, Buffer.alloc(16), len, id, cbor(coseKey)]);
      const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
      return { attestationObject: attestationObject.toString('base64url'), clientDataJSON: clientDataJSON.toString('base64url') };
    },
    // ответ navigator.credentials.get()
    assertion(challenge, { flags = 0x05, rp = HOST, origin = ORIGIN, badSig = false } = {}) {
      counter += 1;
      const authData = Buffer.alloc(37); rpHash(rp).copy(authData); authData[32] = flags; authData.writeUInt32BE(counter, 33);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
      let sig = crypto.sign('sha256', signed, keys.privateKey);
      if (badSig) sig = crypto.sign('sha256', Buffer.from('другие данные'), keys.privateKey);
      return {
        id: credId.toString('base64url'),
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: sig.toString('base64url'),
      };
    },
  };
}

const pk = (body, opts = {}) => call(passkey, { method: 'POST', body, headers: { ...PK, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, ip: opts.ip });
async function register(cookie, auth, opts = {}, extraBody = {}) {
  const o = await pk({ action: 'reg_options' }, { cookie });
  assert.equal(o.code, 200);
  const att = auth.attestation(o.body.challenge, opts);
  return { res: await pk({ action: 'reg_verify', id: auth.id, device_name: 'iPhone', ...att, ...extraBody }, { cookie }), challenge: o.body.challenge, att };
}
async function passkeyLogin(auth, opts = {}, ip) {
  const o = await pk({ action: 'auth_options' }, { ip });
  const a = auth.assertion(o.body.challenge, opts);
  return { res: await pk({ action: 'auth_verify', ...a }, { ip }), body: a };
}
const passkeyCount = async (uid) => (await db.query('SELECT count(*)::int AS n FROM passkeys WHERE user_id=$1', [uid]))[0].n;

// ───────── подготовка ─────────
test('setup: флаг temporary игнорируется, must_change никогда не ставится; /api/password удалён', async () => {
  const r = await call(setup, { method: 'POST', body: { key: process.env.SETUP_KEY, name: 'owner', password: ADMIN_PW, temporary: true } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.must_change, false);
  const [u] = await db.query(`SELECT must_change FROM app_users WHERE name='owner'`);
  assert.equal(u.must_change, false);
  assert.ok(!fs.existsSync(path.join(__dirname, '../api/password.js')), 'endpoint самостоятельной смены пароля удалён');
  assert.ok(fs.readdirSync(path.join(__dirname, '../api')).length <= 12, 'лимит функций Vercel Hobby');

  const a = await signIn(ADMIN_PW);
  assert.equal(a.body.must_change, false);
  admin = a.cookie;
  for (const [name, password, role] of [['Директор', DIR_PW, 'director'], ['Складовщик', KEEP_PW, 'keeper']]) {
    const add = await call(users, { method: 'POST', body: { name, password, role }, ...as(admin) });
    assert.equal(add.code, 200);
    ids[role] = add.body.id;
  }
  dir = (await signIn(DIR_PW)).cookie;
  keeper = (await signIn(KEEP_PW)).cookie;
});

// ───────── вход: CSRF ─────────
test('login: чужой Origin отклоняется (CSRF), свой Origin и запрос без Origin работают', async () => {
  const evil = await call(login, { method: 'POST', body: { password: ADMIN_PW }, headers: { host: HOST, origin: 'https://evil.example' } });
  assert.equal(evil.code, 403);
  assert.ok(!evil.headers['Set-Cookie'], 'сессия не выдана');
  const own = await call(login, { method: 'POST', body: { password: ADMIN_PW }, headers: { host: HOST, origin: ORIGIN } });
  assert.equal(own.code, 200);
  const setupEvil = await call(setup, { method: 'POST', body: { key: 'x' }, headers: { host: HOST, origin: 'https://evil.example' } });
  assert.equal(setupEvil.code, 403);
});

// ───────── /api/users ─────────
test('GET /api/users: пароль администратора = null, у сотрудников виден; есть счётчик passkeys', async () => {
  const list = (await call(users, as(admin))).body;
  const owner = list.find((u) => u.name === 'owner');
  assert.equal(owner.role, 'admin');
  assert.equal(owner.password, null);
  assert.equal(list.find((u) => u.role === 'director').password, DIR_PW);
  assert.equal(list.find((u) => u.role === 'keeper').password, KEEP_PW);
  for (const u of list) assert.equal(typeof u.passkeys, 'number');
  assert.ok(!JSON.stringify(list).includes(ADMIN_PW), 'пароль админа нигде не утёк');
});

// ───────── Face ID: регистрация ─────────
test('passkey reg: ключ берётся из attestationObject, присланный клиентом publicKey игнорируется', async () => {
  const auth = makeAuthenticator();
  const fake = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const { res } = await register(dir, auth, {}, { publicKey: fake, alg: -257 });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const [row] = await db.query('SELECT public_key, alg FROM passkeys WHERE id=$1', [auth.id]);
  assert.equal(row.public_key, auth.spki, 'сохранён ключ из COSE, а не подложенный');
  assert.equal(row.alg, -7);
  const login1 = await passkeyLogin(auth);
  assert.equal(login1.res.code, 200, JSON.stringify(login1.res.body));
  assert.equal(login1.res.body.role, 'director');
  assert.equal((await call(status, as(sessionOf(login1.res)))).code, 200, 'сессия Face ID работает');
});

test('passkey reg: RS256 (-257) тоже поддерживается', async () => {
  const auth = makeAuthenticator('rs256');
  const { res } = await register(keeper, auth);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const [row] = await db.query('SELECT alg FROM passkeys WHERE id=$1', [auth.id]);
  assert.equal(row.alg, -257);
  assert.equal((await passkeyLogin(auth)).res.code, 200);
});

test('passkey reg: чужой rpId, нет UV, нет UP, нет attestationObject, подмена id и повтор challenge — отказ', async () => {
  const auth = makeAuthenticator();
  assert.equal((await register(keeper, auth, { rp: 'evil.example' })).res.code, 400, 'чужой rpIdHash');
  assert.equal((await register(keeper, auth, { flags: 0x41 })).res.code, 400, 'без UV (биометрии)');
  assert.equal((await register(keeper, auth, { flags: 0x44 })).res.code, 400, 'без UP');
  assert.equal((await register(keeper, auth, { flags: 0x05 })).res.code, 400, 'без attestedCredentialData');
  assert.equal((await register(keeper, auth, { origin: 'https://evil.example' })).res.code, 400, 'чужой origin');
  const other = crypto.randomBytes(16);
  assert.equal((await register(keeper, auth, { id: other })).res.code, 400, 'id в authData не совпадает с id ответа');
  const noAtt = await pk({ action: 'reg_options' }, { cookie: keeper });
  const att = auth.attestation(noAtt.body.challenge);
  assert.equal((await pk({ action: 'reg_verify', id: auth.id, clientDataJSON: att.clientDataJSON, publicKey: auth.spki }, { cookie: keeper })).code, 400, 'без attestationObject');
  const badCose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32, 1)], [-3, Buffer.alloc(32, 2)]]);
  assert.equal((await register(keeper, auth, { coseKey: badCose })).res.code, 400, 'точка не на кривой');

  // challenge одноразовый: удачная регистрация, затем тот же ответ ещё раз
  const ok = await register(keeper, auth);
  assert.equal(ok.res.code, 200);
  const replay = await pk({ action: 'reg_verify', id: auth.id, ...ok.att }, { cookie: keeper });
  assert.equal(replay.code, 400, 'повтор challenge регистрации');
  // challenge чужого пользователя не подходит
  const o = await pk({ action: 'reg_options' }, { cookie: dir });
  const a2 = makeAuthenticator();
  const cross = await pk({ action: 'reg_verify', id: a2.id, ...a2.attestation(o.body.challenge) }, { cookie: keeper });
  assert.equal(cross.code, 400, 'challenge выдан другому пользователю');
  // ключ, уже привязанный к другому сотруднику, нельзя перехватить
  const steal = await register(dir, auth);
  assert.equal(steal.res.code, 409);
  const [row] = await db.query('SELECT user_id FROM passkeys WHERE id=$1', [auth.id]);
  assert.equal(row.user_id, ids.keeper);
});

// ───────── Face ID: вход ─────────
test('passkey login: перехваченный ответ нельзя повторить; истёкший и чужой по виду challenge не принимаются', async () => {
  await db.query('DELETE FROM login_fails');
  const auth = makeAuthenticator();
  assert.equal((await register(dir, auth)).res.code, 200);
  const first = await passkeyLogin(auth, {}, '10.9.0.1');
  assert.equal(first.res.code, 200);
  const replay = await pk({ action: 'auth_verify', ...first.body }, { ip: '10.9.0.2' });
  assert.equal(replay.code, 401, 'повтор того же ответа отклонён');

  // истёкший challenge
  const o = await pk({ action: 'auth_options' });
  await db.query(`UPDATE webauthn_challenges SET expires_at = now() - interval '1 second' WHERE challenge=$1`, [o.body.challenge]);
  assert.equal((await pk({ action: 'auth_verify', ...auth.assertion(o.body.challenge) })).code, 401, 'истёкший challenge');
  // challenge регистрации не годится для входа
  const r = await pk({ action: 'reg_options' }, { cookie: dir });
  assert.equal((await pk({ action: 'auth_verify', ...auth.assertion(r.body.challenge) })).code, 401, 'challenge другого вида');
  // выдуманный challenge
  assert.equal((await pk({ action: 'auth_verify', ...auth.assertion('made-up-challenge') })).code, 401);
  // без UV, чужой rpId, поддельная подпись
  assert.equal((await passkeyLogin(auth, { flags: 0x01 })).res.code, 401, 'без UV');
  assert.equal((await passkeyLogin(auth, { rp: 'evil.example' })).res.code, 401, 'чужой rpId');
  assert.equal((await passkeyLogin(auth, { badSig: true })).res.code, 401, 'поддельная подпись');
  assert.equal((await passkeyLogin(auth, { origin: 'https://evil.example' })).res.code, 401, 'чужой origin');
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM webauthn_challenges WHERE kind='auth' AND expires_at > now()`);
  assert.equal(n, 0, 'все использованные challenge удалены');
});

test('passkey login: неудачи считаются в login_fails по IP (5 → 423); общий предел входа по паролю Face ID не блокирует', async () => {
  await db.query('DELETE FROM login_fails');
  const auth = makeAuthenticator();
  assert.equal((await register(dir, auth)).res.code, 200);
  const ip = '10.9.1.1';
  for (let i = 0; i < 5; i++) assert.equal((await passkeyLogin(auth, { badSig: true }, ip)).res.code, 401);
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM login_fails WHERE ip=$1 AND name='passkey'`, [ip]);
  assert.equal(n, 5, 'неудачи Face ID записаны по адресу');
  assert.equal((await passkeyLogin(auth, {}, ip)).res.code, 423, 'с этого адреса даже верный ответ закрыт');
  assert.equal((await passkeyLogin(auth, {}, '10.9.1.2')).res.code, 200, 'другой адрес не затронут');

  // распределённый перебор паролей включил общий предел — пароль закрыт для всех, а Face ID работает
  await db.query('DELETE FROM login_fails');
  for (let i = 0; i < 30; i++) await db.query('INSERT INTO login_fails(ip) VALUES ($1)', [`198.18.0.${i}`]);
  assert.equal((await call(login, { method: 'POST', body: { password: ADMIN_PW } })).code, 423, 'общий предел по паролю действует');
  assert.equal((await passkeyLogin(auth, {}, '10.9.1.3')).res.code, 200, 'Face ID не блокируется общим пределом');
  // и наоборот: неудачи Face ID не закрывают вход по паролю всем
  await db.query('DELETE FROM login_fails');
  for (let i = 0; i < 30; i++) await db.query(`INSERT INTO login_fails(ip, name) VALUES ($1, 'passkey')`, [`198.18.1.${i}`]);
  assert.equal((await call(login, { method: 'POST', body: { password: ADMIN_PW } })).code, 200);
  await db.query('DELETE FROM login_fails');
});

// ───────── отзыв Face ID ─────────
test('passkeys отзываются: сброс пароля, отключение, смена роли и reset_passkeys; счётчик в /api/users', async () => {
  await db.query('DELETE FROM login_fails');
  const add = await call(users, { method: 'POST', body: { name: 'Временный', password: 'temp-user-pw-1', role: 'keeper' }, ...as(admin) });
  const uid = add.body.id;
  const patch = (body) => call(users, { method: 'PATCH', body: { id: uid, ...body }, ...as(admin) });
  const enroll = async (pw) => {
    const c = (await signIn(pw)).cookie;
    const auth = makeAuthenticator();
    assert.equal((await register(c, auth)).res.code, 200);
    return auth;
  };

  let auth = await enroll('temp-user-pw-1');
  assert.equal((await call(users, as(admin))).body.find((u) => u.id === uid).passkeys, 1);
  assert.equal((await patch({ reset_passkeys: true })).code, 200);
  assert.equal(await passkeyCount(uid), 0, 'reset_passkeys');
  assert.equal((await passkeyLogin(auth)).res.code, 401, 'отозванный ключ не входит');
  assert.equal((await call(users, as(admin))).body.find((u) => u.id === uid).passkeys, 0);

  auth = await enroll('temp-user-pw-1');
  assert.equal((await patch({ password: 'temp-user-pw-2' })).code, 200);
  assert.equal(await passkeyCount(uid), 0, 'сброс пароля админом');
  assert.equal((await passkeyLogin(auth)).res.code, 401);

  auth = await enroll('temp-user-pw-2');
  assert.equal((await patch({ role: 'director' })).code, 200);
  assert.equal(await passkeyCount(uid), 0, 'смена роли');

  auth = await enroll('temp-user-pw-2');
  assert.equal((await patch({ name: 'Временный 2' })).code, 200);
  assert.equal(await passkeyCount(uid), 1, 'переименование ключи не трогает');
  assert.equal((await patch({ active: false })).code, 200);
  assert.equal(await passkeyCount(uid), 0, 'отключение');
  assert.equal((await passkeyLogin(auth)).res.code, 401);
});

// ───────── роли: директор только читает финансы ─────────
test('роли: директор не пишет в расходы, оплаты, инвестиции, контрагентов и сорта; читать может', async () => {
  const fin = (resource, method, body, cookie) => call(report, { method, query: { resource, from: today, to: today }, body, ...as(cookie) });
  const refs = (method, body, cookie) => call(status, { method, query: { resource: 'refs' }, body, ...as(cookie) });
  const cats = (await fin('expenses', 'GET', undefined, admin)).body.categories;
  const catId = cats[0].id;

  const exp = await fin('expenses', 'POST', { target: 'expense', category_id: catId, amount: 1000 }, admin);
  assert.equal(exp.code, 200);
  const pay = await fin('payments', 'POST', { counterparty: 'Тест-КА', direction: 'in', amount: 500 }, admin);
  assert.equal(pay.code, 200);
  const inv = await fin('investments', 'POST', { title: 'Насос', amount: 100 }, admin);
  assert.equal(inv.code, 200);
  const cust = await refs('POST', { target: 'customer', name: 'Тест-КА' }, admin);
  assert.equal(cust.code, 200);

  for (const [why, r] of [
    ['акт расхода', await fin('expenses', 'POST', { target: 'expense', category_id: catId, amount: 1000 }, dir)],
    ['правка акта', await fin('expenses', 'PATCH', { target: 'expense', action: 'edit', id: exp.body.id, amount: 1 }, dir)],
    ['отмена акта', await fin('expenses', 'PATCH', { target: 'expense', id: exp.body.id, reason: 'x' }, dir)],
    ['категория', await fin('expenses', 'POST', { target: 'category', name: 'Новая' }, dir)],
    ['оплата', await fin('payments', 'POST', { counterparty: 'Тест-КА', direction: 'in', amount: 1 }, dir)],
    ['отмена оплаты', await fin('payments', 'PATCH', { id: pay.body.id, reason: 'x' }, dir)],
    ['инвестиция', await fin('investments', 'POST', { title: 'Плёнка', amount: 1 }, dir)],
    ['правка инвестиции', await fin('investments', 'PATCH', { id: inv.body.id, action: 'edit', amount: 1 }, dir)],
    ['отмена инвестиции', await fin('investments', 'PATCH', { id: inv.body.id, reason: 'x' }, dir)],
    ['новый контрагент', await refs('POST', { target: 'customer', name: 'Директорский' }, dir)],
    ['правка контрагента', await refs('PATCH', { target: 'customer', id: cust.body.customer.id, phone: '1' }, dir)],
    ['сорт', await refs('POST', { target: 'grade', name: 'Директорский' }, dir)],
    ['складовщик: правка контрагента', await refs('PATCH', { target: 'customer', id: cust.body.customer.id, phone: '1' }, keeper)],
    ['складовщик: оплата', await fin('payments', 'POST', { counterparty: 'Тест-КА', direction: 'in', amount: 1 }, keeper)],
  ]) assert.equal(r.code, 403, why);

  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM expenses WHERE amount=1000 AND status='active'`);
  assert.equal(n, 1, 'директор ничего не записал');
  for (const resource of ['expenses', 'investments', 'reconcile']) {
    assert.equal((await fin(resource, 'GET', undefined, dir)).code, 200, `директор читает ${resource}`);
  }
  assert.equal((await call(report, { query: { from: today, to: today }, ...as(dir) })).code, 200, 'директор читает отчёт');
  assert.equal((await call(report, { query: { from: today, to: today }, ...as(keeper) })).code, 403, 'складовщику финансы по-прежнему закрыты');
  assert.equal((await refs('POST', { target: 'customer', name: 'Из продажи' }, keeper)).code, 200, 'складовщик добавляет покупателя прямо из продажи');
});

// ───────── идемпотентность ─────────
test('идемпотентность: повтор request_id не создаёт вторую оплату/акт/инвестицию/контрагента', async () => {
  const fin = (resource, body) => call(report, { method: 'POST', query: { resource }, body, ...as(admin) });
  const catId = (await call(report, { query: { resource: 'expenses' }, ...as(admin) })).body.categories[0].id;
  const cases = [
    ['payments', 'SELECT count(*)::int AS n FROM payments', (rid) => fin('payments', { request_id: rid, counterparty: 'Идем-КА', direction: 'in', amount: 777 })],
    ['expenses', 'SELECT count(*)::int AS n FROM expenses', (rid) => fin('expenses', { request_id: rid, target: 'expense', category_id: catId, amount: 777 })],
    ['investments', 'SELECT count(*)::int AS n FROM investments', (rid) => fin('investments', { request_id: rid, title: 'Идем', amount: 777 })],
    ['customer', 'SELECT count(*)::int AS n FROM customers', (rid) => call(status, { method: 'POST', query: { resource: 'refs' }, body: { request_id: rid, target: 'customer', name: 'Идем-КА-' + rid }, ...as(admin) })],
  ];
  for (const [name, countSql, send] of cases) {
    const rid = `rid-${name}-1`;
    const [{ n: before }] = await db.query(countSql);
    const a = await send(rid);
    assert.equal(a.code, 200, `${name}: ${JSON.stringify(a.body)}`);
    assert.ok(!a.body.duplicate);
    const b = await send(rid);
    assert.equal(b.code, 200);
    const firstId = a.body.id ?? a.body.customer?.id;
    assert.deepEqual(b.body, { ok: true, duplicate: true, id: firstId }, `${name}: повтор возвращает id первого документа`);
    const [{ n: after }] = await db.query(countSql);
    assert.equal(after - before, 1, `${name}: одна запись`);
  }
  // неудачная запись освобождает ключ: повтор с исправленными данными проходит
  const bad = await fin('payments', { request_id: 'rid-retry', counterparty: 'Идем-КА', direction: 'in', amount: -5 });
  assert.equal(bad.code, 400);
  const good = await fin('payments', { request_id: 'rid-retry', counterparty: 'Идем-КА', direction: 'in', amount: 5 });
  assert.equal(good.code, 200);
  assert.ok(!good.body.duplicate);
  // запрет по роли тоже не занимает ключ
  const denied = await call(report, { method: 'POST', query: { resource: 'payments' }, body: { request_id: 'rid-role', counterparty: 'Идем-КА', direction: 'in', amount: 5 }, ...as(dir) });
  assert.equal(denied.code, 403);
  assert.equal((await fin('payments', { request_id: 'rid-role', counterparty: 'Идем-КА', direction: 'in', amount: 5 })).body.duplicate, undefined);
  assert.equal((await fin('payments', { request_id: 'x'.repeat(101), counterparty: 'Идем-КА', direction: 'in', amount: 5 })).code, 400, 'слишком длинный request_id');
});

// ───────── /api/status, /api/movements ─────────
test('/api/status отдаёт today (Asia/Tashkent)', async () => {
  const r = await call(status, as(dir));
  assert.equal(r.code, 200);
  assert.equal(r.body.today, todayStr());
  assert.equal(r.body.today, new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tashkent' }));
});

test('/api/movements?sale_id=&device= возвращает все строки продажи для накладной', async () => {
  const ins = (device, id, saleId, grade, kg) => db.query(
    `INSERT INTO movements(device, id, ts, type, grade, net_kg, sale_id, customer, price_per_kg, amount)
     VALUES ($1,$2,now(),'out',$3,$4,$5,'Покупатель',1000,$6)`, [device, id, grade, kg, saleId, kg * 1000]);
  await ins('p-A', 1, 7, 'Высший', 2);
  await ins('p-A', 2, 7, 'Первый', 3);
  await ins('p-A', 3, 8, 'Высший', 1);
  await ins('p-B', 1, 7, 'Высший', 9);
  await ins('p-B', 5, null, 'Второй', 4); // продажа без sale_id: номер = id
  for (let i = 10; i < 120; i++) await ins('p-A', i, 100 + i, 'Высший', 1); // много других продаж

  const r = await call(movements, { query: { sale_id: '7', device: 'p-A' }, ...as(dir) });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.map((m) => [m.device, m.id]), [['p-A', 1], ['p-A', 2]]);
  assert.ok('gross_kg' in r.body[0] && 'amount' in r.body[0]);
  const both = await call(movements, { query: { sale_id: '7' }, ...as(dir) });
  assert.equal(both.body.length, 3, 'без device — все устройства');
  assert.equal((await call(movements, { query: { sale_id: '5', device: 'p-B' }, ...as(dir) })).body.length, 1, 'продажа без sale_id');
  assert.equal((await call(movements, { query: { device: 'p-B' }, ...as(dir) })).body.length, 2, 'фильтр device');
  assert.equal((await call(movements, { query: { sale_id: 'abc' }, ...as(dir) })).code, 400);
  assert.equal((await call(movements, { query: { type: 'out', limit: '5' }, ...as(dir) })).body.length, 5, 'прежние фильтры работают');
});

// ───────── валидация ─────────
test('валидация: несуществующие даты → 400, отрицательные строки акта → 400', async () => {
  const catId = (await call(report, { query: { resource: 'expenses' }, ...as(admin) })).body.categories[0].id;
  for (const [why, r] of [
    ['report from', await call(report, { query: { from: '2026-02-30', to: today }, ...as(admin) })],
    ['report to', await call(report, { query: { from: today, to: '2026-13-01' }, ...as(admin) })],
    ['expenses GET', await call(report, { query: { resource: 'expenses', from: '2026-02-30' }, ...as(admin) })],
    ['акт сверки', await call(report, { query: { resource: 'reconcile', counterparty: 'Тест-КА', from: '2025-02-29' }, ...as(admin) })],
    ['movements day', await call(movements, { query: { day: '2026-02-30' }, ...as(admin) })],
    ['doc_date акта', await call(report, { method: 'POST', query: { resource: 'expenses' }, body: { target: 'expense', category_id: catId, amount: 10, doc_date: '2026-02-30' }, ...as(admin) })],
    ['doc_date оплаты', await call(report, { method: 'POST', query: { resource: 'payments' }, body: { counterparty: 'Тест-КА', amount: 10, doc_date: '2026-04-31' }, ...as(admin) })],
    ['doc_date инвестиции', await call(report, { method: 'POST', query: { resource: 'investments' }, body: { title: 'Насос', amount: 10, doc_date: '2026-02-30' }, ...as(admin) })],
    ['doc_date мусор', await call(report, { method: 'POST', query: { resource: 'investments' }, body: { title: 'Насос', amount: 10, doc_date: "2026-01-01'; DROP" }, ...as(admin) })],
  ]) assert.equal(r.code, 400, why);
  assert.equal((await call(report, { query: { from: '2024-02-29', to: '2024-03-01' }, ...as(admin) })).code, 200, 'настоящий 29 февраля проходит');

  const act = (items) => call(report, { method: 'POST', query: { resource: 'expenses' }, body: { target: 'expense', category_id: catId, items }, ...as(admin) });
  assert.equal((await act([{ name: 'Возврат', qty: 1, price: 100 }, { name: 'Минус', sum: -50 }])).code, 400, 'отрицательная сумма строки');
  assert.equal((await act([{ name: 'Минус', qty: 1, price: -100 }])).code, 400, 'отрицательная цена');
  assert.equal((await act([{ name: 'Минус', qty: -2, price: 100 }])).code, 400, 'отрицательное количество');
  assert.equal((await act([{ name: 'Текст', qty: 'abc', price: 100 }])).code, 400, 'нечисловое количество');
  const ok = await act([{ name: 'Плёнка', qty: 2, price: 100 }]);
  assert.equal(ok.code, 200);
  const edit = await call(report, { method: 'PATCH', query: { resource: 'expenses' }, body: { target: 'expense', action: 'edit', id: ok.body.id, items: [{ name: 'x', sum: -1 }] }, ...as(admin) });
  assert.equal(edit.code, 400, 'правка с отрицательной строкой');
  const editDate = await call(report, { method: 'PATCH', query: { resource: 'expenses' }, body: { target: 'expense', action: 'edit', id: ok.body.id, doc_date: '2026-02-30' }, ...as(admin) });
  assert.equal(editDate.code, 400, 'правка с несуществующей датой');
});

// ───────── журнал сервера ─────────
test('лог ошибок: только код и текст, без SQL-параметров и данных', async () => {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try {
    const h = http.handler(async () => {
      const e = new Error('duplicate key value');
      e.code = '23505';
      e.params = ['secret-password-123'];
      e.query = 'INSERT INTO app_users ... secret-password-123';
      throw e;
    });
    const r = await call(h, as(admin));
    assert.equal(r.code, 500);
  } finally {
    console.error = orig;
  }
  const out = lines.join('\n');
  assert.match(out, /23505/);
  assert.match(out, /duplicate key value/);
  assert.ok(!out.includes('secret-password-123'), 'параметры не попали в лог');
  assert.ok(!/\n\s+at /.test(out), 'без стека');
});

// ───────── Excel / CSV ─────────
test('CSV: ячейки с = + - @ обезврежены апострофом, числа не тронуты', async () => {
  await db.query(
    `INSERT INTO movements(device, id, ts, type, grade, net_kg, customer, note, worker, price_per_kg, amount, user_name)
     VALUES ('csv', 1, now(), 'out', 'Высший', 2, '=HYPERLINK("http://evil","x")', '+cmd|calc', '@SUM(A1)', 1000, 2000, '-2+3')`
  );
  const r = await call(report, { query: { from: today, to: today, format: 'csv' }, ...as(admin) });
  assert.equal(r.code, 200);
  const line = String(r.body).split('\r\n').find((l) => l.startsWith('csv;'));
  assert.ok(line, 'строка выгружена');
  const cells = line.split(';');
  assert.ok(line.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), line);
  assert.ok(cells.includes("'+cmd|calc"), 'формула + обезврежена');
  assert.ok(cells.includes("'@SUM(A1)"), 'формула @ обезврежена');
  assert.ok(cells.includes("'-2+3"), 'формула - обезврежена');
  assert.ok(!cells.some((c) => /^[=+@]/.test(c)), 'ни одна ячейка не начинается с формулы');
  assert.ok(cells.includes('2000'), 'числа как есть');
});
