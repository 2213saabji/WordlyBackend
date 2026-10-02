// Country / region saved on the account at signup only: email signup, or
// the first "Continue with Google" (which creates the account). Logins
// write nothing. Plus the per-country / per-region signup summary. Models
// and Google's token check are in-memory stubs, so no database is needed.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.CRON_SECRET = 'cron-test';

const crypto = require('crypto');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { OAuth2Client } = require('google-auth-library');

const email = require('../utils/email');
email.sendSignupVerificationEmail = async () => {};

const User = require('../models/User');
const PendingSignup = require('../models/PendingSignup');
const DeviceSession = require('../models/DeviceSession');
const { signup, verifySignupOtp, googleAuth } = require('../controllers/authController');
const { signupLocations } = require('../controllers/analyticsController');

const RAJASTHAN = { 'x-vercel-ip-country': 'IN', 'x-vercel-ip-country-region': 'RJ' };
const ONTARIO = { 'x-vercel-ip-country': 'CA', 'x-vercel-ip-country-region': 'ON' };
const TOKYO = { 'x-vercel-ip-country': 'JP', 'x-vercel-ip-country-region': '13' };
const rajasthan = { countryCode: 'IN', regionCode: 'RJ', region: 'Rajasthan', regionType: 'State' };

let users;
let pending;
let writes; // every save / update of an existing user

beforeEach(() => {
  users = [];
  pending = null;
  writes = 0;

  User.exists = async () => null;
  User.findOne = async (filter) => users.find((u) => (filter.googleId ? u.googleId === filter.googleId : u.email === filter.email)) || null;
  User.create = async (doc) => {
    const u = { _id: `u${users.length + 1}`, stats: {}, groups: [], ...doc, save: async () => { writes += 1; } };
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
  OAuth2Client.prototype.verifyIdToken = async () => ({
    getPayload: () => ({ email: 'g@x.com', email_verified: true, sub: 'sub-g', name: 'G' }),
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

const google = (headers) => call(googleAuth, { body: { idToken: 't', deviceId: 'd1' }, headers });

test('Continue with Google with no account yet = signup: the account is created with country and region', async () => {
  const res = await google(RAJASTHAN);
  assert.equal(res.status, 200);
  assert.equal(users.length, 1);
  assert.deepEqual(users[0].signupLocation, rajasthan);
  assert.deepEqual(res.body.user.signupLocation, rajasthan);
});

test('Continue with Google again (login): nothing is written, the signup location stays', async () => {
  await google(RAJASTHAN);
  const res = await google(ONTARIO);
  assert.equal(res.status, 200);
  assert.equal(users.length, 1, 'no second account');
  assert.equal(writes, 0, 'the user record is not touched on login');
  assert.deepEqual(users[0].signupLocation, rajasthan);
});

test('Continue with Google for an existing email account links it, without adding a location', async () => {
  users.push({ _id: 'u0', email: 'g@x.com', stats: {}, groups: [], signupLocation: null, save: async () => { writes += 1; } });
  await google(TOKYO);
  assert.equal(users.length, 1);
  assert.equal(users[0].googleId, 'sub-g');
  assert.equal(users[0].signupLocation, null, 'not a signup: this account already existed');
});

test('a rejected Google credential creates nothing', async () => {
  OAuth2Client.prototype.verifyIdToken = async () => { throw new Error('bad'); };
  const res = await google(RAJASTHAN);
  assert.equal(res.status, 401);
  assert.equal(users.length, 0);
});

test('email signup: the signup form request location is saved on the new account', async () => {
  const sent = await call(signup, { body: { username: 'asha', email: 'a@x.com', password: 'longenough' }, headers: RAJASTHAN });
  assert.ok(sent.status < 300, JSON.stringify(sent.body));
  assert.deepEqual(pending.signupLocation, rajasthan);

  // The emailed code is confirmed from somewhere else: the form's location wins.
  PendingSignup.findOneAndUpdate = () => ({ lean: async () => pending });
  const code = '123456';
  pending.otpHash = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`signup:a@x.com:${code}`).digest('hex');
  const done = await call(verifySignupOtp, { body: { email: 'a@x.com', code, deviceId: 'd1' }, headers: ONTARIO });
  assert.equal(done.status, 201);
  assert.deepEqual(users[0].signupLocation, rajasthan);
});

test('no geo headers (local development): the account is created with signupLocation null', async () => {
  await google({});
  assert.equal(users[0].signupLocation, null);
});

// --- summary ---------------------------------------------------------------------

test('GET /analytics/signup-locations needs CRON_SECRET', async () => {
  const res = await call(signupLocations, {});
  assert.equal(res.status, 401);
});

test('GET /analytics/signup-locations: new accounts by country, then region, from the users table', async () => {
  let pipeline;
  User.aggregate = async (p) => {
    pipeline = p;
    return [
      { _id: { countryCode: 'IN', regionCode: 'RJ' }, region: 'Rajasthan', regionType: 'State', count: 5 },
      { _id: { countryCode: 'IN', regionCode: 'MH' }, region: 'Maharashtra', regionType: 'State', count: 7 },
      { _id: { countryCode: 'CA', regionCode: 'ON' }, region: 'Ontario', regionType: 'Province', count: 2 },
      { _id: {}, region: null, regionType: null, count: 1 }, // signupLocation null
    ];
  };
  const res = await call(signupLocations, { headers: { Authorization: 'Bearer cron-test' }, query: { from: '2026-09-01', to: '2026-10-02' } });
  assert.equal(res.status, 200);
  assert.deepEqual(pipeline[0].$match.createdAt.$gte, new Date('2026-08-31T18:30:00.000Z'), 'IST day start');
  assert.deepEqual({ total: res.body.total, unknownLocation: res.body.unknownLocation }, { total: 15, unknownLocation: 1 });
  const [india, canada] = res.body.countries;
  assert.deepEqual(
    { code: india.countryCode, country: india.country, term: india.regionTerm, count: india.count },
    { code: 'IN', country: 'India', term: 'State', count: 12 }
  );
  assert.deepEqual(india.regions.map((r) => [r.region, r.count]), [['Maharashtra', 7], ['Rajasthan', 5]]);
  assert.equal(canada.regionTerm, 'Province');
});

test('GET /analytics/signup-locations rejects a reversed range', async () => {
  const res = await call(signupLocations, { headers: { Authorization: 'Bearer cron-test' }, query: { from: '2026-10-05', to: '2026-10-01' } });
  assert.equal(res.status, 400);
});
