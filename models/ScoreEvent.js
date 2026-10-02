const mongoose = require('mongoose');

const SCORE_EVENT_TYPES = ['game', 'day_bonus', 'decay', 'carry_in', 'demotion_penalty'];

// Every change to a player's tier points, for GET /infinite/score-events
// ("62 points lost", "-50 demotion penalty"). Append-only and for display
// only: TierMembership.score stays the source of truth.
const scoreEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: SCORE_EVENT_TYPES, required: true },
    points: { type: Number, required: true }, // + gained, - lost
    day: { type: String, required: true }, // IST day it applies to
    tier: { type: Number, required: true }, // tier whose points changed
    gameId: { type: mongoose.Schema.Types.ObjectId, ref: 'Game', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

scoreEventSchema.index({ user: 1, _id: -1 });

module.exports = mongoose.model('ScoreEvent', scoreEventSchema);
module.exports.SCORE_EVENT_TYPES = SCORE_EVENT_TYPES;
