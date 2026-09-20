const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const DeviceSession = require('../models/DeviceSession');
const { sendPasswordResetEmail } = require('../utils/email');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

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

  const existing = await User.findOne({ email: email.toLowerCase() });
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
  if (!user) {
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

// Exchanges a still-active device session for a new access token, keyed on
// deviceId alone, so the client only needs email/password again if this
// device was logged out (or never logged in).
async function refresh(req, res) {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  const session = await DeviceSession.findOne({ deviceId, revokedAt: null });
  if (!session) {
    return res.status(401).json({ message: 'Device session is invalid or has been logged out' });
  }

  const user = await User.findById(session.user);
  if (!user) {
    return res.status(401).json({ message: 'Device session is invalid or has been logged out' });
  }

  session.lastUsedAt = new Date();
  await session.save();

  const token = signToken(user._id);
  return res.json({ token, user: publicUser(user) });
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
  const user = await User.findById(req.userId);
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
  refresh,
  logout,
  me,
  forgotPassword,
  resetPassword,
  // Reused by webauthnController.js so a successful passkey authentication
  // can mint the same access token and refresh the same device session.
  signToken,
  publicUser,
  issueDeviceSession,
};
