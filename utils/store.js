// Coin store: order lifecycle and the one credit path shared by the
// client's confirm call and the gateway webhook — whichever arrives first
// credits the coins, the other finds the order already credited.

const CoinOrder = require('../models/CoinOrder');
const User = require('../models/User');
const { runInTransaction, applyCoins, walletChanged, getBalance } = require('./wallet');
const { notify } = require('./tiers');
const { sendCoinReceiptEmail } = require('./email');

function isExpired(order, now = new Date()) {
  return order.status === 'created' && order.expiresAt <= now;
}

// The order as the app sees it. An unpaid order past its expiry reads as
// 'expired' (it's only stored as such once something writes to it).
function serializeOrder(order, now = new Date()) {
  return {
    orderId: order.orderId,
    status: isExpired(order, now) ? 'expired' : order.status,
    packId: order.packId,
    coins: order.coins,
    amountPaise: order.amountPaise,
    currency: order.currency,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    creditedAt: order.creditedAt,
  };
}

// After a credit has committed: the coins_purchased notification and the
// receipt email, each at most once per order (the conditional updates are
// the guards). A failed email is logged, never surfaced: the coins are in.
async function afterCredit(order, balance) {
  await walletChanged(order.user);
  await notify(order.user, 'coins_purchased', { orderId: order.orderId, coins: order.coins, balance });

  const claim = await CoinOrder.updateOne({ _id: order._id, receiptSentAt: null }, { $set: { receiptSentAt: new Date() } });
  if (!claim.modifiedCount) return;
  try {
    const user = await User.findById(order.user).select('email').lean();
    if (user && user.email) {
      await sendCoinReceiptEmail(user.email, {
        orderId: order.orderId,
        coins: order.coins,
        amountPaise: order.amountPaise,
        currency: order.currency,
        paidAt: order.paidAt || new Date(),
        balance,
      });
    }
  } catch (err) {
    console.error(`Coin receipt email for ${order.orderId} failed:`, err);
    await CoinOrder.updateOne({ _id: order._id }, { $set: { receiptSentAt: null } });
  }
}

// Credits a verified payment's coins exactly once. `order` is any read of
// the order; `by` is 'confirm' | 'webhook'. Returns
//   { credited: true, balance }          — this call credited the coins
//   { credited: false, balance }         — they were already credited
async function creditOrder(order, { gatewayPaymentId, by }) {
  const now = new Date();
  // Record the verified payment first ('paid'): if the credit below fails,
  // the order shows paid and the next confirm or webhook retries it.
  if (order.status !== 'credited') {
    await CoinOrder.updateOne(
      { _id: order._id, status: { $in: ['created', 'expired', 'failed'] } },
      { $set: { status: 'paid', paidAt: now, gatewayPaymentId, failureReason: null } }
    );
  }

  const credited = await runInTransaction(async (session) => {
    const claimed = await CoinOrder.findOneAndUpdate(
      { _id: order._id, status: { $ne: 'credited' } },
      { $set: { status: 'credited', creditedAt: now, creditedBy: by, gatewayPaymentId, paidAt: order.paidAt || now } },
      { returnDocument: 'after', session }
    ).lean();
    if (!claimed) return null;
    const entry = await applyCoins({
      userId: order.user,
      type: 'purchase',
      amount: order.coins,
      idempotencyKey: `purchase:${order.orderId}`,
      ref: { orderId: order.orderId, packId: order.packId },
      session,
    });
    return { order: claimed, balance: entry.balanceAfter };
  });

  if (!credited) return { credited: false, balance: await getBalance(order.user) };
  await afterCredit(credited.order, credited.balance);
  return { credited: true, balance: credited.balance };
}

// A payment attempt failed (webhook). Credits nothing; marks the order
// failed unless it's already paid or credited — checkout allows another
// attempt on the same order, and a later success still credits. One
// payment_failed notification per order.
async function failOrder(order, reason) {
  await CoinOrder.updateOne(
    { _id: order._id, status: { $in: ['created', 'expired'] } },
    { $set: { status: 'failed', failureReason: reason || null } }
  );
  const claim = await CoinOrder.updateOne(
    { _id: order._id, failedNotifiedAt: null, status: 'failed' },
    { $set: { failedNotifiedAt: new Date() } }
  );
  if (claim.modifiedCount) {
    await notify(order.user, 'payment_failed', { orderId: order.orderId, coins: order.coins, amountPaise: order.amountPaise });
  }
}

module.exports = { serializeOrder, creditOrder, failOrder, isExpired };
