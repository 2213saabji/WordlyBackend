// Location recorded on email signup and on every "Continue with Google",
// and the per-country / per-region summary. Models and Google's token check
// are in-memory stubs, so no database or network is needed.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.CRON_SECRET = 'cron-test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { OAuth2Client } = require('google-auth-library');

const email = require('../utils/email');
email.sendSignupVerificationEmail = async () => {};

const User = require('../models/User');
const PendingSignup = require('../models/PendingSignup');
const DeviceSession = require('../models/DeviceSession');
const AuthEvent = require('../models/AuthEvent');
const { signup, verifySignupOtp, googleAuth } = require('../controllers/authController');
const { authLocations } = require('../controllers/analyticsController');

const RAJASTHAN = { 'x-vercel-ip-country': 'IN', 'x-vercel-ip-country-region': 'RJ' };
const ONTARIO = { 'x-vercel-ip-country': 'CA', 'x-vercel-ip-country-region': 'ON' };
const TOKYO = { 'x-vercel-ip-country': 'JP', 'x-vercel-ip-country-region': '13' };

let users;
let pending;
let events;
let googleEmail;

beforeEach(() => {
  users = [];
  pending = null;
  events = [];
  googleEmail = 'g@x.com';

  User.exists = async () => null;
  User.findOne = async (filter) => users.find((u) => (filter.googleId ? u.googleId === filter.googleId : u.email === filter.email)) || null;
  User.create = async (doc) => {
    const u = { _id: `u${users.length + 1}`, stats: {}, groups: [], ...doc, save: async () => {} };
    users.push(u);
    return u;
  };
  DeviceSession.findOneAndUpdate = async () => ({});
  PendingSignup.findOne = () => ({ select: () => ({ lean: async () => null }) });
  PendingSignup.findOneAndUpdate = async (filter, update) => {
    pending = { _id: 'p1', email: filter.email, otpAttempts: 0, ...update.$set };
    return pending;
  };
  PendingSignup.findOneAndDelete = async () => { const p = pending; pending = null; return p; };
  AuthEvent.create = async (doc) => { events.push(doc); return doc; };
  OAuth2Client.prototype.verifyIdToken = async () => ({
    getPayload: () => ({ email: googleEmail, email_verified: true, sub: `sub-${googleEmail}`, name: 'G' }),
  });
});

function call(handler, { body = {}, headers = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    Promise.resolve(handler({ body, headers: lower, query, params: {}, get: (h) => lower[h.toLowerCase()] }, res)).catch(reject);
  });
}

const rajasthan = { countryCode: 'IN', regionCode: 'RJ', region: 'Rajasthan', regionType: 'State' };

test('Continue with Google (new account): saves the signup location and records the event', async () => {
  const res = await call(googleAuth, { body: { idToken: 't', deviceId: 'd1' }, headers: RAJASTHAN });
  assert.equal(res.status, 200);
  assert.deepEqual(users[0].signupLocation, rajasthan);
  assert.deepEqual(res.body.user.signupLocation, rajasthan);
  assert.deepEqual(events, [{ event: 'google_continue', user: 'u1', newAccount: true, ...rajasthan }]);
});

test('Continue with Google again (returning): +1 event, signup location unchanged', async () => {
  await call(googleAuth, { body: { idToken: 't', deviceId: 'd1' }, headers: RAJASTHAN });
  await call(googleAuth, { body: { idToken: 't', deviceId: 'd2' }, headers: ONTARIO });
  assert.equal(users.length, 1);
  assert.equal(users[0].signupLocation.region, 'Rajasthan', 'where the account was created');
  assert.deepEqual(events.map((e) => [e.newAccount, e.countryCode, e.region]), [[true, 'IN', 'Rajasthan'], [false, 'CA', 'Ontario']]);
});

test('Google linking an existing email account is not a new account', async () => {
  users.push({ _id: 'u0', email: 'g@x.com', stats: {}, groups: [], save: async () => {} });
  await call(googleAuth, { body: { idToken: 't', deviceId: 'd1' }, headers: TOKYO });
  assert.equal(users.length, 1);
  assert.equal(events[0].newAccount, false);
  assert.equal(events[0].region, 'Tokyo');
});

test('a rejected Google credential records nothing', async () => {
  OAuth2Client.prototype.verifyIdToken = async () => { throw new Error('bad'); };
  const res = await call(googleAuth, { body: { idToken: 't', deviceId: 'd1' }, headers: RAJASTHAN });
  assert.equal(res.status, 401);
  assert.deepEqual(events, []);
});

test('email signup: the form request location is stored and copied to the account', async () => {
  const sent = await call(signup, { body: { username: 'asha', email: 'a@x.com', password: 'longenough' }, headers: RAJASTHAN });
  assert.ok(sent.status < 300, JSON.stringify(sent.body));
  assert.deepEqual(pending.signupLocation, rajasthan);

  // The code is confirmed from somewhere else: the form's location wins.
  PendingSignup.findOneAndUpdate = () => ({ lean: async () => pending });
  const crypto = require('crypto');
  const code = '123456';
  pending.otpHash = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`signup:a@x.com:${code}`).digest('hex');
  const done = await call(verifySignupOtp, { body: { email: 'a@x.com', code, deviceId: 'd1' }, headers: ONTARIO });
  assert.equal(done.status, 201);
  assert.deepEqual(users[0].signupLocation, rajasthan);
  assert.deepEqual(events, [{ event: 'email_signup', user: 'u1', newAccount: true, ...rajasthan }]);
});

test('no geo headers: the account is created with signupLocation null and the event has no country', async () => {
  await call(googleAuth, { body: { idToken: 't', deviceId: 'd1' } });
  assert.equal(users[0].signupLocation, null);
  assert.equal(events[0].countryCode, undefined);
});

test('a failure recording the event never fails the sign-in', async () => {
  AuthEvent.create = async () => { throw new Error('db down'); };
  const res = await call(googleAuth, { body: { idToken: 't', deviceId: 'd1' }, headers: RAJASTHAN });
  assert.equal(res.status, 200);
});

// --- summary ---------------------------------------------------------------------

test('GET /analytics/auth-locations needs CRON_SECRET', async () => {
  const res = await call(authLocations, {});
  assert.equal(res.status, 401);
});

test('GET /analytics/auth-locations: counts by country, then region', async () => {
  let match;
  AuthEvent.aggregate = async (pipeline) => {
    match = pipeline[0].$match;
    return [
      { _id: { countryCode: 'IN', regionCode: 'RJ' }, region: 'Rajasthan', regionType: 'State', count: 5, newAccounts: 3 },
      { _id: { countryCode: 'IN', regionCode: 'MH' }, region: 'Maharashtra', regionType: 'State', count: 7, newAccounts: 7 },
      { _id: { countryCode: 'CA', regionCode: 'ON' }, region: 'Ontario', regionType: 'Province', count: 2, newAccounts: 1 },
      { _id: { countryCode: null, regionCode: null }, region: null, regionType: null, count: 1, newAccounts: 1 },
    ];
  };
  const res = await call(authLocations, {
    headers: { Authorization: 'Bearer cron-test' },
    query: { from: '2026-09-01', to: '2026-10-02', event: 'google_continue' },
  });
  assert.equal(res.status, 200);
  assert.equal(match.event, 'google_continue');
  assert.deepEqual(match.createdAt.$gte, new Date('2026-08-31T18:30:00.000Z'), 'IST day start');
  assert.deepEqual(
    { total: res.body.total, newAccounts: res.body.newAccounts, unknownLocation: res.body.unknownLocation },
    { total: 15, newAccounts: 12, unknownLocation: 1 }
  );
  const [india, canada] = res.body.countries;
  assert.deepEqual(
    { code: india.countryCode, country: india.country, term: india.regionTerm, count: india.count },
    { code: 'IN', country: 'India', term: 'State', count: 12 }
  );
  assert.deepEqual(india.regions.map((r) => [r.region, r.count]), [['Maharashtra', 7], ['Rajasthan', 5]]);
  assert.equal(canada.regionTerm, 'Province');
});

test('GET /analytics/auth-locations rejects a bad event or range', async () => {
  const auth = { Authorization: 'Bearer cron-test' };
  assert.equal((await call(authLocations, { headers: auth, query: { event: 'nope' } })).status, 400);
  assert.equal((await call(authLocations, { headers: auth, query: { from: '2026-10-05', to: '2026-10-01' } })).status, 400);
});
