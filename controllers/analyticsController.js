const User = require('../models/User');
const { requireCronSecret } = require('./cronController');
const { istDayKey, addDaysKey, istDayStart } = require('../utils/dailyWord');
const { countryName } = require('../utils/geo');
const { regionTermFor } = require('../utils/regions');

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;

// GET /analytics/signup-locations?from=2026-09-01&to=2026-10-02
// Server-to-server (Authorization: Bearer $CRON_SECRET), like the cron jobs.
// New accounts (email signup or a first "Continue with Google") by country,
// then region, from User.signupLocation: "India: 12 (Rajasthan 5, …)".
// from / to are IST days, inclusive (default: the last 30).
async function signupLocations(req, res) {
  if (!requireCronSecret(req, res)) return;

  const to = typeof req.query.to === 'string' && DAY_KEY.test(req.query.to) ? req.query.to : istDayKey();
  const from = typeof req.query.from === 'string' && DAY_KEY.test(req.query.from)
    ? req.query.from
    : addDaysKey(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) return res.status(400).json({ message: 'from must not be after to', code: 'INVALID_RANGE' });

  const rows = await User.aggregate([
    { $match: { createdAt: { $gte: istDayStart(from), $lt: istDayStart(addDaysKey(to, 1)) } } },
    {
      $group: {
        _id: { countryCode: '$signupLocation.countryCode', regionCode: '$signupLocation.regionCode' },
        region: { $first: '$signupLocation.region' },
        regionType: { $first: '$signupLocation.regionType' },
        count: { $sum: 1 },
      },
    },
  ]);

  const countries = new Map();
  let total = 0;
  let unknownLocation = 0;
  for (const r of rows) {
    total += r.count;
    const code = r._id.countryCode;
    if (!code) {
      unknownLocation += r.count;
      continue;
    }
    if (!countries.has(code)) {
      countries.set(code, { countryCode: code, country: countryName(code), regionTerm: regionTermFor(code), count: 0, regions: [] });
    }
    const c = countries.get(code);
    c.count += r.count;
    c.regions.push({ regionCode: r._id.regionCode || null, region: r.region || null, regionType: r.regionType || null, count: r.count });
  }

  const byCount = (a, b) => b.count - a.count;
  const list = [...countries.values()].sort(byCount);
  for (const c of list) c.regions.sort(byCount);

  return res.json({ from, to, total, unknownLocation, countries: list });
}

module.exports = { signupLocations };
