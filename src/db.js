const initSqlJs = require('sql.js');

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

/** Cached sql.js module (loaded once, reused across createDatabase calls). */
let _SQL = null;

/**
 * Load the sql.js WASM module (idempotent — only loads once).
 * @returns {Promise<import('sql.js').SqlJsStatic>}
 */
async function initSQL() {
  if (!_SQL) {
    _SQL = await initSqlJs();
  }
  return _SQL;
}

/**
 * Create an in-memory SQLite database and ensure the schema exists.
 *
 * sql.js is a pure-WASM SQLite — no native compilation required.
 * All data operations are **synchronous** after this async init, which
 * means the critical insert-or-conflict section has zero async gaps.
 *
 * @returns {Promise<import('sql.js').Database>}
 */
async function createDatabase() {
  const SQL = await initSQL();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idempotency_key   TEXT    PRIMARY KEY,
      state             TEXT    NOT NULL DEFAULT 'STARTED',
      request_hash      TEXT    NOT NULL,
      request_body      TEXT,
      response_status   INTEGER,
      response_body     TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Parameter helpers
// ---------------------------------------------------------------------------

/**
 * sql.js expects named parameters prefixed with `$`, `:`, or `@`.
 * Our call-sites pass plain objects like `{idempotencyKey: 'x'}`.
 * This helper adds the `$` prefix so sql.js can bind them.
 */
function $(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    out[`$${k}`] = v;
  }
  return out;
}

/**
 * Run a SELECT that returns **one row** (or `undefined`).
 */
function queryOne(db, sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind($(params));
  let row;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row; // undefined if no match — mirrors better-sqlite3's .get()
}

/**
 * Run an INSERT / UPDATE / DELETE and return `{ changes }`.
 */
function execute(db, sql, params) {
  db.run(sql, $(params));
  const changes = db.getRowsModified();
  return { changes };
}

// ---------------------------------------------------------------------------
// Prepared-statement–style wrappers
// ---------------------------------------------------------------------------

/**
 * Return an object whose methods mirror the `better-sqlite3` prepared-
 * statement API (`run()` / `get()`).  This lets the rest of the codebase
 * stay database-agnostic.
 */
function createStatements(db) {
  return {
    insertKey: {
      run(params) {
        return execute(db,
          `INSERT INTO idempotency_keys
             (idempotency_key, state, request_hash, request_body, created_at, updated_at)
           VALUES
             ($idempotencyKey, 'STARTED', $requestHash, $requestBody, $now, $now)`,
          params,
        );
      },
    },

    getKey: {
      get(params) {
        return queryOne(db,
          `SELECT * FROM idempotency_keys WHERE idempotency_key = $idempotencyKey`,
          params,
        );
      },
    },

    completeKey: {
      run(params) {
        return execute(db,
          `UPDATE idempotency_keys
              SET state           = 'COMPLETED',
                  response_status = $responseStatus,
                  response_body   = $responseBody,
                  updated_at      = $now
            WHERE idempotency_key = $idempotencyKey
              AND state           = 'STARTED'`,
          params,
        );
      },
    },

    failKey: {
      run(params) {
        return execute(db,
          `UPDATE idempotency_keys
              SET state           = 'FAILED',
                  response_status = $responseStatus,
                  response_body   = $responseBody,
                  updated_at      = $now
            WHERE idempotency_key = $idempotencyKey
              AND state           = 'STARTED'`,
          params,
        );
      },
    },

    reapStale: {
      run(params) {
        return execute(db,
          `UPDATE idempotency_keys
              SET state           = 'FAILED',
                  response_status = 500,
                  response_body   = $responseBody,
                  updated_at      = $now
            WHERE state      = 'STARTED'
              AND created_at < $cutoff`,
          params,
        );
      },
    },

    purgeExpired: {
      run(params) {
        return execute(db,
          `DELETE FROM idempotency_keys WHERE created_at < $cutoff`,
          params,
        );
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Maintenance helpers
// ---------------------------------------------------------------------------

const STALE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;      // 5 minutes
const KEY_TTL_MS            = 24 * 60 * 60 * 1000;  // 24 hours

/**
 * Mark STARTED rows older than `staleLockTimeoutMs` as FAILED.
 * These represent processes that crashed mid-flight.
 */
function reapStaleLocks(stmts, staleLockTimeoutMs = STALE_LOCK_TIMEOUT_MS) {
  const now    = Date.now();
  const cutoff = now - staleLockTimeoutMs;
  const responseBody = JSON.stringify({
    charged: false,
    error: 'Payment processing timed out. The previous attempt may have been lost. Please retry or contact support.',
  });
  return stmts.reapStale.run({ cutoff, now, responseBody });
}

/**
 * Delete idempotency-key rows older than `keyTtlMs`.
 */
function purgeExpiredKeys(stmts, keyTtlMs = KEY_TTL_MS) {
  const now    = Date.now();
  const cutoff = now - keyTtlMs;
  return stmts.purgeExpired.run({ cutoff });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createDatabase,
  createStatements,
  reapStaleLocks,
  purgeExpiredKeys,
  STALE_LOCK_TIMEOUT_MS,
  KEY_TTL_MS,
};
