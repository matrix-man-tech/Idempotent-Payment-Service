const express = require('express');
const { createChargeHandler } = require('./chargeHandler');

// ---------------------------------------------------------------------------
// Express Application Factory
// ---------------------------------------------------------------------------

/**
 * Create and configure the Express application.
 *
 * @param {Object}  deps
 * @param {Object}  deps.stmts           — prepared statements from db.js
 * @param {Object}  [deps.providerOpts]  — options forwarded to provider.charge()
 * @returns {import('express').Application}
 */
function createApp({ stmts, providerOpts = {} }) {
  const app = express();

  // --- Middleware ---------------------------------------------------------
  app.use(express.json());

  // --- Routes ------------------------------------------------------------

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Charge endpoint — the star of the show
  app.post('/charge', createChargeHandler({ stmts, providerOpts }));

  // --- Error handler -----------------------------------------------------
  app.use((err, _req, res, _next) => {
    console.error('[ERROR]', err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

module.exports = { createApp };
