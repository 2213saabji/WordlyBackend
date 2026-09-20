const Game = require('../models/Game');
const { todayKey } = require('../utils/dailyWord');
const { getWeekRange, rankDailyEntries, rankWeeklyEntries } = require('../utils/leaderboard');

async function daily(req, res) {
  const date = typeof req.query.date === 'string' ? req.query.date : todayKey();

  const games = await Game.find({ date, mode: 'daily', status: { $in: ['won', 'lost'] } })
    .populate('user', 'username')
    .lean();

  return res.json({ date, leaderboard: rankDailyEntries(games) });
}

async function weekly(req, res) {
  const referenceDate = typeof req.query.date === 'string' ? req.query.date : todayKey();
  const { start, end } = getWeekRange(referenceDate);

  const games = await Game.find({
    date: { $gte: start, $lte: end },
    mode: 'daily',
    status: { $in: ['won', 'lost'] },
  })
    .populate('user', 'username')
    .lean();

  return res.json({ week: { start, end }, leaderboard: rankWeeklyEntries(games) });
}

module.exports = { daily, weekly };
