/* Testing only: move one player straight to a tier (e.g. Diamond), skipping
 * the qualifying days and the 00:00 IST promotion.
 *
 * Run with:   node scripts/set-tier.js <email> <tier 1-8> [--announce]
 * Example:    node scripts/set-tier.js me@example.com 1 --announce
 *
 * Uses MONGO_URI from .env, so it writes to whatever database that points
 * at. Check it before running against production.
 *
 * What it does, like a real tier move (utils/tiers.js moveTier):
 * - sets the tier, carries 20% of the score over, resets the day counter
 *   and the miss window;
 * - logs a TierChange — reason "admin", or "promotion"/"demotion" with
 *   --announce so the app shows its "Moved up overnight" screen;
 * - bumps the /sync versions so every open app refetches the tier data.
 * It does not send notifications.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../utils/db');
const User = require('../models/User');
const TierMembership = require('../models/TierMembership');
const TierChange = require('../models/TierChange');
const { getTierConfig } = require('../utils/tierConfig');
const { istDayKey } = require('../utils/dailyWord');
const { rankOf, tierSize } = require('../utils/tiers');
const { bumpSync, bumpGlobal } = require('../utils/sync');

async function main() {
  const [email, tierArg] = process.argv.slice(2);
  const announce = process.argv.includes('--announce');
  const toTier = Number(tierArg);
  if (!email || !Number.isInteger(toTier) || toTier < 1 || toTier > 8) {
    console.error('Usage: node scripts/set-tier.js <email> <tier 1-8> [--announce]');
    process.exit(1);
  }

  await connectDB();
  const user = await User.findOne({ email: email.toLowerCase() }).select('_id username').lean();
  if (!user) throw new Error(`No user with email ${email}`);

  const m = await TierMembership.findOne({ user: user._id }).lean();
  if (!m) throw new Error('This player has no Infinite tier yet — finish one Infinite game first.');
  if (m.tier === toTier) {
    console.log(`${user.username} is already in tier ${toTier}. Nothing to do.`);
    return;
  }

  const config = await getTierConfig();
  const now = new Date();
  const today = istDayKey(now);
  const [oldRank, oldTierSize] = await Promise.all([rankOf(m), tierSize(m.tier)]);
  const carriedScore = Math.floor((m.score * config.carryInPercent) / 100);

  const updated = await TierMembership.findOneAndUpdate(
    { _id: m._id },
    {
      $set: {
        tier: toTier,
        score: carriedScore,
        qualifyingDaysInTier: 0,
        scoreReachedAt: now,
        enteredTierAt: now,
        enteredTierDay: today,
        stickDays: 0,
        window: [],
        missesInWindow: 0,
      },
    },
    { returnDocument: 'after' }
  ).lean();

  const [rankAtEntry, newTierSize] = await Promise.all([rankOf(updated), tierSize(toTier)]);
  const reason = announce ? (toTier < m.tier ? 'promotion' : 'demotion') : 'admin';
  await TierChange.create({
    user: user._id,
    day: today,
    fromTier: m.tier,
    toTier,
    reason,
    oldScore: m.score,
    oldRank,
    oldTierSize,
    carriedScore,
    rankAtEntry,
    newTierSize,
    window: m.window,
  });

  // After the writes, so a sync that sees the bump finds the new data.
  await bumpSync(user._id, ['me', 'infinite', 'tierChanges']);
  await bumpGlobal(['infiniteBoard']);

  console.log(`${user.username}: tier ${m.tier} -> ${toTier} (${reason}). Score ${m.score} -> ${carriedScore}.`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
