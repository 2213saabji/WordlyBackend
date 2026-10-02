const mongoose = require('mongoose');
const CoinTransaction = require('../models/CoinTransaction');
const { getWallet, serializeTransaction } = require('../utils/wallet');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// GET /wallet
async function wallet(req, res) {
  return res.json(await getWallet(req.userId));
}

// GET /wallet/transactions?cursor=&limit=20 — the coin ledger, newest
// first. `cursor` is the previous page's nextCursor (null on the last page).
async function transactions(req, res) {
  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;
  const filter = { user: req.userId };
  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    if (!mongoose.isValidObjectId(req.query.cursor)) {
      return res.status(400).json({ message: 'cursor is invalid', code: 'INVALID_CURSOR' });
    }
    filter._id = { $lt: req.query.cursor };
  }

  const items = await CoinTransaction.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = items.slice(0, limit);
  return res.json({
    items: page.map(serializeTransaction),
    nextCursor: items.length > limit ? String(page[page.length - 1]._id) : null,
  });
}

module.exports = { wallet, transactions };
