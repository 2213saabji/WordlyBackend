// Shared verification logic: identity claims ("one account per X"), review
// cases, masking, and the status object every verification endpoint returns.

const Verification = require('../models/Verification');
const IdentityClaim = require('../models/IdentityClaim');
const ReviewCase = require('../models/ReviewCase');
const User = require('../models/User');
const { identityHash } = require('./verificationCrypto');

const STEPS = ['mobile', 'email', 'bank'];

function maskPhone(e164) {
  const last4 = e164.slice(-4);
  return `+${'•'.repeat(Math.max(0, e164.length - 5))}${last4}`;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

function maskAccount(accountNumber) {
  return `••••${accountNumber.slice(-4)}`;
}

async function getVerification(userId) {
  return Verification.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  ).catch(async (err) => {
    if (err && err.code === 11000) return Verification.findOne({ user: userId });
    throw err;
  });
}

// Claims `hash` of `type` for the user, releasing any other value of the
// same type they held (a changed number or account). If another account
// already holds it, nothing is claimed and a review case is opened instead —
// the detail still counts as verified for this player (they proved they
// control it), but their payouts are held for manual review. Returns true
// if the claim is clean.
async function claimIdentity(userId, type, hash) {
  const existing = await IdentityClaim.findOne({ type, hash }).lean();
  if (existing && String(existing.user) !== String(userId)) {
    await openReviewCase(userId, type, existing.user);
    return false;
  }

  await IdentityClaim.deleteMany({ user: userId, type, hash: { $ne: hash } });
  try {
    await IdentityClaim.updateOne({ type, hash }, { $setOnInsert: { user: userId } }, { upsert: true });
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;
  }
  // Re-read: a concurrent claim by another user may have won the race.
  const owner = await IdentityClaim.findOne({ type, hash }).lean();
  if (owner && String(owner.user) !== String(userId)) {
    await openReviewCase(userId, type, owner.user);
    return false;
  }
  return true;
}

// At most one open case per (user, detail).
function openReviewCase(userId, detail, otherUser) {
  return ReviewCase.updateOne(
    { user: userId, detail, reason: 'identity_in_use', status: 'open' },
    { $setOnInsert: { otherUser } },
    { upsert: true }
  );
}

// Accounts that signed in with Google proved the address to Google (the
// sign-in rejects unverified Google emails, and links by that same address),
// so the email step passes without a link.
async function autoVerifyGoogleEmail(verification) {
  if (verification.email.status === 'verified') return verification;
  const user = await User.findById(verification.user).select('email googleId').lean();
  if (!user || !user.googleId) return verification;

  const hash = identityHash('email', user.email);
  await claimIdentity(verification.user, 'email', hash);
  verification.email.status = 'verified';
  verification.email.method = 'google';
  verification.email.masked = maskEmail(user.email);
  verification.email.emailHash = hash;
  verification.email.verifiedAt = new Date();
  verification.email.tokenHash = null;
  verification.email.tokenExpiresAt = null;
  await verification.save();
  return verification;
}

// The next step the player has to act on, in the PRD's order. A bank
// account awaiting its penny-drop result needs nothing from the player.
function nextStep(v) {
  for (const step of STEPS) {
    const { status } = v[step];
    if (status === 'verified') continue;
    if (step === 'bank' && status === 'pending') continue;
    return step;
  }
  return null;
}

async function openReviewCaseFor(userId) {
  return ReviewCase.findOne({ user: userId, status: 'open' }).sort({ createdAt: -1 }).lean();
}

// The GET /verification/status body (also returned by every step).
async function serializeStatus(v) {
  const reviewCase = await openReviewCaseFor(v.user);
  const complete = STEPS.every((s) => v[s].status === 'verified');
  return {
    mobile: { status: v.mobile.status, masked: v.mobile.status === 'pending' ? v.mobile.otpMasked : v.mobile.masked },
    email: { status: v.email.status, masked: v.email.masked, method: v.email.method },
    bank: { status: v.bank.status, masked: v.bank.masked, ifsc: v.bank.ifsc, nameMatch: v.bank.nameMatch },
    reviewCase: reviewCase ? { status: reviewCase.status, reason: reviewCase.reason, detail: reviewCase.detail } : null,
    nextStep: nextStep(v),
    complete,
  };
}

// For the reward tracker: can a payout be sent, and if not, why.
async function payoutReadiness(userId) {
  const v = await Verification.findOne({ user: userId }).lean();
  const complete = Boolean(v) && STEPS.every((s) => v[s].status === 'verified');
  const reviewCase = await openReviewCaseFor(userId);
  let blockedReason = null;
  if (reviewCase) blockedReason = 'review_case';
  else if (!complete) blockedReason = 'verification_pending';
  return { verificationComplete: complete, blockedReason };
}

module.exports = {
  maskPhone,
  maskEmail,
  maskAccount,
  getVerification,
  claimIdentity,
  autoVerifyGoogleEmail,
  serializeStatus,
  payoutReadiness,
};
