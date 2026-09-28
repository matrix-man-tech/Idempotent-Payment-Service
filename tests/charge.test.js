const request = require('supertest');
const { createDatabase, createStatements, reapStaleLocks, purgeExpiredKeys, STALE_LOCK_TIMEOUT_MS, KEY_TTL_MS } = require('../src/db');
const { createApp } = require('../src/app');
const { hashRequestBody } = require('../src/chargeHandler');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a fresh in-memory app with a forced provider outcome. */
async function buildApp(forcedOutcome = 'success') {
  const db    = await createDatabase();
  const stmts = createStatements(db);
  const app   = createApp({ stmts, providerOpts: { forcedOutcome } });
  return { db, stmts, app };
}

const VALID_BODY = {
  amount: 2500,
  currency: 'usd',
  cardToken: 'tok_visa_4242',
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('POST /charge — Idempotency State Machine', () => {

  // -----------------------------------------------------------------------
  // 1. Happy path — first charge succeeds
  // -----------------------------------------------------------------------
  test('1 — first charge with a new key returns 200 { charged: true }', async () => {
    const { app } = await buildApp('success');

    const res = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-001')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.charged).toBe(true);
    expect(res.body.transactionId).toBeDefined();
    expect(res.body.amount).toBe(2500);
    expect(res.body.currency).toBe('usd');
  });

  // -----------------------------------------------------------------------
  // 2. Replay — same key + same body returns cached response
  // -----------------------------------------------------------------------
  test('2 — replaying the same key + same body returns the cached response', async () => {
    const { app } = await buildApp('success');

    const first = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-002')
      .send(VALID_BODY);

    const second = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-002')
      .send(VALID_BODY);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body); // exact same response
  });

  // -----------------------------------------------------------------------
  // 3. Same key + different body → 422
  // -----------------------------------------------------------------------
  test('3 — same key with different body returns 422', async () => {
    const { app } = await buildApp('success');

    await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-003')
      .send(VALID_BODY);

    const res = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-003')
      .send({ ...VALID_BODY, amount: 9999 });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/different request body/i);
  });

  // -----------------------------------------------------------------------
  // 4. Missing Idempotency-Key header → 400
  // -----------------------------------------------------------------------
  test('4 — missing Idempotency-Key header returns 400', async () => {
    const { app } = await buildApp('success');

    const res = await request(app)
      .post('/charge')
      .send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/);
  });

  // -----------------------------------------------------------------------
  // 5. Provider declines → cached decline on replay
  // -----------------------------------------------------------------------
  test('5 — provider declines, replay returns cached decline', async () => {
    const { app } = await buildApp('decline');

    const first = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-005')
      .send(VALID_BODY);

    expect(first.status).toBe(200);
    expect(first.body.charged).toBe(false);
    expect(first.body.reason).toBe('insufficient_funds');

    // Replay returns the same cached decline
    const second = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-005')
      .send(VALID_BODY);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  // -----------------------------------------------------------------------
  // 6. Provider times out → row stays STARTED → retry gets 409
  // -----------------------------------------------------------------------
  test('6 — provider timeout leaves row STARTED; retry gets 409, then resolves', async () => {
    const db    = await createDatabase();
    const stmts = createStatements(db);
    const app   = createApp({
      stmts,
      providerOpts: { forcedOutcome: 'timeout', timeoutMs: 50 },
    });

    // First request will time out and return 500
    const first = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-006')
      .send(VALID_BODY);

    expect(first.status).toBe(500);

    // Row should still be STARTED
    const row = stmts.getKey.get({ idempotencyKey: 'key-006' });
    expect(row.state).toBe('STARTED');

    // Retry → 409 because it's still STARTED
    const retry = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-006')
      .send(VALID_BODY);

    expect(retry.status).toBe(409);

    // After reaping, the stale row becomes FAILED
    // Simulate time passing by directly updating created_at
    db.run(
      `UPDATE idempotency_keys SET created_at = $old WHERE idempotency_key = 'key-006'`,
      { $old: Date.now() - STALE_LOCK_TIMEOUT_MS - 1000 },
    );

    reapStaleLocks(stmts);

    const after = stmts.getKey.get({ idempotencyKey: 'key-006' });
    expect(after.state).toBe('FAILED');
  });

  // -----------------------------------------------------------------------
  // 7. Concurrent identical requests — only one charges
  // -----------------------------------------------------------------------
  test('7 — concurrent identical requests: one succeeds, other gets cached or 409', async () => {
    const { app } = await buildApp('success');

    // Fire two requests simultaneously
    const [r1, r2] = await Promise.all([
      request(app).post('/charge').set('Idempotency-Key', 'key-007').send(VALID_BODY),
      request(app).post('/charge').set('Idempotency-Key', 'key-007').send(VALID_BODY),
    ]);

    const statuses = [r1.status, r2.status].sort();

    // One of them charged (200), the other either got the cached 200 or a 409
    expect(statuses).toEqual(
      expect.arrayContaining([200]),
    );

    // Verify both are valid outcomes
    for (const r of [r1, r2]) {
      expect([200, 409]).toContain(r.status);
    }

    // If both are 200, they must return the same transactionId (cached replay)
    if (r1.status === 200 && r2.status === 200) {
      expect(r1.body.transactionId).toBe(r2.body.transactionId);
    }
  });

  // -----------------------------------------------------------------------
  // 8. Stale STARTED row is reaped → becomes FAILED
  // -----------------------------------------------------------------------
  test('8 — stale STARTED row is reaped to FAILED', async () => {
    const db    = await createDatabase();
    const stmts = createStatements(db);

    // Manually insert a STARTED row with an old timestamp
    const oldTime = Date.now() - STALE_LOCK_TIMEOUT_MS - 60_000; // 6 min ago
    stmts.insertKey.run({
      idempotencyKey: 'key-008',
      requestHash: hashRequestBody(VALID_BODY),
      requestBody: JSON.stringify(VALID_BODY),
      now: oldTime,
    });

    // Before reaping
    let row = stmts.getKey.get({ idempotencyKey: 'key-008' });
    expect(row.state).toBe('STARTED');

    // Reap
    const result = reapStaleLocks(stmts);
    expect(result.changes).toBe(1);

    // After reaping
    row = stmts.getKey.get({ idempotencyKey: 'key-008' });
    expect(row.state).toBe('FAILED');
    expect(row.response_status).toBe(500);
  });

  // -----------------------------------------------------------------------
  // 9. Key expires after 24h → treated as new request
  // -----------------------------------------------------------------------
  test('9 — expired key (>24h) is purged; same key is treated as new', async () => {
    const db    = await createDatabase();
    const stmts = createStatements(db);
    const app   = createApp({ stmts, providerOpts: { forcedOutcome: 'success' } });

    // First charge
    const first = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-009')
      .send(VALID_BODY);
    expect(first.status).toBe(200);
    expect(first.body.charged).toBe(true);

    // Simulate 25 hours passing
    const oldTime = Date.now() - KEY_TTL_MS - 3_600_000;
    db.run(
      `UPDATE idempotency_keys SET created_at = $old WHERE idempotency_key = 'key-009'`,
      { $old: oldTime },
    );

    // Purge expired keys
    purgeExpiredKeys(stmts);

    // Key should be gone
    const row = stmts.getKey.get({ idempotencyKey: 'key-009' });
    expect(row).toBeUndefined();

    // Same key now treated as a new charge
    const second = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-009')
      .send(VALID_BODY);

    expect(second.status).toBe(200);
    expect(second.body.charged).toBe(true);
    // Different transactionId — this is a genuinely new charge
    expect(second.body.transactionId).not.toBe(first.body.transactionId);
  });

  // -----------------------------------------------------------------------
  // Bonus: missing body fields → 400
  // -----------------------------------------------------------------------
  test('bonus — missing body fields returns 400', async () => {
    const { app } = await buildApp('success');

    const res = await request(app)
      .post('/charge')
      .set('Idempotency-Key', 'key-bonus')
      .send({ amount: 100 }); // missing currency and cardToken

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount.*currency.*cardToken/i);
  });

  // -----------------------------------------------------------------------
  // Bonus: health check
  // -----------------------------------------------------------------------
  test('bonus — GET /health returns 200', async () => {
    const { app } = await buildApp('success');

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
