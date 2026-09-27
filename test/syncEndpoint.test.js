// Step 5 of /sync: GET /api/sync end to end over HTTP, through requireAuth,
// with real routes making the changes (rename, joining a group, scoring an
// Infinite round). Models are in-memory stubs and Date is mocked, so no
// database is needed and throttle / max-age windows can be stepped through.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const SyncState = require('../models/SyncState');
const SyncGlobal = require('../models/SyncGlobal');
const TierConfig = require('../models/TierConfig');
const User = require('../models/User');
const Group = require('../models/Group');
const Game = require('../models/Game');
const InfiniteDay = require('../models/InfiniteDay');
const TierMembership = require('../models/TierMembership');
const { resetGlobalCache, SYNC_KEYS, MAX_AGE_MS } = require('../utils/sync');
const { DEFAULT_TIER_CONFIG } = require('../utils/tierConfig');
const { scoreFinishedGame } = require('../utils/tiers');

const ME = '507f1f77bcf86cd7994390a1';
const OTHER = '507f1f77bcf86cd7994390b2';
const KEYS = Object.keys(SYNC_KEYS);
const T0 = new Date('2026-09-28T10:00:00.000Z').getTime(); // mid-day in both UTC and IST

let server;
let baseUrl;

// --- in-memory store ----------------------------------------------------------

let userDocs; // userId -> { v }
let globalDoc;
let group;

function inc(doc, update) {
  for (const [p, n] of Object.entries(update.$inc)) doc.v[p.slice(2)] = (doc.v[p.slice(2)] || 0) + n;
}
const userDoc = (id) => userDocs.get(String(id)) || userDocs.set(String(id), { v: {} }).get(String(id));
const lean = (v) => ({ lean: async () => (v == null ? null : structuredClone(v)) });

function stubModels() {
  userDocs = new Map();
  globalDoc = { v: {} };
  group = { _id: 'g1', name: 'Friends', inviteCode: 'ABCD1234', owner: OTHER, members: [OTHER] };
  group.save = async () => group;

  SyncState.findOne = ({ user }) => ({ select: () => lean(userDocs.get(String(user)) || null) });
  SyncState.updateOne = async ({ user }, update) => { inc(userDoc(user), update); return {}; };
  SyncState.bulkWrite = async (ops) => { for (const { updateOne: o } of ops) inc(userDoc(o.filter.user), o.update); return {}; };
  SyncGlobal.findById = () => ({ select: () => lean(globalDoc) });
  SyncGlobal.updateOne = async (f, update) => { inc(globalDoc, update); return {}; };
  TierConfig.findOne = () => ({ sort: () => lean(null) }); // defaults

  User.findByIdAndUpdate = (id, update) => {
    const result = { _id: id, username: update.username || 'Me', email: 'me@x.com', stats: {}, groups: [] };
    // updateUsername chains .select(); groupController awaits it directly.
    return Object.assign(Promise.resolve(result), { select: async () => result });
  };
  Group.findOne = async ({ inviteCode }) => (inviteCode === group.inviteCode ? group : null);
  Group.findById = async (id) => (id === group._id ? group : null);
}

// --- server + clock -------------------------------------------------------------

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', require('../routes/syncRoutes'));
  app.use('/api/auth', require('../routes/authRoutes'));
  app.use('/api/groups', require('../routes/groupRoutes'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: T0 });
  resetGlobalCache();
  stubModels();
});

const advance = (ms) => mock.timers.tick(ms);
const bearer = (userId) => ({ Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET)}` });

async function sync(since, userId = ME) {
  const url = since === undefined ? `${baseUrl}/api/sync` : `${baseUrl}/api/sync?since=${encodeURIComponent(since)}`;
  const res = await fetch(url, { headers: bearer(userId) });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function send(method, path, body, userId = ME) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...bearer(userId), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const trueKeys = (changed) => KEYS.filter((k) => changed[k]).sort();

// --- the endpoint -----------------------------------------------------------------

test('401 without a login token', async () => {
  const res = await fetch(`${baseUrl}/api/sync`);
  assert.equal(res.status, 401);
});

test('first sync: every API true, a token, and never cached', async () => {
  const { status, headers, body } = await sync();
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.changed).sort(), [...KEYS].sort());
  assert.deepEqual(trueKeys(body.changed), [...KEYS].sort());
  assert.match(body.syncToken, /^[A-Za-z0-9_-]+$/);
  assert.equal(headers.get('cache-control'), 'no-store');
});

test('syncing again with the token: nothing changed, every API false', async () => {
  const first = await sync();
  advance(5000);
  const { body } = await sync(first.body.syncToken);
  assert.deepEqual(trueKeys(body.changed), []);
});

test('a broken token is treated as a first sync, not an error', async () => {
  const { status, body } = await sync('garbage-token');
  assert.equal(status, 200);
  assert.deepEqual(trueKeys(body.changed), [...KEYS].sort());
});

test('renaming: me is true at once; the boards follow once the minute is up', async () => {
  const first = await sync();
  advance(5000);
  assert.equal((await send('PATCH', '/api/auth/username', { username: 'Guri' })).status, 200);

  const soon = await sync(first.body.syncToken);
  assert.deepEqual(trueKeys(soon.body.changed), ['me'], 'leaderboards held back inside 60 s');

  advance(60_000);
  const later = await sync(soon.body.syncToken);
  assert.deepEqual(trueKeys(later.body.changed), ['daily', 'infiniteBoard', 'weekly']);
});

test("another player joining my group flips my mine, not my me", async () => {
  group.members = [OTHER, ME];
  const first = await sync();
  advance(5000);
  // OTHER can't join twice, so a third user joins.
  const THIRD = '507f1f77bcf86cd7994390c3';
  assert.equal((await send('POST', '/api/groups/join/ABCD1234', null, THIRD)).status, 200);

  const { body } = await sync(first.body.syncToken);
  assert.deepEqual(trueKeys(body.changed), ['mine']);
});

test('scoring an Infinite round flips infinite now and the tier board after the minute', async () => {
  const first = await sync();
  advance(5000);

  // Minimal stubs for scoreFinishedGame(): an existing Tier 5 member.
  const membership = { _id: 'm1', user: ME, tier: 5, score: 100, qualifyingDaysInTier: 0, scoreReachedAt: new Date(T0), lastSettledDay: '2026-09-27' };
  TierMembership.findOne = () => lean(membership);
  TierMembership.updateOne = async () => ({});
  TierMembership.findById = () => lean(membership);
  TierMembership.countDocuments = async () => 0;
  Game.updateOne = async () => ({ modifiedCount: 1 });
  InfiniteDay.findOneAndUpdate = () => lean({ _id: 'd1', user: ME, day: '2026-09-28', tier: 5, activeMs: 0, gamesCompleted: 1, targetMinutes: 20, targetGames: 7, qualified: false });
  const game = { _id: 'x1', user: ME, status: 'won', guesses: [{}, {}, {}], completedAt: new Date() };
  await scoreFinishedGame(game, { config: DEFAULT_TIER_CONFIG, maxAttempts: 6 });

  const soon = await sync(first.body.syncToken);
  assert.deepEqual(trueKeys(soon.body.changed), ['infinite']);
  advance(60_000);
  const later = await sync(soon.body.syncToken);
  assert.deepEqual(trueKeys(later.body.changed), ['infiniteBoard']);
});

test("one user's changes never flip another user's per-user flags", async () => {
  const mine = await sync(undefined, ME);
  advance(5000);
  await send('PATCH', '/api/auth/username', { username: 'Other' }, OTHER);
  const { body } = await sync(mine.body.syncToken, ME);
  assert.equal(body.changed.me, false);
});

test('safety net: after 15 minutes without a refetch, everything is true', async () => {
  const first = await sync();
  advance(MAX_AGE_MS);
  const { body } = await sync(first.body.syncToken);
  assert.deepEqual(trueKeys(body.changed), [...KEYS].sort());
});

test('the leaderboard cache (15 s) is per process and does not hide a change past the minute', async () => {
  const first = await sync();
  // Another server instance bumps the board: this process's cache doesn't know.
  globalDoc.v.daily = 5;
  advance(10_000);
  assert.equal((await sync(first.body.syncToken)).body.changed.daily, false, 'cached and throttled');
  advance(60_000);
  assert.equal((await sync(first.body.syncToken)).body.changed.daily, true, 'cache expired, throttle passed');
});
