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
  return client().query(text, params);
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
  `CREATE INDEX IF NOT EXISTS movements_grade_status_idx ON movements (grade, status)`,
  `CREATE TABLE IF NOT EXISTS devices(
     device text PRIMARY KEY,
     last_seen timestamptz NOT NULL,
     crop text,
     currency text,
     grades jsonb,
     pending integer NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS login_fails(ip text NOT NULL, ts timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE login_fails ADD COLUMN IF NOT EXISTS name text`,
  `CREATE INDEX IF NOT EXISTS login_fails_ts_idx ON login_fails (ts)`,
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
  `ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check`,
  `UPDATE app_users SET role='director' WHERE role='viewer'`,
  `ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('admin','director','keeper'))`,
  `ALTER TABLE app_users ADD COLUMN IF NOT EXISTS pass_enc text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS app_users_name_idx ON app_users (lower(name))`,
  `CREATE TABLE IF NOT EXISTS audit_log(
     id serial PRIMARY KEY,
     ts timestamptz NOT NULL DEFAULT now(),
     user_name text,
     action text NOT NULL,
     detail text NOT NULL DEFAULT '',
     ip text)`,
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
  `CREATE TABLE IF NOT EXISTS passkeys(
     id text PRIMARY KEY,
     user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
     public_key text NOT NULL,
     alg integer NOT NULL DEFAULT -7,
     counter bigint NOT NULL DEFAULT 0,
     device_name text NOT NULL DEFAULT '',
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys (user_id)`,
  `CREATE TABLE IF NOT EXISTS expense_categories(
     id serial PRIMARY KEY,
     name text NOT NULL,
     active boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS exp_cat_name_idx ON expense_categories (lower(name))`,
  `INSERT INTO expense_categories(name)
     SELECT v FROM (VALUES ('Зарплата'),('Удобрения и химия'),('Тара и упаковка'),('Транспорт и доставка'),('Коммуналка и газ'),('Ремонт и инвентарь'),('Прочее')) AS t(v)
     WHERE NOT EXISTS (SELECT 1 FROM expense_categories)`,
  `CREATE TABLE IF NOT EXISTS expenses(
     id serial PRIMARY KEY,
     doc_date date NOT NULL,
     category_id integer NOT NULL REFERENCES expense_categories(id),
     amount double precision NOT NULL,
     counterparty text NOT NULL DEFAULT '',
     payment_method text NOT NULL DEFAULT 'cash',
     comment text NOT NULL DEFAULT '',
     user_name text,
     status text NOT NULL DEFAULT 'active',
     cancel_reason text,
     cancelled_by text,
     cancelled_ts timestamptz,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS expenses_date_status_idx ON expenses (doc_date, status)`,
  `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS doc_number text NOT NULL DEFAULT ''`,
  `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb`,
  // Справочники: сорта и покупатели (без хардкода)
  `CREATE TABLE IF NOT EXISTS grades(
     id serial PRIMARY KEY,
     name text NOT NULL,
     sort_order integer NOT NULL DEFAULT 0,
     active boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS grades_name_idx ON grades (lower(name))`,
  `INSERT INTO grades(name, sort_order)
     SELECT v, o FROM (VALUES ('Высший',1),('Первый',2),('Второй',3)) AS t(v, o)
     WHERE NOT EXISTS (SELECT 1 FROM grades)`,
  `CREATE TABLE IF NOT EXISTS customers(
     id serial PRIMARY KEY,
     name text NOT NULL,
     kind text NOT NULL DEFAULT 'buyer',
     inn text NOT NULL DEFAULT '',
     phone text NOT NULL DEFAULT '',
     note text NOT NULL DEFAULT '',
     active boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'buyer'`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS inn text NOT NULL DEFAULT ''`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_person text NOT NULL DEFAULT ''`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS telegram text NOT NULL DEFAULT ''`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS address text NOT NULL DEFAULT ''`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_terms text NOT NULL DEFAULT ''`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS bank_details text NOT NULL DEFAULT ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS customers_name_idx ON customers (lower(name))`,
  `INSERT INTO customers(name)
     SELECT DISTINCT trim(customer) FROM movements
     WHERE customer IS NOT NULL AND trim(customer) <> ''
     ON CONFLICT DO NOTHING`,
  // Оплаты по контрагентам (для актов сверки и контроля долгов)
  `CREATE TABLE IF NOT EXISTS payments(
     id serial PRIMARY KEY,
     doc_date date NOT NULL,
     counterparty text NOT NULL,
     direction text NOT NULL CHECK(direction IN ('in','out')),
     amount double precision NOT NULL,
     payment_method text NOT NULL DEFAULT 'cash',
     comment text NOT NULL DEFAULT '',
     user_name text,
     status text NOT NULL DEFAULT 'active',
     cancel_reason text,
     cancelled_by text,
     cancelled_ts timestamptz,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS payments_cp_date_idx ON payments (lower(counterparty), doc_date)`,
  // Инвестиции и капитальные вложения в теплицу (отдельно от операционных расходов)
  `CREATE TABLE IF NOT EXISTS investments(
     id serial PRIMARY KEY,
     doc_date date NOT NULL,
     category text NOT NULL DEFAULT 'Постройка и оборудование',
     title text NOT NULL,
     investor text NOT NULL DEFAULT '',
     amount double precision NOT NULL,
     payment_method text NOT NULL DEFAULT 'transfer',
     doc_number text NOT NULL DEFAULT '',
     comment text NOT NULL DEFAULT '',
     user_name text,
     status text NOT NULL DEFAULT 'active',
     cancel_reason text,
     cancelled_by text,
     cancelled_ts timestamptz,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS investments_date_status_idx ON investments (doc_date, status)`,
  // Атомарные последовательности для записей, создаваемых с сайта (device='web')
  `CREATE SEQUENCE IF NOT EXISTS web_mov_seq START 1`,
  `CREATE SEQUENCE IF NOT EXISTS web_sale_seq START 1`,
  `SELECT setval('web_mov_seq', GREATEST(COALESCE((SELECT MAX(id) FROM movements WHERE device='web'), 0), 1), COALESCE((SELECT MAX(id) FROM movements WHERE device='web'), 0) > 0)`,
  `SELECT setval('web_sale_seq', GREATEST(COALESCE((SELECT MAX(sale_id) FROM movements WHERE device='web'), 0), 1), COALESCE((SELECT MAX(sale_id) FROM movements WHERE device='web'), 0) > 0)`,
  // Снимаем устаревший флаг временного пароля у уже созданных сотрудников
  `UPDATE app_users SET must_change=false WHERE must_change=true`,
  // Очистка старых записей неудачных входов (старше суток) при холодном старте
  `DELETE FROM login_fails WHERE ts < now() - interval '24 hours'`,
  ...require('./schema_sync'),
  ...require('./schema_auth'),
];

// Несколько запросов одной транзакцией: [[text, params], ...] -> массив результатов (массивы строк).
// Neon: HTTP-транзакция (все запросы атомарно, по очереди); тесты: PGlite transaction (если есть в __TEST_DB).
async function transaction(list) {
  const c = client();
  if (globalThis.__TEST_DB) {
    if (globalThis.__TEST_DB.transaction) return globalThis.__TEST_DB.transaction(list);
    const out = [];
    for (const [t, p] of list) out.push(await c.query(t, p || []));
    return out;
  }
  return c.transaction(list.map(([t, p]) => c.query(t, p || [])));
}

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

module.exports = { query, transaction, ensureSchema, resetSchemaCache };
