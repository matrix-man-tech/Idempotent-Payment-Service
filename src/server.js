const { createDatabase, createStatements, reapStaleLocks, purgeExpiredKeys } = require('./db');
const { createApp } = require('./app');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT                 = process.env.PORT || 3000;
const CLEANUP_INTERVAL_MS  = 60 * 1000; // run maintenance every 60 s

// ---------------------------------------------------------------------------
// Bootstrap (async because sql.js WASM loading is async)
// ---------------------------------------------------------------------------

(async function main() {
  const db    = await createDatabase();
  const stmts = createStatements(db);
  const app   = createApp({ stmts });

  // -----------------------------------------------------------------------
  // Periodic maintenance
  // -----------------------------------------------------------------------
  const cleanupTimer = setInterval(() => {
    try {
      const reaped = reapStaleLocks(stmts);
      const purged = purgeExpiredKeys(stmts);
      if (reaped.changes > 0 || purged.changes > 0) {
        console.log(
          `[MAINTENANCE] reaped ${reaped.changes} stale lock(s), purged ${purged.changes} expired key(s)`,
        );
      }
    } catch (err) {
      console.error('[MAINTENANCE ERROR]', err);
    }
  }, CLEANUP_INTERVAL_MS);

  // -----------------------------------------------------------------------
  // Start server
  // -----------------------------------------------------------------------
  const server = app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║   Idempotent Payment Retry Service                         ║
║   Listening on http://localhost:${String(PORT).padEnd(5)}                       ║
║   Database: in-memory SQLite (sql.js / WASM)               ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });

  // -----------------------------------------------------------------------
  // Graceful shutdown
  // -----------------------------------------------------------------------
  function shutdown(signal) {
    console.log(`\n[${signal}] Shutting down gracefully…`);
    clearInterval(cleanupTimer);
    server.close(() => {
      db.close();
      console.log('Server closed. Goodbye.');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
})();
