/* One-time migration for the signup location (User.signupLocation).
 *
 * Run with:   node scripts/migrate-signup-location.js            (dry run)
 *             node scripts/migrate-signup-location.js --apply
 *
 * Uses MONGO_URI from .env, so it touches whatever database that points
 * at. Check it before running against production.
 *
 * What it does, in place (no user is deleted, re-created or logged out):
 * - gives every existing user the field as `signupLocation: null`. Where
 *   they signed up is unknown (IPs were never stored), so null is the
 *   honest value; new signups get the real country and region;
 * - drops the `authevents` collection, if a preview deployment created it.
 *   Signup location now lives only on the user.
 * Safe to run more than once: the second run finds nothing to do.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../utils/db');

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDB();
  const db = mongoose.connection.db;
  const users = db.collection('users');

  const [total, missing] = await Promise.all([
    users.countDocuments({}),
    users.countDocuments({ signupLocation: { $exists: false } }),
  ]);
  const hasEvents = (await db.listCollections({ name: 'authevents' }).toArray()).length > 0;
  const eventCount = hasEvents ? await db.collection('authevents').countDocuments({}) : 0;

  console.log(`users: ${total} total, ${missing} without signupLocation`);
  console.log(hasEvents ? `authevents: exists, ${eventCount} rows` : 'authevents: does not exist');

  if (!apply) {
    console.log(`Dry run. --apply would set signupLocation: null on ${missing} user(s)${hasEvents ? ' and drop authevents' : ''}.`);
    return;
  }

  const result = await users.updateMany({ signupLocation: { $exists: false } }, { $set: { signupLocation: null } });
  console.log(`Set signupLocation: null on ${result.modifiedCount} user(s).`);
  if (hasEvents) {
    await db.collection('authevents').drop();
    console.log('Dropped authevents.');
  }
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
