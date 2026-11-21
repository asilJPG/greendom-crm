// Оффлайн-хранилище (IndexedDB) и очередь складских операций для работы моноблока без интернета.
// Когда сеть пропадает: приход, продажа и списание сохраняются локально в IndexedDB с тем же request_id.
// Когда сеть появляется: очередь автоматически отправляется в /api/command в хронологическом порядке (без дублей).
import { rawCall } from './api.js';

const DB_NAME = 'teplica_offline_v1';
const DB_VER = 1;
const QUEUEABLE = new Set(['intake', 'sale', 'writeoff']);

let dbPromise = null;
let flushing = false;
let onChangeCb = () => {};
let onSyncedCb = () => {};

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'request_id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbTx(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const res = fn(store);
    tx.oncomplete = () => resolve(res && 'result' in res ? res.result : res);
    tx.onerror = () => reject(tx.error);
  }));
}

export async function cacheSet(key, value) {
  try { await idbTx('kv', 'readwrite', (s) => s.put({ key, value, ts: Date.now() })); } catch {}
}

export async function cacheGet(key) {
  try {
    const row = await idbTx('kv', 'readonly', (s) => s.get(key));
    return row ? row.value : null;
  } catch {
    return null;
  }
}

export function isQueueableKind(kind) {
  return QUEUEABLE.has(kind);
}

export async function listOutbox() {
  try {
    const rows = await idbTx('outbox', 'readonly', (s) => s.getAll());
    return (rows || []).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  } catch {
    return [];
  }
}

export async function enqueueOffline(kind, payload, request_id) {
  const item = { request_id, kind, payload, created_at: Date.now() };
  await idbTx('outbox', 'readwrite', (s) => s.put(item));
  const count = (await listOutbox()).length;
  onChangeCb({ online: navigator.onLine, pending: count });
  return count;
}

async function removeOutbox(request_id) {
  await idbTx('outbox', 'readwrite', (s) => s.delete(request_id));
}

export async function flushOfflineQueue() {
  if (flushing || !navigator.onLine) return { sent: 0, remaining: (await listOutbox()).length };
  flushing = true;
  let sent = 0;
  let failedMsgs = [];
  try {
    const items = await listOutbox();
    for (const it of items) {
      const r = await rawCall('POST', '/api/command', {
        kind: it.kind,
        payload: it.payload,
        request_id: it.request_id,
      });
      if (r.ok) {
        await removeOutbox(it.request_id);
        sent++;
      } else if (r.status === 0 || r.status >= 500) {
        // Сеть всё ещё нестабильна — остановимся и попробуем позже
        break;
      } else if (r.status === 401 || r.status === 403) {
        // Сессия истекла — оставим в очереди до повторного входа
        break;
      } else {
        // Постоянная бизнес-ошибка (например, нехватка остатка) — убираем, чтобы не блокировать очередь
        await removeOutbox(it.request_id);
        failedMsgs.push((r.data && r.data.error) || 'Операция отклонена сервером');
      }
    }
    const remaining = (await listOutbox()).length;
    onChangeCb({ online: navigator.onLine, pending: remaining });
    if (sent > 0 || failedMsgs.length > 0) onSyncedCb({ sent, remaining, failedMsgs });
    return { sent, remaining };
  } finally {
    flushing = false;
  }
}

/** Применяет локально ещё не отправленные операции поверх кешированных остатков */
export function applyOutboxToStock(stockData, outbox) {
  if (!stockData || !Array.isArray(stockData.rows) || !outbox.length) return stockData;
  const rows = stockData.rows.map((r) => ({ ...r }));
  const byName = Object.fromEntries(rows.map((r) => [r.grade, r]));
  const addDelta = (grade, field, kg) => {
    if (!byName[grade]) {
      const nr = { grade, in_kg: 0, out_kg: 0, writeoff_kg: 0, balance_kg: 0 };
      rows.push(nr);
      byName[grade] = nr;
    }
    byName[grade][field] = Math.round((byName[grade][field] + kg) * 1000) / 1000;
    byName[grade].balance_kg = Math.round((byName[grade].in_kg - byName[grade].out_kg - byName[grade].writeoff_kg) * 1000) / 1000;
  };
  for (const it of outbox) {
    const p = it.payload || {};
    if (it.kind === 'intake') addDelta(p.grade, 'in_kg', Number(p.net_kg || 0));
    else if (it.kind === 'writeoff') addDelta(p.grade, 'writeoff_kg', Number(p.net_kg || 0));
    else if (it.kind === 'sale') {
      for (const s of p.items || []) addDelta(s.grade, 'out_kg', Number(s.net_kg || 0));
    }
  }
  const total_kg = Math.round(rows.reduce((a, r) => a + r.balance_kg, 0) * 1000) / 1000;
  return { rows, total_kg };
}

export async function initOffline({ onChange, onSynced } = {}) {
  onChangeCb = onChange || (() => {});
  onSyncedCb = onSynced || (() => {});

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const update = async () => {
    const pending = (await listOutbox()).length;
    onChangeCb({ online: navigator.onLine, pending });
  };

  window.addEventListener('online', async () => {
    await update();
    await flushOfflineQueue();
  });
  window.addEventListener('offline', update);

  setInterval(async () => {
    if (navigator.onLine) {
      const items = await listOutbox();
      if (items.length) await flushOfflineQueue();
    }
  }, 15000);

  await update();
}
