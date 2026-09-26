const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const User = require('../models/User');
const DeviceSession = require('../models/DeviceSession');
const TierMembership = require('../models/TierMembership');
const { sendPasswordResetEmail } = require('../utils/email');
const { getTierConfig, tierDef } = require('../utils/tierConfig');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

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
  };
}

async function signup(req, res) {
  const { username, email, password, deviceId } = req.body;

  if (!username || !email || !password || !deviceId) {
    return res.status(400).json({ message: 'username, email, password and deviceId are required' });
  }
  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ message: 'Invalid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: 'Password must be at least 8 characters long' });
  }

  // .exists() returns just { _id } off the email index — no need to pull the
  // whole document (passwordHash included) just to check for a duplicate.
  const existing = await User.exists({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ message: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ username, email: email.toLowerCase(), passwordHash });

  const token = signToken(user._id);
  await issueDeviceSession(user._id, deviceId);
  return res.status(201).json({ token, deviceId, user: publicUser(user) });
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
  const [user, membership, tierConfig] = await Promise.all([
    User.findById(req.userId).select(PUBLIC_USER_EXCLUDE).lean(),
    TierMembership.findOne({ user: req.userId }).select('tier').lean(),
    getTierConfig(),
  ]);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  // Infinite tier badge for the header. Read as stored (not settled) — the
  // tier only changes at the nightly reset, and /infinite/me settles fully.
  const tier = membership ? membership.tier : 8;
  return res.json({ user: publicUser(user), infinite: { tier, tierName: tierDef(tierConfig, tier).name } });
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
