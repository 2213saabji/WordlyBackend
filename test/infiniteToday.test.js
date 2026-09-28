// `today` (the progress card, same shape as GET /infinite/me's) on every
// Infinite response: each guess, /game/infinite/current and /new. Models are
// in-memory stubs and Date is mocked, so no database is needed.
const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const Game = require('../models/Game');
const InfiniteDay = require('../models/InfiniteDay');
const TierMembership = require('../models/TierMembership');
const TierConfig = require('../models/TierConfig');
const SyncState = require('../models/SyncState');
const SyncGlobal = require('../models/SyncGlobal');
const { submitInfiniteGuess, getCurrentInfinite, newInfiniteGame } = require('../controllers/gameController');

const USER = '507f1f77bcf86cd799439011';
const T0 = new Date('2026-09-28T06:00:00.000Z').getTime(); // 11:30 IST
const DAY = '2026-09-28';
const TODAY_FIELDS = ['activeMinutes', 'completionRatio', 'day', 'gamesCompleted', 'qualified', 'resetsAt', 'targetGames', 'targetMinutes'];

let days; // day -> doc
let games; // in-memory Game docs
let reads; // InfiniteDay.findOne calls

const lean = (v) => ({ lean: async () => (v == null ? null : structuredClone(v)) });
const sameAnchor = (a, b) => (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());

function gameDoc(fields) {
  const g = { _id: `g${games.length + 1}`, user: USER, mode: 'infinite', status: 'in-progress', guesses: [], createdAt: new Date(), ...fields };
  g.save = async () => g;
  games.push(g);
  return g;
}

beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: T0 });
  days = new Map();
  games = [];
  reads = 0;

  TierConfig.findOne = () => ({ sort: () => lean(null) });
  // A Tier 5 member already settled up to yesterday: no settle work.
  const membership = { _id: 'm1', user: USER, tier: 5, score: 50, qualifyingDaysInTier: 0, scoreReachedAt: new Date(T0), lastSettledDay: '2026-09-27', stickDays: 0, window: [], missesInWindow: 0 };
  TierMembership.findOne = () => lean(membership);
  TierMembership.findById = () => lean(membership);
  TierMembership.updateOne = async () => ({});
  TierMembership.countDocuments = async () => 0;

  InfiniteDay.findOneAndUpdate = (filter, update, opts = {}) => {
    let doc;
    if ('lastHeartbeatAt' in filter) {
      doc = [...days.values()].find((d) => d._id === filter._id);
      if (!doc || !sameAnchor(doc.lastHeartbeatAt, filter.lastHeartbeatAt)) return lean(null);
    } else if (filter._id) {
      doc = [...days.values()].find((d) => d._id === filter._id);
    } else {
      doc = days.get(filter.day);
      if (!doc && opts.upsert) {
        doc = { _id: `d-${filter.day}`, user: USER, day: filter.day, activeMs: 0, gamesCompleted: 0, gamesWon: 0, pointsEarned: 0, qualified: false, lastHeartbeatAt: null, ...update.$setOnInsert };
        days.set(filter.day, doc);
      }
    }
    for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v;
    Object.assign(doc, update.$set || {});
    return lean(doc);
  };
  InfiniteDay.findOne = ({ day }) => { reads += 1; return lean(days.get(day) || null); };
  InfiniteDay.findById = (id) => lean([...days.values()].find((d) => d._id === id));
  InfiniteDay.updateOne = async () => ({ modifiedCount: 0 });

  Game.findOne = async (filter) => games.find((g) => g.status === filter.status && g.mode === filter.mode) || null;
  Game.find = async (filter) => games.filter((g) => g.status === filter.status && g.mode === filter.mode);
  Game.countDocuments = async () => games.length;
  Game.create = async (fields) => gameDoc({ ...fields, word: 'crane' });
  Game.updateOne = async () => ({ modifiedCount: 1 });

  SyncState.updateOne = async () => ({});
  SyncGlobal.updateOne = async () => ({});
});

function call(handler, body = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(handler({ body, userId: USER, headers: {}, socket: {} }, res)).catch(reject);
  });
}

const advance = (ms) => mock.timers.tick(ms);

test('/current with nothing played today: today has the zero card', async () => {
  gameDoc({ word: 'crane' }); // an existing round, created yesterday-ish
  const { body } = await call(getCurrentInfinite);
  assert.deepEqual(Object.keys(body.today).sort(), TODAY_FIELDS);
  assert.equal(body.today.day, DAY);
  assert.equal(body.today.activeMinutes, 0);
  assert.equal(body.today.gamesCompleted, 0);
});

test('/current returning an existing round adds no time, and reads today once', async () => {
  gameDoc({ word: 'crane' });
  days.set(DAY, { _id: `d-${DAY}`, user: USER, day: DAY, activeMs: 5 * 60_000, gamesCompleted: 2, targetMinutes: 20, targetGames: 7, qualified: false, lastHeartbeatAt: new Date(T0 - 60_000) });
  const { body } = await call(getCurrentInfinite);
  assert.equal(body.today.activeMinutes, 5);
  assert.equal(body.today.gamesCompleted, 2);
  assert.equal(days.get(DAY).activeMs, 5 * 60_000, 'a page load credits nothing');
  assert.equal(reads, 1);
});

test('/current creating a round returns today without an extra read', async () => {
  const { body } = await call(getCurrentInfinite);
  assert.equal(body.game.status, 'in-progress');
  assert.equal(body.today.day, DAY);
  assert.equal(reads, 0, 'uses the day document the round-start credit returned');
});

test('a mid-round guess returns today, with the active time credited so far', async () => {
  await call(getCurrentInfinite); // round start: anchor at T0
  advance(90_000);
  const { body } = await call(submitInfiniteGuess, { guess: 'slate' });
  assert.equal(body.game.status, 'in-progress');
  assert.equal(body.tier, undefined, 'tier block only when the round ends');
  assert.deepEqual(Object.keys(body.today).sort(), TODAY_FIELDS);
  assert.equal(body.today.activeMinutes, 1);
  assert.equal(body.today.gamesCompleted, 0);
  assert.equal(reads, 0, 'no extra read: the credit returned the day document');
});

test('active time updates guess by guess', async () => {
  await call(getCurrentInfinite);
  const minutes = [];
  for (const guess of ['slate', 'audio', 'pound']) {
    advance(45_000);
    minutes.push((await call(submitInfiniteGuess, { guess })).body.today.activeMinutes);
  }
  assert.deepEqual(minutes, [0, 1, 2]); // 45 s, 1:30, 2:15
});

test('the guess that ends the round returns today, the same card as tier.today', async () => {
  await call(getCurrentInfinite);
  advance(30_000);
  const { body } = await call(submitInfiniteGuess, { guess: 'crane' });
  assert.equal(body.game.status, 'won');
  assert.ok(body.tier, 'tier block present');
  assert.deepEqual(body.today, body.tier.today);
  assert.equal(body.today.gamesCompleted, 1);
});

test('a round-ending guess scored by a concurrent request still returns today', async () => {
  await call(getCurrentInfinite);
  Game.updateOne = async () => ({ modifiedCount: 0 }); // the other request scored it
  advance(30_000);
  const { body } = await call(submitInfiniteGuess, { guess: 'crane' });
  assert.equal(body.tier, undefined);
  assert.equal(body.today.day, DAY);
});

test('/new (skip) still returns today, from the new round credit', async () => {
  await call(getCurrentInfinite);
  advance(20_000);
  const { status, body } = await call(newInfiniteGame);
  assert.equal(status, 201);
  assert.deepEqual(Object.keys(body.today).sort(), TODAY_FIELDS);
  assert.equal(reads, 0);
});

test('an invalid guess returns only the error (unchanged)', async () => {
  await call(getCurrentInfinite);
  const { status, body } = await call(submitInfiniteGuess, { guess: 'zzzzz' });
  assert.equal(status, 400);
  assert.equal(body.today, undefined);
});
