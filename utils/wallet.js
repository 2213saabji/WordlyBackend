// Coin wallet: every balance change is a ledger entry (CoinTransaction)
// written in the same MongoDB transaction as the Wallet balance, so the
// balance is always the sum of the ledger. Amounts are decided here and in
// the callers on the server — the client never sends one.

const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const CoinTransaction = require('../models/CoinTransaction');
const { bumpSync } = require('./sync');

class InsufficientCoinsError extends Error {
  constructor(balance, required) {
    super('Not enough coins');
    this.balance = balance;
    this.required = required;
  }
}

// The idempotency key was already used: this credit or debit has happened.
class DuplicateEntryError extends Error {}

function isDuplicateKeyError(err) {
  return err && err.code === 11000;
}

// A standalone mongod (local development) has no transactions. Production
// (Atlas) always does. Without them the writes still run, in order, just
// not atomically — so this is logged once and never silent.
let transactionsUnsupported = false;

function isTransactionUnsupported(err) {
  return Boolean(err) && (err.code === 20 || /Transaction numbers are only allowed/i.test(err.message || ''));
}

// Runs fn(session) in a transaction and returns its result. A throw from
// fn aborts everything fn wrote.
async function runInTransaction(fn) {
  if (transactionsUnsupported) return fn(undefined);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (!isTransactionUnsupported(err)) throw err;
    transactionsUnsupported = true;
    console.warn('MongoDB transactions are not supported by this server; wallet writes run without them (development only).');
    return fn(undefined);
  } finally {
    await session.endSession();
  }
}

async function getBalance(userId) {
  const wallet = await Wallet.findOne({ user: userId }).select('balance').lean();
  return wallet ? wallet.balance : 0;
}

async function getWallet(userId) {
  const wallet = await Wallet.findOne({ user: userId }).select('balance updatedAt').lean();
  return { balance: wallet ? wallet.balance : 0, updatedAt: wallet ? wallet.updatedAt : null };
}

// Adds `amount` (negative to debit) to the wallet and writes the ledger
// entry, inside `session`. A debit only applies if the balance covers it
// (InsufficientCoinsError otherwise), so the balance can't go below 0. A
// reused idempotencyKey throws DuplicateEntryError, which aborts the
// transaction and with it the balance change. Returns the ledger entry.
async function applyCoins({ userId, type, amount, idempotencyKey, ref = {}, session }) {
  if (!Number.isInteger(amount) || amount === 0) throw new Error(`applyCoins: bad amount ${amount}`);

  // Without a transaction (development only) the duplicate can't be rolled
  // back afterwards, so check for it first.
  if (!session && (await CoinTransaction.exists({ idempotencyKey }))) throw new DuplicateEntryError();

  const filter = { user: userId };
  if (amount < 0) filter.balance = { $gte: -amount };
  let wallet;
  try {
    wallet = await Wallet.findOneAndUpdate(
      filter,
      { $inc: { balance: amount } },
      { upsert: amount > 0, returnDocument: 'after', session }
    ).lean();
  } catch (err) {
    // Two first credits racing on the upsert: the other created the wallet.
    if (!isDuplicateKeyError(err)) throw err;
    wallet = await Wallet.findOneAndUpdate(filter, { $inc: { balance: amount } }, { returnDocument: 'after', session }).lean();
  }
  if (!wallet) {
    const balance = await Wallet.findOne({ user: userId }).select('balance').session(session || null).lean();
    throw new InsufficientCoinsError(balance ? balance.balance : 0, -amount);
  }

  try {
    const [entry] = await CoinTransaction.create(
      [{ user: userId, type, amount, balanceAfter: wallet.balance, ref, idempotencyKey }],
      { session }
    );
    return entry;
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new DuplicateEntryError();
    throw err;
  }
}

// The wallet changed: the coin chip (/auth/me) and the Coins screen
// (/wallet) both show it. Call after the transaction has committed.
function walletChanged(userId) {
  return bumpSync(userId, ['wallet', 'me']);
}

// +solveReward coins for a solved game, credited at most once per game.
// Returns { awarded, balance }: awarded is 0 for a loss, an abandoned game,
// or a game that was already credited.
async function awardSolveCoins(game, config) {
  const reward = config.coins.solveReward;
  if (game.status !== 'won' || !(reward > 0)) {
    return { awarded: 0, balance: await getBalance(game.user) };
  }
  try {
    const entry = await runInTransaction((session) => applyCoins({
      userId: game.user,
      type: 'earn_solve',
      amount: reward,
      idempotencyKey: `earn_solve:${game._id}`,
      ref: { gameId: String(game._id), mode: game.mode, tier: game.tierAtCompletion ?? null },
      session,
    }));
    await walletChanged(game.user);
    return { awarded: reward, balance: entry.balanceAfter };
  } catch (err) {
    if (!(err instanceof DuplicateEntryError)) throw err;
    return { awarded: 0, balance: await getBalance(game.user) };
  }
}

function serializeTransaction(t) {
  return {
    id: t._id,
    type: t.type,
    amount: t.amount,
    balanceAfter: t.balanceAfter,
    ref: t.ref || {},
    createdAt: t.createdAt,
  };
}

module.exports = {
  InsufficientCoinsError,
  DuplicateEntryError,
  runInTransaction,
  getBalance,
  getWallet,
  applyCoins,
  walletChanged,
  awardSolveCoins,
  serializeTransaction,
};
