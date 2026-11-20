// Доступ к Postgres (Neon). В тестах подменяется локальным PGlite через globalThis.__TEST_DB.
let neonSql;

function client() {
  if (globalThis.__TEST_DB) return globalThis.__TEST_DB;
  if (!neonSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL не задан');
    const { neon } = require('@neondatabase/serverless');
    neonSql = neon(url);
  }
  return neonSql;
}

async function query(text, params = []) {
  return client().query(text, params); // массив строк
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS movements(
     device text NOT NULL,
     id integer NOT NULL,
     ts timestamp NOT NULL,
     type text NOT NULL,
     grade text NOT NULL,
     gross_kg double precision,
     tare_kg double precision,
     net_kg double precision NOT NULL,
     manual boolean NOT NULL DEFAULT false,
     worker text NOT NULL DEFAULT '',
     note text NOT NULL DEFAULT '',
     sale_id integer,
     customer text,
     price_per_kg double precision,
     amount double precision,
     user_name text,
     status text NOT NULL DEFAULT 'active',
     cancel_reason text,
     cancelled_ts timestamp,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (device, id))`,
  `CREATE INDEX IF NOT EXISTS movements_ts_idx ON movements (ts)`,
  `CREATE TABLE IF NOT EXISTS devices(
     device text PRIMARY KEY,
     last_seen timestamptz NOT NULL,
     crop text,
     currency text,
     grades jsonb,
     pending integer NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS login_fails(ip text NOT NULL, ts timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE login_fails ADD COLUMN IF NOT EXISTS name text`,
  `CREATE TABLE IF NOT EXISTS app_users(
     id serial PRIMARY KEY,
     name text NOT NULL,
     role text NOT NULL,
     pass_hash text NOT NULL,
     active boolean NOT NULL DEFAULT true,
     must_change boolean NOT NULL DEFAULT false,
     token_version integer NOT NULL DEFAULT 1,
     last_login timestamptz,
     created_at timestamptz NOT NULL DEFAULT now())`,
  // роли: admin (всё), director (остатки, отчёты, история), keeper (то же + приход и продажа); прежний viewer = director
  `ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check`,
  `UPDATE app_users SET role='director' WHERE role='viewer'`,
  `ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('admin','director','keeper'))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS app_users_name_idx ON app_users (lower(name))`,
  `CREATE TABLE IF NOT EXISTS audit_log(
     id serial PRIMARY KEY,
     ts timestamptz NOT NULL DEFAULT now(),
     user_name text,
     action text NOT NULL,
     detail text NOT NULL DEFAULT '',
     ip text)`,
  // очередь операций с сайта: сайт кладёт, моноблок забирает при обмене и отвечает applied/rejected
  `CREATE TABLE IF NOT EXISTS commands(
     id serial PRIMARY KEY,
     ts timestamptz NOT NULL DEFAULT now(),
     device text NOT NULL,
     user_name text NOT NULL,
     user_role text NOT NULL,
     kind text NOT NULL,
     payload jsonb NOT NULL,
     req_id text,
     status text NOT NULL DEFAULT 'pending',
     result text,
     done_ts timestamptz)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS commands_req_idx ON commands (req_id) WHERE req_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS commands_dev_idx ON commands (device, status)`,
];

let schemaReady;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of SCHEMA) await query(sql);
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

function resetSchemaCache() {
  schemaReady = null;
}

module.exports = { query, ensureSchema, resetSchemaCache };
