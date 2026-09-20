const mongoose = require('mongoose');

// Short-lived record of a challenge we handed out, so /verify can confirm the
// signed response matches something we actually issued (replay protection).
// TTL-indexed - Mongo deletes these on its own 5 minutes after creation.
const webAuthnChallengeSchema = new mongoose.Schema({
  challenge: { type: String, required: true, unique: true },
  purpose: { type: String, enum: ['register', 'authenticate'], required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // known for register; null for discoverable authenticate
  deviceId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: 300 },
});

module.exports = mongoose.model('WebAuthnChallenge', webAuthnChallengeSchema);
