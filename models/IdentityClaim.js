const mongoose = require('mongoose');

// "One account per mobile number / email / bank account" (PRD §7). Each
// verified detail is claimed by exactly one user through the unique
// (type, hash) index; `hash` is a keyed HMAC of the normalised value, so the
// raw number or account is never stored here.
const identityClaimSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['phone', 'email', 'bank'], required: true },
    hash: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

identityClaimSchema.index({ type: 1, hash: 1 }, { unique: true });
identityClaimSchema.index({ user: 1, type: 1 });

module.exports = mongoose.model('IdentityClaim', identityClaimSchema);
