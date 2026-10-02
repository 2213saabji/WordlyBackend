/* v0.2 cleanup: deletes the stored data of the removed mobile / bank
 * verification flow (PRD v0.2 §3.1–3.2). Run once after release, and within
 * 30 days of it.
 *
 * Run with:   node scripts/purge-verification-data.js            (dry run)
 *             node scripts/purge-verification-data.js --apply
 *
 * Uses MONGO_URI from .env, so it touches whatever database that points
 * at. Check it before running against production.
 *
 * What it does:
 * - lists players with a payout that isn't paid yet (pending, processing,
 *   failed). Those cycles are paid under v0.1 terms first, so their bank
 *   details are KEPT until the payout is marked paid; re-run afterwards;
 * - deletes every other `verifications` document (mobile number hash and
 *   mask, OTP state, email-link state, encrypted bank details);
 * - deletes `identityclaims` (phone / email / bank hashes) and
 *   `reviewcases` for those players;
 * - deletes notifications of the removed types.
 * Paid `payouts` records are kept as financial records.
 *
 * The models for these collections were removed with the feature, so this
 * works on the raw collections.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../utils/db');

const REMOVED_NOTIFICATION_TYPES = ['reward_earned', 'payout_sent', 'payout_failed', 'verification_needed'];
const OPEN_PAYOUT_STATUSES = ['pending', 'processing', 'failed'];

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDB();
  const db = mongoose.connection.db;
  const col = (name) => db.collection(name);

  const openPayouts = await col('payouts').find({ status: { $in: OPEN_PAYOUT_STATUSES } }).toArray();
  const heldUsers = [...new Set(openPayouts.map((p) => String(p.user)))];
  const held = heldUsers.map((id) => new mongoose.Types.ObjectId(id));

  if (openPayouts.length) {
    console.log(`${openPayouts.length} unpaid payout(s) for ${heldUsers.length} player(s). Their bank details are kept:`);
    for (const p of openPayouts) {
      console.log(`  user ${p.user}  cycle ${p.cycle}  ₹${p.amountInr}  ${p.status}  eligible ${p.eligibleDay}`);
    }
  } else {
    console.log('No unpaid payouts.');
  }

  const notHeld = { user: { $nin: held } };
  const counts = {
    verifications: await col('verifications').countDocuments(notHeld),
    identityclaims: await col('identityclaims').countDocuments(notHeld),
    reviewcases: await col('reviewcases').countDocuments(notHeld),
    notifications: await col('notifications').countDocuments({ type: { $in: REMOVED_NOTIFICATION_TYPES } }),
  };
  console.log(`${apply ? 'Deleting' : 'Would delete'}:`, counts);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to delete.');
    return;
  }

  await col('verifications').deleteMany(notHeld);
  await col('identityclaims').deleteMany(notHeld);
  await col('reviewcases').deleteMany(notHeld);
  await col('notifications').deleteMany({ type: { $in: REMOVED_NOTIFICATION_TYPES } });
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
