/* Deletes one player's account and everything tied to it.
 *
 * Run with:   node scripts/delete-user.js <email>            (dry run: shows what would go)
 *             node scripts/delete-user.js <email> --apply    (deletes; cannot be undone)
 *
 * Uses MONGO_URI from .env, so it touches whatever database that points
 * at. Check it before running against production.
 *
 * Removed: the user, their games, tier membership / days / changes, score
 * events, notifications, sync state, device sessions, passkeys, wallet,
 * coin ledger and coin orders, a pending signup for the same email, and
 * leftovers of removed features (verification, payouts, auth events).
 * Groups: they're taken out of every group. A group they own passes to
 * its next member; a group with no one else left is deleted.
 * Kept: contact form submissions (support messages, not account data).
 * Works on the raw collections, so it also clears collections whose
 * models have since been removed.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../utils/db');

// Collections whose documents belong to one user through `user`.
const BY_USER = [
  'games', 'tiermemberships', 'infinitedays', 'tierchanges', 'scoreevents', 'notifications',
  'syncstates', 'devicesessions', 'webauthncredentials', 'webauthnchallenges', 'wallets',
  'cointransactions', 'coinorders',
  // removed features
  'verifications', 'identityclaims', 'reviewcases', 'payouts', 'authevents',
];

async function main() {
  const [rawEmail] = process.argv.slice(2);
  const apply = process.argv.includes('--apply');
  if (!rawEmail || rawEmail.startsWith('--')) {
    console.error('Usage: node scripts/delete-user.js <email> [--apply]');
    process.exit(1);
  }
  const email = rawEmail.trim().toLowerCase();

  await connectDB();
  const db = mongoose.connection.db;
  console.log(`Database: ${mongoose.connection.name} on ${mongoose.connection.host}`);

  const user = await db.collection('users').findOne({ email });
  const pendingCount = await db.collection('pendingsignups').countDocuments({ email });
  if (!user) {
    console.log(`No account with email ${email}.${pendingCount ? ` (${pendingCount} pending signup for it.)` : ''}`);
    if (pendingCount && apply) {
      await db.collection('pendingsignups').deleteMany({ email });
      console.log('Deleted the pending signup.');
    }
    return;
  }

  console.log(`Account: ${user.username} <${user.email}>  id ${user._id}  created ${user.createdAt ? user.createdAt.toISOString() : '?'}`);
  console.log(`  sign-in: ${user.passwordHash ? 'password' : ''}${user.passwordHash && user.googleId ? ' + ' : ''}${user.googleId ? 'Google' : ''}`);

  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const counts = {};
  for (const name of BY_USER) {
    if (!existing.has(name)) continue;
    const n = await db.collection(name).countDocuments({ user: user._id });
    if (n) counts[name] = n;
  }
  if (pendingCount) counts.pendingsignups = pendingCount;

  const groups = await db.collection('groups').find({ $or: [{ owner: user._id }, { members: user._id }] }).toArray();
  const groupPlan = groups.map((g) => {
    const others = (g.members || []).filter((m) => String(m) !== String(user._id));
    const owns = String(g.owner) === String(user._id);
    let action = 'leave';
    if (owns && others.length) action = `leave, ownership → member ${others[0]}`;
    if (!others.length) action = 'delete (no other members)';
    return { g, others, owns, action };
  });

  console.log('  linked data:', Object.keys(counts).length ? counts : 'none');
  for (const p of groupPlan) console.log(`  group "${p.g.name}" (${p.g._id}): ${p.action}`);

  if (!apply) {
    console.log('Dry run: nothing deleted. Re-run with --apply to delete this account permanently.');
    return;
  }

  for (const name of Object.keys(counts)) {
    if (name === 'pendingsignups') await db.collection(name).deleteMany({ email });
    else await db.collection(name).deleteMany({ user: user._id });
  }
  const touchedMembers = [];
  for (const p of groupPlan) {
    if (!p.others.length) {
      await db.collection('groups').deleteOne({ _id: p.g._id });
      continue;
    }
    const update = { $pull: { members: user._id } };
    if (p.owns) update.$set = { owner: p.others[0] };
    await db.collection('groups').updateOne({ _id: p.g._id }, update);
    touchedMembers.push(...p.others);
  }
  await db.collection('users').deleteOne({ _id: user._id });

  // Let open apps refresh: the boards they were on, and their groups'
  // members' group lists (the same counters bumpSync / bumpGlobal use).
  await db.collection('syncglobals').updateOne(
    { _id: 'global' },
    { $inc: { 'v.daily': 1, 'v.weekly': 1, 'v.infiniteBoard': 1 } },
    { upsert: true }
  );
  if (touchedMembers.length) {
    await db.collection('syncstates').updateMany({ user: { $in: touchedMembers } }, { $inc: { 'v.mine': 1 } });
  }
  console.log(`Deleted ${user.email}.`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
