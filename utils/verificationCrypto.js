const crypto = require('crypto');

// Every key used by verification is derived from one env secret,
// VERIFICATION_SECRET (a long random string, e.g. `openssl rand -hex 32`).
// Changing it makes existing encrypted bank records unreadable and existing
// identity hashes stop matching, so set it once and keep it.
const MIN_SECRET_LENGTH = 32;
const keyCache = new Map();

function configError() {
  const err = new Error('Verification is not configured on the server');
  err.status = 500;
  return err;
}

function deriveKey(purpose) {
  if (keyCache.has(purpose)) return keyCache.get(purpose);
  const secret = process.env.VERIFICATION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    console.error(`VERIFICATION_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters)`);
    throw configError();
  }
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, 'guessword-verification', purpose, 32));
  keyCache.set(purpose, key);
  return key;
}

// Keyed hash of a normalised identity value ('+919876543210',
// 'a@b.com', '<account>:<IFSC>'). Same input → same hash, so the unique
// index on IdentityClaim enforces one account per value.
function identityHash(type, value) {
  return crypto.createHmac('sha256', deriveKey('identity-hash')).update(`${type}:${value}`).digest('hex');
}

// OTP codes are stored hashed and bound to the user and number they were
// sent for, so a code can't be replayed for a different number.
function otpHash(userId, phoneHash, code) {
  return crypto.createHmac('sha256', deriveKey('otp')).update(`${userId}:${phoneHash}:${code}`).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('bank-encryption'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decryptJson(enc) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('bank-encryption'), Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  const data = Buffer.concat([decipher.update(Buffer.from(enc.data, 'base64')), decipher.final()]);
  return JSON.parse(data.toString('utf8'));
}

// Plain SHA-256 for one-time link tokens — same pattern as password reset.
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { identityHash, otpHash, safeEqualHex, encryptJson, decryptJson, tokenHash };
