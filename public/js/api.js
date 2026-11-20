// Централизованный HTTP-клиент для /api/* с единой обработкой 401 и must_change.
let onUnauthorized = () => {};
let onMustChange = () => {};

export function configureAuthHandlers({ unauthorized, mustChange }) {
  onUnauthorized = unauthorized;
  onMustChange = mustChange;
}

export async function rawCall(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data };
}

export async function api(method, path, body) {
  const r = await rawCall(method, path, body);
  if (r.status === 401) {
    onUnauthorized();
    return { ok: false, data: r.data };
  }
  if (r.status === 403 && r.data && r.data.must_change) {
    onMustChange();
    return { ok: false, data: r.data };
  }
  return r;
}

export const errMsg = (r) => (r.data && r.data.error) || 'Ошибка';
