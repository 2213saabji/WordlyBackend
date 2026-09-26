// Rules engine for the Infinite tier leaderboard: membership, active time,
// scoring, qualifying days, and the nightly settle (promotion / demotion /
// Tier 1 reward cycle). Every write here is idempotent or conditional, so a
// retried request or a re-run of the reset job never double-counts.
// See docs/INFINITE_TIERS_BACKEND_CONTRACT.md.

const TierMembership = require('../models/TierMembership');
const InfiniteDay = require('../models/InfiniteDay');
const TierChange = require('../models/TierChange');
const Notification = require('../models/Notification');
const Payout = require('../models/Payout');
const Game = require('../models/Game');
const { tierDef, dayTargets } = require('./tierConfig');
const { istDayKey, addDaysKey, istDayStart, diffDaysKey } = require('./dailyWord');

const MS_PER_MINUTE = 60 * 1000;

function yesterdayIst(now = new Date()) {
  return addDaysKey(istDayKey(now), -1);
}

function isDuplicateKeyError(err) {
  return err && err.code === 11000;
}

// --- Ranking -----------------------------------------------------------------

// Board order: score DESC, qualifyingDaysInTier DESC, scoreReachedAt ASC, _id ASC.
const BOARD_SORT = { score: -1, qualifyingDaysInTier: -1, scoreReachedAt: 1, _id: 1 };

// 1 + the number of members of the same tier ordered ahead of `m`. One
// indexed count, so it's always current — rank is never stored.
async function rankOf(m) {
  const ahead = await TierMembership.countDocuments({
    tier: m.tier,
    $or: [
      { score: { $gt: m.score } },
      { score: m.score, qualifyingDaysInTier: { $gt: m.qualifyingDaysInTier } },
      { score: m.score, qualifyingDaysInTier: m.qualifyingDaysInTier, scoreReachedAt: { $lt: m.scoreReachedAt } },
      { score: m.score, qualifyingDaysInTier: m.qualifyingDaysInTier, scoreReachedAt: m.scoreReachedAt, _id: { $lt: m._id } },
    ],
  });
  return ahead + 1;
}

function tierSize(tier) {
  return TierMembership.countDocuments({ tier });
}

// --- Notifications -----------------------------------------------------------

function notify(userId, type, data = {}) {
  return Notification.create({ user: userId, type, data });
}

// --- Membership --------------------------------------------------------------

// Every Infinite player starts in Tier 8 on their first completed game. The
// creation day is settled on the next reset, so lastSettledDay starts at
// the day before.
async function ensureMembership(userId, now = new Date()) {
  const existing = await TierMembership.findOne({ user: userId }).lean();
  if (existing) return existing;

  const today = istDayKey(now);
  try {
    const created = await TierMembership.create({
      user: userId,
      tier: 8,
      enteredTierAt: now,
      enteredTierDay: today,
      scoreReachedAt: now,
      lastSettledDay: addDaysKey(today, -1),
    });
    await TierChange.create({ user: userId, day: today, fromTier: 8, toTier: 8, reason: 'seed' });
    return created.toObject();
  } catch (err) {
    // Two first-game completions racing — the other one created it.
    if (isDuplicateKeyError(err)) return TierMembership.findOne({ user: userId }).lean();
    throw err;
  }
}

// --- Days ----------------------------------------------------------------------

// The InfiniteDay for (user, day), creating it with the tier's targets
// snapshotted if it doesn't exist yet.
async function getOrCreateDay(userId, day, tier, config) {
  try {
    return await InfiniteDay.findOneAndUpdate(
      { user: userId, day },
      { $setOnInsert: { tier, ...dayTargets(config, tier) } },
      { upsert: true, returnDocument: 'after' }
    ).lean();
  } catch (err) {
    // Concurrent upserts on the same (user, day) — one wins, the other hits
    // the unique index. Read the winner's document.
    if (isDuplicateKeyError(err)) return InfiniteDay.findOne({ user: userId, day }).lean();
    throw err;
  }
}

// Marks the day qualified the moment both targets are met and awards the
// qualifying-day bonus exactly once (the conditional update is the guard).
// Returns the bonus awarded (0 if none).
async function evaluateQualification(dayDoc, config) {
  if (!dayDoc || dayDoc.qualified) return 0;
  const meetsTime = dayDoc.activeMs >= dayDoc.targetMinutes * MS_PER_MINUTE;
  const meetsGames = dayDoc.gamesCompleted >= dayDoc.targetGames;
  if (!meetsTime || !meetsGames) return 0;

  const now = new Date();
  const bonus = config.scoring.qualifyingDayBonus;
  const result = await InfiniteDay.updateOne(
    { _id: dayDoc._id, qualified: false },
    { $set: { qualified: true, qualifiedAt: now, bonusAwarded: true }, $inc: { pointsEarned: bonus } }
  );
  if (result.modifiedCount === 0) return 0;

  // Scoped to the day's tier: if the player has moved since the day started,
  // the bonus doesn't leak into the new tier's board.
  await TierMembership.updateOne(
    { user: dayDoc.user, tier: dayDoc.tier },
    { $inc: { score: bonus, qualifyingDaysInTier: 1 }, $set: { scoreReachedAt: now } }
  );
  return bonus;
}

// Today's progress card. `dayDoc` may be null (nothing played yet today).
function todayProgress(dayDoc, tier, config, day = istDayKey()) {
  const targets = dayDoc
    ? { targetMinutes: dayDoc.targetMinutes, targetGames: dayDoc.targetGames }
    : dayTargets(config, tier);
  const activeMs = dayDoc ? dayDoc.activeMs : 0;
  const gamesCompleted = dayDoc ? dayDoc.gamesCompleted : 0;
  const timePart = targets.targetMinutes ? Math.min(1, activeMs / (targets.targetMinutes * MS_PER_MINUTE)) : 1;
  const gamesPart = targets.targetGames ? Math.min(1, gamesCompleted / targets.targetGames) : 1;

  return {
    day,
    activeMinutes: Math.floor(activeMs / MS_PER_MINUTE),
    targetMinutes: targets.targetMinutes,
    gamesCompleted,
    targetGames: targets.targetGames,
    qualified: Boolean(dayDoc && dayDoc.qualified),
    completionRatio: Number((0.5 * timePart + 0.5 * gamesPart).toFixed(2)),
    resetsAt: istDayStart(addDaysKey(day, 1)).toISOString(),
  };
}

// --- Active time -------------------------------------------------------------

// Server-side evidence the player is actually playing: an in-progress
// infinite game with a guess (or its start) recently, or a game that ended
// moments ago (the result screen).
async function hasRecentPlay(userId, now, config) {
  const { resultScreenMs, requireGuessWithinMs } = config.activity;
  const game = await Game.findOne({
    user: userId,
    mode: 'infinite',
    $or: [{ status: 'in-progress' }, { completedAt: { $gte: new Date(now - resultScreenMs) } }],
  })
    .sort({ createdAt: -1 })
    .select('status createdAt completedAt guesses.createdAt')
    .lean();

  if (!game) return false;
  if (game.status !== 'in-progress') return true;

  const lastGuess = game.guesses.length ? game.guesses[game.guesses.length - 1].createdAt : null;
  const lastActivity = Math.max(new Date(game.createdAt).getTime(), lastGuess ? new Date(lastGuess).getTime() : 0);
  return now - lastActivity <= requireGuessWithinMs;
}

// Credits active time for one heartbeat. Time is credited as
// now - lastHeartbeatAt on the user's day document — per user, not per
// request — so several tabs share the same real time and can't add up to
// more. The conditional update makes a lost race credit 0.
async function creditActivity({ userId, tier, config, visible, lastInputAgoMs, now = new Date() }) {
  const { heartbeatMinIntervalMs, maxHeartbeatGapMs, idleInputMs } = config.activity;
  const day = istDayKey(now);
  const dayDoc = await getOrCreateDay(userId, day, tier, config);

  const prev = dayDoc.lastHeartbeatAt;
  const gap = prev ? now - new Date(prev) : null;

  // Rate limit: too soon after the last beat. Leave lastHeartbeatAt alone so
  // the next on-time beat still gets its full gap.
  if (gap !== null && gap < heartbeatMinIntervalMs) {
    return { creditedMs: 0, dayDoc };
  }

  const inputAgo = Number(lastInputAgoMs);
  const eligible = visible === true
    && Number.isFinite(inputAgo)
    && inputAgo <= idleInputMs
    && (await hasRecentPlay(userId, now, config));
  const creditedMs = eligible && gap !== null && gap <= maxHeartbeatGapMs ? gap : 0;

  const updated = await InfiniteDay.findOneAndUpdate(
    { _id: dayDoc._id, lastHeartbeatAt: prev },
    { $inc: { activeMs: creditedMs }, $set: { lastHeartbeatAt: now } },
    { returnDocument: 'after' }
  ).lean();

  if (!updated) {
    // Another tab's beat landed first and already covered this interval.
    return { creditedMs: 0, dayDoc: await InfiniteDay.findById(dayDoc._id).lean() };
  }

  const bonus = await evaluateQualification(updated, config);
  return {
    creditedMs,
    dayDoc: bonus ? await InfiniteDay.findById(updated._id).lean() : updated,
  };
}

// --- Scoring -----------------------------------------------------------------

function pointsForGame(game, config, maxAttempts) {
  if (game.status !== 'won') return config.scoring.lossPoints;
  return config.scoring.solveBase + config.scoring.perUnusedGuess * (maxAttempts - game.guesses.length);
}

// Scores a finished infinite game (won, lost, or abandoned-after-a-guess,
// which counts as a loss) exactly once. Returns the `tier` block for the
// guess response, or null if the game was already scored.
async function scoreFinishedGame(game, { config, maxAttempts, now = new Date() }) {
  const membership = await ensureMembership(game.user, now);
  const countedDay = istDayKey(game.completedAt || now);
  const won = game.status === 'won';
  const points = pointsForGame(game, config, maxAttempts);
  const countsAsCompleted = won || config.lossCountsTowardTarget;

  const claim = await Game.updateOne(
    { _id: game._id, scoredAt: null },
    { $set: { scoredAt: now, pointsAwarded: points, countedDay, tierAtCompletion: membership.tier } }
  );
  if (claim.modifiedCount === 0) return null; // a concurrent request already scored it

  game.scoredAt = now;
  game.pointsAwarded = points;
  game.countedDay = countedDay;
  game.tierAtCompletion = membership.tier;

  const dayDoc = await getOrCreateDay(game.user, countedDay, membership.tier, config);
  const updatedDay = await InfiniteDay.findOneAndUpdate(
    { _id: dayDoc._id },
    { $inc: { gamesCompleted: countsAsCompleted ? 1 : 0, gamesWon: won ? 1 : 0, pointsEarned: points } },
    { returnDocument: 'after' }
  ).lean();

  const membershipUpdate = { $set: { lastActiveDay: countedDay } };
  if (points > 0) {
    membershipUpdate.$inc = { score: points };
    membershipUpdate.$set.scoreReachedAt = now;
  }
  await TierMembership.updateOne({ _id: membership._id }, membershipUpdate);

  const bonus = await evaluateQualification(updatedDay, config);
  const finalDay = bonus ? await InfiniteDay.findById(updatedDay._id).lean() : updatedDay;
  const fresh = await TierMembership.findById(membership._id).lean();
  const [rank, size] = await Promise.all([rankOf(fresh), tierSize(fresh.tier)]);

  return {
    pointsAwarded: points,
    qualifyingBonusAwarded: bonus,
    score: fresh.score,
    rank,
    tierSize: size,
    today: todayProgress(finalDay, fresh.tier, config, countedDay),
  };
}

// --- Nightly settle ----------------------------------------------------------

class SettleConflict extends Error {}

// Settles every unsettled IST day up to `uptoDay` for one membership, in
// order: the 7-day window, the day counter (stickDays), the Tier 1 reward
// cycle, demotion and promotion. Safe to call from both the reset job and
// any request (lazy settle) — each write only matches if lastSettledDay is
// still what this call read, so concurrent settles can't apply a day twice.
async function settleMembership(initial, config, uptoDay = yesterdayIst()) {
  const stats = { promoted: 0, demoted: 0, payoutsCreated: 0 };
  let m = initial;
  if (!m || m.lastSettledDay >= uptoDay) return { membership: m, stats };

  const days = await InfiniteDay.find({ user: m.user, day: { $gt: m.lastSettledDay, $lte: uptoDay } })
    .select('day qualified')
    .lean();
  const qualifiedByDay = new Map(days.map((d) => [d.day, d.qualified]));
  const latestDay = yesterdayIst();

  let persistedDay = m.lastSettledDay;
  const state = {
    tier: m.tier,
    stickDays: m.stickDays,
    window: m.window.map((w) => ({ day: w.day, qualified: w.qualified })),
    missesInWindow: m.missesInWindow,
    rewardCycle: m.rewardCycle,
  };

  async function flush(day, extra = {}, extraFilter = {}) {
    const updated = await TierMembership.findOneAndUpdate(
      { _id: m._id, lastSettledDay: persistedDay, ...extraFilter },
      { $set: { ...state, lastSettledDay: day, ...extra } },
      { returnDocument: 'after' }
    ).lean();
    if (updated) persistedDay = day;
    return updated;
  }

  async function moveTier(toTier, reason, day) {
    // Retry on a concurrent score change (a game finishing mid-move); stop
    // if someone else settled this day first.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fresh = await TierMembership.findById(m._id).lean();
      if (!fresh || fresh.lastSettledDay !== persistedDay) throw new SettleConflict();

      const [oldRank, oldTierSize] = await Promise.all([rankOf(fresh), tierSize(fresh.tier)]);
      const carriedScore = Math.floor((fresh.score * config.carryInPercent) / 100);
      const now = new Date();
      const fromTier = state.tier;
      const before = { ...state };

      Object.assign(state, { tier: toTier, stickDays: 0, window: [], missesInWindow: 0 });
      const updated = await flush(
        day,
        {
          score: carriedScore,
          qualifyingDaysInTier: 0,
          scoreReachedAt: now,
          enteredTierAt: now,
          enteredTierDay: addDaysKey(day, 1),
        },
        { score: fresh.score }
      );
      if (!updated) {
        Object.assign(state, before); // undo, re-read, try again
        continue;
      }

      const [rankAtEntry, newTierSize] = await Promise.all([rankOf(updated), tierSize(toTier)]);
      const change = { fromTier, toTier, reason, oldScore: fresh.score, oldRank, oldTierSize, carriedScore, rankAtEntry, newTierSize };
      await TierChange.create({ user: m.user, day, ...change });
      await notify(m.user, reason, change);
      stats[reason === 'promotion' ? 'promoted' : 'demoted'] += 1;
      m = updated;
      return;
    }
    throw new SettleConflict();
  }

  try {
    for (let day = addDaysKey(persistedDay, 1); day <= uptoDay; day = addDaysKey(day, 1)) {
      const qualified = qualifiedByDay.get(day) === true;
      state.window = [...state.window, { day, qualified }].slice(-config.demotion.windowDays);
      state.missesInWindow = state.window.filter((w) => !w.qualified).length;
      state.stickDays = qualified ? state.stickDays + 1 : 0;
      const def = tierDef(config, state.tier);

      // Tier 1: the counter is the reward cycle.
      if (state.tier === 1 && state.stickDays >= def.daysToStick) {
        const cycle = state.rewardCycle + 1;
        if (config.rewardsEnabled && def.rewardInr > 0) {
          const result = await Payout.updateOne(
            { idempotencyKey: `${m.user}:${cycle}` },
            { $setOnInsert: { user: m.user, cycle, amountInr: def.rewardInr, eligibleDay: day, status: 'pending' } },
            { upsert: true }
          );
          if (result.upsertedCount) {
            stats.payoutsCreated += 1;
            await notify(m.user, 'reward_earned', { cycle, amountInr: def.rewardInr, day });
          }
        }
        state.rewardCycle = cycle;
        state.stickDays = 0;
        const updated = await flush(day);
        if (!updated) throw new SettleConflict();
        m = updated;
      }

      if (state.tier <= 7 && state.missesInWindow >= config.demotion.misses) {
        await moveTier(state.tier + 1, 'demotion', day);
      } else if (state.tier >= 2 && state.stickDays >= def.daysToStick) {
        await moveTier(state.tier - 1, 'promotion', day);
      } else if (
        !qualified
        && state.tier <= 7
        && state.missesInWindow === config.demotion.misses - 1
        && day === latestDay // don't send stale risk alerts while catching up old days
      ) {
        const updated = await flush(day);
        if (!updated) throw new SettleConflict();
        m = updated;
        await notify(m.user, 'demotion_risk', { tier: state.tier, missesInWindow: state.missesInWindow, limit: config.demotion.misses });
      }
    }

    if (persistedDay < uptoDay) {
      const updated = await flush(uptoDay);
      if (!updated) throw new SettleConflict();
      m = updated;
    }
  } catch (err) {
    if (!(err instanceof SettleConflict)) throw err;
    // Another request or the reset job settled concurrently; theirs stands.
    m = await TierMembership.findById(m._id).lean();
  }

  return { membership: m, stats };
}

// Loads a user's membership with every day up to yesterday settled, or null
// if they haven't completed an Infinite game yet. Called before any read or
// write of tier state, so tier/targets are right even if the reset cron runs
// late.
async function loadSettledMembership(userId, config) {
  const m = await TierMembership.findOne({ user: userId }).lean();
  if (!m) return null;
  const { membership } = await settleMembership(m, config);
  return membership;
}

// Qualifying days / days in tier, including today once it has qualified.
function consistencyPercent(m, todayQualified) {
  const settled = m.lastSettledDay >= m.enteredTierDay ? diffDaysKey(m.enteredTierDay, m.lastSettledDay) + 1 : 0;
  const days = settled + (todayQualified ? 1 : 0);
  if (!days) return null;
  return Math.round((Math.min(m.qualifyingDaysInTier, days) / days) * 100);
}

module.exports = {
  BOARD_SORT,
  rankOf,
  tierSize,
  notify,
  ensureMembership,
  getOrCreateDay,
  evaluateQualification,
  todayProgress,
  creditActivity,
  scoreFinishedGame,
  settleMembership,
  loadSettledMembership,
  consistencyPercent,
  yesterdayIst,
};
