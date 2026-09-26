const mongoose = require('mongoose');

// A Tier 1 reward for one completed 30-day cycle. Created by the daily reset
// job only while TierConfig.rewardsEnabled is on (Phase 2+). Moving it past
// 'pending' (verification, bank transfer, provider webhook) is Phase 2 work.
const payoutSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    cycle: { type: Number, required: true },
    amountInr: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'processing', 'paid', 'failed'], default: 'pending' },
    eligibleDay: { type: String, required: true }, // IST day the 30th qualifying day was
    providerRef: { type: String, default: null },
    failureReason: { type: String, default: null },
    blockedReason: { type: String, default: null },
    paidAt: { type: Date, default: null },
    // `${userId}:${cycle}` — enforces "one payout per player per cycle" even
    // if the reset job re-runs.
    idempotencyKey: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

payoutSchema.index({ user: 1, cycle: -1 });

module.exports = mongoose.model('Payout', payoutSchema);
