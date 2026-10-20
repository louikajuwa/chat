const { loadConfig } = require('./src/config');
const { createPool, waitForDb } = require('./src/db');
const { createApp } = require('./src/app');

process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
// State is unknown after an uncaught exception: exit and let Docker restart us.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  process.exit(1);
});

async function main() {
  const config = loadConfig();
  config.warnings.forEach((w) => console.warn(`WARNING: ${w}`));

  const pool = createPool(config);
  await waitForDb(pool);
  const { server, io } = createApp({ pool, config });

  server.listen(config.PORT, () => {
    console.log(`Server running on http://localhost:${config.PORT}`);
  });

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 10000).unref();
    try {
      await io.close(); // also closes the underlying http server
      if (server.listening) await new Promise((r) => server.close(r));
      await pool.end();
    } catch (err) {
      console.error('shutdown error:', err);
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
