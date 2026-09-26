const ContactSubmission = require('../models/ContactSubmission');
const TierMembership = require('../models/TierMembership');
const { sendContactDigestEmail } = require('../utils/email');
const { todayKey } = require('../utils/dailyWord');
const { getWeekRange } = require('../utils/leaderboard');
const { getTierConfig } = require('../utils/tierConfig');
const { settleMembership, yesterdayIst } = require('../utils/tiers');

const RESET_DEFAULT_BATCH = 500;
const RESET_MAX_BATCH = 2000;
const RESET_CONCURRENCY = 10;
// Stop picking up new members after this long, well inside a serverless
// function timeout. Whatever's left is picked up by the next call.
const RESET_TIME_BUDGET_MS = 8000;

const DEFAULT_NOTIFY_EMAIL = 'support@guessword.games';
const DEFAULT_DIGEST_EXTRA_EMAIL = '2213saabji@gmail.com';

// These endpoints are triggered by Vercel Cron, not a logged-in user, so
// they're authenticated via a shared secret instead of requireAuth's JWT
// check. Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on
// every cron-triggered request once CRON_SECRET is set as an env var.
function requireCronSecret(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(500).json({ message: 'CRON_SECRET is not configured on the server' });
    return false;
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  return true;
}

function dayRangeUTC(dateKey) {
  return {
    start: new Date(`${dateKey}T00:00:00.000Z`),
    end: new Date(`${dateKey}T23:59:59.999Z`),
  };
}

// Summarizes today's contact submissions and emails the result — doesn't
// delete anything, since the weekly digest (below) is what clears the data.
async function dailyContactDigest(req, res) {
  if (!requireCronSecret(req, res)) return;

  const dateKey = todayKey();
  const { start, end } = dayRangeUTC(dateKey);

  const submissions = await ContactSubmission.find({ createdAt: { $gte: start, $lte: end } })
    .sort({ createdAt: 1 })
    .lean();

  await sendContactDigestEmail({
    to: process.env.CONTACT_NOTIFY_EMAIL || DEFAULT_NOTIFY_EMAIL,
    subject: `GuessWord contact — daily digest (${dateKey})`,
    rangeLabel: `Daily digest for ${dateKey}`,
    submissions,
  });

  return res.json({ message: 'Daily digest sent', date: dateKey, count: submissions.length });
}

// Summarizes the current Mon-Sun week's contact submissions, emails the
// result to both recipients, then clears exactly the submissions that went
// into that email (by _id, not a blanket deleteMany) — so a submission that
// lands in the gap between the query and the delete isn't silently dropped.
async function weeklyContactDigest(req, res) {
  if (!requireCronSecret(req, res)) return;

  const { start: startKey, end: endKey } = getWeekRange(todayKey());
  const start = new Date(`${startKey}T00:00:00.000Z`);
  const end = new Date(`${endKey}T23:59:59.999Z`);

  const submissions = await ContactSubmission.find({ createdAt: { $gte: start, $lte: end } })
    .sort({ createdAt: 1 })
    .lean();

  const to = [
    process.env.CONTACT_NOTIFY_EMAIL || DEFAULT_NOTIFY_EMAIL,
    process.env.CONTACT_DIGEST_EXTRA_EMAIL || DEFAULT_DIGEST_EXTRA_EMAIL,
  ];

  await sendContactDigestEmail({
    to,
    subject: `GuessWord contact — weekly digest (${startKey} to ${endKey})`,
    rangeLabel: `Weekly digest ${startKey} to ${endKey}`,
    submissions,
  });

  const ids = submissions.map((s) => s._id);
  if (ids.length) {
    await ContactSubmission.deleteMany({ _id: { $in: ids } });
  }

  return res.json({
    message: 'Weekly digest sent and data cleared',
    week: { start: startKey, end: endKey },
    count: submissions.length,
  });
}

// Settles yesterday (IST) for the Infinite tier board: day counters, the
// 7-day miss window, promotion, demotion and the Tier 1 reward cycle. One
// call handles up to `batchSize` members; the caller repeats until
// `done: true` (see .github/workflows/infinite-daily-reset.yml). Safe to run
// late or twice — settleMembership() only applies days after each member's
// lastSettledDay, and catches up any days a missed run left behind.
// Requests settle their own user lazily too, so a late run never judges a
// player against the wrong tier.
async function infiniteDailyReset(req, res) {
  if (!requireCronSecret(req, res)) return;

  const config = await getTierConfig();
  const day = yesterdayIst();
  const requested = Number.parseInt(req.query.batchSize, 10);
  const batchSize = Number.isFinite(requested) && requested > 0 ? Math.min(requested, RESET_MAX_BATCH) : RESET_DEFAULT_BATCH;
  const deadline = Date.now() + RESET_TIME_BUDGET_MS;

  // Tiers 1-7 always (a no-show is a missed day), but Tier 8 only when the
  // member has played since their last settle — dormant Tier 8 accounts
  // can't be demoted and have nothing to settle.
  const members = await TierMembership.find({
    lastSettledDay: { $lt: day },
    $or: [
      { tier: { $lte: 7 } },
      { tier: 8, $expr: { $gt: ['$lastActiveDay', '$lastSettledDay'] } },
    ],
  })
    .limit(batchSize)
    .lean();

  const totals = { processed: 0, promoted: 0, demoted: 0, payoutsCreated: 0, failed: 0 };
  for (let i = 0; i < members.length && Date.now() < deadline; i += RESET_CONCURRENCY) {
    const chunk = members.slice(i, i + RESET_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map((m) => settleMembership(m, config, day)));
    for (const r of results) {
      totals.processed += 1;
      if (r.status === 'rejected') {
        totals.failed += 1;
        console.error('Infinite reset: settle failed', r.reason);
        continue;
      }
      totals.promoted += r.value.stats.promoted;
      totals.demoted += r.value.stats.demoted;
      totals.payoutsCreated += r.value.stats.payoutsCreated;
    }
  }

  // `done` ignores failures so one broken member can't keep the caller
  // looping; they're reported in `failed` and retried on the next run.
  const done = members.length < batchSize && totals.processed === members.length;
  return res.json({ day, ...totals, done });
}

module.exports = { dailyContactDigest, weeklyContactDigest, infiniteDailyReset };
