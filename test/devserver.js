// Локальный стенд: те же обработчики, что на Vercel, но поверх PGlite + статика и SPA-роутинг.
// Запуск: node test/devserver.js  (порт 3100)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

process.env.INGEST_TOKEN = process.env.INGEST_TOKEN || 'dev-ingest-token-0123456789abcdef';
process.env.SETUP_KEY = process.env.SETUP_KEY || 'dev-setup-key-0123456789abcdef';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret-0123456789abcdef';

const pg = new PGlite();
globalThis.__TEST_DB = {
  query: async (text, params) => (await pg.query(text, params)).rows,
  transaction: async (list) => pg.transaction(async (tx) => { const out = []; for (const [t, p] of list) out.push((await tx.query(t, p || [])).rows); return out; }),
};

const routes = {};
for (const f of fs.readdirSync(path.join(__dirname, '../api'))) routes['/api/' + f.replace('.js', '')] = require('../api/' + f);

const PUB = path.join(__dirname, '../public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      req.query = Object.fromEntries(url.searchParams);
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (k, v) => {
        if (k.toLowerCase() !== 'set-cookie') return setHeader(k, v);
        const strip = (s) => String(s).replace('; Secure', '');
        return setHeader(k, Array.isArray(v) ? v.map(strip) : strip(v));
      };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (o) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
      const fn = routes[url.pathname];
      if (fn) return fn(req, res);
      const rel = path.normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, '');
      const file = path.join(PUB, rel);
      const target = file.startsWith(PUB) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(PUB, 'index.html');
      res.setHeader('Content-Type', MIME[path.extname(target)] || 'application/octet-stream');
      res.end(fs.readFileSync(target));
    });
  })
  .listen(3100, '127.0.0.1', () => console.log('облако (стенд) на http://localhost:3100'));
