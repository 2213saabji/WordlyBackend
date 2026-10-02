const TierConfig = require('../models/TierConfig');

// Starting values from the PRD (Table 1 + §5.1 days to stick; v0.2 coins,
// paid hints, decay and the demotion penalty). A TierConfig document
// overrides any of these without a release; see getTierConfig().
//
// hintCost: coins for the round's hint (the word's clue). 0 = free, and
// the clue is in the game payload from the start (Tiers 7–8). Above 0, it's
// only revealed through POST /game/infinite/hint (Tiers 1–6). null = hints
// off in that tier (the v0.1 behaviour), for rolling paid hints out after
// coin earning: set tiers 1–6 to null in TierConfig until the store opens.
// cycleReward: what completing the tier's counter earns without moving up.
// Only Diamond has one: a Diamond star per 30-day cycle (no cash).
const DEFAULT_TIER_CONFIG = {
  version: 0,
  tiers: [
    { tier: 1, name: 'Diamond', hintCost: 1000, minActiveMinutes: 60, minGamesCompleted: 20, daysToStick: 30, cycleReward: 'star' },
    { tier: 2, name: 'Platinum', hintCost: 1000, minActiveMinutes: 45, minGamesCompleted: 15, daysToStick: 30, cycleReward: null },
    { tier: 3, name: 'Gold', hintCost: 1000, minActiveMinutes: 35, minGamesCompleted: 12, daysToStick: 21, cycleReward: null },
    { tier: 4, name: 'Silver', hintCost: 1000, minActiveMinutes: 25, minGamesCompleted: 9, daysToStick: 14, cycleReward: null },
    { tier: 5, name: 'Bronze', hintCost: 1000, minActiveMinutes: 20, minGamesCompleted: 7, daysToStick: 10, cycleReward: null },
    { tier: 6, name: 'Copper', hintCost: 1000, minActiveMinutes: 15, minGamesCompleted: 5, daysToStick: 7, cycleReward: null },
    { tier: 7, name: 'Iron', hintCost: 0, minActiveMinutes: 10, minGamesCompleted: 3, daysToStick: 5, cycleReward: null },
    { tier: 8, name: 'Stone', hintCost: 0, minActiveMinutes: 0, minGamesCompleted: 0, daysToStick: 3, cycleReward: null },
  ],
  scoring: { solveBase: 10, perUnusedGuess: 2, lossPoints: 0, qualifyingDayBonus: 20 },
  // Demote at `misses` missed days in the tier's rolling window. Tiers up to
  // stickWindowMaxTier use their commitment period (daysToStick) as the
  // window: 3 misses in 30 days (Diamond, Platinum), 21 (Gold), 14 (Silver).
  // Tiers below use windowDays.
  demotion: { misses: 3, windowDays: 7, stickWindowMaxTier: 4 },
  // Promotion and demotion both carry this share of the old tier's points
  // into the new tier; demotion then takes demotionPenalty off (floor 0).
  carryInPercent: 20,
  demotionPenalty: 50,
  // Inactivity decay: each settled IST day with no completed Infinite game
  // costs `rate` of the current tier points, at least `minPoints` (floor 0).
  // Days before `effectiveFrom` are never decayed, so the first reset after
  // release doesn't decay dormant players retroactively — set it to the
  // release day.
  decay: { rate: 0.05, minPoints: 10, effectiveFrom: '2026-10-03' },
  // Coins: +solveReward per solved word (Daily and Infinite). Packs are what
  // GET /store/coin-packs sells; price in paise, GST inclusive.
  coins: {
    solveReward: 10,
    packs: [{ packId: 'coins_3000', coins: 3000, pricePaise: 1000, currency: 'INR' }],
    orderExpiryMinutes: 30, // an unpaid order shows as expired after this
  },
  activity: {
    heartbeatMinIntervalMs: 10000, // rate limit: beats closer than this earn nothing
    maxHeartbeatGapMs: 45000, // a longer gap (dropped beats, new session) earns nothing
    maxGameActionGapMs: 120000, // cap per gap between game actions (round start / guess)
    idleInputMs: 60000, // no input for this long = idle
    requireGuessWithinMs: 180000, // server-side evidence of actual play
    resultScreenMs: 60000, // time on the result screen after a game still counts
  },
  lossCountsTowardTarget: true,
  tier8RequiresOneGame: true, // Tier 8 has no targets; a day still needs 1 completed game to qualify
  // Contract Q4 defaults, pending product sign-off.
  hideDifficultyInProgress: true,
  abandonAfterGuessIsLoss: true,
};

const CACHE_TTL_MS = 60 * 1000;
let cache = null; // { value, loadedAt }

function mergeConfig(doc) {
  if (!doc) return DEFAULT_TIER_CONFIG;
  const d = DEFAULT_TIER_CONFIG;
  // Tiers merge by tier number, so a doc can override just one tier's field.
  const tiers = d.tiers.map((t) => ({ ...t, ...((doc.tiers || []).find((x) => x.tier === t.tier) || {}) }));
  return {
    ...d,
    ...doc,
    tiers,
    scoring: { ...d.scoring, ...(doc.scoring || {}) },
    demotion: { ...d.demotion, ...(doc.demotion || {}) },
    activity: { ...d.activity, ...(doc.activity || {}) },
    decay: { ...d.decay, ...(doc.decay || {}) },
    // packs, if given, replace the default list as a whole.
    coins: { ...d.coins, ...(doc.coins || {}) },
  };
}

// Cached per process for ~60 s, so a config edit reaches every instance
// within a minute without a DB read on every request.
async function getTierConfig() {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.value;
  const doc = await TierConfig.findOne().sort({ version: -1 }).lean();
  const value = mergeConfig(doc);
  cache = { value, loadedAt: Date.now() };
  return value;
}

function tierDef(config, tier) {
  return config.tiers.find((t) => t.tier === tier);
}

// The demotion rule for `tier`: demote at `misses` missed days within the
// last `windowDays` settled days in the tier.
function demotionRule(config, tier) {
  const { misses, windowDays, stickWindowMaxTier } = config.demotion;
  return {
    misses,
    windowDays: tier <= stickWindowMaxTier ? tierDef(config, tier).daysToStick : windowDays,
  };
}

// The targets a day in `tier` is judged against. Snapshotted onto the
// InfiniteDay document on its first write.
function dayTargets(config, tier) {
  const def = tierDef(config, tier);
  const minGames = tier === 8 && config.tier8RequiresOneGame ? 1 : 0;
  return {
    targetMinutes: def.minActiveMinutes,
    targetGames: Math.max(def.minGamesCompleted, minGames),
  };
}

// Points lost to inactivity on one idle day, from the current tier points.
function decayFor(config, score) {
  if (score <= 0) return 0;
  const { rate, minPoints } = config.decay;
  return Math.min(score, Math.max(minPoints, Math.floor(score * rate)));
}

function coinPack(config, packId) {
  return config.coins.packs.find((p) => p.packId === packId) || null;
}

module.exports = { DEFAULT_TIER_CONFIG, getTierConfig, tierDef, demotionRule, dayTargets, decayFor, coinPack };
