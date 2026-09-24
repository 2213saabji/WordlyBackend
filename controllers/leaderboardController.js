const Game = require('../models/Game');
const { todayKey } = require('../utils/dailyWord');
const { getWeekRange, rankDailyEntries, rankWeeklyEntries, paginate, parsePagination } = require('../utils/leaderboard');

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

module.exports = { daily, weekly };
