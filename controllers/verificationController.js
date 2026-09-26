const crypto = require('crypto');
const Verification = require('../models/Verification');
const Payout = require('../models/Payout');
const User = require('../models/User');
const { getTierConfig } = require('../utils/tierConfig');
const { loadSettledMembership } = require('../utils/tiers');
const { sendEmailVerificationEmail } = require('../utils/email');
const { sendOtpSms, SmsNotConfiguredError } = require('../utils/sms');
const { verifyBankAccount } = require('../utils/pennyDrop');
const { identityHash, otpHash, safeEqualHex, encryptJson, tokenHash } = require('../utils/verificationCrypto');
const {
  maskPhone,
  maskEmail,
  maskAccount,
  getVerification,
  claimIdentity,
  autoVerifyGoogleEmail,
  serializeStatus,
} = require('../utils/verification');

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EMAIL_RESEND_INTERVAL_MS = 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_SEND_LIMIT = 3;
const OTP_SEND_WINDOW_MS = 15 * 60 * 1000;

// E.164: '+', country code, subscriber number — 8 to 15 digits in total.
// Any country is accepted.
const E164_REGEX = /^\+[1-9]\d{7,14}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_REGEX = /^\d{9,18}$/;

function normalizePhone(phone) {
  if (typeof phone !== 'string') return null;
  const cleaned = phone.replace(/[\s\-().]/g, '');
  return E164_REGEX.test(cleaned) ? cleaned : null;
}

// Verification is collected only from players who can earn a payout: in
// Tier 1 now, or holding a payout that hasn't been paid yet.
async function requireRewardEligible(req, res, next) {
  const config = await getTierConfig();
  const membership = await loadSettledMembership(req.userId, config);
  if (membership && membership.tier === 1) return next();
  const openPayout = await Payout.exists({ user: req.userId, status: { $in: ['pending', 'processing', 'failed'] } });
  if (openPayout) return next();
  return res.status(403).json({ message: 'Verification opens once you reach Diamond (Tier 1)', code: 'TIER1_REQUIRED' });
}

// GET /verification/status
async function status(req, res) {
  const v = await autoVerifyGoogleEmail(await getVerification(req.userId));
  return res.json(await serializeStatus(v));
}

// POST /verification/mobile/otp  { phone }
async function sendMobileOtp(req, res) {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({
      message: 'Enter the number in international format, e.g. +919876543210',
      code: 'PHONE_INVALID',
    });
  }

  const v = await getVerification(req.userId);
  const phoneHash = identityHash('phone', phone);

  if (v.mobile.status === 'verified' && v.mobile.phoneHash === phoneHash) {
    return res.json({ ...(await serializeStatus(v)), message: 'This number is already verified' });
  }

  const now = Date.now();
  const recentSends = v.mobile.otpSentAt.filter((t) => now - t.getTime() < OTP_SEND_WINDOW_MS);
  if (recentSends.length >= OTP_SEND_LIMIT) {
    const retryAfterSeconds = Math.ceil((recentSends[0].getTime() + OTP_SEND_WINDOW_MS - now) / 1000);
    return res.status(429).json({
      message: 'Too many codes requested. Try again in a few minutes.',
      code: 'OTP_RATE_LIMITED',
      retryAfterSeconds,
    });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  try {
    await sendOtpSms(phone, code);
  } catch (err) {
    if (err instanceof SmsNotConfiguredError) {
      return res.status(503).json({
        message: 'Mobile verification is not available yet',
        code: 'SMS_PROVIDER_NOT_CONFIGURED',
      });
    }
    console.error('OTP SMS send failed:', err);
    return res.status(502).json({ message: 'Could not send the code. Try again.', code: 'OTP_SEND_FAILED' });
  }

  // Requesting a code for a new number re-opens the mobile step until that
  // number is confirmed.
  v.mobile.status = 'pending';
  v.mobile.otpPhoneHash = phoneHash;
  v.mobile.otpMasked = maskPhone(phone);
  v.mobile.otpCodeHash = otpHash(req.userId, phoneHash, code);
  v.mobile.otpExpiresAt = new Date(now + OTP_TTL_MS);
  v.mobile.otpAttempts = 0;
  v.mobile.otpSentAt = [...recentSends, new Date(now)];
  await v.save();

  return res.json({ ...(await serializeStatus(v)), expiresInSeconds: OTP_TTL_MS / 1000 });
}

// POST /verification/mobile/verify  { phone, code }
async function verifyMobileOtp(req, res) {
  const phone = normalizePhone(req.body?.phone);
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const invalid = () => res.status(400).json({ message: 'That code is wrong or has expired', code: 'OTP_INVALID' });

  if (!phone || !/^\d{6}$/.test(code)) return invalid();

  const v = await getVerification(req.userId);
  const phoneHash = identityHash('phone', phone);
  const m = v.mobile;

  if (!m.otpCodeHash || m.otpPhoneHash !== phoneHash || !m.otpExpiresAt || m.otpExpiresAt < new Date()) {
    return invalid();
  }
  if (m.otpAttempts >= OTP_MAX_ATTEMPTS) {
    return res.status(400).json({ message: 'Too many wrong codes. Request a new one.', code: 'OTP_INVALID' });
  }
  if (!safeEqualHex(m.otpCodeHash, otpHash(req.userId, phoneHash, code))) {
    m.otpAttempts += 1;
    await v.save();
    return invalid();
  }

  await claimIdentity(req.userId, 'phone', phoneHash);
  m.status = 'verified';
  m.phoneHash = phoneHash;
  m.masked = maskPhone(phone);
  m.verifiedAt = new Date();
  m.otpPhoneHash = null;
  m.otpMasked = null;
  m.otpCodeHash = null;
  m.otpExpiresAt = null;
  m.otpAttempts = 0;
  await v.save();

  return res.json(await serializeStatus(v));
}

// POST /verification/email/send — emails a verification link to the
// account's email address.
async function sendEmailLink(req, res) {
  let v = await getVerification(req.userId);
  v = await autoVerifyGoogleEmail(v);
  if (v.email.status === 'verified') {
    return res.json({ ...(await serializeStatus(v)), message: 'Your email is already verified' });
  }

  const now = Date.now();
  if (v.email.lastSentAt && now - v.email.lastSentAt.getTime() < EMAIL_RESEND_INTERVAL_MS) {
    const retryAfterSeconds = Math.ceil((v.email.lastSentAt.getTime() + EMAIL_RESEND_INTERVAL_MS - now) / 1000);
    return res.status(429).json({ message: 'Wait a minute before asking for another link', code: 'EMAIL_RATE_LIMITED', retryAfterSeconds });
  }

  const user = await User.findById(req.userId).select('email').lean();
  const rawToken = crypto.randomBytes(32).toString('hex');

  v.email.status = 'pending';
  v.email.method = 'link';
  v.email.masked = maskEmail(user.email);
  v.email.emailHash = identityHash('email', user.email);
  v.email.tokenHash = tokenHash(rawToken);
  v.email.tokenExpiresAt = new Date(now + EMAIL_TOKEN_TTL_MS);
  v.email.lastSentAt = new Date(now);
  await v.save();

  try {
    await sendEmailVerificationEmail(user.email, rawToken);
  } catch (err) {
    console.error('Verification email send failed:', err);
    v.email.lastSentAt = null; // let them retry straight away
    await v.save();
    return res.status(502).json({ message: 'Could not send the email. Try again.', code: 'EMAIL_SEND_FAILED' });
  }

  return res.json({ ...(await serializeStatus(v)), expiresInSeconds: EMAIL_TOKEN_TTL_MS / 1000 });
}

// POST /verification/email/confirm  { token } — public. Called by the
// frontend's /verify-email/:token page, which may be opened on a device
// where the player isn't signed in; the token alone identifies them.
async function confirmEmail(req, res) {
  const { token } = req.body || {};
  const invalid = () => res.status(400).json({
    message: 'This verification link is invalid or has expired. Request a new one.',
    code: 'VERIFICATION_TOKEN_INVALID',
  });
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return invalid();

  const v = await Verification.findOne({
    'email.tokenHash': tokenHash(token),
    'email.tokenExpiresAt': { $gt: new Date() },
  });
  if (!v) return invalid();

  await claimIdentity(v.user, 'email', v.email.emailHash);
  v.email.status = 'verified';
  v.email.verifiedAt = new Date();
  v.email.tokenHash = null;
  v.email.tokenExpiresAt = null;
  await v.save();

  return res.json({ message: 'Email verified', email: { status: 'verified', masked: v.email.masked } });
}

// POST /verification/bank  { accountHolderName, accountNumber, ifsc }
async function submitBank(req, res) {
  const body = req.body || {};
  const accountHolderName = typeof body.accountHolderName === 'string' ? body.accountHolderName.trim().replace(/\s+/g, ' ') : '';
  const accountNumber = typeof body.accountNumber === 'string' ? body.accountNumber.replace(/\s/g, '') : '';
  const ifsc = typeof body.ifsc === 'string' ? body.ifsc.trim().toUpperCase() : '';

  if (accountHolderName.length < 2 || accountHolderName.length > 100) {
    return res.status(400).json({ message: 'Enter the account holder name as it appears at your bank', code: 'BANK_NAME_INVALID' });
  }
  if (!ACCOUNT_REGEX.test(accountNumber)) {
    return res.status(400).json({ message: 'Account number must be 9 to 18 digits', code: 'BANK_ACCOUNT_INVALID' });
  }
  if (!IFSC_REGEX.test(ifsc)) {
    return res.status(400).json({ message: 'Enter a valid 11-character IFSC code, e.g. HDFC0001234', code: 'IFSC_INVALID' });
  }

  const v = await getVerification(req.userId);
  const accountHash = identityHash('bank', `${accountNumber}:${ifsc}`);

  await claimIdentity(req.userId, 'bank', accountHash);
  // Any (re)submission restarts the bank step; while it's pending, payouts
  // for the current cycle are held (see payoutReadiness).
  v.bank.status = 'pending';
  v.bank.masked = maskAccount(accountNumber);
  v.bank.ifsc = ifsc;
  v.bank.accountHash = accountHash;
  v.bank.encrypted = encryptJson({ accountHolderName, accountNumber, ifsc });
  v.bank.nameMatch = null;
  v.bank.providerRef = null;
  v.bank.submittedAt = new Date();
  v.bank.verifiedAt = null;
  await v.save();

  const result = await verifyBankAccount({ accountHolderName, accountNumber, ifsc });
  if (result) {
    v.bank.nameMatch = result.nameMatch;
    v.bank.providerRef = result.providerRef || null;
    v.bank.status = result.nameMatch ? 'verified' : 'name_mismatch';
    v.bank.verifiedAt = result.nameMatch ? new Date() : null;
    await v.save();
  }

  return res.json(await serializeStatus(v));
}

module.exports = {
  requireRewardEligible,
  status,
  sendMobileOtp,
  verifyMobileOtp,
  sendEmailLink,
  confirmEmail,
  submitBank,
};
