const mongoose = require('mongoose');

// One per player: their coin balance. The ledger (CoinTransaction) is the
// record of every change; `balance` is its running sum, written in the same
// transaction as each ledger entry (see utils/wallet.js), so the two can't
// drift. Created on the first credit; no document means a balance of 0.
const walletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    balance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Wallet', walletSchema);
