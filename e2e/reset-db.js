// Drops and recreates the tables of the throwaway E2E database from chat.sql.
// Refuses to touch anything whose name does not end with "_test".
const fs = require('fs');
const mysql = require('mysql2/promise');

(async () => {
  const name = process.env.DB_NAME || '';
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset: DB_NAME must end with "_test" (got "${name}")`);
  }
  const sql = fs.readFileSync(process.env.CHAT_SQL || '/chat.sql', 'utf8');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: name,
    multipleStatements: true,
  });
  await conn.query('DROP TABLE IF EXISTS messages, chat_room, schema_migrations, admin_sessions');
  await conn.query(sql);
  await conn.end();
  console.log(`reset-db: ${name} recreated from chat.sql`);
})().catch((e) => { console.error(e.message); process.exit(1); });
