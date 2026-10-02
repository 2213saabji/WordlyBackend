// Coin wallet (PRD v0.2 §2.1, §7): ledger + balance in one transaction,
// no negative balances, one credit per solved game. Models are in-memory
// stubs (test/helpers/coinStubs.js), so no database is needed.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SyncState = require('../models/SyncState');
const { DEFAULT_TIER_CONFIG: config } = require('../utils/tierConfig');
const {
  applyCoins, awardSolveCoins, runInTransaction, InsufficientCoinsError, DuplicateEntryError,
} = require('../utils/wallet');
const { stubCoins } = require('./helpers/coinStubs');

const USER = '507f1f77bcf86cd799439011';
let coins;

beforeEach(() => {
  coins = stubCoins();
  SyncState.updateOne = async () => ({});
});

const won = (id, over = {}) => ({ _id: id, user: USER, mode: 'infinite', status: 'won', tierAtCompletion: 4, ...over });

test('a solved word earns 10 coins, recorded in the ledger with the new balance', async () => {
  const result = await awardSolveCoins(won('g1'), config);
  assert.deepEqual(result, { awarded: 10, balance: 10 });
  assert.equal(coins.ledger.length, 1);
  assert.deepEqual(
    { type: coins.ledger[0].type, amount: coins.ledger[0].amount, balanceAfter: coins.ledger[0].balanceAfter, ref: coins.ledger[0].ref },
    { type: 'earn_solve', amount: 10, balanceAfter: 10, ref: { gameId: 'g1', mode: 'infinite', tier: 4 } }
  );
});

test('the same game is credited once, however often it is called', async () => {
  await awardSolveCoins(won('g1'), config);
  const again = await awardSolveCoins(won('g1'), config);
  assert.deepEqual(again, { awarded: 0, balance: 10 });
  assert.equal(coins.balance(USER), 10);
  assert.equal(coins.ledger.length, 1);
});

test('Daily solves earn coins too', async () => {
  const result = await awardSolveCoins(won('d1', { mode: 'daily', tierAtCompletion: undefined }), config);
  assert.equal(result.awarded, 10);
  assert.equal(coins.ledger[0].ref.mode, 'daily');
});

test('a loss or an abandoned game earns nothing', async () => {
  assert.deepEqual(await awardSolveCoins(won('g2', { status: 'lost' }), config), { awarded: 0, balance: 0 });
  assert.deepEqual(await awardSolveCoins(won('g3', { status: 'abandoned' }), config), { awarded: 0, balance: 0 });
  assert.equal(coins.ledger.length, 0);
});

test('the solve reward is config', async () => {
  const result = await awardSolveCoins(won('g4'), { ...config, coins: { ...config.coins, solveReward: 25 } });
  assert.equal(result.awarded, 25);
});

test('a debit larger than the balance is refused and changes nothing', async () => {
  coins.setBalance(USER, 340);
  await assert.rejects(
    runInTransaction((session) => applyCoins({ userId: USER, type: 'hint_spend', amount: -1000, idempotencyKey: 'hint:x', session })),
    (err) => err instanceof InsufficientCoinsError && err.balance === 340 && err.required === 1000
  );
  assert.equal(coins.balance(USER), 340);
  assert.equal(coins.ledger.length, 0);
});

test('a debit with no wallet at all is refused (balance 0)', async () => {
  await assert.rejects(
    runInTransaction((session) => applyCoins({ userId: USER, type: 'hint_spend', amount: -1000, idempotencyKey: 'hint:y', session })),
    (err) => err instanceof InsufficientCoinsError && err.balance === 0
  );
});

test('a reused idempotency key rolls the balance change back', async () => {
  await runInTransaction((session) => applyCoins({ userId: USER, type: 'adjustment', amount: 50, idempotencyKey: 'k1', session }));
  await assert.rejects(
    runInTransaction((session) => applyCoins({ userId: USER, type: 'adjustment', amount: 50, idempotencyKey: 'k1', session })),
    DuplicateEntryError
  );
  assert.equal(coins.balance(USER), 50, 'the second +50 was rolled back');
  assert.equal(coins.ledger.length, 1);
});

test('the balance always equals the sum of the ledger', async () => {
  await awardSolveCoins(won('a'), config);
  await awardSolveCoins(won('b'), config);
  await runInTransaction((session) => applyCoins({ userId: USER, type: 'purchase', amount: 3000, idempotencyKey: 'purchase:GW-1', session }));
  await runInTransaction((session) => applyCoins({ userId: USER, type: 'hint_spend', amount: -1000, idempotencyKey: 'hint:c', session }));
  assert.equal(coins.balance(USER), coins.ledger.reduce((sum, t) => sum + t.amount, 0));
  assert.equal(coins.balance(USER), 2020);
  assert.equal(coins.ledger.at(-1).balanceAfter, 2020);
});
