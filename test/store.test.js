// Coin store (PRD v0.2 §2.2, §7): orders, the client confirm and the
// gateway webhook sharing one idempotent credit. PAYMENT_PROVIDER=mock and
// in-memory model stubs, so no database or network is needed.
// config/razorpay.js wins over the environment, so the mock gateway is
// selected there: these tests must never reach the real Razorpay API.
require('../config/razorpay').PAYMENT_PROVIDER = 'mock';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Replace the receipt email and the webhook's DB connect before anything
// destructures them.
const email = require('../utils/email');
let receipts;
email.sendCoinReceiptEmail = async (to, receipt) => { receipts.push({ to, ...receipt }); };
require('../utils/db').connectDB = async () => {};

const TierConfig = require('../models/TierConfig');
const Notification = require('../models/Notification');
const SyncState = require('../models/SyncState');
const User = require('../models/User');
const { coinPacks, createOrder, getOrder, confirmOrder } = require('../controllers/storeController');
const { receivePaymentWebhook } = require('../controllers/paymentWebhookController');
const { mockSign } = require('../utils/payments');
const { stubCoins } = require('./helpers/coinStubs');

const USER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439099';
let coins;
let notes;

const lean = (v) => ({ lean: async () => (v == null ? null : structuredClone(v)) });

beforeEach(() => {
  coins = stubCoins();
  receipts = [];
  notes = [];
  TierConfig.findOne = () => ({ sort: () => lean(null) });
  Notification.create = async (n) => { notes.push([n.type, n.data]); return n; };
  SyncState.updateOne = async () => ({});
  User.findById = () => ({ select: () => lean({ _id: USER, email: 'me@x.com' }) });
});

function call(handler, { body = {}, params = {}, headers = {}, userId = USER } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
      sendStatus(c) { resolve({ status: c }); },
    };
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { body, params, query: {}, userId, headers: lower, get: (h) => lower[h.toLowerCase()] };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function newOrder(headers) {
  const res = await call(createOrder, { body: { packId: 'coins_3000' }, headers });
  assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
  return res.body;
}

const paymentSignature = (gatewayOrderId, paymentId) => mockSign(`${gatewayOrderId}|${paymentId}`);

function webhook(payload, { sign = true } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  return call(receivePaymentWebhook, { body: raw, headers: sign ? { 'X-Razorpay-Signature': mockSign(raw) } : {} });
}

const captured = (gatewayOrderId, amount = 1000) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: 'pay_W1', order_id: gatewayOrderId, amount, status: 'captured' } } },
});

test('GET /store/coin-packs lists the 3,000-coin pack for ₹10', async () => {
  const { body } = await call(coinPacks);
  assert.deepEqual(body, { packs: [{ packId: 'coins_3000', coins: 3000, pricePaise: 1000, currency: 'INR' }] });
});

test('creating an order snapshots the pack and returns what checkout needs', async () => {
  const order = await newOrder();
  assert.match(order.orderId, /^GW-\d{8}$/);
  assert.equal(order.status, 'created');
  assert.equal(order.coins, 3000);
  assert.equal(order.amountPaise, 1000);
  assert.equal(order.gateway.provider, 'mock');
  assert.match(order.gateway.orderId, /^mock_order_/);
  assert.equal(order.gateway.amountPaise, 1000);
});

test('an unknown pack is rejected', async () => {
  const res = await call(createOrder, { body: { packId: 'coins_999999' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PACK');
});

test('the same Idempotency-Key returns the same order', async () => {
  const a = await newOrder({ 'Idempotency-Key': 'k-1' });
  const b = await newOrder({ 'Idempotency-Key': 'k-1' });
  assert.equal(a.orderId, b.orderId);
  assert.equal(coins.orders.length, 1);
});

test('confirm with a valid signature credits 3,000 coins once, notifies and emails a receipt', async () => {
  coins.setBalance(USER, 340);
  const order = await newOrder();
  const body = { gatewayPaymentId: 'pay_Q1', signature: paymentSignature(order.gateway.orderId, 'pay_Q1') };
  const res = await call(confirmOrder, { params: { orderId: order.orderId }, body });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'credited', orderId: order.orderId, coinsCredited: 3000, balance: 3340 });
  assert.deepEqual(coins.ledger.map((t) => [t.type, t.amount, t.idempotencyKey]), [['purchase', 3000, `purchase:${order.orderId}`]]);
  assert.deepEqual(notes, [['coins_purchased', { orderId: order.orderId, coins: 3000, balance: 3340 }]]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].to, 'me@x.com');
  assert.equal(coins.orders[0].creditedBy, 'confirm');

  const again = await call(confirmOrder, { params: { orderId: order.orderId }, body });
  assert.equal(again.status, 409);
  assert.deepEqual({ code: again.body.code, balance: again.body.balance }, { code: 'ALREADY_CREDITED', balance: 3340 });
  assert.equal(coins.balance(USER), 3340, 'still credited once');
  assert.equal(receipts.length, 1);
});

test('a bad signature credits nothing (402 PAYMENT_FAILED) and leaves the order open', async () => {
  const order = await newOrder();
  const res = await call(confirmOrder, { params: { orderId: order.orderId }, body: { gatewayPaymentId: 'pay_Q1', signature: 'forged' } });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'PAYMENT_FAILED');
  assert.equal(coins.balance(USER), 0);
  assert.equal(coins.orders[0].status, 'created');
});

test("another player's order is not found", async () => {
  const order = await newOrder();
  const res = await call(getOrder, { params: { orderId: order.orderId }, userId: OTHER });
  assert.equal(res.status, 404);
});

test('webhook first, then confirm: credited once by the webhook, confirm says ALREADY_CREDITED', async () => {
  const order = await newOrder();
  const hook = await webhook(captured(order.gateway.orderId));
  assert.equal(hook.status, 200);
  assert.equal(coins.balance(USER), 3000);
  assert.equal(coins.orders[0].creditedBy, 'webhook');

  const res = await call(confirmOrder, {
    params: { orderId: order.orderId },
    body: { gatewayPaymentId: 'pay_W1', signature: paymentSignature(order.gateway.orderId, 'pay_W1') },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALREADY_CREDITED');
  assert.equal(coins.balance(USER), 3000);
  assert.equal(coins.ledger.length, 1);
});

test('a repeated webhook delivery credits nothing more', async () => {
  const order = await newOrder();
  await webhook(captured(order.gateway.orderId));
  await webhook(captured(order.gateway.orderId));
  assert.equal(coins.balance(USER), 3000);
  assert.equal(notes.filter(([t]) => t === 'coins_purchased').length, 1);
});

test('an unsigned or forged webhook is rejected', async () => {
  const order = await newOrder();
  const res = await webhook(captured(order.gateway.orderId), { sign: false });
  assert.equal(res.status, 401);
  assert.equal(coins.balance(USER), 0);
});

test('a captured amount that does not match the order is never credited', async () => {
  const order = await newOrder();
  const res = await webhook(captured(order.gateway.orderId, 1));
  assert.equal(res.status, 200, 'acknowledged so the gateway stops retrying');
  assert.equal(coins.balance(USER), 0);
});

test('payment.failed marks the order failed with one notification; a later success still credits', async () => {
  const order = await newOrder();
  const failed = { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_F1', order_id: order.gateway.orderId, amount: 1000, error_description: 'Card declined' } } } };
  await webhook(failed);
  await webhook(failed);
  assert.equal(coins.orders[0].status, 'failed');
  assert.equal(notes.filter(([t]) => t === 'payment_failed').length, 1);
  assert.equal(coins.balance(USER), 0);

  const status = await call(getOrder, { params: { orderId: order.orderId } });
  assert.equal(status.body.status, 'failed');

  await webhook(captured(order.gateway.orderId)); // retried with UPI, succeeded
  assert.equal(coins.orders[0].status, 'credited');
  assert.equal(coins.balance(USER), 3000);
});

test('an unpaid order past its expiry reads as expired', async () => {
  const order = await newOrder();
  coins.orders[0].expiresAt = new Date(Date.now() - 1000);
  const { body } = await call(getOrder, { params: { orderId: order.orderId } });
  assert.equal(body.status, 'expired');
});

test('confirm with missing fields: 400 INVALID_REQUEST, nothing credited', async () => {
  const order = await newOrder();
  const res = await call(confirmOrder, { params: { orderId: order.orderId }, body: { gatewayPaymentId: 'pay_Q1' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REQUEST');
  assert.equal(coins.balance(USER), 0);
});

test("confirm accepts Checkout's handler response as is (razorpay_* fields)", async () => {
  const order = await newOrder();
  const res = await call(confirmOrder, {
    params: { orderId: order.orderId },
    body: {
      razorpay_order_id: order.gateway.orderId,
      razorpay_payment_id: 'pay_R1',
      razorpay_signature: paymentSignature(order.gateway.orderId, 'pay_R1'),
    },
  });
  assert.equal(res.status, 200);
  assert.equal(coins.balance(USER), 3000);
});

test('confirm with a razorpay_order_id for another order: 400 ORDER_MISMATCH', async () => {
  const order = await newOrder();
  const res = await call(confirmOrder, {
    params: { orderId: order.orderId },
    body: { razorpay_order_id: 'order_someone_else', razorpay_payment_id: 'pay_R1', razorpay_signature: paymentSignature('order_someone_else', 'pay_R1') },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ORDER_MISMATCH');
  assert.equal(coins.balance(USER), 0);
});

test('a pack priced under Razorpay\'s ₹1 minimum is refused before calling the gateway', async () => {
  const { createGatewayOrder, PaymentProviderError } = require('../utils/payments');
  await assert.rejects(createGatewayOrder({ amountPaise: 50, currency: 'INR', receipt: 'GW-1' }), PaymentProviderError);
  await assert.rejects(createGatewayOrder({ amountPaise: 10.5, currency: 'INR', receipt: 'GW-1' }), PaymentProviderError);
});
