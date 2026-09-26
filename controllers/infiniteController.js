const TierChange = require('../models/TierChange');
const InfiniteDay = require('../models/InfiniteDay');
const Payout = require('../models/Payout');
const { istDayKey } = require('../utils/dailyWord');
const { getTierConfig, tierDef } = require('../utils/tierConfig');
const { parsePagination } = require('../utils/leaderboard');
const { payoutReadiness } = require('../utils/verification');
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
    rankAtEntry: c.rankAtEntry,
    newTierSize: c.newTierSize,
    // The old tier's last <=7 settled days at the moment of the move
    // (e.g. the missed days behind a demotion). Empty for moves logged
    // before this field existed.
    window: (c.window || []).map((w) => ({ day: w.day, qualified: w.qualified })),
    day: c.day,
    createdAt: c.createdAt,
  };
}

async function rewardSummary(userId, membership, config) {
  const def = tierDef(config, 1);
  const [payouts, readiness] = await Promise.all([
    Payout.find({ user: userId }).sort({ cycle: -1 }).limit(24).lean(),
    payoutReadiness(userId),
  ]);
  const inTier1 = membership && membership.tier === 1;
  return {
    enabled: config.rewardsEnabled,
    inTier1: Boolean(inTier1),
    day: inTier1 ? membership.stickDays : 0,
    of: def.daysToStick,
    amountInr: def.rewardInr,
    verificationComplete: readiness.verificationComplete,
    // 'review_case' | 'verification_pending' | null
    blockedReason: readiness.blockedReason,
    payouts: payouts.map((p) => ({
      cycle: p.cycle,
      amountInr: p.amountInr,
      status: p.status,
      eligibleDay: p.eligibleDay,
      paidAt: p.paidAt,
    })),
  };
}

// GET /infinite/tiers
async function tiers(req, res) {
  const config = await getTierConfig();
  return res.json({
    version: config.version,
    tiers: config.tiers.map((t) => ({
      tier: t.tier,
      name: t.name,
      hintsEnabled: t.hintsEnabled,
      minActiveMinutes: t.minActiveMinutes,
      minGamesCompleted: t.tier === 8 && config.tier8RequiresOneGame ? Math.max(1, t.minGamesCompleted) : t.minGamesCompleted,
      daysToStick: t.daysToStick,
      rewardInr: t.rewardInr,
    })),
    scoring: {
      solveBase: config.scoring.solveBase,
      perUnusedGuess: config.scoring.perUnusedGuess,
      qualifyingDayBonus: config.scoring.qualifyingDayBonus,
    },
    demotion: config.demotion,
    carryInPercent: config.carryInPercent,
    resetTimeIst: '00:00',
  });
}

// GET /infinite/me — tier status and today's progress card.
async function me(req, res) {
  const config = await getTierConfig();
  const membership = await loadSettledMembership(req.userId, config);
  const tier = membership ? membership.tier : 8;
  const def = tierDef(config, tier);
  const today = istDayKey();
  const dayDoc = await InfiniteDay.findOne({ user: req.userId, day: today }).lean();
  const progress = todayProgress(dayDoc, tier, config, today);

  if (!membership) {
    // Not yet on a board: Tier 8 defaults until the first completed game.
    return res.json({
      tier,
      tierName: def.name,
      hintsEnabled: def.hintsEnabled,
      score: 0,
      rank: null,
      tierSize: await tierSize(tier),
      qualifyingDaysInTier: 0,
      consistencyPercent: null,
      counter: { stickDays: 0, daysToStick: def.daysToStick, daysLeft: def.daysToStick, resetsOnEntry: true },
      demotion: { missesInWindow: 0, limit: config.demotion.misses, atRisk: false, window: [] },
      today: progress,
      lastChange: null,
      completedCycles: [],
      reward: null,
    });
  }

  const [rank, size, lastChange] = await Promise.all([
    rankOf(membership),
    tierSize(tier),
    TierChange.findOne({ user: req.userId, reason: { $in: ['promotion', 'demotion', 'admin'] } })
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  return res.json({
    tier,
    tierName: def.name,
    hintsEnabled: def.hintsEnabled,
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
      limit: config.demotion.misses,
      // Tier 8 can't be demoted.
      atRisk: tier <= 7 && membership.missesInWindow >= config.demotion.misses - 1,
      window: membership.window.map((w) => ({ day: w.day, qualified: w.qualified })),
    },
    today: progress,
    lastChange: lastChange ? serializeTierChange(lastChange) : null,
    // Completed Diamond 30-day cycles, whether or not rewards are on.
    completedCycles: (membership.completedCycles || []).map((c) => ({ cycle: c.cycle, day: c.day })),
    reward: tier === 1 ? await rewardSummary(req.userId, membership, config) : null,
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

// GET /rewards/me — Tier 1 reward cycle and payout history.
async function rewardsMe(req, res) {
  const config = await getTierConfig();
  const membership = await loadSettledMembership(req.userId, config);
  return res.json(await rewardSummary(req.userId, membership, config));
}

module.exports = { tiers, me, heartbeat, tierChanges, rewardsMe };
