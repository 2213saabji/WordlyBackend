const mongoose = require('mongoose');

// Append-only log of every tier move. Feeds notifications, the "moved from
// #12 in Bronze to #28 in Silver" UI (GET /infinite/tier-changes) and audits.
const tierChangeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true }, // IST day that was settled when the move happened
    fromTier: { type: Number, required: true },
    toTier: { type: Number, required: true },
    reason: { type: String, enum: ['promotion', 'demotion', 'seed', 'admin'], required: true },
    oldScore: { type: Number, default: 0 },
    oldRank: { type: Number, default: null },
    oldTierSize: { type: Number, default: null },
    carriedScore: { type: Number, default: 0 },
    rankAtEntry: { type: Number, default: null },
    newTierSize: { type: Number, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

tierChangeSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('TierChange', tierChangeSchema);
