// Step 2 of /sync: each write path that changes a user's data bumps the
// matching sync key(s) — and only those. Models are replaced by in-memory
// stubs, so no database is needed.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SyncState = require('../models/SyncState');
const SyncGlobal = require('../models/SyncGlobal');
const TierMembership = require('../models/TierMembership');
const InfiniteDay = require('../models/InfiniteDay');
const TierChange = require('../models/TierChange');
const Notification = require('../models/Notification');
const Payout = require('../models/Payout');
const ReviewCase = require('../models/ReviewCase');
const Game = require('../models/Game');
const User = require('../models/User');

const { DEFAULT_TIER_CONFIG } = require('../utils/tierConfig');
const { settleMembership, notify } = require('../utils/tiers');
const { verificationChanged } = require('../utils/verification');
const { markRead } = require('../controllers/notificationController');
const { updateUsername } = require('../controllers/authController');
const { submitGuess } = require('../controllers/gameController');

const USER = '507f1f77bcf86cd799439011';
const config = DEFAULT_TIER_CONFIG;

let bumps; // [[userId, key], …] in order
let globals; // global keys bumped
const keys = () => bumps.map(([, k]) => k);
const globalKeys = () => [...new Set(globals)].sort();
const lean = (v) => ({ lean: async () => (v ? structuredClone(v) : null) });

beforeEach(() => {
  bumps = [];
  SyncState.updateOne = async (filter, update) => {
    for (const path of Object.keys(update.$inc)) bumps.push([String(filter.user), path.slice(2)]);
    return {};
  };
  globals = [];
  SyncGlobal.updateOne = async (filter, update) => {
    globals.push(...Object.keys(update.$inc).map((p) => p.slice(2)));
    return {};
  };
  Notification.create = async (doc) => ({ _id: 'n1', ...doc });
});

function call(handler, { body = {}, params = {}, userId = USER } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(handler({ body, params, userId, headers: {}, socket: {} }, res)).catch(reject);
  });
}

// --- notifications ----------------------------------------------------------

test('notify() bumps notifications for that user', async () => {
  await notify(USER, 'demotion_risk', { tier: 5 });
  assert.deepEqual(bumps, [[USER, 'notifications']]);
});

test('marking notifications read bumps notifications only when something changed', async () => {
  const id = '507f1f77bcf86cd799439022';
  Notification.updateMany = async () => ({ modifiedCount: 1 });
  await call(markRead, { body: { ids: [id] } });
  assert.deepEqual(keys(), ['notifications']);

  bumps = [];
  Notification.updateMany = async () => ({ modifiedCount: 0 }); // already read
  await call(markRead, { body: { ids: [id] } });
  assert.deepEqual(keys(), []);
});

test('a rejected markRead (bad ids) bumps nothing', async () => {
  await call(markRead, { body: { ids: ['nope'] } });
  assert.deepEqual(keys(), []);
});

// --- /auth/me ---------------------------------------------------------------

test('changing the username bumps me', async () => {
  User.findByIdAndUpdate = () => ({ select: async () => ({ _id: USER, username: 'New', email: 'a@x.com', stats: {}, groups: [] }) });
  const res = await call(updateUsername, { body: { username: 'New' } });
  assert.equal(res.status, 200);
  assert.deepEqual(keys(), ['me']);
  assert.deepEqual(globalKeys(), ['daily', 'infiniteBoard', 'weekly'], 'the name shows on every board');
});

test('an invalid username bumps nothing', async () => {
  await call(updateUsername, { body: { username: 'x' } });
  assert.deepEqual(keys(), []);
});

// --- daily game -------------------------------------------------------------

function stubDailyGame(word) {
  const game = { _id: 'g1', mode: 'daily', date: '2026-09-28', word, status: 'in-progress', guesses: [], createdAt: new Date(), save: async () => {} };
  Game.findOne = async () => game;
  const user = { stats: { gamesPlayed: 0, gamesWon: 0, currentStreak: 0, maxStreak: 0, lastWinDate: null }, save: async () => {} };
  User.findById = async () => user;
  return game;
}

test('a daily guess that does not finish the game bumps today only', async () => {
  stubDailyGame('crane');
  const res = await call(submitGuess, { body: { guess: 'slate' } });
  assert.equal(res.status, 200);
  assert.deepEqual(keys(), ['today']);
  assert.deepEqual(globalKeys(), [], 'boards only list finished games');
});

test('the guess that finishes the daily game bumps today, me (stats) and the daily/weekly boards', async () => {
  stubDailyGame('crane');
  const res = await call(submitGuess, { body: { guess: 'crane' } });
  assert.equal(res.body.game.status, 'won');
  assert.deepEqual(keys().sort(), ['me', 'today']);
  assert.deepEqual(globalKeys(), ['daily', 'weekly']);
});

test('an invalid daily guess bumps nothing', async () => {
  stubDailyGame('crane');
  await call(submitGuess, { body: { guess: 'zzzzz' } });
  assert.deepEqual(keys(), []);
});

// --- verification / rewards -------------------------------------------------

test('verificationChanged() bumps rewards and infinite (Tier 1 reward block)', async () => {
  await verificationChanged(USER);
  assert.deepEqual(keys().sort(), ['infinite', 'rewards']);
});

// --- nightly settle ---------------------------------------------------------

// In-memory TierMembership for one player, plus the days they played.
function stubSettle(membership, playedDays = {}) {
  let doc = structuredClone(membership);
  TierMembership.findOneAndUpdate = (filter, update) => {
    const matches = String(filter._id) === String(doc._id)
      && filter.lastSettledDay === doc.lastSettledDay
      && (filter.score === undefined || filter.score === doc.score);
    if (matches) Object.assign(doc, update.$set);
    return lean(matches ? doc : null);
  };
  TierMembership.findById = () => lean(doc);
  TierMembership.countDocuments = async () => 0;
  InfiniteDay.find = () => ({
    select: () => lean(Object.entries(playedDays).map(([day, qualified]) => ({ day, qualified }))),
  });
  TierChange.create = async () => ({});
  Payout.updateOne = async () => ({ upsertedCount: 1 });
  return () => doc;
}

const member = (over) => ({
  _id: 'm1', user: USER, tier: 5, score: 100, stickDays: 0, window: [], missesInWindow: 0,
  rewardCycle: 0, completedCycles: [], lastSettledDay: '2026-01-01', ...over,
});

test('settle: nothing to settle bumps nothing', async () => {
  stubSettle(member());
  await settleMembership(member(), config, '2026-01-01');
  assert.deepEqual(keys(), []);
});

test('settle: an ordinary settled day bumps infinite only', async () => {
  stubSettle(member(), { '2026-01-02': true });
  await settleMembership(member(), config, '2026-01-02');
  assert.deepEqual(keys(), ['infinite']);
  assert.deepEqual(globalKeys(), [], 'plain settled days are covered by the IST date, not a bump');
});

test('settle: a demotion also bumps me (tier badge), tierChanges and notifications', async () => {
  const start = member({
    window: [{ day: '2025-12-31', qualified: false }, { day: '2026-01-01', qualified: false }],
    missesInWindow: 2,
  });
  const current = stubSettle(start); // 2026-01-02 not played → 3rd miss
  const { stats } = await settleMembership(start, config, '2026-01-02');
  assert.equal(stats.demoted, 1);
  assert.equal(current().tier, 6);
  assert.deepEqual(keys().sort(), ['infinite', 'me', 'notifications', 'tierChanges']);
  assert.ok(!keys().includes('rewards'), 'no Tier 1 involved');
  assert.deepEqual(globalKeys(), ['infiniteBoard'], 'moved between tier boards');
});

test('settle: any settled day in Tier 1 also bumps rewards (the tracker day count)', async () => {
  stubSettle(member({ tier: 1 }), { '2026-01-02': true });
  await settleMembership(member({ tier: 1 }), config, '2026-01-02');
  assert.deepEqual(keys().sort(), ['infinite', 'rewards']);
});

test('settle: promotion into Tier 1 bumps rewards', async () => {
  const start = member({ tier: 2, stickDays: config.tiers[1].daysToStick - 1 });
  stubSettle(start, { '2026-01-02': true });
  const { stats } = await settleMembership(start, config, '2026-01-02');
  assert.equal(stats.promoted, 1);
  assert.ok(keys().includes('rewards'));
  assert.ok(keys().includes('me') && keys().includes('tierChanges'));
});

test('settle: a completed Tier 1 cycle with rewards on bumps rewards and notifications', async () => {
  const start = member({ tier: 1, stickDays: config.tiers[0].daysToStick - 1 });
  stubSettle(start, { '2026-01-02': true });
  const { stats } = await settleMembership(start, { ...config, rewardsEnabled: true }, '2026-01-02');
  assert.equal(stats.payoutsCreated, 1);
  assert.deepEqual([...new Set(keys())].sort(), ['infinite', 'notifications', 'rewards']);
});

test('settle: all bumps go to the settled player', async () => {
  stubSettle(member(), { '2026-01-02': true });
  await settleMembership(member(), config, '2026-01-02');
  assert.ok(bumps.every(([u]) => u === USER));
});

// --- review cases -----------------------------------------------------------

test('opening a review case bumps rewards + infinite; an existing open case does not', async () => {
  const { claimIdentity } = require('../utils/verification');
  const IdentityClaim = require('../models/IdentityClaim');
  IdentityClaim.findOne = () => lean({ user: '507f1f77bcf86cd799439099' }); // held by someone else

  ReviewCase.updateOne = async () => ({ upsertedCount: 1 });
  assert.equal(await claimIdentity(USER, 'phone', 'h1'), false);
  assert.deepEqual(keys().sort(), ['infinite', 'rewards']);

  bumps = [];
  ReviewCase.updateOne = async () => ({ upsertedCount: 0 });
  await claimIdentity(USER, 'phone', 'h1');
  assert.deepEqual(keys(), []);
});
