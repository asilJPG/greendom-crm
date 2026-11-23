// Централизованный HTTP-клиент для /api/* с единой обработкой 401.
// Смены собственного пароля больше нет: пароли сотрудникам задаёт только администратор.
let onUnauthorized = () => {};
let onMustChange = () => {};

export function configureAuthHandlers({ unauthorized, mustChange }) {
  onUnauthorized = unauthorized;
  if (mustChange) onMustChange = mustChange;
}

// Связь определяем по настоящим запросам, а не по navigator.onLine: на Windows браузер иногда считает,
// что сети нет (Wi-Fi моргнул, «Нет подключения к Интернету»), хотя сервер отвечает. Тогда сайт копил операции
// в очереди и другие устройства их не видели.
export const net = { ok: true };
function setNet(ok) {
  if (net.ok === ok) return;
  net.ok = ok;
  try { window.dispatchEvent(new CustomEvent('netchange', { detail: { ok } })); } catch {}
}

export async function rawCall(method, path, body) {
  let res;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  // запрос, который висит дольше этого времени, считаем обрывом связи
  const timer = ctrl ? setTimeout(() => ctrl.abort(), method === 'GET' ? 15000 : 20000) : null;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch {
    setNet(false);
    return { ok: false, status: 0, data: { error: 'Нет связи с сервером. Проверьте интернет и повторите' } };
  } finally {
    if (timer) clearTimeout(timer);
  }
  setNet(true);
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
    return { ok: false, status: 401, data: r.data };
  }
  if (r.status === 403 && r.data && r.data.must_change) {
    onMustChange();
    return { ok: false, status: 403, data: r.data };
  }
  return r;
}

export const errMsg = (r) => (r.data && r.data.error) || (r.status === 403 ? 'Недостаточно прав' : 'Ошибка');

export const newRequestId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
