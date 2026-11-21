// Service Worker: кеширует оболочку сайта (Network-First), чтобы моноблок открывался и работал даже без интернета.
const CACHE = 'teplica-shell-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/api.js',
  '/js/app.js',
  '/js/num.js',
  '/js/numpad.js',
  '/js/offline.js',
  '/js/scale.js',
  '/js/passkey.js',
  '/js/report.js',
  '/js/invoice.js',
  '/js/expenses.js',
  '/js/payments.js',
  '/js/investments.js',
  '/js/counterparties.js',
  '/js/refs.js',
  '/js/ui.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API-запросы не кешируем в SW — для них работает IndexedDB в offline.js
  if (url.pathname.startsWith('/api/')) return;

  // Network-first: при наличии сети всегда берём свежий деплой и обновляем кеш;
  // при пропаже сети отдаём кеш (для SPA-маршрутов — /index.html).
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate') {
          return (await caches.match('/index.html')) || (await caches.match('/'));
        }
        return new Response('Offline', { status: 503 });
      })
  );
});
