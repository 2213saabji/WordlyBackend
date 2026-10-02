const mongoose = require('mongoose');

// An email/password signup waiting for its email to be confirmed. The User
// is only created once the player clicks the emailed link or enters the
// emailed code (see verifySignupLink / verifySignupOtp in authController.js),
// so login and every other flow only ever see verified accounts. Signing up
// again with the same email replaces the pending record and sends a new
// email. TTL-indexed: Mongo deletes a record 24 hours after its last send.
const pendingSignupSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },

    tokenHash: { type: String, required: true }, // sha256 of the emailed link token
    otpHash: { type: String, required: true }, // HMAC of the emailed 6-digit code
    expiresAt: { type: Date, required: true }, // when the link and code stop working
    otpAttempts: { type: Number, default: 0 },
    lastSentAt: { type: Date, required: true, expires: 24 * 60 * 60 },
    // Location of the signup form request, copied to the User on creation
    // (the emailed link may be opened somewhere else).
    signupLocation: {
      type: new mongoose.Schema(
        { countryCode: String, regionCode: String, region: String, regionType: String },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true }
);

pendingSignupSchema.index({ tokenHash: 1 });

module.exports = mongoose.model('PendingSignup', pendingSignupSchema);
