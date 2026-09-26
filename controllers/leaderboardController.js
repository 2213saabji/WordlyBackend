const Game = require('../models/Game');
const TierMembership = require('../models/TierMembership');
const { todayKey } = require('../utils/dailyWord');
const { getWeekRange, rankDailyEntries, rankWeeklyEntries, paginate, parsePagination } = require('../utils/leaderboard');
const { getTierConfig, tierDef } = require('../utils/tierConfig');
const { loadSettledMembership, rankOf, BOARD_SORT } = require('../utils/tiers');

async function daily(req, res) {
  const date = typeof req.query.date === 'string' ? req.query.date : todayKey();

  const games = await Game.find({ date, mode: 'daily', status: { $in: ['won', 'lost'] } })
    // Global leaderboard — potentially every daily player. Trim to just what
    // rankDailyEntries() reads instead of shipping full game docs (word included).
    .select('user status guesses.result timeTakenMs')
    .populate('user', 'username')
    .lean();

  const { page, limit } = parsePagination(req.query);
  const { items, pagination } = paginate(rankDailyEntries(games), page, limit);

  return res.json({ date, leaderboard: items, pagination });
}

async function weekly(req, res) {
  const referenceDate = typeof req.query.date === 'string' ? req.query.date : todayKey();
  const { start, end } = getWeekRange(referenceDate);

  const games = await Game.find({
    date: { $gte: start, $lte: end },
    mode: 'daily',
    status: { $in: ['won', 'lost'] },
  })
    .select('user status guesses.result timeTakenMs')
    .populate('user', 'username')
    .lean();

  const { page, limit } = parsePagination(req.query);
  const { items, pagination } = paginate(rankWeeklyEntries(games), page, limit);

  return res.json({ week: { start, end }, leaderboard: items, pagination });
}

// GET /leaderboard/infinite?tier=4&page=1&limit=20 — one tier's board.
// Public (optionalAuth): signed-out visitors get `me: null`, and `tier`
// defaults to 8 for them. Unlike daily/weekly this is sorted and paged in
// the database (the board is every Infinite player, not one day's games),
// and each rank is skip + position on the same index rankOf() counts over.
async function infinite(req, res) {
  const config = await getTierConfig();
  const mine = req.userId ? await loadSettledMembership(req.userId, config) : null;

  let tier = mine ? mine.tier : 8;
  if (req.query.tier !== undefined) {
    tier = Number(req.query.tier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 8) {
      return res.status(400).json({ message: 'tier must be an integer from 1 to 8', code: 'INVALID_TIER' });
    }
  }

  const { page: requestedPage, limit } = parsePagination(req.query);
  const total = await TierMembership.countDocuments({ tier });
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const skip = (page - 1) * limit;

  const members = await TierMembership.find({ tier })
    .sort(BOARD_SORT)
    .skip(skip)
    .limit(limit)
    .select('user score qualifyingDaysInTier stickDays')
    .populate('user', 'username')
    .lean();

  const inThisTier = Boolean(mine && mine.tier === tier);
  return res.json({
    tier,
    tierName: tierDef(config, tier).name,
    leaderboard: members.map((m, i) => ({
      rank: skip + i + 1,
      // A membership can outlive its user (account deleted) — keep the row
      // so ranks stay contiguous, just without a name.
      userId: m.user ? m.user._id : null,
      username: m.user ? m.user.username : null,
      score: m.score,
      qualifyingDaysInTier: m.qualifyingDaysInTier,
      stickDays: m.stickDays,
    })),
    me: req.userId
      ? {
        rank: inThisTier ? await rankOf(mine) : null,
        score: mine ? mine.score : 0,
        qualifyingDaysInTier: mine ? mine.qualifyingDaysInTier : 0,
        stickDays: mine ? mine.stickDays : 0,
        tier: mine ? mine.tier : 8,
        inThisTier,
      }
      : null,
    pagination: { page, limit, total, totalPages },
  });
}

module.exports = { daily, weekly, infinite };
