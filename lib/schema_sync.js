// Схема для синхронизации сайт ↔ склад (зеркало веб-операций, алиасы сортов, курсоры). Подключается в lib/db.js.
module.exports = [
  // Переименования сортов на сайте: моноблок ещё может присылать старое имя — облако переводит его в новое,
  // а моноблок по списку алиасов переименовывает свои записи и config.json.
  `CREATE TABLE IF NOT EXISTS grade_aliases(
     old_name text PRIMARY KEY,
     new_name text NOT NULL,
     ts timestamptz NOT NULL DEFAULT now())`,
  // Зеркало веб-операций для моноблока читается по курсору (updated_at, id) только для device='web'.
  `CREATE INDEX IF NOT EXISTS movements_web_upd_idx ON movements (updated_at, id) WHERE device='web'`,
  // Очередь команд по устройству и статусу (лимит, применение зависших, выдача моноблоку).
  `CREATE INDEX IF NOT EXISTS commands_user_status_idx ON commands (user_name, status)`,
];
