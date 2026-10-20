#!/usr/bin/env bash
# Idempotent DB bootstrap, run by the one-shot `db-setup` compose service on every `up`:
#  1. create/rotate the least-privilege `chat_app` user and its grants
#  2. apply db/migrations/NNN_name.sql to `chat` in order, once each (tracked in schema_migrations)
set -euo pipefail

: "${MYSQL_ROOT_PASSWORD:?}" "${DB_APP_PASSWORD:?}"
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"   # keeps the password off the command line
MYSQL=(mysql -h db -uroot --batch --skip-column-names)

echo "db-setup: waiting for MySQL"
for _ in $(seq 1 30); do "${MYSQL[@]}" -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 2; done

echo "db-setup: user and grants"
"${MYSQL[@]}" <<SQL
CREATE DATABASE IF NOT EXISTS \`chat\`;
CREATE DATABASE IF NOT EXISTS \`chat_test\`;
CREATE USER IF NOT EXISTS 'chat_app'@'%' IDENTIFIED BY '${DB_APP_PASSWORD}';
ALTER USER 'chat_app'@'%' IDENTIFIED BY '${DB_APP_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`chat\`.* TO 'chat_app'@'%';
GRANT ALL PRIVILEGES ON \`chat_test\`.* TO 'chat_app'@'%';
FLUSH PRIVILEGES;
SQL

echo "db-setup: migrations"
"${MYSQL[@]}" chat -e "CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"

shopt -s nullglob
for f in /db/migrations/[0-9][0-9][0-9]_*.sql; do   # glob expands sorted
  v=$(basename "$f" .sql)
  if [ -n "$("${MYSQL[@]}" chat -e "SELECT 1 FROM schema_migrations WHERE version='${v}'")" ]; then
    echo "  skip  $v"
    continue
  fi
  echo "  apply $v"
  "${MYSQL[@]}" chat < "$f"
  "${MYSQL[@]}" chat -e "INSERT INTO schema_migrations (version) VALUES ('${v}')"
done
echo "db-setup: done"
