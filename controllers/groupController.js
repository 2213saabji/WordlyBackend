const crypto = require('crypto');

const Group = require('../models/Group');
const User = require('../models/User');
const Game = require('../models/Game');
const { todayKey } = require('../utils/dailyWord');
const { getWeekRange, rankDailyEntries, rankWeeklyEntries, paginate } = require('../utils/leaderboard');

const DEFAULT_LEADERBOARD_LIMIT = 20;
const MAX_LEADERBOARD_LIMIT = 100;

function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. 'A1B2C3D4'
}

// Clamps page/limit from query params to sane bounds instead of trusting
// them outright — a bad `limit` shouldn't be able to force a huge scan.
function parsePagination(query) {
  const page = Number.parseInt(query.page, 10);
  const limit = Number.parseInt(query.limit, 10);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LEADERBOARD_LIMIT) : DEFAULT_LEADERBOARD_LIMIT,
  };
}

async function createGroup(req, res) {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Group name is required' });
  }

  let inviteCode;
  do {
    inviteCode = generateInviteCode();
  } while (await Group.exists({ inviteCode })); // lighter than findOne — no document to materialize

  const group = await Group.create({
    name: name.trim(),
    inviteCode,
    owner: req.userId,
    members: [req.userId],
  });

  await User.findByIdAndUpdate(req.userId, { $addToSet: { groups: group._id } });

  return res.status(201).json({ group });
}

async function joinGroup(req, res) {
  const { code } = req.params;
  const group = await Group.findOne({ inviteCode: code.toUpperCase() });

  if (!group) {
    return res.status(404).json({ message: 'Invalid invite code' });
  }

  if (group.members.some((m) => m.toString() === req.userId)) {
    return res.status(409).json({ message: 'You are already a member of this group' });
  }

  group.members.push(req.userId);
  await group.save();
  await User.findByIdAndUpdate(req.userId, { $addToSet: { groups: group._id } });

  return res.json({ group });
}

async function myGroups(req, res) {
  const groups = await Group.find({ members: req.userId })
    .select('name inviteCode owner members createdAt')
    .lean();
  return res.json({ groups });
}

async function leaveGroup(req, res) {
  const { id } = req.params;
  const group = await Group.findById(id);
  if (!group) {
    return res.status(404).json({ message: 'Group not found' });
  }

  group.members = group.members.filter((m) => m.toString() !== req.userId);
  await group.save();
  await User.findByIdAndUpdate(req.userId, { $pull: { groups: group._id } });

  return res.json({ message: 'Left group' });
}

async function leaderboard(req, res) {
  const { id } = req.params;
  // Read-only response: .lean() skips document hydration, and the populate
  // select drops `email` (fetched before but never used in the mapping below).
  const group = await Group.findById(id)
    .populate({ path: 'members', select: 'username stats' })
    .lean();

  if (!group) {
    return res.status(404).json({ message: 'Group not found' });
  }

  const isMember = group.members.some((m) => m._id.toString() === req.userId);
  if (!isMember) {
    return res.status(403).json({ message: 'You are not a member of this group' });
  }

  const leaderboardEntries = group.members
    .map((member) => ({
      userId: member._id,
      username: member.username,
      gamesPlayed: member.stats.gamesPlayed,
      gamesWon: member.stats.gamesWon,
      currentStreak: member.stats.currentStreak,
      maxStreak: member.stats.maxStreak,
      winRate: member.stats.gamesPlayed
        ? Number(((member.stats.gamesWon / member.stats.gamesPlayed) * 100).toFixed(1))
        : 0,
    }))
    .sort((a, b) => b.currentStreak - a.currentStreak || b.gamesWon - a.gamesWon)
    .map((entry, index) => ({ rank: index + 1, ...entry }));

  const { page, limit } = parsePagination(req.query);
  const { items, pagination } = paginate(leaderboardEntries, page, limit);

  return res.json({
    group: { id: group._id, name: group.name, inviteCode: group.inviteCode },
    leaderboard: items,
    pagination,
  });
}

async function dailyLeaderboard(req, res) {
  const { id } = req.params;
  const group = await Group.findById(id).select('name members').lean();
  if (!group) {
    return res.status(404).json({ message: 'Group not found' });
  }
  if (!group.members.some((m) => m.toString() === req.userId)) {
    return res.status(403).json({ message: 'You are not a member of this group' });
  }

  const date = typeof req.query.date === 'string' ? req.query.date : todayKey();
  const games = await Game.find({
    user: { $in: group.members },
    date,
    mode: 'daily',
    status: { $in: ['won', 'lost'] },
  })
    // Only these fields feed rankDailyEntries() — skips shipping `word` and
    // every guess's timestamp over the wire for what can be a big result set.
    .select('user status guesses.result timeTakenMs')
    .populate('user', 'username')
    .lean();

  const entries = rankDailyEntries(games);
  const { page, limit } = parsePagination(req.query);
  const { items, pagination } = paginate(entries, page, limit);

  // Guaranteed regardless of pagination: if the caller finished today's
  // game (the only way they'd appear in `entries` at all, since the query
  // above only pulls won/lost games for `date`), their own rank is always
  // returned here — even when it falls outside the requested page.
  const me = entries.find((entry) => entry.userId.toString() === req.userId) || null;

  return res.json({
    group: { id: group._id, name: group.name },
    date,
    leaderboard: items,
    pagination,
    me,
  });
}

async function weeklyLeaderboard(req, res) {
  const { id } = req.params;
  const group = await Group.findById(id).select('name members').lean();
  if (!group) {
    return res.status(404).json({ message: 'Group not found' });
  }
  if (!group.members.some((m) => m.toString() === req.userId)) {
    return res.status(403).json({ message: 'You are not a member of this group' });
  }

  const referenceDate = typeof req.query.date === 'string' ? req.query.date : todayKey();
  const { start, end } = getWeekRange(referenceDate);
  const games = await Game.find({
    user: { $in: group.members },
    date: { $gte: start, $lte: end },
    mode: 'daily',
    status: { $in: ['won', 'lost'] },
  })
    .select('user status guesses.result timeTakenMs')
    .populate('user', 'username')
    .lean();

  const entries = rankWeeklyEntries(games);
  const { page, limit } = parsePagination(req.query);
  const { items, pagination } = paginate(entries, page, limit);

  return res.json({
    group: { id: group._id, name: group.name },
    week: { start, end },
    leaderboard: items,
    pagination,
  });
}

module.exports = {
  createGroup,
  joinGroup,
  myGroups,
  leaveGroup,
  leaderboard,
  dailyLeaderboard,
  weeklyLeaderboard,
};
