# Idempotent Payment Retry Service

A production-grade Node.js service that guarantees **exactly-once payment processing** using idempotency keys, a state-machine, and database-level distributed locking.

## Architecture

```
Client  ──POST /charge──▶  Express Server  ──INSERT (UNIQUE)──▶  SQLite
                                │                                  │
                                │  ◀── constraint violation ───────┘
                                │      (key exists → cached path)
                                │
                                ▼
                          Payment Provider
                          (success / decline / timeout)
                                │
                                ▼
                          UPDATE state → COMPLETED | FAILED
                          Cache response for future replays
```

### State Machine

```
                    ┌──────────┐
        INSERT OK   │          │   Provider succeeds
  ─────────────────▶│ STARTED  │──────────────────────▶ COMPLETED (terminal)
                    │          │
                    └────┬─────┘
                         │
                         │ Provider declines
                         │ OR stale-lock reaper fires
                         ▼
                      FAILED (terminal)
```

| State | Meaning | Terminal? |
|:------|:--------|:----------|
| `STARTED` | Lock acquired, provider call in-flight | No |
| `COMPLETED` | Card was charged successfully | Yes |
| `FAILED` | Provider declined or processing timed out | Yes |

## API Contract

### `POST /charge`

**Headers:**

| Header | Required | Description |
|:-------|:---------|:------------|
| `Idempotency-Key` | ✅ | Client-generated UUID. Same key = same outcome for 24h. |
| `Content-Type` | ✅ | `application/json` |

**Request Body:**

```json
{
  "amount": 2500,
  "currency": "usd",
  "cardToken": "tok_visa_4242"
}
```

**Responses:**

| Status | When | Body |
|:-------|:-----|:-----|
| `200` | Charge succeeded (or cached success) | `{ "charged": true, "transactionId": "txn_...", "amount": 2500, "currency": "usd" }` |
| `200` | Charge declined (or cached decline) | `{ "charged": false, "reason": "insufficient_funds" }` |
| `400` | Missing header or body fields | `{ "error": "..." }` |
| `409` | Key is in-flight (STARTED state) | `{ "error": "A payment with this key is being processed..." }` |
| `422` | Key reused with different body | `{ "error": "Key used with different request body..." }` |
| `500` | Provider timeout or internal error | `{ "error": "..." }` |

### `GET /health`

Returns `200 { "status": "ok" }`.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server (port 3000)
npm start

# Run tests
npm test
```

### Example: Charge a Card

```bash
# First charge — provider processes it
curl -X POST http://localhost:3000/charge \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: pay_abc123" \
  -d '{"amount": 2500, "currency": "usd", "cardToken": "tok_visa_4242"}'

# Retry with the same key — returns cached response, no double-charge
curl -X POST http://localhost:3000/charge \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: pay_abc123" \
  -d '{"amount": 2500, "currency": "usd", "cardToken": "tok_visa_4242"}'
```

## Design Decisions

### Why UNIQUE Constraint as the Lock?

The `INSERT INTO ... PRIMARY KEY` is **atomic at the database level**. If two concurrent requests try to insert the same key, exactly one succeeds and the other gets a constraint violation. This is stronger than any application-level "check-then-insert" pattern and requires zero additional infrastructure (no Redis, no advisory locks).

### Why `better-sqlite3` (Synchronous API)?

The critical section — "insert key → check if insert succeeded → proceed or return cached" — must not have async gaps. With an async database driver, a `yield` point between the insert and the result check opens a window for race conditions. `better-sqlite3`'s synchronous API eliminates this entirely.

### Request Fingerprinting

If a client accidentally reuses an idempotency key for a *different* charge (different amount, currency, etc.), the service detects the mismatch via a SHA-256 hash of the sorted request body and returns `422` instead of silently returning the wrong cached response.

### Stale Lock Recovery

If a process crashes between acquiring the lock (`STARTED`) and writing the result (`COMPLETED`/`FAILED`), the row is orphaned. A background reaper runs every 60 seconds and marks `STARTED` rows older than 5 minutes as `FAILED`, unblocking client retries.

### The "Charged but Not Recorded" Gap

The most dangerous failure: the provider charges the card, but the process crashes before writing `COMPLETED`. Mitigations:

1. **Forward the idempotency key to the provider** — their side also deduplicates, preventing a true double-charge on retry.
2. **Daily reconciliation** — compare your ledger against the provider's transaction records.
3. **The stale reaper marks the row `FAILED`** — which is conservative (safe for the customer) but may require manual resolution.

## Project Structure

```
├── package.json
├── README.md
├── src/
│   ├── app.js             # Express app factory
│   ├── chargeHandler.js   # Idempotency state machine (core logic)
│   ├── db.js              # SQLite schema, prepared statements, maintenance
│   ├── provider.js        # Simulated payment provider
│   └── server.js          # Entry point, periodic cleanup, graceful shutdown
├── tests/
│   └── charge.test.js     # 11 test cases covering all edge cases
└── data/
    └── payments.db        # SQLite database (created on first run)
```

## License

MIT
