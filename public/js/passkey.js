// Клиент WebAuthn / Passkeys (Face ID на iPhone, Touch ID на Mac, отпечаток/лицо на Android).
import { api, rawCall, errMsg } from './api.js';

function b64uToBuf(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
}

function bufToB64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function detectDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone (Face ID)';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Macintosh/i.test(ua)) return 'Mac (Touch ID)';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  return 'Устройство';
}

export async function isPasskeySupported() {
  if (!window.PublicKeyCredential || !navigator.credentials) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function registerPasskey() {
  const optRes = await api('POST', '/api/passkey', { action: 'reg_options' });
  if (!optRes.ok) throw new Error(errMsg(optRes));
  const opts = optRes.data;

  const cred = await navigator.credentials.create({
    publicKey: {
      ...opts,
      challenge: b64uToBuf(opts.challenge),
      user: { ...opts.user, id: b64uToBuf(opts.user.id) },
      excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    },
  });
  if (!cred || !cred.response) throw new Error('Не удалось создать ключ');
  if (!cred.response.getPublicKey || !cred.response.getAuthenticatorData) {
    throw new Error('Браузер не поддерживает экспорт ключа Passkey (обновите Safari/Chrome)');
  }

  const verifyRes = await api('POST', '/api/passkey', {
    action: 'reg_verify',
    id: cred.id,
    clientDataJSON: bufToB64u(cred.response.clientDataJSON),
    authenticatorData: bufToB64u(cred.response.getAuthenticatorData()),
    publicKey: bufToB64u(cred.response.getPublicKey()),
    alg: cred.response.getPublicKeyAlgorithm ? cred.response.getPublicKeyAlgorithm() : -7,
    device_name: detectDeviceName(),
  });
  if (!verifyRes.ok) throw new Error(errMsg(verifyRes));
  return true;
}

export async function loginWithPasskey() {
  const optRes = await rawCall('POST', '/api/passkey', { action: 'auth_options' });
  if (!optRes.ok) throw new Error(errMsg(optRes));
  const opts = optRes.data;

  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64uToBuf(opts.challenge),
      rpId: opts.rpId,
      timeout: opts.timeout || 60000,
      userVerification: 'required',
    },
  });
  if (!cred || !cred.response) throw new Error('Вход отменён');

  const verifyRes = await rawCall('POST', '/api/passkey', {
    action: 'auth_verify',
    id: cred.id,
    clientDataJSON: bufToB64u(cred.response.clientDataJSON),
    authenticatorData: bufToB64u(cred.response.authenticatorData),
    signature: bufToB64u(cred.response.signature),
  });
  if (!verifyRes.ok) throw new Error(errMsg(verifyRes));
  return verifyRes.data;
}
