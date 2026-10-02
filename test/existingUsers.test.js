// Players registered before v0.2 (coins, signup location) and the app
// version they're running: their stored documents have none of the new
// fields, and nothing they do may fail or show an error. Models are
// in-memory stubs, so no database is needed.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');

const User = require('../models/User');
const DeviceSession = require('../models/DeviceSession');
const PendingSignup = require('../models/PendingSignup');
const AuthEvent = require('../models/AuthEvent');
const TierMembership = require('../models/TierMembership');
const TierChange = require('../models/TierChange');
const TierConfig = require('../models/TierConfig');
const InfiniteDay = require('../models/InfiniteDay');
const Notification = require('../models/Notification');
const SyncState = require('../models/SyncState');
const SyncGlobal = require('../models/SyncGlobal');
const { login, googleAuth, me: authMe, verifySignupOtp } = require('../controllers/authController');
const { me: infiniteMe, tiers, legacyRewardsMe, tierChanges } = require('../controllers/infiniteController');
const { list: listNotifications } = require('../controllers/notificationController');
const { stubCoins } = require('./helpers/coinStubs');
const { istDayKey, addDaysKey } = require('../utils/dailyWord');

const USER = '507f1f77bcf86cd799439011';
const lean = (v) => ({ lean: async () => (v == null ? null : structuredClone(v)) });
let events;
let saves;

// A user document exactly as stored before v0.2: no signupLocation.
const OLD_USER = {
  _id: USER, username: 'asha', email: 'asha@x.com', stats: { gamesPlayed: 40 }, groups: [],
  createdAt: new Date('2026-01-15'), updatedAt: new Date('2026-01-15'),
};

beforeEach(() => {
  stubCoins(); // no Wallet documents: nobody has coins yet
  events = [];
  saves = 0;
  AuthEvent.create = async (doc) => { events.push(doc); return doc; };
  DeviceSession.findOneAndUpdate = async () => ({});
  TierConfig.findOne = () => ({ sort: () => lean(null) });
  SyncState.updateOne = async () => ({});
  SyncGlobal.updateOne = async () => ({});
  InfiniteDay.findOne = () => lean(null);
  TierMembership.countDocuments = async () => 0;
});

function call(handler, { body = {}, headers = {}, query = {}, userId } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    Promise.resolve(handler({ body, headers: lower, query, params: {}, userId, get: (h) => lower[h.toLowerCase()] }, res)).catch(reject);
  });
}

// --- auth --------------------------------------------------------------------

test('an old account (as hydrated by mongoose) reads signupLocation as null and saves without errors', async () => {
  const doc = User.hydrate(structuredClone(OLD_USER));
  assert.equal(doc.signupLocation, null);
  await doc.validate();
  assert.ok(!doc.isModified('signupLocation'), 'reading it never writes it');
});

test('email login for an old account: 200, unchanged except signupLocation: null', async () => {
  const passwordHash = await bcrypt.hash('longenough', 4);
  User.findOne = async () => User.hydrate({ ...structuredClone(OLD_USER), passwordHash });
  const res = await call(login, { body: { email: 'asha@x.com', password: 'longenough', deviceId: 'd1' }, headers: { 'x-vercel-ip-country': 'IN', 'x-vercel-ip-country-region': 'RJ' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, 'asha');
  assert.equal(res.body.user.signupLocation, null);
  assert.deepEqual(events, [], 'plain email login is not recorded');
});

test('GET /auth/me for an old account (lean, no wallet, no tier): coinBalance 0, signupLocation null', async () => {
  User.findById = () => ({ select: () => lean(OLD_USER) });
  TierMembership.findOne = () => ({ select: () => lean(null) });
  const res = await call(authMe, { userId: USER });
  assert.equal(res.status, 200);
  assert.equal(res.body.coinBalance, 0);
  assert.equal(res.body.user.signupLocation, null);
  assert.deepEqual(res.body.infinite, { tier: 8, tierName: 'Stone' });
});

test('Continue with Google for an old Google account: 200, counted, and their signupLocation is not invented', async () => {
  const doc = User.hydrate({ ...structuredClone(OLD_USER), googleId: 'sub-1' });
  doc.save = async () => { saves += 1; };
  User.findOne = async (filter) => (filter.googleId === 'sub-1' ? doc : null);
  User.create = async () => { throw new Error('must not create a second account'); };
  OAuth2Client.prototype.verifyIdToken = async () => ({ getPayload: () => ({ email: 'asha@x.com', email_verified: true, sub: 'sub-1', name: 'Asha' }) });

  const res = await call(googleAuth, { body: { idToken: 't', deviceId: 'd1' }, headers: { 'x-vercel-ip-country': 'IN', 'x-vercel-ip-country-region': 'RJ' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.signupLocation, null, 'where they signed up is unknown, not today\'s location');
  assert.equal(saves, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].newAccount, false);
  assert.equal(events[0].region, 'Rajasthan');
});

test('a signup started before the deploy (pending record without signupLocation) still completes', async () => {
  const crypto = require('crypto');
  const code = '654321';
  const pending = {
    _id: 'p1', email: 'new@x.com', username: 'new', passwordHash: 'h', otpAttempts: 0,
    expiresAt: new Date(Date.now() + 60000),
    otpHash: crypto.createHmac('sha256', process.env.JWT_SECRET).update(`signup:new@x.com:${code}`).digest('hex'),
  };
  PendingSignup.findOneAndUpdate = () => lean(pending);
  PendingSignup.findOneAndDelete = async () => pending;
  let created;
  User.create = async (doc) => { created = { _id: 'u2', stats: {}, groups: [], ...doc }; return created; };

  const res = await call(verifySignupOtp, { body: { email: 'new@x.com', code, deviceId: 'd1' } });
  assert.equal(res.status, 201);
  assert.equal(created.signupLocation, null, 'no headers locally, nothing on the old pending record');
  assert.equal(events[0].event, 'email_signup');
});

test('the analytics write failing (e.g. the new collection unavailable) never blocks an old account', async () => {
  AuthEvent.create = async () => { throw new Error('boom'); };
  const doc = User.hydrate({ ...structuredClone(OLD_USER), googleId: 'sub-1' });
  User.findOne = async () => doc;
  OAuth2Client.prototype.verifyIdToken = async () => ({ getPayload: () => ({ email: 'asha@x.com', email_verified: true, sub: 'sub-1' }) });
  const res = await call(googleAuth, { body: { idToken: 't', deviceId: 'd1' } });
  assert.equal(res.status, 200);
});

// --- Infinite tier data stored before v0.2 ---------------------------------------

// No lastDecay; completedCycles from v0.1; settled up to yesterday.
const OLD_MEMBER = {
  _id: 'm1', user: USER, tier: 1, score: 900, qualifyingDaysInTier: 40, scoreReachedAt: new Date(),
  stickDays: 4, window: [], missesInWindow: 0, rewardCycle: 2,
  completedCycles: [{ cycle: 1, day: '2026-08-01' }, { cycle: 2, day: '2026-08-31' }],
  enteredTierDay: '2026-07-01', enteredTierAt: new Date('2026-07-01'), lastSettledDay: addDaysKey(istDayKey(), -1),
};

test('GET /infinite/me for an old Diamond member: stars from their v0.1 cycles, lastDecay null', async () => {
  TierMembership.findOne = () => lean(OLD_MEMBER);
  TierChange.findOne = () => ({ sort: () => lean(null) });
  const res = await call(infiniteMe, { userId: USER });
  assert.equal(res.status, 200);
  assert.equal(res.body.stars, 2);
  assert.equal(res.body.lastDecay, null);
  assert.equal(res.body.hintsEnabled, false, 'the field the running app reads is still there');
});

test('a tier change logged before v0.2 reads with a consistent breakdown', async () => {
  const old = { fromTier: 5, toTier: 4, reason: 'promotion', oldScore: 1450, carriedScore: 290, day: '2026-09-17', createdAt: new Date() };
  TierChange.countDocuments = async () => 1;
  TierChange.find = () => ({ sort: () => ({ skip: () => ({ limit: () => lean([old]) }) }) });
  const res = await call(tierChanges, { userId: USER, query: {} });
  const [c] = res.body.changes;
  assert.deepEqual({ carriedPoints: c.carriedPoints, penalty: c.penalty, entryPoints: c.entryPoints }, { carriedPoints: 290, penalty: 0, entryPoints: 290 });
});

// --- the app version already installed ---------------------------------------------

test('GET /infinite/tiers keeps rewardInr (0) for the running app, so it shows the star, never a ₹ amount', async () => {
  const res = await call(tiers, {});
  for (const t of res.body.tiers) assert.equal(t.rewardInr, 0);
  assert.deepEqual(res.body.tiers[0].reward, { type: 'star' });
});

test('GET /rewards/me (still called by the running app\'s Diamond and history screens): 200, stars as zero payouts', async () => {
  TierMembership.findOne = () => lean(OLD_MEMBER);
  const res = await call(legacyRewardsMe, { userId: USER });
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.inTier1, true);
  assert.equal(res.body.day, 4);
  assert.equal(res.body.blockedReason, null);
  assert.deepEqual(res.body.payouts, [
    { cycle: 1, amountInr: 0, status: 'paid', eligibleDay: '2026-08-01', paidAt: null },
    { cycle: 2, amountInr: 0, status: 'paid', eligibleDay: '2026-08-31', paidAt: null },
  ]);
});

test('GET /rewards/me for a player with no tier yet: an empty, valid answer', async () => {
  TierMembership.findOne = () => lean(null);
  const res = await call(legacyRewardsMe, { userId: USER });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.payouts, []);
  assert.equal(res.body.inTier1, false);
});

test('old notifications of removed types are left out of the list, not returned with an unknown type', async () => {
  let filter;
  Notification.countDocuments = async (f) => { filter = filter || f; return 0; };
  Notification.find = () => ({ sort: () => ({ skip: () => ({ limit: () => lean([]) }) }) });
  await call(listNotifications, { userId: USER, query: {} });
  assert.ok(!filter.type.$in.includes('verification_needed'));
  assert.ok(filter.type.$in.includes('promotion'));
});
