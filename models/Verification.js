const mongoose = require('mongoose');

// Tier 1 payout verification, one per user: mobile (SMS OTP), email (link)
// and bank account (penny-drop). Collected only once a player reaches
// Tier 1 (PRD §7). Raw phone numbers and bank details are never stored in
// plain text: identities are keyed hashes (see utils/verificationCrypto.js)
// and the bank record is AES-256-GCM encrypted. Only masked values are ever
// sent back to the client.
const encryptedSchema = new mongoose.Schema(
  { iv: String, tag: String, data: String },
  { _id: false }
);

const verificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    mobile: {
      status: { type: String, enum: ['not_started', 'pending', 'verified'], default: 'not_started' },
      masked: { type: String, default: null },
      phoneHash: { type: String, default: null }, // identity hash of the verified number
      verifiedAt: { type: Date, default: null },
      // The OTP currently outstanding, if any.
      otpPhoneHash: { type: String, default: null },
      otpMasked: { type: String, default: null },
      otpCodeHash: { type: String, default: null },
      otpExpiresAt: { type: Date, default: null },
      otpAttempts: { type: Number, default: 0 },
      otpSentAt: { type: [Date], default: [] }, // recent sends, for the 3-per-15-min limit
    },

    email: {
      status: { type: String, enum: ['not_started', 'pending', 'verified'], default: 'not_started' },
      masked: { type: String, default: null },
      method: { type: String, enum: ['link', 'google', null], default: null },
      emailHash: { type: String, default: null }, // identity hash of the address the link was sent to
      verifiedAt: { type: Date, default: null },
      tokenHash: { type: String, default: null },
      tokenExpiresAt: { type: Date, default: null },
      lastSentAt: { type: Date, default: null },
    },

    bank: {
      status: { type: String, enum: ['not_started', 'pending', 'verified', 'name_mismatch'], default: 'not_started' },
      masked: { type: String, default: null }, // e.g. '••••1234'
      ifsc: { type: String, default: null }, // branch code — public, kept readable
      accountHash: { type: String, default: null },
      encrypted: { type: encryptedSchema, default: null }, // { accountHolderName, accountNumber, ifsc }
      nameMatch: { type: Boolean, default: null },
      providerRef: { type: String, default: null },
      submittedAt: { type: Date, default: null },
      verifiedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

// POST /verification/email/confirm looks the link token up by its hash.
verificationSchema.index({ 'email.tokenHash': 1 }, { partialFilterExpression: { 'email.tokenHash': { $type: 'string' } } });

module.exports = mongoose.model('Verification', verificationSchema);
