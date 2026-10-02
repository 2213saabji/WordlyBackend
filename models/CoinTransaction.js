const mongoose = require('mongoose');

const COIN_TRANSACTION_TYPES = ['earn_solve', 'purchase', 'hint_spend', 'refund', 'adjustment'];

// The coin ledger: one entry per change to a wallet, never edited. Written
// only by utils/wallet.js, in the same transaction as the balance change.
// `idempotencyKey` is unique, so the same solve, order or hint can never
// credit or debit twice ('earn_solve:<gameId>', 'purchase:<orderId>',
// 'hint:<gameId>').
const coinTransactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: COIN_TRANSACTION_TYPES, required: true },
    amount: { type: Number, required: true }, // + credit, - debit
    balanceAfter: { type: Number, required: true },
    // What it was for: { gameId, mode, tier } for solves and hints,
    // { orderId, packId } for purchases.
    ref: { type: mongoose.Schema.Types.Mixed, default: {} },
    idempotencyKey: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// GET /wallet/transactions: newest first, paged by _id.
coinTransactionSchema.index({ user: 1, _id: -1 });

module.exports = mongoose.model('CoinTransaction', coinTransactionSchema);
module.exports.COIN_TRANSACTION_TYPES = COIN_TRANSACTION_TYPES;
