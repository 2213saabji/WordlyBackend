// Paid hints (PRD v0.2 §2.3, with the word's clue as the hint): free in
// Tiers 7–8, 1,000 coins in Tiers 1–6, one per round, debit and reveal in
// one transaction. Models are in-memory stubs, so no database is needed.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const Game = require('../models/Game');
const InfiniteDay = require('../models/InfiniteDay');
const TierMembership = require('../models/TierMembership');
const TierConfig = require('../models/TierConfig');
const SyncState = require('../models/SyncState');
const SyncGlobal = require('../models/SyncGlobal');
const { revealInfiniteHint, getCurrentInfinite } = require('../controllers/gameController');
const { hintForWord } = require('../utils/wordHints');
const { istDayKey, addDaysKey } = require('../utils/dailyWord');
const { stubCoins } = require('./helpers/coinStubs');

const USER = '507f1f77bcf86cd799439011';
const WORD = 'crane';
const HINT = hintForWord(WORD);

let coins;
let game;

const lean = (v) => ({ lean: async () => (v == null ? null : structuredClone(v)) });

function setTier(tier) {
  const m = { _id: 'm1', user: USER, tier, score: 0, qualifyingDaysInTier: 0, scoreReachedAt: new Date(), lastSettledDay: addDaysKey(istDayKey(), -1), stickDays: 0, window: [], missesInWindow: 0 };
  TierMembership.findOne = () => lean(m);
  TierMembership.findById = () => lean(m);
}

beforeEach(() => {
  coins = stubCoins();
  TierConfig.findOne = () => ({ sort: () => lean(null) });
  TierMembership.countDocuments = async () => 0;
  InfiniteDay.findOne = () => lean(null);
  SyncState.updateOne = async () => ({});
  SyncGlobal.updateOne = async () => ({});

  game = { _id: 'g1', user: USER, mode: 'infinite', word: WORD, status: 'in-progress', guesses: [], createdAt: new Date(), hintRevealedAt: null, hintCoinsSpent: 0 };
  game.save = async () => game;
  Game.findOne = async (filter) => (game.status === filter.status ? game : null);
  Game.findById = async () => game;
  Game.updateOne = async (filter, update) => {
    const ok = game.status === (filter.status || game.status) && game.hintRevealedAt === filter.hintRevealedAt;
    if (ok) Object.assign(game, update.$set);
    return { modifiedCount: ok ? 1 : 0 };
  };
  setTier(4);
});

function call(handler, body = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(handler({ body, params: {}, query: {}, userId: USER, headers: {}, socket: {} }, res)).catch(reject);
  });
}

test('the word under test has a hint', () => {
  assert.ok(HINT, 'pick a word that has an entry in data/wordHints.js');
});

test('paid tier: the in-progress round hides the hint and shows its cost', async () => {
  const { body } = await call(getCurrentInfinite);
  assert.equal(body.game.hint, undefined);
  assert.equal(body.game.hintCost, 1000);
  assert.equal(body.game.hintsEnabled, false, 'deprecated flag: older apps keep hiding it');
  assert.equal(body.game.hintRevealed, false);
});

test('free tier (7–8): the hint is in the payload and the endpoint charges nothing', async () => {
  setTier(7);
  const current = await call(getCurrentInfinite);
  assert.equal(current.body.game.hint, HINT);
  assert.equal(current.body.game.hintCost, 0);

  const res = await call(revealInfiniteHint);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { hint: HINT, coinsSpent: 0, balance: 0, hintsUsed: 1, hintsLeft: 0 });
  assert.equal(coins.ledger.length, 0);
});

test('paid tier without expectedCost (an app from before paid hints) gets the old 403 and is charged nothing', async () => {
  coins.setBalance(USER, 5000);
  const res = await call(revealInfiniteHint);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'HINTS_DISABLED_FOR_TIER', 'the code that app already handles (shows "hints off")');
  assert.equal(res.body.hintCost, 1000);
  assert.equal(coins.balance(USER), 5000);
  assert.equal(game.hintRevealedAt, null);
});

test('paid tier with a wrong expectedCost charges nothing: 409 HINT_COST_CHANGED', async () => {
  coins.setBalance(USER, 5000);
  const res = await call(revealInfiniteHint, { expectedCost: 500 });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'HINT_COST_CHANGED');
  assert.equal(res.body.hintCost, 1000);
  assert.equal(coins.balance(USER), 5000);
});

test('paid tier: confirming debits 1,000 coins and reveals the hint', async () => {
  coins.setBalance(USER, 2340);
  const res = await call(revealInfiniteHint, { gameId: 'g1', expectedCost: 1000 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { hint: HINT, coinsSpent: 1000, balance: 1340, hintsUsed: 1, hintsLeft: 0 });
  assert.equal(coins.balance(USER), 1340);
  assert.deepEqual(coins.ledger.map((t) => [t.type, t.amount, t.idempotencyKey]), [['hint_spend', -1000, 'hint:g1']]);
  assert.ok(game.hintRevealedAt);
  assert.equal(game.hintCoinsSpent, 1000);

  const after = await call(getCurrentInfinite);
  assert.equal(after.body.game.hint, HINT, 'a bought hint stays in the payload');
  assert.equal(after.body.game.hintCoinsSpent, 1000);
});

test('asking again for a bought hint returns it at no charge', async () => {
  coins.setBalance(USER, 2340);
  await call(revealInfiniteHint, { expectedCost: 1000 });
  const again = await call(revealInfiniteHint, { expectedCost: 1000 });
  assert.equal(again.status, 200);
  assert.equal(again.body.coinsSpent, 0);
  assert.equal(coins.balance(USER), 1340);
});

test('not enough coins: 402 with balance and required, nothing changes', async () => {
  coins.setBalance(USER, 340);
  const res = await call(revealInfiniteHint, { expectedCost: 1000 });
  assert.equal(res.status, 402);
  assert.deepEqual(
    { code: res.body.code, balance: res.body.balance, required: res.body.required },
    { code: 'INSUFFICIENT_COINS', balance: 340, required: 1000 }
  );
  assert.equal(coins.balance(USER), 340);
  assert.equal(game.hintRevealedAt, null);
});

test('if the reveal fails inside the transaction, the debit is rolled back', async () => {
  coins.setBalance(USER, 2340);
  // The round ends between the read and the reveal.
  Game.updateOne = async () => ({ modifiedCount: 0 });
  Game.findById = async () => ({ ...game, status: 'won' });
  const res = await call(revealInfiniteHint, { expectedCost: 1000 });
  assert.equal(res.status, 400);
  assert.equal(coins.balance(USER), 2340);
  assert.equal(coins.ledger.length, 0);
  assert.equal(coins.aborted, 1);
});

test('a word with no hint: 409 NOTHING_TO_REVEAL and no charge', async () => {
  coins.setBalance(USER, 2340);
  game.word = 'zzzzz';
  const res = await call(revealInfiniteHint, { expectedCost: 1000 });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'NOTHING_TO_REVEAL');
  assert.equal(coins.balance(USER), 2340);
});

test('a gameId that is not the current round: 400, no charge', async () => {
  coins.setBalance(USER, 2340);
  const res = await call(revealInfiniteHint, { gameId: 'other', expectedCost: 1000 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_GAME_IN_PROGRESS');
  assert.equal(coins.balance(USER), 2340);
});

test('the hint cost is per-tier config', async () => {
  TierConfig.findOne = () => ({ sort: () => lean({ version: 99, tiers: [{ tier: 4, hintCost: 250 }] }) });
  // Bust the 60 s config cache.
  const tc = require('../utils/tierConfig');
  const realNow = Date.now;
  Date.now = () => realNow() + 120000;
  try {
    coins.setBalance(USER, 300);
    const res = await call(revealInfiniteHint, { expectedCost: 250 });
    assert.equal(res.status, 200);
    assert.equal(res.body.coinsSpent, 250);
    assert.equal((await tc.getTierConfig()).tiers[3].hintCost, 250);
  } finally {
    Date.now = realNow;
  }
});

test('hintCost null turns hints off in a tier (staged rollout): hidden, 403, no charge', async () => {
  TierConfig.findOne = () => ({ sort: () => lean({ version: 100, tiers: [{ tier: 4, hintCost: null }] }) });
  const realNow = Date.now;
  Date.now = () => realNow() + 240000; // past the cache set by the test above
  try {
    coins.setBalance(USER, 5000);
    const current = await call(getCurrentInfinite);
    assert.equal(current.body.game.hint, undefined);
    assert.equal(current.body.game.hintCost, null);
    assert.equal(current.body.game.hintsEnabled, false);
    const res = await call(revealInfiniteHint, { expectedCost: 1000 });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'HINTS_DISABLED_FOR_TIER');
    assert.equal(coins.balance(USER), 5000);
  } finally {
    Date.now = realNow;
  }
});
