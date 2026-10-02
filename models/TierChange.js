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
    carriedScore: { type: Number, default: 0 }, // points entered the new tier with (= entryPoints)
    // The carry-in breakdown: carryInPercent of the old score, then the
    // demotion penalty (0 on promotion, never more than carriedPoints).
    carriedPoints: { type: Number, default: null },
    penalty: { type: Number, default: 0 }, // <= 0
    entryPoints: { type: Number, default: null },
    rankAtEntry: { type: Number, default: null },
    newTierSize: { type: Number, default: null },
    // Snapshot of the old tier's last <=7 settled days when the move happened.
    window: {
      type: [new mongoose.Schema({ day: String, qualified: Boolean }, { _id: false })],
      default: [],
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

tierChangeSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('TierChange', tierChangeSchema);
