// Rules engine for the Infinite tier leaderboard: membership, active time,
// scoring, qualifying days, and the nightly settle (inactivity decay /
// promotion / demotion / Diamond stars). Every write here is idempotent or
// conditional, so a retried request or a re-run of the reset job never
// double-counts. See docs/INFINITE_TIERS_BACKEND_CONTRACT.md and, for
// decay and the demotion penalty, docs/COINS_HINTS_CONTRACT.md.

const TierMembership = require('../models/TierMembership');
const InfiniteDay = require('../models/InfiniteDay');
const TierChange = require('../models/TierChange');
const Notification = require('../models/Notification');
const ScoreEvent = require('../models/ScoreEvent');
const Game = require('../models/Game');
const { tierDef, demotionRule, dayTargets, decayFor } = require('./tierConfig');
const { istDayKey, addDaysKey, istDayStart, diffDaysKey } = require('./dailyWord');
const { bumpSync, bumpGlobal } = require('./sync');

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

async function notify(userId, type, data = {}) {
  const created = await Notification.create({ user: userId, type, data });
  await bumpSync(userId, 'notifications');
  return created;
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
  const credited = await TierMembership.updateOne(
    { user: dayDoc.user, tier: dayDoc.tier },
    { $inc: { score: bonus, qualifyingDaysInTier: 1 }, $set: { scoreReachedAt: now } }
  );
  if (credited.modifiedCount) {
    await ScoreEvent.create({ user: dayDoc.user, type: 'day_bonus', points: bonus, day: dayDoc.day, tier: dayDoc.tier });
  }
  await Promise.all([bumpSync(dayDoc.user, 'infinite'), bumpGlobal('infiniteBoard')]);
  await promoteIfEarnedToday(dayDoc, config);
  return bonus;
}

// A promotion earned today happens now instead of at the nightly reset: if
// the day that just qualified is the one that completes the tier's counter,
// settle today right away. It's the same settle the reset would run, so the
// score carry-in, window, rank at entry and notifications are identical;
// the reset then simply finds today already settled. Demotions stay nightly
// (a miss is only known once the day is over).
async function promoteIfEarnedToday(dayDoc, config) {
  const today = istDayKey();
  if (dayDoc.day !== today) return;
  const m = await TierMembership.findOne({ user: dayDoc.user }).lean();
  // Only for the tier the day was played in, with every earlier day
  // settled (each request settles those first), so today is the next one.
  if (!m || m.tier !== dayDoc.tier || m.tier < 2 || m.lastSettledDay !== addDaysKey(today, -1)) return;
  if (m.stickDays + 1 < tierDef(config, m.tier).daysToStick) return;
  await settleMembership(m, config, today);
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

// Credits active time for one heartbeat or game action. Time is credited
// as now - lastHeartbeatAt on the user's day document — per user, not per
// request — so several tabs share the same real time and can't add up to
// more. The conditional update makes a lost race credit 0.
//
// source 'heartbeat' (the legacy 15 s client beat): a gap over
// maxHeartbeatGapMs earns 0, and the beat must pass the rate limit, the
// client's visible/input report and hasRecentPlay().
// source 'game' (round start or guess, recorded by the server itself): the
// action is the evidence of play, so none of those checks apply; each gap
// is capped at maxGameActionGapMs instead, so thinking time counts but a
// player who walks away mid-round earns at most the cap.
async function creditActivity({ userId, tier, config, visible, lastInputAgoMs, source = 'heartbeat', now = new Date() }) {
  const { heartbeatMinIntervalMs, maxHeartbeatGapMs, maxGameActionGapMs, idleInputMs } = config.activity;
  const day = istDayKey(now);
  const dayDoc = await getOrCreateDay(userId, day, tier, config);

  const prev = dayDoc.lastHeartbeatAt;
  const gap = prev ? now - new Date(prev) : null;

  let creditedMs;
  if (source === 'game') {
    creditedMs = gap === null ? 0 : Math.max(0, Math.min(gap, maxGameActionGapMs));
  } else {
    // Rate limit: too soon after the last beat. Leave lastHeartbeatAt alone
    // so the next on-time beat still gets its full gap.
    if (gap !== null && gap < heartbeatMinIntervalMs) {
      return { creditedMs: 0, dayDoc };
    }

    const inputAgo = Number(lastInputAgoMs);
    const eligible = visible === true
      && Number.isFinite(inputAgo)
      && inputAgo <= idleInputMs
      && (await hasRecentPlay(userId, now, config));
    creditedMs = eligible && gap !== null && gap <= maxHeartbeatGapMs ? gap : 0;
  }

  const updated = await InfiniteDay.findOneAndUpdate(
    { _id: dayDoc._id, lastHeartbeatAt: prev },
    { $inc: { activeMs: creditedMs }, $set: { lastHeartbeatAt: now } },
    { returnDocument: 'after' }
  ).lean();

  if (!updated) {
    // Another tab's beat landed first and already covered this interval.
    return { creditedMs: 0, dayDoc: await InfiniteDay.findById(dayDoc._id).lean() };
  }

  // /infinite/me shows whole minutes, so only a new minute changes it —
  // most guesses don't need the extra write.
  if (Math.floor(updated.activeMs / MS_PER_MINUTE) !== Math.floor((updated.activeMs - creditedMs) / MS_PER_MINUTE)) {
    await bumpSync(userId, 'infinite');
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
  if (points > 0) {
    await ScoreEvent.create({ user: game.user, type: 'game', points, day: countedDay, tier: membership.tier, gameId: game._id });
  }
  // The score (or, for a first game, the player) is new on the tier board.
  await Promise.all([bumpSync(game.user, 'infinite'), bumpGlobal('infiniteBoard')]);

  const bonus = await evaluateQualification(updatedDay, config);
  const finalDay = bonus ? await InfiniteDay.findById(updatedDay._id).lean() : updatedDay;
  const fresh = await TierMembership.findById(membership._id).lean();
  const [rank, size] = await Promise.all([rankOf(fresh), tierSize(fresh.tier)]);

  return {
    pointsAwarded: points,
    qualifyingBonusAwarded: bonus,
    // After an instant promotion (promoteIfEarnedToday) these are already
    // the new tier's: the carried-in score and the rank there.
    score: fresh.score,
    rank,
    tierSize: size,
    // Set when this round's qualifying day completed the counter and moved
    // the player up, so the app can react at once (the promotion screen).
    promotion: fresh.tier < membership.tier ? { fromTier: membership.tier, toTier: fresh.tier } : null,
    today: todayProgress(finalDay, fresh.tier, config, countedDay),
  };
}

// --- Nightly settle ----------------------------------------------------------

class SettleConflict extends Error {}

// Settles every unsettled IST day up to `uptoDay` for one membership, in
// order. For each day:
//   1. inactivity decay — a day with no completed Infinite game costs
//      decay.rate of the current points (at least decay.minPoints, floor 0);
//   2. the miss window (the tier's daysToStick in tiers 1–4, 7 days below)
//      and the day counter (stickDays);
//   3. Tier 1: a completed counter is a Diamond star (completedCycles);
//   4. demotion (carry-in minus demotionPenalty) or promotion (carry-in),
//      from the points left after that night's decay.
// Safe to call from both the reset job and any request (lazy settle) —
// each write only matches if lastSettledDay is still what this call read,
// so concurrent settles can't apply a day twice.
async function settleMembership(initial, config, uptoDay = yesterdayIst()) {
  const stats = { promoted: 0, demoted: 0, decayed: 0, pointsDecayed: 0, starsEarned: 0 };
  let m = initial;
  if (!m || m.lastSettledDay >= uptoDay) return { membership: m, stats };

  const days = await InfiniteDay.find({ user: m.user, day: { $gt: m.lastSettledDay, $lte: uptoDay } })
    .select('day qualified gamesCompleted gamesWon')
    .lean();
  const dayByKey = new Map(days.map((d) => [d.day, d]));
  const latestDay = yesterdayIst();

  let persistedDay = m.lastSettledDay;
  // Sync keys this settle changed, bumped once at the end.
  const touched = new Set();
  const state = {
    tier: m.tier,
    stickDays: m.stickDays,
    window: m.window.map((w) => ({ day: w.day, qualified: w.qualified })),
    missesInWindow: m.missesInWindow,
    rewardCycle: m.rewardCycle,
    completedCycles: (m.completedCycles || []).map((c) => ({ cycle: c.cycle, day: c.day })),
    lastDecay: m.lastDecay ? { day: m.lastDecay.day, points: m.lastDecay.points } : null,
  };
  // Tier points as of the day being settled. Decay comes off this and is
  // written as an $inc on the next flush, so a game scored meanwhile (today)
  // isn't overwritten; a tier move sets the score outright instead.
  let score = m.score;
  let pendingDecay = 0;
  let pendingEvents = []; // ScoreEvents, written once their flush lands
  const pendingDecayLog = { points: 0, days: 0, lastDay: null, tier: null };
  const decayLog = { points: 0, days: 0, lastDay: null, tier: null }; // persisted

  async function flush(day, extra = {}, extraFilter = {}) {
    const update = { $set: { ...state, lastSettledDay: day, ...extra } };
    if (pendingDecay && extra.score === undefined) {
      update.$inc = { score: -pendingDecay };
      update.$set.scoreReachedAt = new Date();
    }
    const updated = await TierMembership.findOneAndUpdate(
      { _id: m._id, lastSettledDay: persistedDay, ...extraFilter },
      update,
      { returnDocument: 'after' }
    ).lean();
    if (!updated) return null;
    persistedDay = day;
    pendingDecay = 0;
    score = updated.score;
    if (pendingDecayLog.days) {
      decayLog.points += pendingDecayLog.points;
      decayLog.days += pendingDecayLog.days;
      decayLog.lastDay = pendingDecayLog.lastDay;
      decayLog.tier = pendingDecayLog.tier;
      Object.assign(pendingDecayLog, { points: 0, days: 0, lastDay: null, tier: null });
    }
    if (pendingEvents.length) {
      const events = pendingEvents;
      pendingEvents = [];
      await ScoreEvent.insertMany(events);
    }
    return updated;
  }

  async function moveTier(toTier, reason, day) {
    // Retry on a concurrent score change (a game finishing mid-move); stop
    // if someone else settled this day first.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fresh = await TierMembership.findById(m._id).lean();
      if (!fresh || fresh.lastSettledDay !== persistedDay) throw new SettleConflict();

      // Tonight's decay (not written yet) comes off before the carry-over.
      const oldScore = Math.max(0, fresh.score - pendingDecay);
      const [oldRank, oldTierSize] = await Promise.all([rankOf({ ...fresh, score: oldScore }), tierSize(fresh.tier)]);
      const carriedPoints = Math.floor((oldScore * config.carryInPercent) / 100);
      const entryPoints = reason === 'demotion' ? Math.max(0, carriedPoints - config.demotionPenalty) : carriedPoints;
      const penalty = entryPoints - carriedPoints; // 0, or minus what the penalty actually took
      const now = new Date();
      const fromTier = state.tier;
      const before = { ...state };
      const eventsBefore = pendingEvents;

      Object.assign(state, { tier: toTier, stickDays: 0, window: [], missesInWindow: 0 });
      pendingEvents = [...pendingEvents, { user: m.user, type: 'carry_in', points: carriedPoints, day, tier: toTier }];
      if (penalty < 0) pendingEvents.push({ user: m.user, type: 'demotion_penalty', points: penalty, day, tier: toTier });
      const updated = await flush(
        day,
        {
          score: entryPoints,
          qualifyingDaysInTier: 0,
          scoreReachedAt: now,
          enteredTierAt: now,
          enteredTierDay: addDaysKey(day, 1),
        },
        { score: fresh.score }
      );
      if (!updated) {
        Object.assign(state, before); // undo, re-read, try again
        pendingEvents = eventsBefore;
        continue;
      }

      const [rankAtEntry, newTierSize] = await Promise.all([rankOf(updated), tierSize(toTier)]);
      const change = {
        fromTier,
        toTier,
        reason,
        oldScore,
        oldRank,
        oldTierSize,
        carriedScore: entryPoints,
        carriedPoints,
        penalty,
        entryPoints,
        rankAtEntry,
        newTierSize,
      };
      // The old tier's window, including the day that triggered the move.
      await TierChange.create({ user: m.user, day, ...change, window: before.window });
      touched.add('me').add('tierChanges'); // /auth/me carries the tier badge
      await notify(m.user, reason, change);
      stats[reason === 'promotion' ? 'promoted' : 'demoted'] += 1;
      m = updated;
      return;
    }
    throw new SettleConflict();
  }

  try {
    for (let day = addDaysKey(persistedDay, 1); day <= uptoDay; day = addDaysKey(day, 1)) {
      const played = dayByKey.get(day);
      const qualified = Boolean(played && played.qualified === true);

      // 1. Inactivity decay: no completed Infinite game that day. A day
      // played but short of the targets isn't decayed — it's only a miss.
      // A qualifying day always had games, whatever the counters say.
      const idle = !qualified && (!played || !(played.gamesCompleted > 0 || played.gamesWon > 0));
      const { effectiveFrom } = config.decay;
      if (idle && (!effectiveFrom || day >= effectiveFrom)) {
        const lost = decayFor(config, score);
        if (lost > 0) {
          score -= lost;
          pendingDecay += lost;
          state.lastDecay = { day, points: -lost };
          pendingEvents.push({ user: m.user, type: 'decay', points: -lost, day, tier: state.tier });
          pendingDecayLog.points += lost;
          pendingDecayLog.days += 1;
          pendingDecayLog.lastDay = day;
          pendingDecayLog.tier = state.tier;
        }
      }

      // 2. Window and day counter.
      const rule = demotionRule(config, state.tier);
      state.window = [...state.window, { day, qualified }].slice(-rule.windowDays);
      state.missesInWindow = state.window.filter((w) => !w.qualified).length;
      state.stickDays = qualified ? state.stickDays + 1 : 0;
      const def = tierDef(config, state.tier);

      // 3. Tier 1: a completed counter is a Diamond star.
      if (state.tier === 1 && state.stickDays >= def.daysToStick) {
        const cycle = state.rewardCycle + 1;
        state.rewardCycle = cycle;
        if (!state.completedCycles.some((c) => c.cycle === cycle)) {
          state.completedCycles = [...state.completedCycles, { cycle, day }];
        }
        state.stickDays = 0;
        const updated = await flush(day);
        if (!updated) throw new SettleConflict();
        m = updated;
        stats.starsEarned += 1;
      }

      // 4. Demotion / promotion / risk alert.
      if (state.tier <= 7 && state.missesInWindow >= rule.misses) {
        await moveTier(state.tier + 1, 'demotion', day);
      } else if (state.tier >= 2 && state.stickDays >= def.daysToStick) {
        await moveTier(state.tier - 1, 'promotion', day);
      } else if (
        !qualified
        && state.tier <= 7
        && state.missesInWindow === rule.misses - 1
        && day === latestDay // don't send stale risk alerts while catching up old days
      ) {
        const updated = await flush(day);
        if (!updated) throw new SettleConflict();
        m = updated;
        await notify(m.user, 'demotion_risk', {
          tier: state.tier,
          missesInWindow: state.missesInWindow,
          limit: rule.misses,
          windowDays: rule.windowDays,
          demotionPenalty: config.demotionPenalty,
        });
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
  } finally {
    // Whatever this call managed to write, even if it then failed. Any
    // settled day changes /infinite/me (counter, window, points).
    if (persistedDay !== initial.lastSettledDay) touched.add('infinite');
    if (decayLog.days) {
      stats.decayed = 1;
      stats.pointsDecayed = decayLog.points;
      // One notification per settle, however many idle days it covered.
      await notify(initial.user, 'points_decayed', {
        points: -decayLog.points,
        days: decayLog.days,
        day: decayLog.lastDay,
        tier: decayLog.tier,
      });
    }
    if (touched.size) await bumpSync(initial.user, [...touched]);
    // A tier move takes the player off one board and onto another; decay
    // changes their points on it. (Plain settled days also change stickDays
    // on the board, but for everyone at once — /sync covers that with the
    // IST date instead of a bump each.)
    if (touched.has('tierChanges') || decayLog.days) await bumpGlobal('infiniteBoard');
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
