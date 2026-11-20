// Локальный стенд: те же обработчики, что на Vercel, но поверх PGlite. Для проверки без аккаунтов и интернета.
// Запуск: node test/devserver.js  (порт 3100)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

process.env.INGEST_TOKEN = process.env.INGEST_TOKEN || 'dev-ingest-token-0123456789abcdef';
process.env.DASHBOARD_PASSWORDS = process.env.DASHBOARD_PASSWORDS || 'dev-password-1234';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret-0123456789abcdef';

const pg = new PGlite();
globalThis.__TEST_DB = { query: async (text, params) => (await pg.query(text, params)).rows };

const routes = {};
for (const f of fs.readdirSync(path.join(__dirname, '../api'))) routes['/api/' + f.replace('.js', '')] = require('../api/' + f);

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      req.query = Object.fromEntries(url.searchParams);
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
      const setHeader = res.setHeader.bind(res); // на http без шифрования Secure-cookie не работают, на Vercel (https) это не нужно
      res.setHeader = (k, v) => setHeader(k, k.toLowerCase() === 'set-cookie' ? String(v).replace('; Secure', '') : v);
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (o) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
      const fn = routes[url.pathname];
      if (fn) return fn(req, res);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(__dirname, '../public/index.html')));
    });
  })
  .listen(3100, '127.0.0.1', () => console.log('облако (стенд) на http://localhost:3100'));
