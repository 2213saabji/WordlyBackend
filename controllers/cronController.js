const ContactSubmission = require('../models/ContactSubmission');
const { sendContactDigestEmail } = require('../utils/email');
const { todayKey } = require('../utils/dailyWord');
const { getWeekRange } = require('../utils/leaderboard');

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

module.exports = { dailyContactDigest, weeklyContactDigest };
