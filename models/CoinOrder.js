const mongoose = require('mongoose');

// A coin pack purchase: created → paid → credited, or failed / expired.
// 'paid' means the payment is verified but the coins aren't in the wallet
// yet; the next confirm or webhook retries the credit. Coins are credited
// exactly once: the move to 'credited' and the ledger entry happen in one
// transaction (see utils/store.js). 'expired' is shown for an unpaid order
// past expiresAt; a payment that still arrives after that is credited.
const ORDER_STATUSES = ['created', 'paid', 'credited', 'failed', 'expired'];

const coinOrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true }, // 'GW-12345678', shown on receipts
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    packId: { type: String, required: true },
    // Copied from the pack, so a later price change can't alter an order.
    coins: { type: Number, required: true },
    amountPaise: { type: Number, required: true },
    currency: { type: String, required: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'created' },

    provider: { type: String, required: true }, // 'razorpay' | 'mock'
    gatewayOrderId: { type: String, required: true, unique: true },
    gatewayPaymentId: { type: String, default: null },
    failureReason: { type: String, default: null },

    // Client-sent Idempotency-Key for POST /store/orders: a retried create
    // returns the same order instead of making a second one.
    idempotencyKey: { type: String, default: null },

    expiresAt: { type: Date, required: true },
    paidAt: { type: Date, default: null },
    creditedAt: { type: Date, default: null },
    creditedBy: { type: String, enum: ['confirm', 'webhook', null], default: null },
    failedNotifiedAt: { type: Date, default: null }, // guard: one payment_failed notification
    receiptSentAt: { type: Date, default: null }, // guard: one receipt email
  },
  { timestamps: true }
);

coinOrderSchema.index(
  { user: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('CoinOrder', coinOrderSchema);
module.exports.ORDER_STATUSES = ORDER_STATUSES;
