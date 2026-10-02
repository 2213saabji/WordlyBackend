// In-memory stand-ins for the v0.2 coin and score models (Wallet,
// CoinTransaction, CoinOrder, ScoreEvent) and for mongoose sessions, so
// tests run without a database. A stubbed transaction snapshots the wallets
// and the ledger and restores them if the callback throws, like an aborted
// MongoDB transaction would. (This file has no tests of its own.)

const mongoose = require('mongoose');
const Wallet = require('../../models/Wallet');
const CoinTransaction = require('../../models/CoinTransaction');
const CoinOrder = require('../../models/CoinOrder');
const ScoreEvent = require('../../models/ScoreEvent');

const clone = (v) => (v == null ? null : structuredClone(v));

// A chainable query whose terminal is .lean() (or await).
function query(get) {
  const q = {
    select: () => q,
    session: () => q,
    sort: () => q,
    limit: () => q,
    lean: async () => clone(get()),
    then: (resolve, reject) => Promise.resolve(clone(get())).then(resolve, reject),
  };
  return q;
}

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('$gte' in v) return doc[k] >= v.$gte;
      if ('$ne' in v) return doc[k] !== v.$ne;
      if ('$in' in v) return v.$in.includes(doc[k]);
      if ('$lt' in v) return String(doc[k]) < String(v.$lt);
    }
    return String(doc[k]) === String(v) || doc[k] === v;
  });
}

function applyUpdate(doc, update) {
  for (const [k, n] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + n;
  Object.assign(doc, update.$set || {});
  for (const [k, v] of Object.entries(update.$setOnInsert || {})) if (doc[k] === undefined) doc[k] = v;
}

let seq = 0;
const nextId = (prefix) => `${prefix}${String(++seq).padStart(6, '0')}`;

function stubCoins() {
  const state = {
    wallets: new Map(), // userId -> { user, balance, updatedAt }
    ledger: [],
    orders: [],
    scoreEvents: [],
    transactions: 0, // committed
    aborted: 0,
  };

  mongoose.startSession = async () => ({
    async withTransaction(fn) {
      const snapshot = { wallets: clone([...state.wallets.entries()]), ledger: clone(state.ledger), orders: clone(state.orders) };
      try {
        await fn();
        state.transactions += 1;
      } catch (err) {
        state.wallets = new Map(snapshot.wallets);
        state.ledger = snapshot.ledger;
        state.orders = snapshot.orders;
        state.aborted += 1;
        throw err;
      }
    },
    async endSession() {},
  });

  Wallet.findOne = ({ user }) => query(() => state.wallets.get(String(user)) || null);
  Wallet.findOneAndUpdate = (filter, update, opts = {}) => query(() => {
    let w = state.wallets.get(String(filter.user));
    if (!w) {
      if (!opts.upsert) return null;
      w = { _id: nextId('w'), user: String(filter.user), balance: 0 };
      state.wallets.set(String(filter.user), w);
    }
    if (filter.balance && !(w.balance >= filter.balance.$gte)) return null;
    applyUpdate(w, update);
    w.updatedAt = new Date();
    return w;
  });

  CoinTransaction.exists = async ({ idempotencyKey }) => state.ledger.some((t) => t.idempotencyKey === idempotencyKey);
  CoinTransaction.create = async (docs) => docs.map((d) => {
    if (state.ledger.some((t) => t.idempotencyKey === d.idempotencyKey)) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    const entry = { _id: nextId('t'), createdAt: new Date(), ...d, user: String(d.user) };
    state.ledger.push(entry);
    return entry;
  });
  CoinTransaction.find = (filter) => query(() => state.ledger
    .filter((t) => matches(t, filter))
    .sort((a, b) => (a._id < b._id ? 1 : -1)));

  CoinOrder.create = async (doc) => {
    const order = { _id: nextId('o'), status: 'created', createdAt: new Date(), receiptSentAt: null, failedNotifiedAt: null, paidAt: null, ...doc, user: String(doc.user) };
    state.orders.push(order);
    return { ...order, toObject: () => clone(order) };
  };
  CoinOrder.findOne = (filter) => query(() => state.orders.find((o) => matches(o, filter)) || null);
  CoinOrder.updateOne = async (filter, update) => {
    const o = state.orders.find((x) => matches(x, filter));
    if (!o) return { modifiedCount: 0 };
    applyUpdate(o, update);
    return { modifiedCount: 1 };
  };
  CoinOrder.findOneAndUpdate = (filter, update) => query(() => {
    const o = state.orders.find((x) => matches(x, filter));
    if (!o) return null;
    applyUpdate(o, update);
    return o;
  });

  ScoreEvent.create = async (doc) => { state.scoreEvents.push({ _id: nextId('e'), ...doc }); return doc; };
  ScoreEvent.insertMany = async (docs) => { for (const d of docs) state.scoreEvents.push({ _id: nextId('e'), ...d }); return docs; };

  state.balance = (userId) => (state.wallets.get(String(userId)) || { balance: 0 }).balance;
  state.setBalance = (userId, balance) => state.wallets.set(String(userId), { _id: nextId('w'), user: String(userId), balance });
  return state;
}

module.exports = { stubCoins };
