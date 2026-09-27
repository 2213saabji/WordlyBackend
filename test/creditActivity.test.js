// creditActivity() with source 'game' (round start / guess) and the legacy
// 'heartbeat' path. The Mongo models are replaced by a small in-memory
// store, so these run without a database: `npm test`.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const InfiniteDay = require('../models/InfiniteDay');
const TierMembership = require('../models/TierMembership');
const Game = require('../models/Game');
const { DEFAULT_TIER_CONFIG: config } = require('../utils/tierConfig');
const { creditActivity } = require('../utils/tiers');

const USER = 'u1';
const TIER = 1; // targets of 60 min / 20 games, so no day qualifies mid-test
const CAP = config.activity.maxGameActionGapMs;
const T0 = new Date('2026-09-28T06:00:00.000Z'); // 11:30 IST

let days; // _id -> day doc
let nextId;
let recentPlay; // what Game.findOne returns for hasRecentPlay()

const lean = (v) => ({ lean: async () => (v ? { ...v } : null) });
const sameAnchor = (a, b) => (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  days = new Map();
  nextId = 1;
  recentPlay = null;

  InfiniteDay.findOneAndUpdate = (filter, update, opts = {}) => {
    let doc;
    if ('lastHeartbeatAt' in filter) {
      // The conditional credit: only matches if the anchor is unchanged.
      doc = days.get(filter._id);
      if (!doc || !sameAnchor(doc.lastHeartbeatAt, filter.lastHeartbeatAt)) return lean(null);
    } else {
      doc = [...days.values()].find((d) => d.user === filter.user && d.day === filter.day);
      if (!doc && opts.upsert) {
        doc = { _id: nextId++, user: filter.user, day: filter.day, activeMs: 0, gamesCompleted: 0, qualified: false, lastHeartbeatAt: null, ...update.$setOnInsert };
        days.set(doc._id, doc);
      }
    }
    for (const [k, v] of Object.entries(update.$inc || {})) doc[k] += v;
    Object.assign(doc, update.$set || {});
    // Snapshot now, resolve on a later tick like a real round trip, so
    // concurrent calls interleave and each sees the state at query time.
    const snapshot = { ...doc };
    return { lean: () => tick().then(() => snapshot) };
  };
  InfiniteDay.findById = (id) => lean(days.get(id));
  InfiniteDay.updateOne = async () => ({ modifiedCount: 0 });
  TierMembership.updateOne = async () => ({});
  Game.findOne = () => ({ sort: () => ({ select: () => lean(recentPlay) }) });
});

const at = (ms) => new Date(T0.getTime() + ms);
const game = (now) => creditActivity({ userId: USER, tier: TIER, config, source: 'game', now });
const beat = (now, extra = {}) =>
  creditActivity({ userId: USER, tier: TIER, config, visible: true, lastInputAgoMs: 1000, now, ...extra });
const activeMs = () => [...days.values()][0].activeMs;

test('first action of the day credits 0 and sets the anchor', async () => {
  const { creditedMs, dayDoc } = await game(T0);
  assert.equal(creditedMs, 0);
  assert.equal(new Date(dayDoc.lastHeartbeatAt).getTime(), T0.getTime());
});

test('a small gap is credited in full, even 3 s (no heartbeat rate limit)', async () => {
  await game(T0);
  const { creditedMs } = await game(at(3000));
  assert.equal(creditedMs, 3000);
});

test('a gap above the cap is capped', async () => {
  await game(T0);
  const { creditedMs } = await game(at(5 * 60 * 1000));
  assert.equal(creditedMs, CAP);
});

test('a gap exactly at the cap is credited in full', async () => {
  await game(T0);
  const { creditedMs } = await game(at(CAP));
  assert.equal(creditedMs, CAP);
});

test('game actions skip hasRecentPlay and the client-reported input checks', async () => {
  recentPlay = null; // would make a heartbeat ineligible
  await game(T0);
  const { creditedMs } = await game(at(20000));
  assert.equal(creditedMs, 20000);
});

test('a round of guesses under the cap adds up to the real elapsed time', async () => {
  const actions = [0, 8000, 21000, 55000, 110000, 150000]; // round start, then 5 guesses
  for (const ms of actions) await game(at(ms));
  assert.equal(activeMs(), 150000);
});

test('a long pause mid-round is capped, the rest still counts', async () => {
  for (const ms of [0, 10000, 10000 + 60 * 60 * 1000, 10000 + 60 * 60 * 1000 + 5000]) await game(at(ms));
  assert.equal(activeMs(), 10000 + CAP + 5000);
});

test('next round started 40 s after the last guess credits 40 s', async () => {
  await game(T0); // last guess of the previous round
  const { creditedMs } = await game(at(40000)); // new round start
  assert.equal(creditedMs, 40000);
});

test('the first action on a new IST day starts a fresh day at 0', async () => {
  await game(T0);
  const nextDay = new Date('2026-09-29T03:00:00.000Z'); // 08:30 IST next day
  const { creditedMs, dayDoc } = await game(nextDay);
  assert.equal(creditedMs, 0);
  assert.equal(dayDoc.day, '2026-09-29');
  assert.equal(days.size, 2);
});

test('two tabs acting at once: the overlap is credited only once', async () => {
  await game(T0);
  // Both read the same anchor (T0) before either writes. Without the
  // conditional update this would credit 30 s + 31 s = 61 s.
  const [a, b] = await Promise.all([game(at(30000)), game(at(31000))]);
  assert.deepEqual([a.creditedMs, b.creditedMs].sort((x, y) => x - y), [0, 30000]);
  assert.equal(activeMs(), 30000);
});

test('old client heartbeats alongside guesses do not double-count', async () => {
  recentPlay = { status: 'in-progress', createdAt: T0, guesses: [{ createdAt: T0 }] };
  await game(T0); // round start
  await beat(at(15000)); // +15 s
  await game(at(20000)); // guess, +5 s
  await beat(at(35000)); // +15 s
  await game(at(50000)); // guess, +15 s
  assert.equal(activeMs(), 50000); // exactly the elapsed time
});

// --- heartbeat path unchanged ---

test('heartbeat: a gap within maxHeartbeatGapMs is credited', async () => {
  recentPlay = { status: 'in-progress', createdAt: T0, guesses: [{ createdAt: T0 }] };
  await beat(T0);
  const { creditedMs } = await beat(at(15000));
  assert.equal(creditedMs, 15000);
});

test('heartbeat: a gap over maxHeartbeatGapMs earns 0 (cutoff, not cap)', async () => {
  recentPlay = { status: 'in-progress', createdAt: T0, guesses: [{ createdAt: T0 }] };
  await beat(T0);
  const { creditedMs } = await beat(at(config.activity.maxHeartbeatGapMs + 1000));
  assert.equal(creditedMs, 0);
});

test('heartbeat: beats closer than heartbeatMinIntervalMs earn 0 and keep the anchor', async () => {
  recentPlay = { status: 'in-progress', createdAt: T0, guesses: [{ createdAt: T0 }] };
  await beat(T0);
  assert.equal((await beat(at(3000))).creditedMs, 0);
  assert.equal((await beat(at(15000))).creditedMs, 15000);
});

test('heartbeat: no recent play, hidden tab or idle input earns 0', async () => {
  await beat(T0);
  assert.equal((await beat(at(15000))).creditedMs, 0); // no recent play
  recentPlay = { status: 'in-progress', createdAt: T0, guesses: [{ createdAt: at(15000) }] };
  assert.equal((await beat(at(30000), { visible: false })).creditedMs, 0);
  assert.equal((await beat(at(45000), { lastInputAgoMs: config.activity.idleInputMs + 1 })).creditedMs, 0);
});
