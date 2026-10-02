const mongoose = require('mongoose');
const TierChange = require('../models/TierChange');
const InfiniteDay = require('../models/InfiniteDay');
const ScoreEvent = require('../models/ScoreEvent');
const { istDayKey } = require('../utils/dailyWord');
const { getTierConfig, tierDef, demotionRule } = require('../utils/tierConfig');
const { parsePagination } = require('../utils/leaderboard');
const {
  loadSettledMembership,
  creditActivity,
  todayProgress,
  rankOf,
  tierSize,
  consistencyPercent,
} = require('../utils/tiers');

function serializeTierChange(c) {
  return {
    fromTier: c.fromTier,
    toTier: c.toTier,
    reason: c.reason,
    oldScore: c.oldScore,
    oldRank: c.oldRank,
    oldTierSize: c.oldTierSize,
    carriedScore: c.carriedScore,
    // Carry-in breakdown: carriedPoints (carryInPercent of oldScore), then
    // penalty (the demotion penalty actually taken, <= 0), = entryPoints.
    // Moves logged before v0.2 have no breakdown: entryPoints = carriedScore.
    carriedPoints: c.carriedPoints ?? c.carriedScore,
    penalty: c.penalty || 0,
    entryPoints: c.entryPoints ?? c.carriedScore,
    rankAtEntry: c.rankAtEntry,
    newTierSize: c.newTierSize,
    // The old tier's miss window at the moment of the move
    // (e.g. the missed days behind a demotion). Empty for moves logged
    // before this field existed.
    window: (c.window || []).map((w) => ({ day: w.day, qualified: w.qualified })),
    day: c.day,
    createdAt: c.createdAt,
  };
}

function tierReward(def) {
  return def.cycleReward === 'star' ? { type: 'star' } : null;
}

// GET /infinite/tiers
async function tiers(req, res) {
  const config = await getTierConfig();
  return res.json({
    version: config.version,
    tiers: config.tiers.map((t) => ({
      tier: t.tier,
      name: t.name,
      // Coins per hint; 0 = free hints, null = hints off.
      hintCost: t.hintCost,
      // Deprecated: hintCost === 0. Kept one release for older apps.
      hintsEnabled: t.hintCost === 0,
      minActiveMinutes: t.minActiveMinutes,
      minGamesCompleted: t.tier === 8 && config.tier8RequiresOneGame ? Math.max(1, t.minGamesCompleted) : t.minGamesCompleted,
      daysToStick: t.daysToStick,
      // What a completed counter earns without moving up: { type: 'star' }
      // in Diamond, null elsewhere.
      reward: tierReward(t),
      // Deprecated, always 0: apps from before v0.2 read it (0 = no cash
      // reward, so they show the star). Removed next release.
      rewardInr: 0,
      demotion: demotionRule(config, t.tier),
    })),
    scoring: {
      solveBase: config.scoring.solveBase,
      perUnusedGuess: config.scoring.perUnusedGuess,
      qualifyingDayBonus: config.scoring.qualifyingDayBonus,
    },
    demotion: config.demotion,
    carryInPercent: config.carryInPercent,
    demotionPenalty: config.demotionPenalty,
    decay: { rate: config.decay.rate, minPoints: config.decay.minPoints },
    coins: { solveReward: config.coins.solveReward },
    resetTimeIst: '00:00',
  });
}

// GET /infinite/me — tier status and today's progress card.
async function me(req, res) {
  const config = await getTierConfig();
  const membership = await loadSettledMembership(req.userId, config);
  const tier = membership ? membership.tier : 8;
  const def = tierDef(config, tier);
  const rule = demotionRule(config, tier);
  const today = istDayKey();
  const dayDoc = await InfiniteDay.findOne({ user: req.userId, day: today }).lean();
  const progress = todayProgress(dayDoc, tier, config, today);

  if (!membership) {
    // Not yet on a board: Tier 8 defaults until the first completed game.
    return res.json({
      tier,
      tierName: def.name,
      hintCost: def.hintCost,
      hintsEnabled: def.hintCost === 0, // deprecated
      score: 0,
      rank: null,
      tierSize: await tierSize(tier),
      qualifyingDaysInTier: 0,
      consistencyPercent: null,
      counter: { stickDays: 0, daysToStick: def.daysToStick, daysLeft: def.daysToStick, resetsOnEntry: true },
      demotion: { missesInWindow: 0, limit: rule.misses, windowDays: rule.windowDays, atRisk: false, window: [] },
      today: progress,
      lastChange: null,
      completedCycles: [],
      stars: 0,
      lastDecay: null,
    });
  }

  const [rank, size, lastChange] = await Promise.all([
    rankOf(membership),
    tierSize(tier),
    TierChange.findOne({ user: req.userId, reason: { $in: ['promotion', 'demotion', 'admin'] } })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const completedCycles = (membership.completedCycles || []).map((c) => ({ cycle: c.cycle, day: c.day }));
  return res.json({
    tier,
    tierName: def.name,
    hintCost: def.hintCost,
    hintsEnabled: def.hintCost === 0, // deprecated
    score: membership.score,
    rank,
    tierSize: size,
    qualifyingDaysInTier: membership.qualifyingDaysInTier,
    consistencyPercent: consistencyPercent(membership, progress.qualified),
    counter: {
      stickDays: membership.stickDays,
      daysToStick: def.daysToStick,
      daysLeft: Math.max(0, def.daysToStick - membership.stickDays),
      resetsOnEntry: true,
    },
    demotion: {
      missesInWindow: membership.missesInWindow,
      limit: rule.misses,
      windowDays: rule.windowDays,
      // Tier 8 can't be demoted.
      atRisk: tier <= 7 && membership.missesInWindow >= rule.misses - 1,
      window: membership.window.map((w) => ({ day: w.day, qualified: w.qualified })),
    },
    today: progress,
    lastChange: lastChange ? serializeTierChange(lastChange) : null,
    // Completed Diamond 30-day cycles: one Diamond star each.
    completedCycles,
    stars: completedCycles.length,
    // The most recent inactivity decay ({ day, points: -62 }), or null.
    lastDecay: membership.lastDecay ? { day: membership.lastDecay.day, points: membership.lastDecay.points } : null,
  });
}

// POST /infinite/activity/heartbeat
async function heartbeat(req, res) {
  const { visible, lastInputAgoMs } = req.body || {};
  const config = await getTierConfig();
  const membership = await loadSettledMembership(req.userId, config);
  const tier = membership ? membership.tier : 8;

  const { creditedMs, dayDoc } = await creditActivity({
    userId: req.userId,
    tier,
    config,
    visible,
    lastInputAgoMs,
  });

  const { day, activeMinutes, targetMinutes, gamesCompleted, targetGames, qualified } = todayProgress(dayDoc, tier, config, dayDoc.day);
  return res.json({ creditedMs, today: { day, activeMinutes, targetMinutes, gamesCompleted, targetGames, qualified } });
}

// GET /infinite/tier-changes?page=1 — the caller's tier history, newest first.
async function tierChanges(req, res) {
  const { page, limit } = parsePagination(req.query);
  const filter = { user: req.userId, reason: { $ne: 'seed' } };
  const [total, changes] = await Promise.all([
    TierChange.countDocuments(filter),
    TierChange.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return res.json({
    changes: changes.map(serializeTierChange),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  });
}

const SCORE_EVENTS_DEFAULT_LIMIT = 20;
const SCORE_EVENTS_MAX_LIMIT = 50;

// GET /infinite/score-events?cursor=&limit=20 — every change to the
// caller's tier points (games, day bonus, decay, carry-in, demotion
// penalty), newest first. `cursor` is the previous page's nextCursor.
async function scoreEvents(req, res) {
  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, SCORE_EVENTS_MAX_LIMIT) : SCORE_EVENTS_DEFAULT_LIMIT;
  const filter = { user: req.userId };
  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    if (!mongoose.isValidObjectId(req.query.cursor)) {
      return res.status(400).json({ message: 'cursor is invalid', code: 'INVALID_CURSOR' });
    }
    filter._id = { $lt: req.query.cursor };
  }
  // Make sure idle days up to yesterday are decayed before listing.
  await loadSettledMembership(req.userId, await getTierConfig());

  const items = await ScoreEvent.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const page = items.slice(0, limit);
  return res.json({
    items: page.map((e) => ({
      id: e._id,
      type: e.type,
      points: e.points,
      day: e.day,
      tier: e.tier,
      gameId: e.gameId || null,
      createdAt: e.createdAt,
    })),
    nextCursor: items.length > limit ? String(page[page.length - 1]._id) : null,
  });
}

// GET /rewards/me — removed in v0.2, kept answering for one release only
// for app versions that still read Diamond cycles from it. Same shape as
// before with no money: every completed cycle (Diamond star) is a
// zero-amount "payout", which those apps render as a star.
async function legacyRewardsMe(req, res) {
  const config = await getTierConfig();
  const membership = await loadSettledMembership(req.userId, config);
  const inTier1 = Boolean(membership && membership.tier === 1);
  return res.json({
    enabled: false,
    inTier1,
    day: inTier1 ? membership.stickDays : 0,
    of: tierDef(config, 1).daysToStick,
    amountInr: 0,
    verificationComplete: false,
    blockedReason: null,
    payouts: ((membership && membership.completedCycles) || []).map((c) => ({
      cycle: c.cycle,
      amountInr: 0,
      status: 'paid',
      eligibleDay: c.day,
      paidAt: null,
    })),
  });
}

module.exports = { tiers, me, heartbeat, tierChanges, scoreEvents, legacyRewardsMe };
