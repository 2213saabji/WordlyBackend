const crypto = require('crypto');
const CoinOrder = require('../models/CoinOrder');
const { getTierConfig, coinPack } = require('../utils/tierConfig');
const { getBalance } = require('../utils/wallet');
const { serializeOrder, creditOrder } = require('../utils/store');
const {
  PaymentsNotConfiguredError,
  PaymentProviderError,
  createGatewayOrder,
  verifyPaymentSignature,
} = require('../utils/payments');

const MAX_IDEMPOTENCY_KEY_LENGTH = 100;

function serializePack(p) {
  return { packId: p.packId, coins: p.coins, pricePaise: p.pricePaise, currency: p.currency };
}

// 'GW-' + 8 digits: short enough to read out to support, random so order
// numbers don't reveal sales volume.
function newOrderId() {
  return `GW-${crypto.randomInt(10000000, 100000000)}`;
}

function idempotencyKeyOf(req) {
  const key = req.get('Idempotency-Key');
  return typeof key === 'string' && key.trim() ? key.trim().slice(0, MAX_IDEMPOTENCY_KEY_LENGTH) : null;
}

// The order body the app opens checkout with.
function orderResponse(order) {
  return {
    ...serializeOrder(order),
    gateway: {
      provider: order.provider,
      orderId: order.gatewayOrderId,
      key: order.provider === 'razorpay' ? process.env.RAZORPAY_KEY_ID : 'mock_key',
      amountPaise: order.amountPaise,
      currency: order.currency,
    },
  };
}

// GET /store/coin-packs
async function coinPacks(req, res) {
  const config = await getTierConfig();
  return res.json({ packs: config.coins.packs.map(serializePack) });
}

// POST /store/orders  { packId }   (Idempotency-Key header recommended)
async function createOrder(req, res) {
  const config = await getTierConfig();
  const pack = coinPack(config, req.body && req.body.packId);
  if (!pack) return res.status(400).json({ message: 'Unknown coin pack', code: 'INVALID_PACK' });

  const idempotencyKey = idempotencyKeyOf(req);
  if (idempotencyKey) {
    const existing = await CoinOrder.findOne({ user: req.userId, idempotencyKey }).lean();
    if (existing && existing.packId !== pack.packId) {
      return res.status(409).json({ message: 'This Idempotency-Key was used for a different pack', code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    if (existing) return res.json(orderResponse(existing));
  }

  const orderId = newOrderId();
  let gateway;
  try {
    gateway = await createGatewayOrder({
      amountPaise: pack.pricePaise,
      currency: pack.currency,
      receipt: orderId,
      notes: { orderId, userId: String(req.userId), packId: pack.packId },
    });
  } catch (err) {
    if (err instanceof PaymentsNotConfiguredError) {
      return res.status(503).json({ message: 'Coin purchases are not available yet', code: 'PAYMENTS_NOT_CONFIGURED' });
    }
    if (err instanceof PaymentProviderError) {
      console.error(err.message);
      return res.status(502).json({ message: "Couldn't start the payment. Try again.", code: 'PAYMENT_PROVIDER_ERROR' });
    }
    throw err;
  }

  try {
    const order = await CoinOrder.create({
      orderId,
      user: req.userId,
      packId: pack.packId,
      coins: pack.coins,
      amountPaise: pack.pricePaise,
      currency: pack.currency,
      provider: gateway.provider,
      gatewayOrderId: gateway.gatewayOrderId,
      idempotencyKey,
      expiresAt: new Date(Date.now() + config.coins.orderExpiryMinutes * 60 * 1000),
    });
    return res.status(201).json(orderResponse(order.toObject()));
  } catch (err) {
    // The same Idempotency-Key raced in twice: return the one that won.
    if (err && err.code === 11000 && idempotencyKey) {
      const existing = await CoinOrder.findOne({ user: req.userId, idempotencyKey }).lean();
      if (existing) return res.json(orderResponse(existing));
    }
    throw err;
  }
}

async function findOwnOrder(req) {
  const { orderId } = req.params;
  if (typeof orderId !== 'string' || !/^GW-\d{8}$/.test(orderId)) return null;
  return CoinOrder.findOne({ orderId, user: req.userId }).lean();
}

// GET /store/orders/:orderId — for polling when checkout closed before the
// confirm call got through (the webhook credits it in the meantime).
async function getOrder(req, res) {
  const order = await findOwnOrder(req);
  if (!order) return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
  return res.json({ ...serializeOrder(order), balance: await getBalance(req.userId) });
}

// POST /store/orders/:orderId/confirm  { gatewayPaymentId, signature }
// Checkout's success callback. Verifies the gateway signature and credits
// the coins — unless the webhook already did (409 ALREADY_CREDITED, which
// the app treats as success).
async function confirmOrder(req, res) {
  const order = await findOwnOrder(req);
  if (!order) return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });

  if (order.status === 'credited') {
    return res.status(409).json({
      message: 'These coins are already in your wallet',
      code: 'ALREADY_CREDITED',
      coinsCredited: order.coins,
      balance: await getBalance(req.userId),
    });
  }

  const { gatewayPaymentId, signature } = req.body || {};
  let valid;
  try {
    valid = verifyPaymentSignature({ provider: order.provider, gatewayOrderId: order.gatewayOrderId, gatewayPaymentId, signature });
  } catch (err) {
    if (err instanceof PaymentsNotConfiguredError) {
      return res.status(503).json({ message: 'Coin purchases are not available yet', code: 'PAYMENTS_NOT_CONFIGURED' });
    }
    throw err;
  }
  if (!valid) {
    // Not proof of payment. The order is left as it is: a real payment
    // still credits through the webhook.
    return res.status(402).json({ message: "Payment didn't go through. You weren't charged.", code: 'PAYMENT_FAILED' });
  }

  const result = await creditOrder(order, { gatewayPaymentId, by: 'confirm' });
  if (!result.credited) {
    return res.status(409).json({
      message: 'These coins are already in your wallet',
      code: 'ALREADY_CREDITED',
      coinsCredited: order.coins,
      balance: result.balance,
    });
  }
  return res.json({ status: 'credited', orderId: order.orderId, coinsCredited: order.coins, balance: result.balance });
}

module.exports = { coinPacks, createOrder, getOrder, confirmOrder };
