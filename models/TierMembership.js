const mongoose = require('mongoose');

// One per Infinite player: which tier they're in and their standing there.
// Created on the player's first completed Infinite game, in Tier 8. Rank is
// never stored — it's computed live from the ranking index below (see
// rankOf() in utils/tiers.js), so any score change or tier move re-orders
// both boards on the next read.
const windowDaySchema = new mongoose.Schema(
  {
    day: { type: String, required: true }, // IST 'YYYY-MM-DD'
    qualified: { type: Boolean, required: true },
  },
  { _id: false }
);

const tierMembershipSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    tier: { type: Number, required: true, min: 1, max: 8, default: 8 },
    enteredTierAt: { type: Date, required: true },
    enteredTierDay: { type: String, required: true }, // IST day

    score: { type: Number, default: 0 }, // reset to a 20% carry-in on every tier change
    qualifyingDaysInTier: { type: Number, default: 0 }, // tie-break #1: total, not consecutive
    scoreReachedAt: { type: Date, required: true }, // tie-break #2: set on every score change

    // The tier's day counter: +1 per qualifying day, 0 on a miss, promotion or
    // demotion. Promote when it reaches the tier's daysToStick. In Tier 1 it's
    // the reward cycle (0..30).
    stickDays: { type: Number, default: 0 },
    window: { type: [windowDaySchema], default: [] }, // last <=7 settled days in this tier
    missesInWindow: { type: Number, default: 0 },

    lastSettledDay: { type: String, required: true }, // reset-job idempotency cursor (IST day)
    lastActiveDay: { type: String, default: null }, // IST day of the last completed game
    rewardCycle: { type: Number, default: 0 }, // +1 each time a Tier 1 30-day cycle completes
    // Every completed Tier 1 cycle, money or not (Diamond stars, "cycle
    // complete" history rows). Kept across tier moves. ~12 entries a year.
    completedCycles: {
      type: [new mongoose.Schema({ cycle: Number, day: String }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true }
);

// Ranking + board listing. _id is the final tie-break so a page boundary
// never shows the same player twice or skips one.
tierMembershipSchema.index({ tier: 1, score: -1, qualifyingDaysInTier: -1, scoreReachedAt: 1, _id: 1 });
// Reset-job batches.
tierMembershipSchema.index({ tier: 1, lastSettledDay: 1 });

module.exports = mongoose.model('TierMembership', tierMembershipSchema);
