const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const User = require('../models/User');
const DeviceSession = require('../models/DeviceSession');
const TierMembership = require('../models/TierMembership');
const PendingSignup = require('../models/PendingSignup');
const { sendPasswordResetEmail, sendSignupVerificationEmail } = require('../utils/email');
const { getTierConfig, tierDef } = require('../utils/tierConfig');
const { getBalance } = require('../utils/wallet');
const { locationFromRequest, storedLocation } = require('../utils/geo');
const { bumpSync, bumpGlobal } = require('../utils/sync');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SIGNUP_CODE_TTL_MS = 15 * 60 * 1000; // link and code, 15 minutes
const SIGNUP_RESEND_INTERVAL_MS = 60 * 1000;
const SIGNUP_OTP_MAX_ATTEMPTS = 5;

// Audience is read lazily (not at module load) so a missing GOOGLE_CLIENT_ID
// only breaks googleAuth(), not the whole server at startup.
const googleClient = new OAuth2Client();

// Never needed once a doc leaves the DB layer — trims what publicUser() would
// have to ignore off the wire on every read-only user fetch.
const PUBLIC_USER_EXCLUDE = '-passwordHash -resetPasswordTokenHash -resetPasswordExpires';

// Short-lived: once this expires, the client calls /refresh instead of
// asking the user to log in again, as long as its device session is intact.
function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  });
}

// One session per deviceId. Re-running this for a deviceId that's already
// tied to a session (same or different user) overwrites it, which is what
// lets a device get re-used/re-logged-into after a logout. There's no
// separate refresh secret — deviceId itself is what /refresh checks against,
// so the client only has to remember deviceId, not manage a second token.
async function issueDeviceSession(userId, deviceId) {
  await DeviceSession.findOneAndUpdate(
    { deviceId },
    { user: userId, revokedAt: null, lastUsedAt: new Date() },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    stats: user.stats,
    groups: user.groups,
    // { countryCode, regionCode, region, regionType } or null.
    signupLocation: user.signupLocation || null,
  };
}

// --- Signup (email verified before the account exists) -------------------

function signupOtpHash(email, code) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`signup:${email}:${code}`).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function retryAfterSeconds(pending, now) {
  return Math.ceil((pending.lastSentAt.getTime() + SIGNUP_RESEND_INTERVAL_MS - now) / 1000);
}

// Stores a fresh link token + code on the pending signup (replacing any
// earlier ones) and emails them. On a send failure the pending signup is
// removed so the player can simply try again.
async function sendSignupCodes(email, fields) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();

  await PendingSignup.findOneAndUpdate(
    { email },
    {
      $set: {
        ...fields,
        tokenHash: sha256(rawToken),
        otpHash: signupOtpHash(email, code),
        expiresAt: new Date(now + SIGNUP_CODE_TTL_MS),
        otpAttempts: 0,
        lastSentAt: new Date(now),
      },
    },
    { upsert: true }
  );

  try {
    await sendSignupVerificationEmail(email, rawToken, code, SIGNUP_CODE_TTL_MS / 60000);
  } catch (err) {
    await PendingSignup.deleteOne({ email });
    throw err;
  }
}

function signupSentResponse(email) {
  return {
    message: 'We sent a verification code and link to your email',
    email,
    expiresInSeconds: SIGNUP_CODE_TTL_MS / 1000,
    resendAfterSeconds: SIGNUP_RESEND_INTERVAL_MS / 1000,
  };
}

// Turns a confirmed pending signup into a real account and logs this
// device in. Deleting the pending record first is what makes the link and
// code single-use: of two concurrent confirms, only one gets the record.
async function completeSignup(pendingId, deviceId, req, res) {
  const pending = await PendingSignup.findOneAndDelete({ _id: pendingId });
  if (!pending) {
    return res.status(400).json({ message: 'This signup was already completed or has expired', code: 'SIGNUP_INVALID' });
  }

  // Where the signup form was sent from; failing that, this confirm request.
  const signupLocation = (pending.signupLocation && pending.signupLocation.countryCode)
    ? storedLocation(pending.signupLocation)
    : storedLocation(locationFromRequest(req));

  let user;
  try {
    user = await User.create({
      username: pending.username,
      email: pending.email,
      passwordHash: pending.passwordHash,
      signupLocation,
    });
  } catch (err) {
    // The email got an account in the meantime (e.g. Google sign-in).
    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'An account with this email already exists', code: 'EMAIL_TAKEN' });
    }
    throw err;
  }

  const token = signToken(user._id);
  await issueDeviceSession(user._id, deviceId);
  return res.status(201).json({ token, deviceId, user: publicUser(user) });
}

// POST /auth/signup  { username, email, password }
// Doesn't create the account: it emails a 6-digit code and a link, and the
// account is created when either is confirmed.
async function signup(req, res) {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'username, email and password are required' });
  }
  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ message: 'Invalid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters long' });
  }

  const normalizedEmail = email.toLowerCase();
  // .exists() returns just { _id } off the email index — no need to pull the
  // whole document (passwordHash included) just to check for a duplicate.
  const existing = await User.exists({ email: normalizedEmail });
  if (existing) {
    return res.status(409).json({ message: 'An account with this email already exists', code: 'EMAIL_TAKEN' });
  }

  const now = Date.now();
  const pending = await PendingSignup.findOne({ email: normalizedEmail }).select('lastSentAt').lean();
  if (pending && now - pending.lastSentAt.getTime() < SIGNUP_RESEND_INTERVAL_MS) {
    return res.status(429).json({
      message: 'Wait a minute before asking for another code',
      code: 'SIGNUP_RATE_LIMITED',
      retryAfterSeconds: retryAfterSeconds(pending, now),
    });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  try {
    await sendSignupCodes(normalizedEmail, { username, passwordHash, signupLocation: storedLocation(locationFromRequest(req)) });
  } catch (err) {
    console.error('Failed to send signup verification email:', err);
    return res.status(502).json({ message: 'Could not send the verification email. Try again.', code: 'EMAIL_SEND_FAILED' });
  }

  return res.status(202).json(signupSentResponse(normalizedEmail));
}

// POST /auth/signup/resend  { email }
async function resendSignup(req, res) {
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
  if (!email) {
    return res.status(400).json({ message: 'email is required' });
  }

  const pending = await PendingSignup.findOne({ email }).select('lastSentAt').lean();
  if (!pending) {
    return res.status(404).json({ message: 'No signup is waiting for this email. Sign up again.', code: 'SIGNUP_NOT_FOUND' });
  }
  const now = Date.now();
  if (now - pending.lastSentAt.getTime() < SIGNUP_RESEND_INTERVAL_MS) {
    return res.status(429).json({
      message: 'Wait a minute before asking for another code',
      code: 'SIGNUP_RATE_LIMITED',
      retryAfterSeconds: retryAfterSeconds(pending, now),
    });
  }

  try {
    await sendSignupCodes(email, {});
  } catch (err) {
    console.error('Failed to resend signup verification email:', err);
    return res.status(502).json({ message: 'Could not send the verification email. Sign up again.', code: 'EMAIL_SEND_FAILED' });
  }
  return res.json(signupSentResponse(email));
}

// POST /auth/signup/verify-otp  { email, code, deviceId }
async function verifySignupOtp(req, res) {
  const { deviceId } = req.body;
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const invalid = () => res.status(400).json({ message: 'That code is wrong or has expired', code: 'SIGNUP_CODE_INVALID' });

  if (!email || !deviceId) {
    return res.status(400).json({ message: 'email, code and deviceId are required' });
  }
  if (!/^\d{6}$/.test(code)) return invalid();

  // Count the attempt before checking it, atomically, so parallel guesses
  // can't get past the limit.
  const pending = await PendingSignup.findOneAndUpdate(
    { email, expiresAt: { $gt: new Date() }, otpAttempts: { $lt: SIGNUP_OTP_MAX_ATTEMPTS } },
    { $inc: { otpAttempts: 1 } },
    { returnDocument: 'after' }
  ).lean();

  if (!pending) {
    const exhausted = await PendingSignup.exists({ email, expiresAt: { $gt: new Date() } });
    if (exhausted) {
      return res.status(400).json({ message: 'Too many wrong codes. Request a new one.', code: 'SIGNUP_CODE_ATTEMPTS' });
    }
    return invalid();
  }
  if (!safeEqualHex(pending.otpHash, signupOtpHash(email, code))) return invalid();

  return completeSignup(pending._id, deviceId, req, res);
}

// POST /auth/signup/verify/:token  { deviceId }
// Called by the frontend's /verify-signup/:token page (the emailed link).
async function verifySignupLink(req, res) {
  const { token } = req.params;
  const { deviceId } = req.body;
  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  const pending = await PendingSignup.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } })
    .select('_id')
    .lean();
  if (!pending) {
    return res.status(400).json({ message: 'This verification link is invalid or has expired', code: 'SIGNUP_LINK_INVALID' });
  }

  return completeSignup(pending._id, deviceId, req, res);
}

async function login(req, res) {
  const { email, password, deviceId } = req.body;

  if (!email || !password || !deviceId) {
    return res.status(400).json({ message: 'email, password and deviceId are required' });
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  // Same generic message for "no such user", "wrong password", and
  // "this account has no password" (Google-only account) — don't let this
  // endpoint reveal which of those is actually true.
  if (!user || !user.passwordHash) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const token = signToken(user._id);
  await issueDeviceSession(user._id, deviceId);
  return res.json({ token, deviceId, user: publicUser(user) });
}

// Verifies a Google ID token (the `credential` Google Identity Services
// hands the frontend after the user picks an account) and signs the caller
// into this app — creating an account on first sign-in, or linking Google
// to an existing email/password account on subsequent ones. The ID token is
// verified server-side against Google's public keys; the frontend never
// gets to just assert "trust me, this is alice@example.com".
async function googleAuth(req, res) {
  const { idToken, deviceId } = req.body;

  if (!idToken || !deviceId) {
    return res.status(400).json({ message: 'idToken and deviceId are required' });
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.error('GOOGLE_CLIENT_ID is not configured');
    return res.status(500).json({ message: 'Google sign-in is not configured on the server' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid Google credential' });
  }

  if (!payload || !payload.email || !payload.sub) {
    return res.status(401).json({ message: 'Invalid Google credential' });
  }
  if (!payload.email_verified) {
    return res.status(401).json({ message: 'Google account email is not verified' });
  }

  const email = payload.email.toLowerCase();
  const googleId = payload.sub;

  let user = await User.findOne({ googleId });

  if (!user) {
    // First time this Google identity has signed in here — check whether an
    // email/password account already owns this email before creating a new
    // one, so the two don't collide on the unique email index.
    user = await User.findOne({ email });
    if (user) {
      user.googleId = googleId;
      await user.save();
    }
  }

  if (!user) {
    user = await User.create({
      username: payload.name || email.split('@')[0],
      email,
      googleId,
      // A Google sign-in with no account yet is the signup: record where
      // it came from. Returning and linked accounts are left as they are.
      signupLocation: storedLocation(locationFromRequest(req)),
    });
  }

  const token = signToken(user._id);
  await issueDeviceSession(user._id, deviceId);
  return res.json({ token, deviceId, user: publicUser(user) });
}

// Exchanges a still-active device session for a new access token, keyed on
// deviceId alone, so the client only needs email/password again if this
// device was logged out (or never logged in).
async function refresh(req, res) {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  // Was 3 round trips (findOne session, findById user, save session) — this
  // does the lookup, the lastUsedAt bump, and the user fetch in one.
  const session = await DeviceSession.findOneAndUpdate(
    { deviceId, revokedAt: null },
    { lastUsedAt: new Date() },
    { new: true }
  ).populate({ path: 'user', select: PUBLIC_USER_EXCLUDE });

  if (!session || !session.user) {
    return res.status(401).json({ message: 'Device session is invalid or has been logged out' });
  }

  const token = signToken(session.user._id);
  return res.json({ token, user: publicUser(session.user) });
}

// Revokes this device's session so future /refresh calls for it fail and
// the device has to go through email/password login again. Other devices
// on the same account are untouched.
async function logout(req, res) {
  const { deviceId } = req.body;
  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  const session = await DeviceSession.findOneAndUpdate(
    { deviceId, user: req.userId, revokedAt: null },
    { revokedAt: new Date() }
  );

  if (!session) {
    return res.status(404).json({ message: 'No active session found for this device' });
  }

  return res.json({ message: 'Logged out' });
}

async function me(req, res) {
  const [user, membership, tierConfig, coinBalance] = await Promise.all([
    User.findById(req.userId).select(PUBLIC_USER_EXCLUDE).lean(),
    TierMembership.findOne({ user: req.userId }).select('tier').lean(),
    getTierConfig(),
    getBalance(req.userId),
  ]);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  // Infinite tier badge for the header. Read as stored (not settled) — the
  // tier only changes at the nightly reset, and /infinite/me settles fully.
  const tier = membership ? membership.tier : 8;
  // coinBalance feeds the header coin chip; GET /wallet has the same number.
  return res.json({ user: publicUser(user), infinite: { tier, tierName: tierDef(tierConfig, tier).name }, coinBalance });
}

async function updateUsername(req, res) {
  const { username } = req.body;

  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ message: 'username is required' });
  }
  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    return res.status(400).json({ message: 'username must be between 2 and 30 characters' });
  }

  const user = await User.findByIdAndUpdate(
    req.userId,
    { username: trimmed },
    { new: true }
  ).select(PUBLIC_USER_EXCLUDE);

  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  // The name also shows on every leaderboard the player is on.
  await Promise.all([bumpSync(req.userId, 'me'), bumpGlobal(['daily', 'weekly', 'infiniteBoard'])]);
  return res.json({ user: publicUser(user) });
}

async function forgotPassword(req, res) {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'email is required' });
  }

  const user = await User.findOne({ email: email.toLowerCase() });

  // Always respond the same way whether or not the account exists,
  // so this endpoint can't be used to enumerate registered emails.
  const genericResponse = {
    message: 'If an account with that email exists, a password reset link has been sent.',
  };

  if (!user) {
    return res.json(genericResponse);
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  user.resetPasswordTokenHash = tokenHash;
  user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await user.save();

  try {
    await sendPasswordResetEmail(user.email, rawToken);
  } catch (err) {
    user.resetPasswordTokenHash = null;
    user.resetPasswordExpires = null;
    await user.save();
    console.error('Failed to send password reset email:', err);
    return res.status(500).json({ message: 'Failed to send password reset email' });
  }

  return res.json(genericResponse);
}

async function resetPassword(req, res) {
  const { token } = req.params;
  const { password } = req.body;

  if (!password || password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters long' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    resetPasswordTokenHash: tokenHash,
    resetPasswordExpires: { $gt: new Date() },
  });

  if (!user) {
    return res.status(400).json({ message: 'Password reset token is invalid or has expired' });
  }

  user.passwordHash = await bcrypt.hash(password, 10);
  user.resetPasswordTokenHash = null;
  user.resetPasswordExpires = null;
  await user.save();

  return res.json({ message: 'Password has been reset successfully' });
}

module.exports = {
  signup,
  resendSignup,
  verifySignupOtp,
  verifySignupLink,
  login,
  googleAuth,
  refresh,
  logout,
  me,
  updateUsername,
  forgotPassword,
  resetPassword,
  // Reused by webauthnController.js so a successful passkey authentication
  // can mint the same access token and refresh the same device session.
  signToken,
  publicUser,
  issueDeviceSession,
};
