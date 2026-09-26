const TierConfig = require('../models/TierConfig');

// Starting values from the PRD (Table 1 + §5.1 days to stick). A TierConfig
// document overrides any of these without a release; see getTierConfig().
const DEFAULT_TIER_CONFIG = {
  version: 0,
  tiers: [
    { tier: 1, name: 'Diamond', hintsEnabled: false, minActiveMinutes: 60, minGamesCompleted: 20, daysToStick: 30, rewardInr: 100 },
    { tier: 2, name: 'Platinum', hintsEnabled: false, minActiveMinutes: 45, minGamesCompleted: 15, daysToStick: 30, rewardInr: 0 },
    { tier: 3, name: 'Gold', hintsEnabled: false, minActiveMinutes: 35, minGamesCompleted: 12, daysToStick: 21, rewardInr: 0 },
    { tier: 4, name: 'Silver', hintsEnabled: false, minActiveMinutes: 25, minGamesCompleted: 9, daysToStick: 14, rewardInr: 0 },
    { tier: 5, name: 'Bronze', hintsEnabled: false, minActiveMinutes: 20, minGamesCompleted: 7, daysToStick: 10, rewardInr: 0 },
    { tier: 6, name: 'Copper', hintsEnabled: false, minActiveMinutes: 15, minGamesCompleted: 5, daysToStick: 7, rewardInr: 0 },
    { tier: 7, name: 'Iron', hintsEnabled: true, minActiveMinutes: 10, minGamesCompleted: 3, daysToStick: 5, rewardInr: 0 },
    { tier: 8, name: 'Stone', hintsEnabled: true, minActiveMinutes: 0, minGamesCompleted: 0, daysToStick: 3, rewardInr: 0 },
  ],
  scoring: { solveBase: 10, perUnusedGuess: 2, lossPoints: 0, qualifyingDayBonus: 20 },
  demotion: { misses: 3, windowDays: 7 },
  carryInPercent: 20,
  activity: {
    heartbeatMinIntervalMs: 10000, // rate limit: beats closer than this earn nothing
    maxHeartbeatGapMs: 45000, // a longer gap (dropped beats, new session) earns nothing
    idleInputMs: 60000, // no input for this long = idle
    requireGuessWithinMs: 180000, // server-side evidence of actual play
    resultScreenMs: 60000, // time on the result screen after a game still counts
  },
  lossCountsTowardTarget: true,
  tier8RequiresOneGame: true, // Tier 8 has no targets; a day still needs 1 completed game to qualify
  // Contract Q4 defaults, pending product sign-off.
  hideDifficultyInProgress: true,
  abandonAfterGuessIsLoss: true,
  // Phase 1 ships with no reward: Tier 1's counter still cycles at 30, but no
  // Payout is created until this is switched on (Phase 2).
  rewardsEnabled: false,
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

module.exports = { DEFAULT_TIER_CONFIG, getTierConfig, tierDef, dayTargets };
