const mongoose = require('mongoose');

const AUTH_EVENTS = ['email_signup', 'google_continue'];

// Signup analytics: one row per account created by email signup and per
// successful "Continue with Google" (new or returning account), with the
// country / region the request came from (utils/geo.js). Only the coarse
// location is kept, never the IP. Counted by GET /analytics/auth-locations.
const authEventSchema = new mongoose.Schema(
  {
    event: { type: String, enum: AUTH_EVENTS, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    newAccount: { type: Boolean, required: true },
    countryCode: { type: String, default: null }, // 'IN'
    regionCode: { type: String, default: null }, // 'RJ'
    region: { type: String, default: null }, // 'Rajasthan'
    regionType: { type: String, default: null }, // 'State'
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

authEventSchema.index({ createdAt: -1 });
authEventSchema.index({ event: 1, createdAt: -1 });

module.exports = mongoose.model('AuthEvent', authEventSchema);
module.exports.AUTH_EVENTS = AUTH_EVENTS;
