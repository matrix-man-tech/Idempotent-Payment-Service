const crypto = require('crypto');
const provider = require('./provider');

// ---------------------------------------------------------------------------
// Charge Handler — the heart of the idempotency state machine
// ---------------------------------------------------------------------------

/**
 * Create the POST /charge handler.
 *
 * We use a factory so the caller can inject the db statements and provider
 * options (e.g. forced outcomes for tests).
 *
 * @param {Object}  deps
 * @param {Object}  deps.stmts           — prepared statements from db.js
 * @param {Object}  [deps.providerOpts]  — options forwarded to provider.charge()
 * @returns {import('express').RequestHandler}
 */
function createChargeHandler({ stmts, providerOpts = {} }) {
  return async function chargeHandler(req, res, next) {
    // ------------------------------------------------------------------
    // 1. Validate the Idempotency-Key header
    // ------------------------------------------------------------------
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'Missing required Idempotency-Key header.',
      });
    }

    // ------------------------------------------------------------------
    // 2. Validate the request body
    // ------------------------------------------------------------------
    const { amount, currency, cardToken } = req.body || {};
    if (!amount || !currency || !cardToken) {
      return res.status(400).json({
        error: 'Request body must include amount, currency, and cardToken.',
      });
    }

    // ------------------------------------------------------------------
    // 3. Compute a fingerprint of the request body
    // ------------------------------------------------------------------
    const requestHash = hashRequestBody(req.body);
    const requestBody = JSON.stringify(req.body);
    const now = Date.now();

    // ------------------------------------------------------------------
    // 4. Attempt to acquire the idempotency lock (INSERT)
    // ------------------------------------------------------------------
    let isNewKey = false;
    try {
      stmts.insertKey.run({
        idempotencyKey,
        requestHash,
        requestBody,
        now,
      });
      isNewKey = true;
    } catch (err) {
      // UNIQUE constraint violation → key already exists
      if (
        err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
        err.code === 'SQLITE_CONSTRAINT' ||
        (err.message && err.message.includes('UNIQUE constraint failed'))
      ) {
        isNewKey = false;
      } else {
        // Unexpected DB error — propagate
        return next(err);
      }
    }

    // ------------------------------------------------------------------
    // 5a. Key already exists — return cached result or 409
    // ------------------------------------------------------------------
    if (!isNewKey) {
      const existing = stmts.getKey.get({ idempotencyKey });

      if (!existing) {
        // Should not happen, but guard against it
        return res.status(500).json({ error: 'Internal inconsistency.' });
      }

      // Fingerprint mismatch — same key, different payload
      if (existing.request_hash !== requestHash) {
        return res.status(422).json({
          error:
            'Idempotency-Key has already been used with a different request body. ' +
            'Use a new key for a different charge.',
        });
      }

      // Terminal states — replay the cached response
      if (existing.state === 'COMPLETED' || existing.state === 'FAILED') {
        const cachedBody = JSON.parse(existing.response_body);
        return res.status(existing.response_status).json(cachedBody);
      }

      // STARTED — another request is currently processing this key
      if (existing.state === 'STARTED') {
        return res.status(409).json({
          error:
            'A payment with this Idempotency-Key is currently being processed. ' +
            'Please retry after a short delay.',
        });
      }

      // Unknown state (should never happen)
      return res.status(500).json({ error: 'Unknown idempotency-key state.' });
    }

    // ------------------------------------------------------------------
    // 5b. New key — call the payment provider
    // ------------------------------------------------------------------
    try {
      const result = await provider.charge(
        { amount, currency, cardToken },
        providerOpts,
      );

      if (result.approved) {
        // ---- SUCCESS ----
        const responseBody = {
          charged: true,
          transactionId: result.transactionId,
          amount,
          currency,
        };
        stmts.completeKey.run({
          idempotencyKey,
          responseStatus: 200,
          responseBody: JSON.stringify(responseBody),
          now: Date.now(),
        });
        return res.status(200).json(responseBody);
      } else {
        // ---- DECLINE ----
        const responseBody = {
          charged: false,
          reason: result.reason,
        };
        stmts.failKey.run({
          idempotencyKey,
          responseStatus: 200,
          responseBody: JSON.stringify(responseBody),
          now: Date.now(),
        });
        return res.status(200).json(responseBody);
      }
    } catch (err) {
      // ---- PROVIDER TIMEOUT / ERROR ----
      // The row stays in STARTED. The stale-lock reaper will clean it up.
      // Return 500 so the client knows to retry.
      return res.status(500).json({
        error:
          'Payment processing failed due to an upstream error. ' +
          'You may safely retry with the same Idempotency-Key after a short delay.',
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic SHA-256 hash of the request body.
 * Keys of the object are sorted so that `{a:1,b:2}` and `{b:2,a:1}`
 * produce the same hash.
 */
function hashRequestBody(body) {
  const sorted = JSON.stringify(sortKeys(body));
  return crypto.createHash('sha256').update(sorted).digest('hex');
}

/** Recursively sort object keys for deterministic serialization. */
function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeys(obj[key]);
        return acc;
      }, {});
  }
  return obj;
}

module.exports = { createChargeHandler, hashRequestBody };
