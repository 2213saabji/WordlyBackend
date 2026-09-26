const mongoose = require('mongoose');

// One per user per IST day with Infinite activity — the base unit of
// consistency. A day with no document counts as a missed day.
const infiniteDaySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true }, // IST 'YYYY-MM-DD'
    tier: { type: Number, required: true }, // tier the day is judged against

    // Copied from TierConfig on the day's first write, so a config change
    // mid-day never moves the goalposts for a day already in progress.
    targetMinutes: { type: Number, required: true },
    targetGames: { type: Number, required: true },

    activeMs: { type: Number, default: 0 },
    lastHeartbeatAt: { type: Date, default: null },

    gamesCompleted: { type: Number, default: 0 },
    gamesWon: { type: Number, default: 0 },
    pointsEarned: { type: Number, default: 0 },

    qualified: { type: Boolean, default: false },
    qualifiedAt: { type: Date, default: null },
    bonusAwarded: { type: Boolean, default: false }, // guard for the +20 qualifying-day bonus
  },
  { timestamps: true }
);

infiniteDaySchema.index({ user: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('InfiniteDay', infiniteDaySchema);
