const mongoose = require('mongoose');

// A manual-review hold on a player's payouts. Opened when a verified detail
// is already linked to another account (PRD §7): the payout is blocked but
// the player keeps their tier. Resolving cases is admin work (not built yet).
const reviewCaseSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: ['identity_in_use'], required: true },
    detail: { type: String, enum: ['phone', 'email', 'bank'], required: true },
    otherUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    resolvedAt: { type: Date, default: null },
    note: { type: String, default: null },
  },
  { timestamps: true }
);

reviewCaseSchema.index({ user: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ReviewCase', reviewCaseSchema);
