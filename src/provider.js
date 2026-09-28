const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Simulated Payment Provider
// ---------------------------------------------------------------------------
// In production this would be a real HTTP client talking to Stripe / Adyen /
// etc. For this service it simulates three outcomes:
//   1. Approved   — card charged successfully
//   2. Declined   — card declined (insufficient funds, etc.)
//   3. Timeout    — upstream is too slow; throws an error
//
// The provider also supports a **deterministic mode** where the outcome is
// dictated by the caller — essential for writing reliable tests.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000; // 10 s simulated provider timeout

/**
 * @typedef {Object} ChargeResult
 * @property {boolean}  approved
 * @property {string}   [transactionId]  — present when approved
 * @property {string}   [reason]         — present when declined
 */

/**
 * Simulate a card charge.
 *
 * @param {Object}  params
 * @param {number}  params.amount       — amount in smallest currency unit (e.g. cents)
 * @param {string}  params.currency     — ISO 4217 currency code
 * @param {string}  params.cardToken    — tokenised card reference
 * @param {Object}  [options]
 * @param {'success'|'decline'|'timeout'|null} [options.forcedOutcome]
 *        If set, overrides the random outcome (for tests).
 * @param {number}  [options.timeoutMs] — how long a "timeout" outcome waits.
 * @returns {Promise<ChargeResult>}
 */
async function charge({ amount, currency, cardToken }, options = {}) {
  const { forcedOutcome = null, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  // Decide outcome --------------------------------------------------------
  let outcome = forcedOutcome;
  if (!outcome) {
    const roll = Math.random();
    if (roll < 0.60)      outcome = 'success';
    else if (roll < 0.85) outcome = 'decline';
    else                  outcome = 'timeout';
  }

  // Simulate a small network delay (5-50 ms) for non-timeout outcomes
  if (outcome !== 'timeout') {
    await sleep(5 + Math.random() * 45);
  }

  switch (outcome) {
    case 'success':
      return {
        approved: true,
        transactionId: `txn_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      };

    case 'decline':
      return {
        approved: false,
        reason: 'insufficient_funds',
      };

    case 'timeout':
      await sleep(timeoutMs);
      throw new Error('Payment provider timed out');

    default:
      throw new Error(`Unknown outcome: ${outcome}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { charge };
