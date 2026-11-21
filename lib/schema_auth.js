// Схема для входа и безопасности (challenge Face ID, ключи идемпотентности и т.п.). Подключается в lib/db.js.
module.exports = [
  // Одноразовые короткоживущие challenge WebAuthn: хранятся на сервере и удаляются при первом использовании,
  // поэтому перехваченный ответ Face ID нельзя предъявить повторно.
  `CREATE TABLE IF NOT EXISTS webauthn_challenges(
     challenge text PRIMARY KEY,
     kind text NOT NULL,
     user_id integer,
     expires_at timestamptz NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS webauthn_challenges_exp_idx ON webauthn_challenges (expires_at)`,
  `DELETE FROM webauthn_challenges WHERE expires_at < now()`,
  // Ключи идемпотентности денежных записей (оплаты, акты расхода, инвестиции, контрагенты).
  `CREATE TABLE IF NOT EXISTS idempotency_keys(
     key text PRIMARY KEY,
     user_name text,
     created_at timestamptz NOT NULL DEFAULT now())`,
  // id созданного документа: повтор запроса возвращает его в ответе { ok, duplicate, id }.
  `ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS doc_id integer`,
  `DELETE FROM idempotency_keys WHERE created_at < now() - interval '30 days'`,
];
