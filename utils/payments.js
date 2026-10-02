// Payment gateway for coin purchases. One place to talk to the provider.
// Settings come from config/razorpay.js (TEMPORARY, hardcoded there; it
// wins over the environment), else from environment variables:
//
//   PAYMENT_PROVIDER=razorpay → Razorpay Orders + Checkout. Needs
//                               RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and, for
//                               POST /webhooks/payments, RAZORPAY_WEBHOOK_SECRET.
//                               Turn on auto-capture in the Razorpay dashboard,
//                               and subscribe the webhook to payment.captured,
//                               payment.failed and order.paid.
//   PAYMENT_PROVIDER=mock     → no network: orders are 'mock_order_…' and
//                               signatures are HMACs with MOCK_SECRET below.
//                               Local development and tests only — never in
//                               production.
//   unset                     → razorpay if RAZORPAY_KEY_ID is set, else not
//                               configured (the store answers 503).

const crypto = require('crypto');
const hardcoded = require('../config/razorpay');

// A Razorpay setting: the value in config/razorpay.js wins (TEMPORARY, see
// that file); one left empty there falls back to the environment.
function setting(name) {
  return hardcoded[name] || process.env[name] || '';
}

const RAZORPAY_API = 'https://api.razorpay.com/v1';
const RAZORPAY_MIN_AMOUNT_PAISE = 100; // Razorpay rejects orders under ₹1
const MOCK_SECRET = 'mock_payment_secret';

class PaymentsNotConfiguredError extends Error {}
class PaymentProviderError extends Error {}

function providerName() {
  const p = setting('PAYMENT_PROVIDER');
  if (p === 'mock' || p === 'razorpay') return p;
  return setting('RAZORPAY_KEY_ID') ? 'razorpay' : null;
}

function razorpayKeys() {
  const keyId = setting('RAZORPAY_KEY_ID');
  const keySecret = setting('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) throw new PaymentsNotConfiguredError('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set');
  return { keyId, keySecret };
}

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Creates the gateway's order for a CoinOrder. Returns what the app needs
// to open checkout: { provider, gatewayOrderId, keyId }.
async function createGatewayOrder({ amountPaise, currency, receipt, notes }) {
  const provider = providerName();
  if (!provider) throw new PaymentsNotConfiguredError('No payment provider is configured');
  // Pack prices are config, so a typo there (e.g. rupees instead of paise)
  // is caught here, before Razorpay refuses it.
  if (!Number.isInteger(amountPaise) || amountPaise < RAZORPAY_MIN_AMOUNT_PAISE) {
    throw new PaymentProviderError(`Order amount must be a whole number of paise, at least ${RAZORPAY_MIN_AMOUNT_PAISE}; got ${amountPaise}`);
  }

  if (provider === 'mock') {
    return { provider, gatewayOrderId: `mock_order_${crypto.randomBytes(8).toString('hex')}`, keyId: 'mock_key' };
  }

  const { keyId, keySecret } = razorpayKeys();
  let response;
  try {
    response = await fetch(`${RAZORPAY_API}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: amountPaise, currency, receipt, notes }),
    });
  } catch (err) {
    throw new PaymentProviderError(`Razorpay order request failed: ${err.message}`);
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    // Not the player's session: the server's Razorpay keys are wrong, or
    // test and live keys are mixed up. Never passed on to the app as a 401.
    throw new PaymentProviderError('Razorpay rejected the API keys (401): check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  }
  if (!response.ok || !body.id) {
    const reason = body.error && body.error.description ? body.error.description : `HTTP ${response.status}`;
    throw new PaymentProviderError(`Razorpay order create failed: ${reason}`);
  }
  return { provider, gatewayOrderId: body.id, keyId };
}

// Checkout's success callback signature: HMAC-SHA256 of
// "<gateway order id>|<gateway payment id>" with the key secret.
function verifyPaymentSignature({ provider, gatewayOrderId, gatewayPaymentId, signature }) {
  if (typeof gatewayPaymentId !== 'string' || !gatewayPaymentId || typeof signature !== 'string') return false;
  const secret = provider === 'mock' ? MOCK_SECRET : razorpayKeys().keySecret;
  return safeEqual(hmacHex(secret, `${gatewayOrderId}|${gatewayPaymentId}`), signature);
}

// Webhook signature (X-Razorpay-Signature): HMAC-SHA256 of the raw body
// with the webhook secret. In mock mode, MOCK_SECRET.
function verifyWebhookSignature(rawBody, signature) {
  const provider = providerName();
  const secret = provider === 'mock' ? MOCK_SECRET : setting('RAZORPAY_WEBHOOK_SECRET');
  if (!secret) throw new PaymentsNotConfiguredError('RAZORPAY_WEBHOOK_SECRET is not set');
  return safeEqual(hmacHex(secret, rawBody), signature);
}

// The parts of a Razorpay webhook the store acts on, or null for an event
// it doesn't use. kind: 'captured' (money taken) | 'failed'.
function parseWebhookEvent(payload) {
  const event = payload && payload.event;
  const payment = payload && payload.payload && payload.payload.payment && payload.payload.payment.entity;
  if (!payment || !payment.order_id) return null;
  let kind = null;
  if (event === 'payment.captured' || event === 'order.paid') kind = 'captured';
  else if (event === 'payment.failed') kind = 'failed';
  if (!kind) return null;
  return {
    kind,
    gatewayOrderId: payment.order_id,
    gatewayPaymentId: payment.id || null,
    amountPaise: payment.amount,
    failureReason: payment.error_description || payment.error_reason || null,
  };
}

// For tests and local development with PAYMENT_PROVIDER=mock: the
// signatures checkout and the webhook would send.
function mockSign(data) {
  return hmacHex(MOCK_SECRET, data);
}

module.exports = {
  setting,
  PaymentsNotConfiguredError,
  PaymentProviderError,
  providerName,
  createGatewayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  parseWebhookEvent,
  mockSign,
};
