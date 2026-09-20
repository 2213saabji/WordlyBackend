const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoUint8Array, decodeClientDataJSON } = require('@simplewebauthn/server/helpers');

const User = require('../models/User');
const WebAuthnCredential = require('../models/WebAuthnCredential');
const WebAuthnChallenge = require('../models/WebAuthnChallenge');
const { signToken, publicUser, issueDeviceSession } = require('./authController');

const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Wordle';
const RP_ID = process.env.WEBAUTHN_RP_ID || '37d19d9b-3001.uks1.devtunnels.ms';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://37d19d9b-3001.uks1.devtunnels.ms';

// --- Registration: enroll a passkey for this device, for the currently
// signed-in user. Call this right after a normal email/password login, as
// an explicit "turn on passkey login for this device" step.

async function registrationOptions(req, res) {
  const { deviceId } = req.body;
  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  const user = await User.findById(req.userId);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  const existing = await WebAuthnCredential.find({ user: user._id, revokedAt: null });

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.email,
    userDisplayName: user.username,
    userID: isoUint8Array.fromUTF8String(user._id.toString()),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credentialID, transports: c.transports })),
    authenticatorSelection: {
      residentKey: 'required', // discoverable credential - required for the "no deviceId known yet" login flow
      userVerification: 'preferred',
    },
  });

  await WebAuthnChallenge.create({
    challenge: options.challenge,
    purpose: 'register',
    user: user._id,
    deviceId,
  });

  return res.json(options);
}

async function registrationVerify(req, res) {
  const { deviceId, response } = req.body;
  if (!deviceId || !response) {
    return res.status(400).json({ message: 'deviceId and response are required' });
  }

  const clientData = decodeClientDataJSON(response.response.clientDataJSON);
  const challengeDoc = await WebAuthnChallenge.findOneAndDelete({
    challenge: clientData.challenge,
    purpose: 'register',
  });
  if (!challengeDoc) {
    return res.status(400).json({ message: 'Registration challenge expired or already used. Request new options first.' });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeDoc.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
  } catch (err) {
    return res.status(400).json({ message: 'Registration verification failed: ' + err.message });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ message: 'Registration could not be verified' });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  await WebAuthnCredential.create({
    user: challengeDoc.user,
    deviceId,
    credentialID: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    deviceType: credentialDeviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice',
    backedUp: credentialBackedUp,
  });

  return res.status(201).json({ message: 'Passkey registered for this device' });
}

// --- Authentication: recognize a device by its passkey alone, without
// needing to already know its deviceId - this is what survives the user
// clearing cookies/localStorage/IndexedDB, since the private key lives in
// the platform authenticator, not in browser storage.

async function authenticationOptions(req, res) {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'preferred',
    // No allowCredentials on purpose: this is the discoverable-credential
    // ("usernameless") flow - the platform authenticator itself lists which
    // passkeys it holds for this origin, so the caller doesn't need to
    // already know who they are or which deviceId this browser used to have.
  });

  await WebAuthnChallenge.create({
    challenge: options.challenge,
    purpose: 'authenticate',
  });

  return res.json(options);
}

async function authenticationVerify(req, res) {
  const { response } = req.body;
  if (!response || !response.id) {
    return res.status(400).json({ message: 'response is required' });
  }

  const cred = await WebAuthnCredential.findOne({ credentialID: response.id, revokedAt: null });
  if (!cred) {
    return res.status(401).json({ message: 'Passkey not recognized or has been revoked' });
  }

  const clientData = decodeClientDataJSON(response.response.clientDataJSON);
  const challengeDoc = await WebAuthnChallenge.findOneAndDelete({
    challenge: clientData.challenge,
    purpose: 'authenticate',
  });
  if (!challengeDoc) {
    return res.status(400).json({ message: 'Authentication challenge expired or already used. Request new options first.' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeDoc.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: cred.credentialID,
        publicKey: cred.publicKey,
        counter: cred.counter,
        transports: cred.transports,
      },
    });
  } catch (err) {
    return res.status(400).json({ message: 'Authentication verification failed: ' + err.message });
  }

  if (!verification.verified) {
    return res.status(401).json({ message: 'Passkey signature could not be verified' });
  }

  cred.counter = verification.authenticationInfo.newCounter;
  cred.lastUsedAt = new Date();
  await cred.save();

  const user = await User.findById(cred.user);
  if (!user) {
    return res.status(401).json({ message: 'Passkey not recognized or has been revoked' });
  }

  // Re-issue the same deviceId's session, so the plain deviceId-based
  // /auth/refresh keeps working going forward until storage is cleared again.
  await issueDeviceSession(user._id, cred.deviceId);

  const token = signToken(user._id);
  return res.json({ token, deviceId: cred.deviceId, user: publicUser(user) });
}

// --- Management ---

async function listDevices(req, res) {
  const creds = await WebAuthnCredential.find({ user: req.userId, revokedAt: null })
    .select('deviceId deviceType backedUp createdAt lastUsedAt')
    .sort({ lastUsedAt: -1 });
  return res.json({ devices: creds });
}

async function revoke(req, res) {
  const { deviceId } = req.body;
  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required' });
  }

  const cred = await WebAuthnCredential.findOneAndUpdate(
    { user: req.userId, deviceId, revokedAt: null },
    { revokedAt: new Date() }
  );
  if (!cred) {
    return res.status(404).json({ message: 'No active passkey found for this device' });
  }

  return res.json({ message: 'Passkey revoked for this device' });
}

module.exports = {
  registrationOptions,
  registrationVerify,
  authenticationOptions,
  authenticationVerify,
  listDevices,
  revoke,
};
