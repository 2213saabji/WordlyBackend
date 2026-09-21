const mongoose = require('mongoose');

// One passkey per device per user. credentialID + publicKey are what the
// backend verifies signatures against - the private key never leaves the
// device's secure hardware (Secure Enclave / TPM / Android Keystore).
const webAuthnCredentialSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true, trim: true }, // label/lookup only, not a secret
    credentialID: { type: String, required: true, unique: true }, // base64url, from the authenticator
    publicKey: { type: Buffer, required: true },
    counter: { type: Number, required: true, default: 0 }, // must strictly increase - clone detection
    transports: { type: [String], default: [] },
    deviceType: { type: String, enum: ['singleDevice', 'multiDevice'], default: 'singleDevice' },
    backedUp: { type: Boolean, default: false }, // true for synced passkeys (iCloud Keychain, etc.)
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// "this user's active passkeys" — registrationOptions() (excludeCredentials),
// listDevices(), and revoke() all filter on exactly these two fields.
webAuthnCredentialSchema.index({ user: 1, revokedAt: 1 });

module.exports = mongoose.model('WebAuthnCredential', webAuthnCredentialSchema);
