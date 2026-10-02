const AuthEvent = require('../models/AuthEvent');
const { AUTH_EVENTS } = AuthEvent;
const { requireCronSecret } = require('./cronController');
const { istDayKey, addDaysKey, istDayStart } = require('../utils/dailyWord');
const { countryName } = require('../utils/geo');
const { regionTermFor } = require('../utils/regions');

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;

// GET /analytics/auth-locations?from=2026-09-01&to=2026-10-02&event=google_continue&newAccount=true
// Server-to-server (Authorization: Bearer $CRON_SECRET), like the cron jobs.
// Counts signups and "Continue with Google" by country, then region:
// "India: 12 (Rajasthan 5, Maharashtra 4, …)". from / to are IST days,
// inclusive (default: the last 30). event: email_signup | google_continue |
// all (default). newAccount=true counts only newly created accounts.
async function authLocations(req, res) {
  if (!requireCronSecret(req, res)) return;

  const to = typeof req.query.to === 'string' && DAY_KEY.test(req.query.to) ? req.query.to : istDayKey();
  const from = typeof req.query.from === 'string' && DAY_KEY.test(req.query.from)
    ? req.query.from
    : addDaysKey(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) return res.status(400).json({ message: 'from must not be after to', code: 'INVALID_RANGE' });

  const event = req.query.event || 'all';
  if (event !== 'all' && !AUTH_EVENTS.includes(event)) {
    return res.status(400).json({ message: `event must be all, ${AUTH_EVENTS.join(' or ')}`, code: 'INVALID_EVENT' });
  }

  const match = { createdAt: { $gte: istDayStart(from), $lt: istDayStart(addDaysKey(to, 1)) } };
  if (event !== 'all') match.event = event;
  if (req.query.newAccount === 'true') match.newAccount = true;

  const rows = await AuthEvent.aggregate([
    { $match: match },
    {
      $group: {
        _id: { countryCode: '$countryCode', regionCode: '$regionCode' },
        region: { $first: '$region' },
        regionType: { $first: '$regionType' },
        count: { $sum: 1 },
        newAccounts: { $sum: { $cond: ['$newAccount', 1, 0] } },
      },
    },
  ]);

  const countries = new Map();
  let total = 0;
  let newAccounts = 0;
  let unknownLocation = 0;
  for (const r of rows) {
    total += r.count;
    newAccounts += r.newAccounts;
    const code = r._id.countryCode;
    if (!code) {
      unknownLocation += r.count;
      continue;
    }
    if (!countries.has(code)) {
      countries.set(code, {
        countryCode: code,
        country: countryName(code),
        regionTerm: regionTermFor(code),
        count: 0,
        newAccounts: 0,
        regions: [],
      });
    }
    const c = countries.get(code);
    c.count += r.count;
    c.newAccounts += r.newAccounts;
    c.regions.push({
      regionCode: r._id.regionCode || null,
      region: r.region || null,
      regionType: r.regionType || null,
      count: r.count,
      newAccounts: r.newAccounts,
    });
  }

  const byCount = (a, b) => b.count - a.count;
  const list = [...countries.values()].sort(byCount);
  for (const c of list) c.regions.sort(byCount);

  return res.json({ from, to, event, total, newAccounts, unknownLocation, countries: list });
}

module.exports = { authLocations };
